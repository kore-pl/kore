package httpapi

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// passwordTestHash 生成测试哈希（固定 salt、低迭代，测试内专用；生产走 HashPassword）。
func passwordTestHash(t *testing.T, password string) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key, err := pbkdf2.Key(sha256.New, password, salt, 1000, 32)
	if err != nil {
		t.Fatalf("派生测试哈希失败: %v", err)
	}
	return "pbkdf2-sha256$1000$" + base64.StdEncoding.EncodeToString(salt) + "$" +
		base64.StdEncoding.EncodeToString(key)
}

// passwordTestServer 构造带鉴权 + CSRF + 可观测写回的 Server。
// writer 记录写入的 hash（用于断言"新口令 HashPassword 结果被持久化"）。
type passwordTestEnv struct {
	server *Server
	auth   *auth.Manager
	mu     sync.Mutex
	hashes []string // 写回的哈希历史
	fail   bool     // 模拟写回失败
}

func passwordTestServer(t *testing.T, oldPassword string) *passwordTestEnv {
	t.Helper()
	env := &passwordTestEnv{}
	db, err := openTestStore(t)
	if err != nil {
		t.Fatal(err)
	}
	mgr := auth.NewManager(db, passwordTestHash(t, oldPassword), 0, false)
	env.auth = mgr
	env.server = New(Options{
		Auth: mgr,
		PasswordWriter: func(hash string) error {
			env.mu.Lock()
			defer env.mu.Unlock()
			if env.fail {
				return io.ErrClosedPipe
			}
			env.hashes = append(env.hashes, hash)
			return nil
		},
	}, nil)
	return env
}

func openTestStore(t *testing.T) (*store.Store, error) {
	t.Helper()
	return store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// passwordLogin 用给定口令登录，返回 session/csrf cookie；expectOK 控制失败即 fatal。
func passwordLogin(t *testing.T, s *Server, password string, expectOK bool) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"password":"`+password+`"}`)))
	if expectOK && rec.Code != http.StatusOK {
		t.Fatalf("登录应成功，实际 %d: %s", rec.Code, rec.Body.String())
	}
	return rec
}

// passwordChange 发起一次带完整会话 + CSRF 的改口令请求；body 原样传入。
func passwordChange(s *Server, session, csrf, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, authPasswordPath, strings.NewReader(body))
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrf})
	req.Header.Set(csrfHeaderName, csrf)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// parseErrorBody 解析统一错误体。
func parseErrorBody(t *testing.T, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析响应体失败: %v; body=%s", err, rec.Body.String())
	}
	return body
}

// TestMustChangeGateBlocksNonPasswordEndpoints 覆盖 ADR-0055 §4：must_change=true 时，
// 已登录会话访问非改密/登出端点一律 403 + 白话「首次登录请先设置新口令」；
// 改密端点可用，且改密成功后标志清除、旧会话全部失效（单管理员一次性状态机，非 RBAC）。
func TestMustChangeGateBlocksNonPasswordEndpoints(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	env.auth.SetMustChange(true)
	loginRec := passwordLogin(t, env.server, pwOld, true)
	session := sessionCookieFrom(t, loginRec)
	csrf := csrfCookieFrom(t, loginRec)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	rec := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("must_change 下非改密端点应 403，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if body := parseErrorBody(t, rec); !strings.Contains(body.Message, "首次登录请先设置新口令") {
		t.Fatalf("403 文案应为白话首登提示，实际 %q", body.Message)
	}
	// 改密端点可用，且成功后清标志 + 吊销旧会话。
	bodyStr := `{"current_password":"`+pwOld+`","new_password":"`+pwNew+`"}`
	changeRec := passwordChange(env.server, session, csrf, bodyStr)
	if changeRec.Code != http.StatusOK {
		t.Fatalf("must_change 下改密端点应可用，实际 %d: %s", changeRec.Code, changeRec.Body.String())
	}
	if env.auth.MustChange() {
		t.Fatal("改密成功后 must_change 标志未清除")
	}
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	req2.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	rec2 := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("改密后旧会话应失效，实际 %d: %s", rec2.Code, rec2.Body.String())
	}
}

// sessionCookieFrom / csrfCookieFrom 从登录响应里取 cookie 值。
func sessionCookieFrom(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.CookieName { return c.Value }
	}
	t.Fatal("登录响应未下发会话 cookie")
	return ""
}
func csrfCookieFrom(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == csrfCookieName { return c.Value }
	}
	t.Fatal("登录响应未下发 CSRF cookie")
	return ""
}
const (
	pwOld = "old-pass-1234"
	pwNew = "brand-new-pass-9999"
)

// TestChangePasswordWrongCurrentReturns401 旧口令错 → 401 E_UNAUTHORIZED + 固定人话文案，
// 且不回显任何输入（G-30）。
func TestChangePasswordWrongCurrentReturns401(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	login := passwordLogin(t, env.server, pwOld, true)
	session := cookieFrom(t, login, auth.CookieName).Value
	csrf := cookieFrom(t, login, csrfCookieName).Value

	body := `{"current_password":"totally-wrong-pw","new_password":"` + pwNew + `"}`
	rec := passwordChange(env.server, session, csrf, body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("旧口令错应 401，实际 %d: %s", rec.Code, rec.Body.String())
	}
	eb := parseErrorBody(t, rec)
	if eb.Code != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("错误码应 %s，实际 %s", pluginapi.E_UNAUTHORIZED, eb.Code)
	}
	if eb.Message != "当前口令不正确" {
		t.Fatalf("文案应为固定人话「当前口令不正确」，实际 %q", eb.Message)
	}
	if strings.Contains(rec.Body.String(), "totally-wrong-pw") || strings.Contains(rec.Body.String(), pwNew) {
		t.Fatalf("响应体泄漏口令明文（G-30）: %s", rec.Body.String())
	}
	// 失败不应触发写回、不应改变内存哈希。
	env.mu.Lock()
	defer env.mu.Unlock()
	if len(env.hashes) != 0 {
		t.Fatalf("旧口令错不应写回，实际写了 %d 次", len(env.hashes))
	}
}

// TestChangePasswordShortOrSameReturns400 新口令 <12 或 ==旧 → 400 E_INVALID，
// 文案人话且不回显。
func TestChangePasswordShortOrSameReturns400(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	login := passwordLogin(t, env.server, pwOld, true)
	session := cookieFrom(t, login, auth.CookieName).Value
	csrf := cookieFrom(t, login, csrfCookieName).Value

	cases := []struct {
		name string
		body string
	}{
		{"too_short", `{"current_password":"` + pwOld + `","new_password":"short"}`},
		{"same_as_old", `{"current_password":"` + pwOld + `","new_password":"` + pwOld + `"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := passwordChange(env.server, session, csrf, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s 应 400，实际 %d: %s", tc.name, rec.Code, rec.Body.String())
			}
			eb := parseErrorBody(t, rec)
			if eb.Code != pluginapi.E_INVALID {
				t.Fatalf("错误码应 %s，实际 %s", pluginapi.E_INVALID, eb.Code)
			}
			if eb.Message == "" || strings.Contains(eb.Message, pwOld) {
				t.Fatalf("文案应为人话且不回显旧口令，实际 %q", eb.Message)
			}
		})
	}
	env.mu.Lock()
	defer env.mu.Unlock()
	if len(env.hashes) != 0 {
		t.Fatalf("校验失败不应写回，实际写了 %d 次", len(env.hashes))
	}
}

// TestChangePasswordSuccessRevokesAllAndSwitchesHash 成功改口令：
// 写回 HashPassword 结果 + 全局 RevokeAll（旧会话失效）+ 内存基准切换（新口令登录 200）。
func TestChangePasswordSuccessRevokesAllAndSwitchesHash(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	login := passwordLogin(t, env.server, pwOld, true)
	session := cookieFrom(t, login, auth.CookieName).Value
	csrf := cookieFrom(t, login, csrfCookieName).Value

	body := `{"current_password":"` + pwOld + `","new_password":"` + pwNew + `"}`
	rec := passwordChange(env.server, session, csrf, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("改口令应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var okBody sessionBody
	if err := json.Unmarshal(rec.Body.Bytes(), &okBody); err != nil {
		t.Fatalf("解析成功响应失败: %v", err)
	}
	if okBody.Authenticated {
		t.Fatal("成功响应 authenticated 必须为 false")
	}
	// 响应不得回显任何口令（G-30）。
	if strings.Contains(rec.Body.String(), pwOld) || strings.Contains(rec.Body.String(), pwNew) {
		t.Fatalf("响应体泄漏口令明文（G-30）: %s", rec.Body.String())
	}

	// ① 写回的哈希可由新口令 Verify 通过，且不是旧哈希。
	env.mu.Lock()
	written := append([]string(nil), env.hashes...)
	env.mu.Unlock()
	if len(written) != 1 {
		t.Fatalf("应恰好写回 1 次，实际 %d", len(written))
	}
	if ok, err := auth.VerifyPassword(written[0], pwNew); err != nil || !ok {
		t.Fatalf("写回哈希应能校验新口令: ok=%v err=%v", ok, err)
	}
	if ok, _ := auth.VerifyPassword(written[0], pwOld); ok {
		t.Fatal("写回哈希不应匹配旧口令")
	}

	// ② 旧会话立即失效（RevokeAll 生效）——用旧 session 访问受保护端点应 401。
	probe := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	env.server.Handler().ServeHTTP(probe, req)
	if probe.Code != http.StatusUnauthorized {
		t.Fatalf("旧会话应 401，实际 %d: %s", probe.Code, probe.Body.String())
	}

	// ③ 内存基准已切换：新口令登录 200，旧口令登录 401。
	if got := passwordLogin(t, env.server, pwNew, true).Code; got != http.StatusOK {
		t.Fatalf("新口令应能登录，实际 %d", got)
	}
	if got := passwordLogin(t, env.server, pwOld, false).Code; got != http.StatusUnauthorized {
		t.Fatalf("旧口令应无法登录，实际 %d", got)
	}
}

// TestChangePasswordWriterFailureKeepsOldPassword 写回失败时不切换内存基准、
// 不伪造成功（fail-secure）：返回 5xx，旧口令仍可登录。
func TestChangePasswordWriterFailureKeepsOldPassword(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	env.fail = true
	login := passwordLogin(t, env.server, pwOld, true)
	session := cookieFrom(t, login, auth.CookieName).Value
	csrf := cookieFrom(t, login, csrfCookieName).Value

	body := `{"current_password":"` + pwOld + `","new_password":"` + pwNew + `"}`
	rec := passwordChange(env.server, session, csrf, body)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("写回失败应 500，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if got := passwordLogin(t, env.server, pwOld, true).Code; got != http.StatusOK {
		t.Fatalf("写回失败后旧口令仍应可登录，实际 %d", got)
	}
}

// TestChangePasswordRequiresCSRF 无 CSRF 头/ cookie → 401（withCSRF 门口生效，
// password 不在豁免清单）。
func TestChangePasswordRequiresCSRF(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	login := passwordLogin(t, env.server, pwOld, true)
	session := cookieFrom(t, login, auth.CookieName).Value

	req := httptest.NewRequest(http.MethodPost, authPasswordPath,
		strings.NewReader(`{"current_password":"`+pwOld+`","new_password":"`+pwNew+`"}`))
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	// 故意不带 csrf cookie/header。
	rec := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("缺 CSRF 应 401，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// TestChangePasswordRequiresSession 未登录（无会话 cookie）→ 401（withAuth 门口）。
func TestChangePasswordRequiresSession(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	rec := passwordChange(env.server, "", "",
		`{"current_password":"`+pwOld+`","new_password":"`+pwNew+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// TestChangePasswordNoPlaintextInLogs 明文口令不进日志/审计（G-30）：
// 注入记录型审计出口，成功与失败路径各走一遍，检查所有事件不含明文。
func TestChangePasswordNoPlaintextInLogs(t *testing.T) {
	env := passwordTestServer(t, pwOld)
	capture := &pwAuditCapture{}
	env.server.auditRecorder = capture

	login := passwordLogin(t, env.server, pwOld, true)
	session := cookieFrom(t, login, auth.CookieName).Value
	csrf := cookieFrom(t, login, csrfCookieName).Value

	// 成功路径 + 错误口令路径各一次。
	passwordChange(env.server, session, csrf,
		`{"current_password":"`+pwOld+`","new_password":"`+pwNew+`"}`)
	passwordChange(env.server, session, csrf,
		`{"current_password":"wrong-pass-value","new_password":"`+pwNew+`"}`)

	for _, ev := range capture.events {
		blob, _ := json.Marshal(ev)
		if strings.Contains(string(blob), pwOld) || strings.Contains(string(blob), pwNew) ||
			strings.Contains(string(blob), "wrong-pass-value") {
			t.Fatalf("审计事件泄漏口令明文（G-30）: %s", blob)
		}
	}
}

// pwAuditCapture 是测试用审计出口，攒下所有事件供明文泄漏断言。
type pwAuditCapture struct {
	events []AuditEvent
}

func (c *pwAuditCapture) Record(ev AuditEvent) { c.events = append(c.events, ev) }
