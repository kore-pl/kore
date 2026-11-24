package auth

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// secReq 构造一个可控"传输方式"的请求：tlsOn 模拟直连 TLS，remote 是对端地址
// （UDS 为 "@"），xfp 是反代透传的 X-Forwarded-Proto。
func secReq(tlsOn bool, remote, xfp string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = remote
	if tlsOn {
		r.TLS = &tls.ConnectionState{}
	}
	if xfp != "" {
		r.Header.Set("X-Forwarded-Proto", xfp)
	}
	return r
}

// TestCookieSecureAutoPolicy 覆盖 auto 的判定矩阵。
//
// 反例自证：旧实现把 auto 折成 `CookieSecure == "true"`，即下面的
// "TLS 直连 / 反代声明 https" 两行在旧代码上恒为 false —— 这正是 P1：
// HTTPS 部署（反代终结 TLS、UDS 回源）下 7 天会话令牌仍不带 Secure。
func TestCookieSecureAutoPolicy(t *testing.T) {
	m := newPolicyManager(t, CookiePolicyAuto)
	cases := []struct {
		name   string
		tlsOn  bool
		remote string
		xfp    string
		want   bool
	}{
		{"TLS 直连", true, "203.0.113.9:5555", "", true},
		// 反例：请求本身是 TLS 时，伪造/错误的转发头不能把 Secure 降级。
		{"TLS 直连 + XFP=http 不可降级", true, "203.0.113.9:5555", "http", true},
		{"UDS + 反代声明 https", false, "@", "https", true},
		{"loopback TCP + 多段 XFP（取首值）", false, "127.0.0.1:5555", "https, http", true},
		{"UDS + 反代声明 http", false, "@", "http", false},
		{"UDS + 无转发头", false, "@", "", false},
		{"纯 HTTP loopback（本机浏览器）", false, "127.0.0.1:5555", "", false},
		// 非本机对端不可信：转发头不采信（当前监听面只可能是本机，防御将来放宽）。
		{"非本机对端 + XFP=https 不采信", false, "203.0.113.9:5555", "https", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := m.CookieSecure(secReq(tc.tlsOn, tc.remote, tc.xfp)); got != tc.want {
				t.Fatalf("CookieSecure = %v，期望 %v", got, tc.want)
			}
		})
	}
}

// TestCookieSecureExplicitPolicy 验证 true / false 是显式覆盖：
// true 在纯 HTTP 下也加 Secure（用户自担登不上的后果），false 在 TLS 下也不加。
func TestCookieSecureExplicitPolicy(t *testing.T) {
	always := newPolicyManager(t, CookiePolicyTrue)
	for _, r := range []*http.Request{secReq(true, "203.0.113.9:5555", ""), secReq(false, "@", "")} {
		if !always.CookieSecure(r) {
			t.Fatalf("cookie_secure=true 必须恒加 Secure")
		}
	}
	never := newPolicyManager(t, CookiePolicyFalse)
	if never.CookieSecure(secReq(true, "203.0.113.9:5555", "")) {
		t.Fatalf("cookie_secure=false 是显式退出，TLS 下也不得加 Secure")
	}
}

// TestSetCookieSecureFollowsPolicy 断言 cookie 实际属性（不只是判定函数）。
func TestSetCookieSecureFollowsPolicy(t *testing.T) {
	m := newPolicyManager(t, CookiePolicyAuto)

	tlsRec := httptest.NewRecorder()
	m.SetCookie(tlsRec, secReq(true, "203.0.113.9:5555", ""), "tok")
	tlsCookie := onlyCookie(t, tlsRec, CookieName)
	if !tlsCookie.Secure || !tlsCookie.HttpOnly || tlsCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("TLS 请求的会话 cookie 应 Secure+HttpOnly+SameSite=Strict: %+v", tlsCookie)
	}

	plainRec := httptest.NewRecorder()
	m.SetCookie(plainRec, secReq(false, "@", ""), "tok")
	if onlyCookie(t, plainRec, CookieName).Secure {
		t.Fatalf("纯 HTTP 的会话 cookie 不应带 Secure（否则浏览器丢弃 → 登不上）")
	}
	if raw := plainRec.Header().Get("Set-Cookie"); strings.Contains(raw, "Secure") {
		t.Fatalf("纯 HTTP 的 Set-Cookie 不应出现 Secure: %s", raw)
	}

	// 清除路径与下发路径同一判据，否则残留 cookie 清不掉。
	clearTLS := httptest.NewRecorder()
	m.ClearCookie(clearTLS, secReq(true, "203.0.113.9:5555", ""))
	if c := onlyCookie(t, clearTLS, CookieName); !c.Secure || c.MaxAge != -1 {
		t.Fatalf("TLS 下清除 cookie 应 Secure + MaxAge=-1: %+v", c)
	}
}

// TestCookiePolicyFallback 非法取值退回 auto（不静默关掉保护）。
func TestCookiePolicyFallback(t *testing.T) {
	m := newPolicyManager(t, "bogus")
	if !m.CookieSecure(secReq(true, "203.0.113.9:5555", "")) {
		t.Fatalf("非法 cookie_secure 应退回 auto，而不是当作 false")
	}
	if NewManager(openStore(t), "h", 0, false).CookieSecure(secReq(true, "203.0.113.9:5555", "")) {
		t.Fatalf("NewManager(secure=false) 应保持显式 false 语义")
	}
}

// newPolicyManager 打开临时库并构造指定策略的 Manager。
func newPolicyManager(t *testing.T, policy string) *Manager {
	t.Helper()
	return NewManagerWithPolicy(openStore(t), "hash", 0, policy)
}

// onlyCookie 取响应里唯一的 cookie，缺失或多发都失败。
func onlyCookie(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != name {
		t.Fatalf("应只下发 %s 一个 cookie，实际 %v", name, rec.Header().Values("Set-Cookie"))
	}
	return cookies[0]
}
