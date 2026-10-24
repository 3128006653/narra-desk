// Package main 的 HTTP 策略层 —— `deploy/httpContract.md` 的 Go 落地。
//
// 与 `src/deploy/proxyPolicy.ts` 一一对应：本文件只做判定，不做 IO。
// 顺序约定遵循 PITFALLS P-6：不依赖请求体解析的判定（Host / Origin）一律前置。
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"regexp"
	"strings"
)

// ---------------------------------------------------------------- 路由

type routeKind string

const (
	routeHealth  routeKind = "health"
	routeStatic  routeKind = "static"
	routeProxy   routeKind = "proxy"
	routeFS      routeKind = "fs"
	routeUnknown routeKind = "unknown"
)

// proxyPathAllowlist：只有这些路径被转发，其余 /v1/* 一律拒绝。
var proxyPathAllowlist = map[string]struct{}{
	"/v1/chat/completions": {},
	"/v1/embeddings":       {},
	"/v1/models":           {},
}

var staticExtRe = regexp.MustCompile(`\.(js|css|html|ico|png|svg|woff2?)$`)

func classifyRoute(pathname string) routeKind {
	p := pathname
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	switch {
	case p == "/health":
		return routeHealth
	case strings.HasPrefix(p, "/v1/"):
		return routeProxy
	case strings.HasPrefix(p, "/fs/"):
		return routeFS
	case p == "/" || strings.HasPrefix(p, "/assets/") || staticExtRe.MatchString(p):
		return routeStatic
	default:
		return routeUnknown
	}
}

// isProxyPathAllowed —— 「其他路径一律拒绝」只作用于代理转发。
// 静态资源走独立路由，否则照字面实现会把自己的前端挡掉。
func isProxyPathAllowed(pathname string) bool {
	p := pathname
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	_, ok := proxyPathAllowlist[p]
	return ok
}

// ---------------------------------------------------------------- Host

// hostAllowlist 只接受这三种形态；带端口是合法的（浏览器一定会带）。
var hostAllowlist = []string{"localhost", "127.0.0.1", "[::1]"}

var bracketHostRe = regexp.MustCompile(`^(\[[^\]]+\])(?::\d+)?$`)

// parseHostHost 解析 Host 头 → 归一化主机名（去端口、小写、保留 IPv6 方括号）。
// 无法解析时返回 false（视为非法）。
func parseHostHost(hostHeader string) (string, bool) {
	if hostHeader == "" {
		return "", false
	}
	h := strings.ToLower(strings.TrimSpace(hostHeader))
	if m := bracketHostRe.FindStringSubmatch(h); m != nil {
		return m[1], true
	}
	idx := strings.LastIndexByte(h, ':')
	name := h
	if idx > 0 {
		name = h[:idx]
	}
	if name == "" {
		return "", false
	}
	return name, true
}

// isHostAllowed —— DNS rebinding 的必选缓解，不是可选加固。
func isHostAllowed(hostHeader string) bool {
	host, ok := parseHostHost(hostHeader)
	if !ok {
		return false
	}
	for _, a := range hostAllowlist {
		if a == host {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- Origin

// isOriginAllowed：
//   - 无 Origin 头 → 允许（同源导航请求不带 Origin）
//   - Origin: null → 拒绝（file:// 演示模式不经过本代理）
//   - 其余必须等于由**已校验的 Host** 派生出的源
//
// 之所以不维护独立 Origin 白名单：端口是启动时决定的，写死白名单会在换端口时失效；
// 而 Host 校验已经在前一步完成，用 Host 派生是最小且自洽的判定。
func isOriginAllowed(origin, hostHeader string) bool {
	if origin == "" {
		return true
	}
	if strings.EqualFold(origin, "null") {
		return false
	}
	o := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(origin), "/"))
	host := strings.ToLower(strings.TrimSpace(hostHeader))
	return o == "http://"+host || o == "https://"+host
}

// ---------------------------------------------------------------- 配对

type pairingState struct {
	token         string
	tokenUsed     bool
	sessionSecret string
}

// newPairingState：32 字节随机 token，启动时一次。
func newPairingState() (*pairingState, error) {
	t, err := randomSecret()
	if err != nil {
		return nil, err
	}
	return &pairingState{token: t}, nil
}

func randomSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// verifyToken：一次性；首次成功配对前不过期（v0.6.1 对 5 分钟过期的修正）。
func (s *pairingState) verifyToken(presented string) bool {
	if s.tokenUsed || presented == "" {
		return false
	}
	return constantTimeEqual(s.token, presented)
}

// completePairing：token 作废 + 签发**独立**的 session secret。
// cookie 值若等于 token，token 泄漏（Referer / 日志 / 屏幕共享）＝ 会话劫持。
func (s *pairingState) completePairing() (string, error) {
	secret, err := randomSecret()
	if err != nil {
		return "", err
	}
	s.tokenUsed = true
	s.sessionSecret = secret
	return secret, nil
}

func (s *pairingState) isPaired(cookieSecret string) bool {
	if s.sessionSecret == "" || cookieSecret == "" {
		return false
	}
	return constantTimeEqual(s.sessionSecret, cookieSecret)
}

// constantTimeEqual 定长比较，避免时序侧信道；长度不等直接 false。
func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ---------------------------------------------------------------- 体积与 Content-Type

const (
	maxRequestBodyBytes  = 8 * 1024 * 1024
	maxResponseBodyBytes = 8 * 1024 * 1024
)

func isWithinBodyLimit(n int64) bool {
	return n >= 0 && n <= maxRequestBodyBytes
}

// isContentTypeAllowed：代理只转发 JSON API；charset 后缀允许。
func isContentTypeAllowed(header string) bool {
	if header == "" {
		return false
	}
	base := header
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	return strings.EqualFold(strings.TrimSpace(base), "application/json")
}

// ---------------------------------------------------------------- 响应头

// securityHeaders：X-Frame-Options 与 CSP frame-ancestors 并存不冲突。
var securityHeaders = [][2]string{
	{"X-Frame-Options", "DENY"},
	{"Content-Security-Policy", "frame-ancestors 'none'"},
	{"Cross-Origin-Resource-Policy", "same-origin"},
	{"Referrer-Policy", "no-referrer"},
}

var tokenQueryRe = regexp.MustCompile(`(?:^|&)token=([A-Za-z0-9_-]+)(?:&|$)`)

// extractTokenFromQuery：token 可以不在首位。
func extractTokenFromQuery(query string) (string, bool) {
	q := strings.TrimPrefix(query, "?")
	m := tokenQueryRe.FindStringSubmatch(q)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// stripTokenFromQuery：配对跳转时原地去掉 token，保留其余参数。
func stripTokenFromQuery(query string) string {
	q := strings.TrimPrefix(query, "?")
	parts := strings.Split(q, "&")
	kept := parts[:0]
	for _, p := range parts {
		if p == "" || strings.HasPrefix(p, "token=") {
			continue
		}
		kept = append(kept, p)
	}
	return strings.Join(kept, "&")
}
