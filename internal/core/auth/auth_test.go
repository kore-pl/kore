package auth_test

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
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
)

// testPassword 是测试用明文口令与哈希。
const testPassword = "correct-horse"

// makeHash 生成 pbkdf2-sha256 存储串（固定 salt，便于重复）。
func makeHash(t *testing.T, password string) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key, err := pbkdf2.Key(sha256.New, password, salt, 1000, 32)
	if err != nil {
		t.Fatalf("派生测试哈希失败: %v", err)
	}
	return "pbkdf2-sha256$1000$" + base64.StdEncoding.EncodeToString(salt) + "$" +
		base64.StdEncoding.EncodeToString(key)
}

// newStore 打开临时状态库并注册清理。
func newStore(t *testing.T) *store.Store {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开测试状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// newServer 构造带鉴权的 httpapi Server。
func newServer(t *testing.T) *httpapi.Server {
	t.Helper()
	mgr := auth.NewManager(newStore(t), makeHash(t, testPassword), 0, false)
	return httpapi.New(httpapi.Options{Auth: mgr}, nil)
}

// request 执行一次带可选 cookie 的请求。
func request(t *testing.T, s *httpapi.Server, method, path, body, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// login 返回登录响应（含 cookie）。
func login(t *testing.T, s *httpapi.Server, password string) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, s, http.MethodPost, "/api/v1/auth/login", `{"username":"admin","password":"`+password+`"}`, "")
}

// cookieValue 从登录响应里取出会话 cookie。
func cookieValue(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.CookieName {
			return c.Value
		}
	}
	t.Fatalf("响应缺少 %s cookie: %v", auth.CookieName, rec.Header())
	return ""
}

// TestCorrectPasswordLogin 验证正确口令登录成功并下发 cookie。
func TestCorrectPasswordLogin(t *testing.T) {
	rec := login(t, newServer(t), testPassword)
	if rec.Code != http.StatusOK {
		t.Fatalf("正确口令登录状态码 = %d，期望 200；body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"authenticated":true`) {
		t.Fatalf("响应体缺少 authenticated:true: %s", rec.Body.String())
	}
	if cookieValue(t, rec) == "" {
		t.Fatal("登录成功但未下发会话 cookie")
	}
}

// TestWrongPassword401 验证错误口令返回 401 E_UNAUTHORIZED。
func TestWrongPassword401(t *testing.T) {
	rec := login(t, newServer(t), "wrong-password")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("错误口令状态码 = %d，期望 401；body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "E_UNAUTHORIZED") {
		t.Fatalf("错误体缺少 E_UNAUTHORIZED: %s", rec.Body.String())
	}
}

// TestNoCookieProtected401 验证无 cookie 访问受保护端点返回 401。
func TestNoCookieProtected401(t *testing.T) {
	s := newServer(t)
	rec := request(t, s, http.MethodGet, "/api/v1/system/info", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 cookie 访问受保护端点状态码 = %d，期望 401；body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "E_UNAUTHORIZED") {
		t.Fatalf("错误体缺少 E_UNAUTHORIZED: %s", rec.Body.String())
	}
}

// TestLogoutThen401 验证登出后原 cookie 再访问受保护端点返回 401。
func TestLogoutThen401(t *testing.T) {
	s := newServer(t)
	cookie := cookieValue(t, login(t, s, testPassword))
	if got := request(t, s, http.MethodGet, "/api/v1/auth/session", "", cookie).Code; got != http.StatusOK {
		t.Fatalf("登录后访问 session 状态码 = %d，期望 200", got)
	}
	logout := request(t, s, http.MethodPost, "/api/v1/auth/logout", "", cookie)
	if logout.Code != http.StatusOK {
		t.Fatalf("登出状态码 = %d，期望 200", logout.Code)
	}
	rec := request(t, s, http.MethodGet, "/api/v1/auth/session", "", cookie)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("登出后访问状态码 = %d，期望 401；body=%s", rec.Code, rec.Body.String())
	}
}
// TestApplyCredentialSnapshot 覆盖 ADR-0055 §5 的 SIGHUP 同步内核：
// 新哈希与 must_change 原子应用；无变化时不报变化（避免每次热更踢全员下线）。
func TestApplyCredentialSnapshot(t *testing.T) {
	db := newStore(t)
	oldHash := makeHash(t, testPassword)
	newHash := makeHash(t, "reset-password-9999")
	mgr := auth.NewManager(db, oldHash, 0, false)
	mgr.SetMustChange(true)

	if !mgr.MustChange() {
		t.Fatal("初始 must_change 应为 true")
	}
	// 无变化：不报变化。
	if mgr.ApplyCredentialSnapshot(oldHash, true) {
		t.Fatal("同哈希同标志不应报告变化")
	}
	// CLI 重置：新哈希 + must_change=true → 报变化并生效。
	if !mgr.ApplyCredentialSnapshot(newHash, true) {
		t.Fatal("新哈希应报告变化")
	}
	if ok, err := mgr.Verify("reset-password-9999"); err != nil || !ok {
		t.Fatalf("SIGHUP 后新口令应可登录: ok=%v err=%v", ok, err)
	}
	if ok, err := mgr.Verify(testPassword); err != nil || ok {
		t.Fatalf("SIGHUP 后旧口令应失效: ok=%v err=%v", ok, err)
	}
	// 在线改密清标志：报变化且生效。
	if !mgr.ApplyCredentialSnapshot(newHash, false) {
		t.Fatal("must_change 清除应报告变化")
	}
	if mgr.MustChange() {
		t.Fatal("改密后 must_change 应为 false")
	}
}

// TestMustChangeIsNotAccessGateViaAuthManager 通过 newServer 验证用户口径
// 2026-11-25：「首次登录请先设置新口令不能是必选项」。must_change 标志只驱动
// 非阻断提示头 X-Kore-Password-Hint，绝不驱动 403 闸门：会话有效即全部业务端点放行。
func TestMustChangeIsNotAccessGateViaAuthManager(t *testing.T) {
	s := newServer(t)
	cookie := cookieValue(t, login(t, s, testPassword))
	if got := request(t, s, http.MethodGet, "/api/v1/auth/session", "", cookie).Code; got != http.StatusOK {
		t.Fatalf("must_change=false 时应放行，实际 %d", got)
	}
	// 直接通过 server.AuthManager 打开标志（模拟 CLI 重置后 SIGHUP 同步）。
	s.AuthManager().SetMustChange(true)
	rec := request(t, s, http.MethodGet, "/api/v1/auth/session", "", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("must_change=true 时业务端点仍应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "首次登录请先设置新口令") {
		t.Fatalf("响应不应含阻断文案，实际 %s", rec.Body.String())
	}
}
