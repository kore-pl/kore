package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// localCSRFCookie 从响应里取 kore_csrf 的值；不存在返回空串。
func localCSRFCookie(rec *httptest.ResponseRecorder) string {
	for _, c := range rec.Result().Cookies() {
		if c.Name == csrfCookieName {
			return c.Value
		}
	}
	return ""
}

// TestLocalGETBootstrapsCSRF 覆盖 P0 回归：本机免密不经过登录，幂等请求必须
// 补发 kore_csrf，否则面板所有数据视图的 POST 都会被 CSRF 401 拦下。
func TestLocalGETBootstrapsCSRF(t *testing.T) {
	for _, tc := range []struct {
		name       string
		remoteAddr string
	}{
		{"loopback", "127.0.0.1:5555"},
		{"uds", "@"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newLocalTestServer(t, time.Hour)
			req := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
			req.RemoteAddr = tc.remoteAddr
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("本机 GET 应 200，实际 %d: %s", rec.Code, rec.Body.String())
			}
			token := localCSRFCookie(rec)
			if token == "" {
				t.Fatalf("本机 GET 未下发 %s: %v", csrfCookieName, rec.Header().Values("Set-Cookie"))
			}
			// 属性约定：非 HttpOnly（前端要读）、SameSite=Strict、Path=/。
			for _, c := range rec.Result().Cookies() {
				if c.Name != csrfCookieName {
					continue
				}
				if c.HttpOnly {
					t.Fatal("kore_csrf 不能是 HttpOnly（双提交要求前端可读）")
				}
				if c.SameSite != http.SameSiteStrictMode {
					t.Fatalf("kore_csrf 应 SameSite=Strict，实际 %v", c.SameSite)
				}
				if c.Path != "/" {
					t.Fatalf("kore_csrf 应 Path=/，实际 %q", c.Path)
				}
			}
		})
	}
}

// TestLocalCSRFStillBlocksForgedPost 证明补发令牌没有削弱 CSRF：
// 无 token / 错 token / 只带 cookie 不带头的跨站伪造 POST 一律 401。
func TestLocalCSRFStillBlocksForgedPost(t *testing.T) {
	srv := newLocalTestServer(t, time.Hour)

	// 先 GET 拿一个真实令牌（模拟面板首次加载）。
	boot := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
	boot.RemoteAddr = "127.0.0.1:5555"
	bootRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(bootRec, boot)
	token := localCSRFCookie(bootRec)
	if token == "" {
		t.Fatal("前置失败：本机 GET 未下发 CSRF 令牌")
	}

	forged := []struct {
		name  string
		setup func(*http.Request)
	}{
		{"无 cookie 无头", func(*http.Request) {}},
		{"只带 cookie 不带头", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: csrfCookieName, Value: token})
		}},
		{"只带头不带 cookie", func(r *http.Request) {
			r.Header.Set(csrfHeaderName, token)
		}},
		{"头与 cookie 不一致", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: csrfCookieName, Value: token})
			r.Header.Set(csrfHeaderName, token+"-wrong")
		}},
	}
	for _, tc := range forged {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/echo/enable", strings.NewReader("{}"))
			req.RemoteAddr = "127.0.0.1:5555"
			req.Header.Set("Origin", "http://evil.example")
			tc.setup(req)
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("伪造 POST 应 401，实际 %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "CSRF") {
				t.Fatalf("401 应来自 CSRF 校验，实际 %s", rec.Body.String())
			}
		})
	}

	// 正确双提交（cookie == 头）才放行到业务层。
	ok := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/echo/enable", strings.NewReader("{}"))
	ok.RemoteAddr = "127.0.0.1:5555"
	ok.AddCookie(&http.Cookie{Name: csrfCookieName, Value: token})
	ok.Header.Set(csrfHeaderName, token)
	okRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(okRec, ok)
	if okRec.Code == http.StatusUnauthorized && strings.Contains(okRec.Body.String(), "CSRF") {
		t.Fatalf("正确双提交不应被 CSRF 拦下: %s", okRec.Body.String())
	}
}

// TestRemoteDoesNotGetLocalToken 锁定边界：非本机请求不下发令牌，且即便带着
// 令牌和头，远程仍必须凭会话——CSRF 不是远程的认证替代品。
func TestRemoteDoesNotGetLocalToken(t *testing.T) {
	srv := newLocalTestServer(t, time.Hour)

	// 先在本机拿到真实令牌，模拟"攻击者抄到了令牌"。
	boot := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
	boot.RemoteAddr = "127.0.0.1:5555"
	bootRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(bootRec, boot)
	token := localCSRFCookie(bootRec)
	if token == "" {
		t.Fatal("前置失败：本机 GET 未下发 CSRF 令牌")
	}

	// 远程 GET 不得下发 kore_csrf。
	remoteGet := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
	remoteGet.RemoteAddr = "203.0.113.9:5555"
	remoteRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(remoteRec, remoteGet)
	if remoteRec.Code != http.StatusUnauthorized {
		t.Fatalf("远程未登录 GET 应 401，实际 %d", remoteRec.Code)
	}
	if got := localCSRFCookie(remoteRec); got != "" {
		t.Fatalf("远程请求不应获得 kore_csrf，实际 %q", got)
	}

	// 远程即使带有效双提交，也仍需会话：withAuth 必须回 401（非 CSRF 原因）。
	remotePost := httptest.NewRequest(http.MethodPost, "/api/v1/plugins/echo/enable", strings.NewReader("{}"))
	remotePost.RemoteAddr = "203.0.113.9:5555"
	remotePost.AddCookie(&http.Cookie{Name: csrfCookieName, Value: token})
	remotePost.Header.Set(csrfHeaderName, token)
	remotePostRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(remotePostRec, remotePost)
	if remotePostRec.Code != http.StatusUnauthorized {
		t.Fatalf("远程无会话 POST 应 401，实际 %d: %s", remotePostRec.Code, remotePostRec.Body.String())
	}
	if strings.Contains(remotePostRec.Body.String(), "CSRF") {
		t.Fatalf("远程 401 应来自会话鉴权而非 CSRF: %s", remotePostRec.Body.String())
	}
}
