package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// handler 级集成测试：把 `deploy/httpContract.md` §1–§5 在真实 HTTP 处理器上跑一遍。
// 仍然测不到的部分（浏览器 cookie 行为、DNS rebinding、Safari）见 ACCEPTANCE.md。

func testApp(t *testing.T, upstream string, fsRoot string) (*app, string) {
	t.Helper()
	webRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(webRoot, "index.html"), []byte("<html>NARRA_INDEX</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(webRoot, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webRoot, "assets", "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}

	var u *url.URL
	if upstream != "" {
		var err error
		u, err = url.Parse(upstream)
		if err != nil {
			t.Fatal(err)
		}
	}
	pairing, err := newPairingState()
	if err != nil {
		t.Fatal(err)
	}
	return newApp(appConfig{
		WebRoot:     webRoot,
		Upstream:    u,
		UpstreamKey: "s3cret",
		FSRoot:      fsRoot,
	}, pairing), webRoot
}

func do(app *app, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec
}

func req(method, target string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, "http://127.0.0.1:8787"+target, body)
	r.Host = "127.0.0.1:8787"
	return r
}

// pair 走一次真实配对流程，返回可复用的 cookie。
func pair(t *testing.T, app *app) *http.Cookie {
	t.Helper()
	rec := do(app, req(http.MethodGet, "/?token="+app.pairing.token, nil))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("pairing: want 303, got %d (%s)", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			return c
		}
	}
	t.Fatal("pairing did not set session cookie")
	return nil
}

func withCookie(r *http.Request, c *http.Cookie) *http.Request {
	r.AddCookie(c)
	return r
}

func TestHostAndOriginGate(t *testing.T) {
	app, _ := testApp(t, "", "")

	for _, h := range []string{"evil.com", "app.localhost", "127.0.0.1.evil.com"} {
		r := req(http.MethodGet, "/health", nil)
		r.Host = h
		if rec := do(app, r); rec.Code != http.StatusForbidden {
			t.Errorf("Host %q: want 403, got %d", h, rec.Code)
		}
	}

	// Host 合法但 Origin 跨站
	r := req(http.MethodGet, "/health", nil)
	r.Header.Set("Origin", "https://evil.com")
	if rec := do(app, r); rec.Code != http.StatusForbidden {
		t.Errorf("bad origin: want 403, got %d", rec.Code)
	}

	// 同源 Origin 放行：Host/Origin 都过，停在配对门（401），不是 403
	r = req(http.MethodGet, "/health", nil)
	r.Header.Set("Origin", "http://127.0.0.1:8787")
	if rec := do(app, r); rec.Code != http.StatusUnauthorized {
		t.Errorf("same origin: want 401 (passed host/origin), got %d", rec.Code)
	}

	// /health 也必须配对：契约 §2 的配对门没有例外路由
	cookie := pair(t, app)
	if rec := do(app, withCookie(req(http.MethodGet, "/health", nil), cookie)); rec.Code != http.StatusOK {
		t.Errorf("paired /health: want 200, got %d", rec.Code)
	}
}

func TestPairingFlowAndCookieFlags(t *testing.T) {
	app, _ := testApp(t, "", "")

	// 未配对访问静态资源 → 401
	if rec := do(app, req(http.MethodGet, "/", nil)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unpaired: want 401, got %d", rec.Code)
	}

	rec := do(app, req(http.MethodGet, "/?token="+app.pairing.token, nil))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("pairing: want 303, got %d", rec.Code)
	}
	rawCookie := rec.Header().Get("Set-Cookie")
	for _, want := range []string{"HttpOnly", "SameSite=Strict", "Path=/"} {
		if !strings.Contains(rawCookie, want) {
			t.Errorf("Set-Cookie missing %q: %q", want, rawCookie)
		}
	}
	if strings.Contains(rawCookie, "Secure") {
		t.Errorf("Secure must not be set on localhost: %q", rawCookie)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("pairing did not set session cookie")
	}
	cookie := cookies[0]
	if cookie.Value == app.pairing.token {
		t.Fatal("cookie must be an independent session secret, not the token")
	}

	// token 一次性：只用 token、不带 cookie 再来一次 → 401
	// 且响应体要说明「已用过」，与「完全没带 token」区分开（否则用户会一直重试死链接）
	rec = do(app, req(http.MethodGet, "/?token="+app.pairing.token, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("reused token: want 401, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "token invalid") {
		t.Fatalf("reused token body should explain it: %q", rec.Body.String())
	}

	// 带 cookie → 200
	rec = do(app, withCookie(req(http.MethodGet, "/", nil), cookie))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "NARRA_INDEX") {
		t.Fatalf("paired GET /: %d %q", rec.Code, rec.Body.String())
	}

	// 伪造 cookie → 401
	if rec := do(app, withCookie(req(http.MethodGet, "/", nil), &http.Cookie{Name: sessionCookieName, Value: "forged"})); rec.Code != http.StatusUnauthorized {
		t.Fatalf("forged cookie: want 401, got %d", rec.Code)
	}
}

func TestProcessRestartInvalidatesCookie(t *testing.T) {
	app, _ := testApp(t, "", "")
	cookie := pair(t, app)

	// 模拟重启：新进程 = 新 pairingState（secret 不落盘）
	restarted, _ := testApp(t, "", "")
	if rec := do(restarted, withCookie(req(http.MethodGet, "/", nil), cookie)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("old cookie after restart: want 401, got %d", rec.Code)
	}
}

func TestSecurityHeaders(t *testing.T) {
	app, _ := testApp(t, "", "")
	cookie := pair(t, app)
	rec := do(app, withCookie(req(http.MethodGet, "/health", nil), cookie))
	for _, h := range securityHeaders {
		if got := rec.Header().Get(h[0]); got != h[1] {
			t.Errorf("%s = %q, want %q", h[0], got, h[1])
		}
	}
	// 401 响应也带加固头（setSecurityHeaders 在最前）
	if rec := do(app, req(http.MethodGet, "/health", nil)); rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Error("unpaired 401 must still carry security headers")
	}
}

func TestStaticRoutingAndTraversal(t *testing.T) {
	app, _ := testApp(t, "", "")
	cookie := pair(t, app)

	rec := do(app, withCookie(req(http.MethodGet, "/assets/app.js", nil), cookie))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "console.log") {
		t.Fatalf("GET /assets/app.js: %d", rec.Code)
	}

	// 规范化后逃出 webroot → 404（不是 403：不暴露路由存在性）
	for _, p := range []string{
		"/assets/../../etc/passwd",
		"/assets/../index.html/../../secret.txt",
		"/%2e%2e/%2e%2e/etc/passwd",
	} {
		if rec := do(app, withCookie(req(http.MethodGet, p, nil), cookie)); rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: want 404, got %d", p, rec.Code)
		}
	}
}

func TestProxyAllowlistAndGuards(t *testing.T) {
	app, _ := testApp(t, "http://127.0.0.1:1", "")
	cookie := pair(t, app)

	if rec := do(app, withCookie(req(http.MethodPost, "/v1/secret/admin", strings.NewReader("{}")), cookie)); rec.Code != http.StatusNotFound {
		t.Errorf("non-allowlisted proxy path: want 404, got %d", rec.Code)
	}

	r := withCookie(req(http.MethodPost, "/v1/chat/completions", strings.NewReader("{}")), cookie)
	r.Header.Set("Content-Type", "text/plain")
	if rec := do(app, r); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain: want 415, got %d", rec.Code)
	}

	r = withCookie(req(http.MethodPost, "/v1/chat/completions", strings.NewReader("{}")), cookie)
	r.Header.Set("Content-Type", "application/json")
	r.ContentLength = maxRequestBodyBytes + 1
	if rec := do(app, r); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized body: want 413, got %d", rec.Code)
	}
}

func TestProxyForwardsAndPassesRetryAfter(t *testing.T) {
	var seenAuth, seenBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		seenBody = string(b)
		if r.URL.Query().Get("fail") == "429" {
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":"rate limited"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"pong"}}]}`)
	}))
	defer upstream.Close()

	app, _ := testApp(t, upstream.URL, "")
	cookie := pair(t, app)

	r := withCookie(req(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"m"}`)), cookie)
	r.Header.Set("Content-Type", "application/json")
	rec := do(app, r)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "pong") {
		t.Fatalf("proxy: %d %q", rec.Code, rec.Body.String())
	}
	if seenAuth != "Bearer s3cret" {
		t.Errorf("upstream Authorization = %q", seenAuth)
	}
	if seenBody != `{"model":"m"}` {
		t.Errorf("upstream body = %q", seenBody)
	}

	r = withCookie(req(http.MethodPost, "/v1/chat/completions?fail=429", strings.NewReader("{}")), cookie)
	r.Header.Set("Content-Type", "application/json")
	rec = do(app, r)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "30" {
		t.Fatalf("429 passthrough: %d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestProxyWithoutUpstream(t *testing.T) {
	app, _ := testApp(t, "", "")
	cookie := pair(t, app)
	r := withCookie(req(http.MethodPost, "/v1/chat/completions", strings.NewReader("{}")), cookie)
	r.Header.Set("Content-Type", "application/json")
	if rec := do(app, r); rec.Code != http.StatusBadGateway {
		t.Errorf("no upstream: want 502, got %d", rec.Code)
	}
}

func TestFSHelperDisabledByDefault(t *testing.T) {
	app, _ := testApp(t, "", "")
	cookie := pair(t, app)
	if rec := do(app, withCookie(req(http.MethodGet, "/fs/a.md", nil), cookie)); rec.Code != http.StatusNotFound {
		t.Errorf("fs disabled: want 404, got %d", rec.Code)
	}
}

func TestFSHelperReadWriteAndJail(t *testing.T) {
	fsRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(fsRoot, "a.md"), []byte("# hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	app, _ := testApp(t, "", fsRoot)
	cookie := pair(t, app)

	rec := do(app, withCookie(req(http.MethodGet, "/fs/a.md", nil), cookie))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "hello") {
		t.Fatalf("GET /fs/a.md: %d %q", rec.Code, rec.Body.String())
	}

	// 逃逸尝试与扩展名拒绝 → 404
	for _, p := range []string{"/fs/../escape.md", "/fs/x.exe", "/fs/README"} {
		if rec := do(app, withCookie(req(http.MethodGet, p, nil), cookie)); rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: want 404, got %d", p, rec.Code)
		}
	}

	r := withCookie(req(http.MethodPut, "/fs/b.md", strings.NewReader("written")), cookie)
	if rec := do(app, r); rec.Code != http.StatusNoContent {
		t.Fatalf("PUT /fs/b.md: want 204, got %d", rec.Code)
	}
	got, err := os.ReadFile(filepath.Join(fsRoot, "b.md"))
	if err != nil || string(got) != "written" {
		t.Fatalf("written file = %q, err=%v", got, err)
	}
}
