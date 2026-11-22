package httpapi

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
)

// csrfTestHash 生成测试用口令哈希（固定 salt，便于重复）。
func csrfTestHash(t *testing.T, password string) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key, err := pbkdf2.Key(sha256.New, password, salt, 1000, 32)
	if err != nil {
		t.Fatalf("派生测试哈希失败: %v", err)
	}
	return "pbkdf2-sha256$1000$" + base64.StdEncoding.EncodeToString(salt) + "$" +
		base64.StdEncoding.EncodeToString(key)
}

// csrfTestServer 构造带鉴权且启用 CSRF 的 Server（口试口令 csrf-pass）。
func csrfTestServer(t *testing.T) *Server {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(Options{Auth: auth.NewManager(db, csrfTestHash(t, "csrf-pass"), 0, false)}, nil)
}

// csrfLogin 正确口令登录，回传原始响应（含两个 Set-Cookie）。
func csrfLogin(t *testing.T, s *Server) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"password":"csrf-pass"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("登录状态码 %d: %s", rec.Code, rec.Body.String())
	}
	return rec
}

// cookieFrom 按名字取出响应中的 cookie；未找到时失败。
func cookieFrom(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("响应缺少 cookie %q: %v", name, rec.Header().Values("Set-Cookie"))
	return nil
}

// TestLoginSetsCSRFCookie 验证登录同时下发 kore_session 与 kore_csrf，
// 且 kore_csrf 非 HttpOnly、SameSite=Strict、Path=/（缺口1 回归）。
func TestLoginSetsCSRFCookie(t *testing.T) {
	rec := csrfLogin(t, csrfTestServer(t))
	session := cookieFrom(t, rec, auth.CookieName)
	csrf := cookieFrom(t, rec, csrfCookieName)
	if !session.HttpOnly {
		t.Fatal("kore_session 应为 HttpOnly")
	}
	if csrf.HttpOnly {
		t.Fatal("kore_csrf 必须非 HttpOnly（双提交要求前端可读）")
	}
	if csrf.Value == "" || csrf.Value == session.Value {
		t.Fatalf("kore_csrf 应独立随机且与会话不同: session=%q csrf=%q", session.Value, csrf.Value)
	}
	if csrf.Path != "/" {
		t.Fatalf("kore_csrf Path = %q，期望 /", csrf.Path)
	}
	if csrf.SameSite != http.SameSiteStrictMode {
		t.Fatalf("kore_csrf SameSite = %v，期望 Strict", csrf.SameSite)
	}
}

// writeWithCookies 发起一次带会话与可选 csrf cookie/header 的写请求。
func writeWithCookies(t *testing.T, s *Server, session, csrf string, withHeader bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/store/refresh", strings.NewReader(""))
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	if csrf != "" {
		req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrf})
	}
	if withHeader {
		req.Header.Set(csrfHeaderName, csrf)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// TestFirstWriteWithCSRFPasses 验证用登录下发的两个 cookie + 同名 header，
// 首次写请求通过 CSRF 双提交，不再 401（缺口1 核心验收）。
func TestFirstWriteWithCSRFPasses(t *testing.T) {
	s := csrfTestServer(t)
	rec := csrfLogin(t, s)
	session := cookieFrom(t, rec, auth.CookieName).Value
	csrf := cookieFrom(t, rec, csrfCookieName).Value

	got := writeWithCookies(t, s, session, csrf, true).Code
	if got == http.StatusUnauthorized {
		t.Fatalf("带双 cookie 的首次写仍 401（CSRF 缺口未修复）")
	}
	// store 未装配时应 501 E_UNSUPPORTED；关键是 CSRF 已放行。
	if got != http.StatusNotImplemented {
		t.Fatalf("首次写状态码 %d，期望 501（CSRF 放行后由 store 未装配兜底）", got)
	}
}

// TestWriteWithoutCSRFStill401 验证只带会话、不带 csrf（或 header 不匹配）仍 401。
func TestWriteWithoutCSRFStill401(t *testing.T) {
	s := csrfTestServer(t)
	rec := csrfLogin(t, s)
	session := cookieFrom(t, rec, auth.CookieName).Value

	if got := writeWithCookies(t, s, session, "", false).Code; got != http.StatusUnauthorized {
		t.Fatalf("缺 csrf cookie 应 401，实际 %d", got)
	}
	if got := writeWithCookies(t, s, session, "x", false).Code; got != http.StatusUnauthorized {
		t.Fatalf("无 header 应 401，实际 %d", got)
	}
}
