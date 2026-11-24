package httpapi

import (
	"crypto/tls"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
)

// cookieTestServer 构造带鉴权的 Server，cookie_secure 用显式策略。
func cookieTestServer(t *testing.T, policy string) *Server {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(Options{Auth: auth.NewManagerWithPolicy(db, csrfTestHash(t, "csrf-pass"), 0, policy)}, nil)
}

// loginRequest 构造登录请求：tlsOn 模拟直连 TLS，remote 是对端地址，
// xfp 是反代透传的 X-Forwarded-Proto。
func newCookieLoginRequest(t *testing.T, tlsOn bool, remote, xfp string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"password":"csrf-pass"}`))
	req.RemoteAddr = remote
	if tlsOn {
		req.TLS = &tls.ConnectionState{}
	}
	if xfp != "" {
		req.Header.Set("X-Forwarded-Proto", xfp)
	}
	return req
}

// login 直接打 Handler，断言 200 并回传响应。
func doCookieLogin(t *testing.T, s *Server, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("登录状态码 %d: %s", rec.Code, rec.Body.String())
	}
	return rec
}

// TestLoginCookieSecureByTransport 是三种入口的端到端属性断言：
//   - HTTPS（直连 TLS / 反代声明 XFP=https，UDS 回源）→ 两个 cookie 都带 Secure；
//   - 纯 HTTP（UDS 无转发头）→ 不带 Secure（否则浏览器丢弃 cookie，登不上）；
//   - 反例自证：旧实现 `CookieSecure == "true"` 把 auto 折成 false，
//     第 1 组在旧代码上必失败——本用例就是修复的守卫。
func TestLoginCookieSecureByTransport(t *testing.T) {
	cases := []struct {
		name  string
		tlsOn bool
		xfp   string
		want  bool
	}{
		{"TLS 直连", true, "", true},
		{"反代终结 TLS（UDS + XFP=https）", false, "https", true},
		{"纯 HTTP（UDS 无转发头）", false, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := cookieTestServer(t, auth.CookiePolicyAuto)
			req := newCookieLoginRequest(t, tc.tlsOn, "@", tc.xfp)
			req.Host = "panel.example.com"
			rec := doCookieLogin(t, s, req)
			session := cookieFrom(t, rec, auth.CookieName)
			csrf := cookieFrom(t, rec, csrfCookieName)
			if session.Secure != tc.want {
				t.Fatalf("kore_session Secure = %v，期望 %v（Set-Cookie=%v）",
					session.Secure, tc.want, rec.Header().Values("Set-Cookie"))
			}
			// kore_csrf 与会话 cookie 属性必须一致（双提交前端可读，但同样要 Secure）。
			if csrf.Secure != tc.want {
				t.Fatalf("kore_csrf Secure = %v，期望 %v", csrf.Secure, tc.want)
			}
			if !session.HttpOnly || csrf.HttpOnly {
				t.Fatalf("HttpOnly 语义被破坏: session=%v csrf=%v", session.HttpOnly, csrf.HttpOnly)
			}
		})
	}
}

// TestLoginCookieSecureExplicitTrue 验证 cookie_secure=true 在纯 HTTP 下也加
// Secure：这是显式选择，后果是浏览器丢弃 cookie（登不上），由启动 WARN 告知。
func TestLoginCookieSecureExplicitTrue(t *testing.T) {
	s := cookieTestServer(t, auth.CookiePolicyTrue)
	rec := doCookieLogin(t, s, newCookieLoginRequest(t, false, "@", ""))
	if !cookieFrom(t, rec, auth.CookieName).Secure {
		t.Fatalf("cookie_secure=true 时纯 HTTP 也必须带 Secure")
	}
}

// TestLoginCookieSecureExplicitFalse 验证显式退出在 TLS 下也不加 Secure。
func TestLoginCookieSecureExplicitFalse(t *testing.T) {
	s := cookieTestServer(t, auth.CookiePolicyFalse)
	rec := doCookieLogin(t, s, newCookieLoginRequest(t, true, "203.0.113.9:5555", ""))
	if cookieFrom(t, rec, auth.CookieName).Secure {
		t.Fatalf("cookie_secure=false 时 TLS 下也不得带 Secure")
	}
}
