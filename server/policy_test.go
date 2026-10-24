package main

import (
	"testing"
)

// 与 `tests/proxyPolicy.test.ts` 一一对应：改一处判定必须两边同时改。

func TestClassifyRoute(t *testing.T) {
	cases := []struct {
		path string
		want routeKind
	}{
		{"/health", routeHealth},
		{"/v1/chat/completions", routeProxy},
		{"/v1/anything", routeProxy},
		{"/fs/foo.md", routeFS},
		{"/", routeStatic},
		{"/assets/app.js", routeStatic},
		{"/index.html", routeStatic},
		{"/favicon.ico", routeStatic},
		{"/font.woff2", routeStatic},
		{"/random/path", routeUnknown},
		{"/assets/app.js?v=2", routeStatic},
		{"/v1/chat/completions?x=1", routeProxy},
	}
	for _, c := range cases {
		if got := classifyRoute(c.path); got != c.want {
			t.Errorf("classifyRoute(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

func TestProxyPathAllowlist(t *testing.T) {
	for p := range proxyPathAllowlist {
		if !isProxyPathAllowed(p) {
			t.Errorf("allowlisted path %q rejected", p)
		}
	}
	for _, p := range []string{"/v1/secret/admin", "/v1/", "/"} {
		if isProxyPathAllowed(p) {
			t.Errorf("path %q should be rejected", p)
		}
	}
}

func TestHostAllowlist(t *testing.T) {
	for _, h := range []string{
		"localhost", "127.0.0.1", "[::1]",
		"localhost:8080", "127.0.0.1:5173", "[::1]:8080",
		"LOCALHOST", "  Localhost:80  ",
	} {
		if !isHostAllowed(h) {
			t.Errorf("host %q should be allowed", h)
		}
	}
	for _, h := range []string{
		"evil.com", "localhost.evil.com", "127.0.0.1.evil.com", "app.localhost", "", ":8080",
	} {
		if isHostAllowed(h) {
			t.Errorf("host %q should be rejected", h)
		}
	}
	if got, ok := parseHostHost("[::1]:8080"); !ok || got != "[::1]" {
		t.Errorf("parseHostHost([::1]:8080) = %q,%v", got, ok)
	}
	if _, ok := parseHostHost(""); ok {
		t.Error("empty host should not parse")
	}
}

func TestOriginPolicy(t *testing.T) {
	cases := []struct {
		origin string
		want   bool
	}{
		{"", true},
		{"http://127.0.0.1:8080", true},
		{"http://127.0.0.1:8080/", true},
		{"https://127.0.0.1:8080", true},
		{"https://evil.com", false},
		{"http://127.0.0.1:9999", false},
		{"null", false},
	}
	for _, c := range cases {
		if got := isOriginAllowed(c.origin, "127.0.0.1:8080"); got != c.want {
			t.Errorf("isOriginAllowed(%q) = %v, want %v", c.origin, got, c.want)
		}
	}
	// 大小写归一化：Origin 与 Host 都按小写比较
	if !isOriginAllowed("http://LOCALHOST:8080", "LOCALHOST:8080") {
		t.Error("origin/host case folding failed")
	}
}

func TestPairingSecrets(t *testing.T) {
	st, err := newPairingState()
	if err != nil {
		t.Fatal(err)
	}
	if !st.verifyToken(st.token) {
		t.Fatal("fresh token should verify")
	}
	if st.verifyToken("wrong") || st.verifyToken("") {
		t.Fatal("wrong/empty token should be rejected")
	}
	// 首次成功配对前不过期：重复校验仍通过
	if !st.verifyToken(st.token) {
		t.Fatal("token must not expire before first successful pairing")
	}

	secret, err := st.completePairing()
	if err != nil {
		t.Fatal(err)
	}
	if secret == st.token {
		t.Fatal("session secret must differ from token")
	}
	if st.verifyToken(st.token) {
		t.Fatal("token must be one-shot")
	}
	if !st.isPaired(secret) {
		t.Fatal("issued secret should pair")
	}
	if st.isPaired("forged") || st.isPaired("") {
		t.Fatal("forged/empty secret must not pair")
	}
	if constantTimeEqual("abc", "abcd") || !constantTimeEqual("abc", "abc") || !constantTimeEqual("", "") {
		t.Fatal("constantTimeEqual length handling wrong")
	}
}

func TestBodyAndContentType(t *testing.T) {
	if !isWithinBodyLimit(maxRequestBodyBytes) {
		t.Error("limit boundary should pass")
	}
	if isWithinBodyLimit(maxRequestBodyBytes+1) || isWithinBodyLimit(-1) {
		t.Error("over-limit and negative must be rejected")
	}
	for _, ct := range []string{"application/json", "application/json; charset=utf-8", "Application/JSON"} {
		if !isContentTypeAllowed(ct) {
			t.Errorf("%q should be accepted", ct)
		}
	}
	for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded"} {
		if isContentTypeAllowed(ct) {
			t.Errorf("%q should be rejected", ct)
		}
	}
}

func TestExtractToken(t *testing.T) {
	cases := []struct{ q, want string }{
		{"?token=ABC123", "ABC123"},
		{"token=ABC123", "ABC123"},
		{"?a=1&token=abc&b=2", "abc"},
	}
	for _, c := range cases {
		got, ok := extractTokenFromQuery(c.q)
		if !ok || got != c.want {
			t.Errorf("extractTokenFromQuery(%q) = %q,%v", c.q, got, ok)
		}
	}
	if _, ok := extractTokenFromQuery("?a=1"); ok {
		t.Error("missing token should not parse")
	}
	if got := stripTokenFromQuery("?a=1&token=abc&b=2"); got != "a=1&b=2" {
		t.Errorf("stripTokenFromQuery = %q", got)
	}
}
