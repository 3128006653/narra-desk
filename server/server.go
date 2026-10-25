// HTTP 壳：静态托管 / `/v1/*` 代理 / 配对 / 加固头 / FS helper 接线。
//
// 校验顺序（`deploy/httpContract.md` §2，遵循 PITFALLS P-6）：
//
//	Host → Origin → 路由 → 配对态 → Content-Type → Content-Length
//
// Host/Origin 不依赖任何请求体解析，必须最先做；配对若放最前，
// 未配对时攻击者能通过响应差异探测路由存在性。
package main

import (
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const sessionCookieName = "nd_session"

type appConfig struct {
	WebRoot     string
	Upstream    *url.URL
	UpstreamKey string
	FSRoot      string
}

type app struct {
	cfg     appConfig
	pairing *pairingState
	limiter *writeRateLimiter
	client  *http.Client
	now     func() time.Time
}

func newApp(cfg appConfig, pairing *pairingState) *app {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &app{
		cfg:     cfg,
		pairing: pairing,
		limiter: newWriteRateLimiter(fsMaxWritesPerMin),
		client:  &http.Client{Transport: transport},
		now:     time.Now,
	}
}

func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)

	// 1. Host —— DNS rebinding 的必选缓解
	if !isHostAllowed(r.Host) {
		http.Error(w, "bad host", http.StatusForbidden)
		return
	}
	// 2. Origin
	if !isOriginAllowed(r.Header.Get("Origin"), r.Host) {
		http.Error(w, "bad origin", http.StatusForbidden)
		return
	}
	// 3. 路由
	route := classifyRoute(r.URL.Path)
	if route == routeUnknown {
		notFound(w)
		return
	}

	// /health 同样走配对门：契约 §2 步骤 4 是「未配对且非配对端点 → 拒绝」，
	// 不给任何路由留绕过口，否则「哪些路径能在未配对时访问」本身成了可探测信息。
	if route == routeHealth {
		if !a.pairing.isPaired(sessionCookie(r)) {
			a.rejectUnpaired(w)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = io.WriteString(w, `{"ok":true}`)
		return
	}

	// 4. 配对态
	if !a.pairing.isPaired(sessionCookie(r)) {
		if tok, ok := extractTokenFromQuery(r.URL.RawQuery); ok {
			if a.pairing.verifyToken(tok) {
				secret, err := a.pairing.completePairing()
				if err != nil {
					http.Error(w, "cannot create session", http.StatusInternalServerError)
					return
				}
				a.setSessionCookie(w, secret)
				// 原地跳转去掉 token；必须配 Referrer-Policy: no-referrer，否则 token 从 Referer 泄漏
				target := r.URL.Path
				if q := stripTokenFromQuery(r.URL.RawQuery); q != "" {
					target += "?" + q
				}
				http.Redirect(w, r, target, http.StatusSeeOther)
				return
			}
			// 带了 token 但无效：最常见是「已用过」或「进程重启过」。
			// 与「完全没带 token」分开报，否则用户会一直重试同一个死链接。
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w,
				"token invalid: already used, or issued by a previous process.\n"+
					"restart narra-desk and open the newly printed URL.\n"+
					"note: localhost and 127.0.0.1 are different cookie origins - keep the printed host.\n")
			return
		}
		a.rejectUnpaired(w)
		return
	}

	switch route {
	case routeStatic:
		a.serveStatic(w, r)
	case routeFS:
		a.serveFS(w, r)
	case routeProxy:
		a.serveProxy(w, r)
	}
}

func (a *app) rejectUnpaired(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = io.WriteString(w, "not paired: open the printed URL containing ?token=...\n")
}

func setSecurityHeaders(w http.ResponseWriter) {
	for _, h := range securityHeaders {
		w.Header().Set(h[0], h[1])
	}
	w.Header().Set("Cache-Control", "no-store")
}

func (a *app) setSessionCookie(w http.ResponseWriter, secret string) {
	// Secure 不设：localhost 非 https（契约中的已知妥协，由 Host 校验 + 进程短生命周期覆盖）
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    secret,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
}

func sessionCookie(r *http.Request) string {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

func notFound(w http.ResponseWriter) {
	// 统一 404：403 会暴露路由/文件存在性（B2 的判定依据）
	http.Error(w, "not found", http.StatusNotFound)
}

// ---------------------------------------------------------------- 静态资源

func (a *app) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	p := r.URL.Path
	if p == "/" {
		p = "/index.html"
	}
	clean := path.Clean(p)

	// 规范化后再判一次：`/assets/../../etc/passwd` 清成 `/etc/passwd`，不能被当作 assets 放行
	if !(clean == "/index.html" || strings.HasPrefix(clean, "/assets/") || staticExtRe.MatchString(clean)) {
		notFound(w)
		return
	}

	rel := strings.TrimPrefix(clean, "/")
	if rel == "" {
		notFound(w)
		return
	}

	rootAbs, err := filepath.Abs(a.cfg.WebRoot)
	if err != nil {
		notFound(w)
		return
	}
	realRoot, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		notFound(w)
		return
	}
	full := filepath.Join(realRoot, filepath.FromSlash(rel))
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		notFound(w)
		return
	}
	if !isPathWithin(realRoot, real) {
		notFound(w)
		return
	}
	info, err := os.Stat(real)
	if err != nil || info.IsDir() {
		notFound(w)
		return
	}

	f, err := os.Open(real)
	if err != nil {
		notFound(w)
		return
	}
	defer f.Close()

	if ct := mime.TypeByExtension(filepath.Ext(real)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// isPathWithin 用 filepath.Rel 判定，自动遵循宿主平台的大小写与分隔符语义。
func isPathWithin(root, child string) bool {
	rel, err := filepath.Rel(root, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

// ---------------------------------------------------------------- FS helper（默认关闭）

func (a *app) serveFS(w http.ResponseWriter, r *http.Request) {
	if a.cfg.FSRoot == "" {
		notFound(w)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/fs/")
	opt := jailOptions{
		Root:     a.cfg.FSRoot,
		Platform: platformForHost(),
		Resolver: osJailResolver{},
	}
	res := resolveWithin(rel, opt)
	if !res.OK {
		notFound(w)
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		a.readFSFile(w, r, res.RealPath)
	case http.MethodPut, http.MethodPost:
		a.writeFSFile(w, r, res.RealPath)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *app) readFSFile(w http.ResponseWriter, r *http.Request, realPath string) {
	info, err := os.Stat(realPath)
	if err != nil || info.IsDir() {
		notFound(w)
		return
	}
	if info.Size() > fsMaxFileBytes {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	f, err := os.Open(realPath)
	if err != nil {
		notFound(w)
		return
	}
	defer f.Close()
	if ct := mime.TypeByExtension(filepath.Ext(realPath)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

func (a *app) writeFSFile(w http.ResponseWriter, r *http.Request, realPath string) {
	// 频次上限先于读体：拒绝时不该先把 100MB 读进内存
	if ok, retry := a.limiter.allow(a.now()); !ok {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retry.Seconds()+0.999)))
		http.Error(w, "too many writes", http.StatusTooManyRequests)
		return
	}

	if r.ContentLength > fsMaxFileBytes {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, fsMaxFileBytes))
	if err != nil {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}

	// 写路径必须落在真实存在的目录内：解析父目录的真实路径，
	// 否则「父目录是符号链接、叶子文件不存在」会绕过 jail（TS 版同款限制，此处收紧）
	parentReal, err := filepath.EvalSymlinks(filepath.Dir(realPath))
	if err != nil {
		notFound(w)
		return
	}
	if !isPathWithin(mustRealRoot(a.cfg.FSRoot), parentReal) {
		notFound(w)
		return
	}

	used, err := workspaceBytes(a.cfg.FSRoot)
	if err == nil && used+int64(len(body)) > fsMaxWorkspaceBytes {
		http.Error(w, "workspace quota exceeded", http.StatusInsufficientStorage)
		return
	}

	if err := os.WriteFile(realPath, body, 0o644); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func mustRealRoot(root string) string {
	if r, err := filepath.EvalSymlinks(root); err == nil {
		return r
	}
	return root
}

// ---------------------------------------------------------------- 代理

func (a *app) serveProxy(w http.ResponseWriter, r *http.Request) {
	if !isProxyPathAllowed(r.URL.Path) {
		notFound(w)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if a.cfg.Upstream == nil {
		http.Error(w, "upstream not configured (set -upstream or NARRA_UPSTREAM)", http.StatusBadGateway)
		return
	}

	hasBody := r.Method == http.MethodPost
	// 5. Content-Type（仅代理路由）
	if hasBody && !isContentTypeAllowed(r.Header.Get("Content-Type")) {
		http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
		return
	}
	// 6. Content-Length —— 上限检查先于读体（O(1) 挡掉绝大多数输入）
	if r.ContentLength > maxRequestBodyBytes || !isWithinBodyLimit(r.ContentLength) {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}

	var body []byte
	if hasBody {
		var err error
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBodyBytes))
		if err != nil {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
	}

	u := *a.cfg.Upstream
	u.Path = strings.TrimRight(u.Path, "/") + r.URL.Path
	u.RawQuery = r.URL.RawQuery

	req, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, "bad upstream url", http.StatusBadGateway)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if v := r.Header.Get("Accept"); v != "" {
		req.Header.Set("Accept", v)
	}
	// 推荐部署下由代理持有凭证；用户直连模式不经过这里
	if a.cfg.UpstreamKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.cfg.UpstreamKey)
	} else if v := r.Header.Get("Authorization"); v != "" {
		req.Header.Set("Authorization", v)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.ContentLength > maxResponseBodyBytes {
		http.Error(w, "upstream response too large", http.StatusBadGateway)
		return
	}

	// 只透传必要头：Content-Type 决定 SSE/JSON，Retry-After 决定 429 退避（ACCEPTANCE C2）
	if v := resp.Header.Get("Content-Type"); v != "" {
		w.Header().Set("Content-Type", v)
	}
	if v := resp.Header.Get("Retry-After"); v != "" {
		w.Header().Set("Retry-After", v)
	}
	w.WriteHeader(resp.StatusCode)

	fw := flushWriter{w: w}
	if f, ok := w.(http.Flusher); ok {
		fw.f = f
	}
	// 流式必须边读边写（UI 用 SSE）；上限靠上面的 Content-Length 预检 + 这里的硬截断
	n, err := io.Copy(fw, io.LimitReader(resp.Body, maxResponseBodyBytes+1))
	if err != nil {
		log.Printf("proxy: upstream stream error: %v", err)
		return
	}
	if n > maxResponseBodyBytes {
		log.Printf("proxy: response exceeded %d bytes, truncated", maxResponseBodyBytes)
	}
}

type flushWriter struct {
	w io.Writer
	f http.Flusher
}

func (fw flushWriter) Write(p []byte) (int, error) {
	n, err := fw.w.Write(p)
	if fw.f != nil {
		fw.f.Flush()
	}
	return n, err
}
