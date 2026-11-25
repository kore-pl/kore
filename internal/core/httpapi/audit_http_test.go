package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// recordingAuditRecorder 收集 HTTP 侧审计事件（内存），供断言 action/result/detail。
type recordingAuditRecorder struct {
	mu     sync.Mutex
	events []AuditEvent
}

func (r *recordingAuditRecorder) Record(ev AuditEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	detail := make(map[string]string, len(ev.Detail))
	for k, v := range ev.Detail {
		detail[k] = v
	}
	ev.Detail = detail
	r.events = append(r.events, ev)
}

func (r *recordingAuditRecorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = nil
}

func (r *recordingAuditRecorder) snapshot() []AuditEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]AuditEvent(nil), r.events...)
}

func (r *recordingAuditRecorder) byAction(action string) []AuditEvent {
	var out []AuditEvent
	for _, ev := range r.snapshot() {
		if ev.Action == action {
			out = append(out, ev)
		}
	}
	return out
}

// newAuditHTTPServer 组装带真实 auth + 内存审计出口的 Server；caps 决定插件能力分级。
func newAuditHTTPServer(t *testing.T, caps map[string][]string, tweak func(*Server)) (*Server, *recordingAuditRecorder, *capDeclBackend) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	backend := &capDeclBackend{caps: caps}
	recorder := &recordingAuditRecorder{}
	srv := New(Options{
		Version: "0.1.0-audit-http", Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: backend, Auth: auth.NewManager(db, auditHash(t), 0, false),
		CapabilityResolver: capFullAdminResolver,
		AuditRecorder:      recorder,
		// 放宽登录限速：审计测试要连续制造失败，不被 429 提前截断。
		LoginLimiter: auth.NewLoginLimiter(1000, time.Minute, time.Minute),
	}, nil)
	if tweak != nil {
		tweak(srv)
	}
	return srv, recorder, backend
}

// auditLoginRequest 发一次登录请求（固定来源 IP 与 UA，验证脱敏与截断）。
func auditLoginRequest(t *testing.T, srv *Server, password string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"username":"admin","password":%q}`, password)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
	req.RemoteAddr = "192.168.1.100:54321"
	req.Header.Set("User-Agent", "audit-test-agent")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// auditLoginWithCaptcha 取一次验证码并带答案发登录请求（挑战态下的真链路）。
func auditLoginWithCaptcha(t *testing.T, srv *Server, password string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/captcha", nil))
	var body captchaBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var a, b int
	if _, err := fmt.Sscanf(body.TextQuestion, "%d + %d = ?", &a, &b); err != nil {
		t.Fatal(err)
	}
	payload := fmt.Sprintf(`{"username":"admin","password":%q,"captcha_id":%q,"captcha_answer":"%d"}`, password, body.ID, a+b)
	out := httptest.NewRecorder()
	srv.Handler().ServeHTTP(out, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(payload)))
	return out
}

// auditLoginCookies 登录并取会话/CSRF cookie；失败即终止用例。
func auditLoginCookies(t *testing.T, srv *Server) (string, string) {
	t.Helper()
	rec := auditLoginRequest(t, srv, "audit-password")
	if rec.Code != http.StatusOK {
		t.Fatalf("登录应 200，实际 %d body=%s", rec.Code, rec.Body.String())
	}
	session, csrf := "", ""
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case auth.CookieName:
			session = c.Value
		case csrfCookieName:
			csrf = c.Value
		}
	}
	if session == "" || csrf == "" {
		t.Fatalf("登录未下发 session/csrf cookie（session=%q csrf=%q）", session, csrf)
	}
	return session, csrf
}

// auditInvokeRequest 发一次 invoke（带会话与 CSRF 双提交）。
func auditInvokeRequest(t *testing.T, srv *Server, session, csrf, plugin, method string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/invoke/"+plugin+"/"+method, strings.NewReader(`{}`))
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrf})
	req.Header.Set(csrfHeaderName, csrf)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// TestLoginAuditSuccess 登录成功写 1 条 login.success，detail 含脱敏 IP、UA 与 session 前缀。
func TestLoginAuditSuccess(t *testing.T) {
	srv, recorder, _ := newAuditHTTPServer(t, nil, nil)
	rec := auditLoginRequest(t, srv, "audit-password")
	if rec.Code != http.StatusOK {
		t.Fatalf("登录应 200，实际 %d", rec.Code)
	}
	events := recorder.byAction(auditActionLoginSuccess)
	if len(events) != 1 {
		t.Fatalf("应写 1 条 login.success，实际 %d（events=%+v）", len(events), recorder.snapshot())
	}
	ev := events[0]
	if ev.Result != auditResultOK || ev.Subject != loginRateKey {
		t.Fatalf("login.success 字段不符: %+v", ev)
	}
	if ev.Detail["ip"] != "192.168.1.x" {
		t.Errorf("IP 应脱敏为 192.168.1.x，实际 %q", ev.Detail["ip"])
	}
	if ev.Detail["user_agent"] != "audit-test-agent" {
		t.Errorf("user_agent 原文不符: %q", ev.Detail["user_agent"])
	}
	if got := ev.Detail["session_id_prefix"]; len(got) != sessionPrefixLen {
		t.Errorf("session_id_prefix 应为 %d 字符，实际 %q（%d）", sessionPrefixLen, got, len(got))
	}
	assertNoPassword(t, ev)
	if recorder.byAction(auditActionLoginFailed) != nil {
		t.Fatal("成功登录不应写 login.failed")
	}
}

// TestLoginAuditFailedWrongPassword 错口令写 1 条 login.failed，reason=wrong_password 且不含口令。
func TestLoginAuditFailedWrongPassword(t *testing.T) {
	srv, recorder, _ := newAuditHTTPServer(t, nil, nil)
	rec := auditLoginRequest(t, srv, "wrong-password")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("错口令应 401，实际 %d", rec.Code)
	}
	events := recorder.byAction(auditActionLoginFailed)
	if len(events) != 1 {
		t.Fatalf("应写 1 条 login.failed，实际 %d", len(events))
	}
	ev := events[0]
	if ev.Result != auditResultDenied || ev.Detail["reason"] != "wrong_password" {
		t.Fatalf("login.failed 字段不符: %+v", ev)
	}
	if ev.Detail["ip"] != "192.168.1.x" {
		t.Errorf("IP 未脱敏: %q", ev.Detail["ip"])
	}
	assertNoPassword(t, ev)
}

// TestLoginAuditRateLimited 惩罚模式下的错口令写 login.failed reason=rate_limited，
// 且正确口令不受影响（P1 DoS 修复：不再有"锁定期内连正确口令也拒"的硬锁）。
func TestLoginAuditRateLimited(t *testing.T) {
	srv, recorder, _ := newAuditHTTPServer(t, nil, func(s *Server) {
		s.loginLimiter = auth.NewLoginLimiter(1, time.Minute, time.Minute)
	})
	if rec := auditLoginRequest(t, srv, "wrong-password"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("第 1 次错口令应 401，实际 %d", rec.Code)
	}
	recorder.reset()
	// max=1：第 2 次错口令进入惩罚模式，1s 延迟后 429 并记 rate_limited。
	if rec := auditLoginWithCaptcha(t, srv, "wrong-password"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("惩罚模式下错口令应 429 E_RATELIMIT，实际 %d", rec.Code)
	}
	events := recorder.byAction(auditActionLoginFailed)
	if len(events) != 1 || events[0].Detail["reason"] != "rate_limited" {
		t.Fatalf("应写 1 条 reason=rate_limited 的 login.failed，实际 %+v", events)
	}
	assertNoPassword(t, events[0])
	// 正确口令在惩罚期间仍能登录：错口令不能把管理员锁死。
	if rec := auditLoginWithCaptcha(t, srv, "audit-password"); rec.Code != http.StatusOK {
		t.Fatalf("惩罚期间正确口令应 200，实际 %d", rec.Code)
	}
}

// assertNoPassword 断言审计事件任何字段都不包含测试口令。
func assertNoPassword(t *testing.T, ev AuditEvent) {
	t.Helper()
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("序列化审计事件失败: %v", err)
	}
	for _, secret := range []string{"audit-password", "wrong-password"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("审计事件泄露口令 %q: %s", secret, raw)
		}
	}
}

// TestReadOnlyInvokeNotAudited 只声明 system:read 的插件（只读类）invoke 不写审计。
func TestReadOnlyInvokeNotAudited(t *testing.T) {
	srv, recorder, _ := newAuditHTTPServer(t, map[string][]string{"echo": {"system:read"}}, nil)
	session, csrf := auditLoginCookies(t, srv)
	recorder.reset()
	rec := auditInvokeRequest(t, srv, session, csrf, "echo", "echo.echo")
	if rec.Code != http.StatusOK {
		t.Fatalf("只读 invoke 应 200，实际 %d body=%s", rec.Code, rec.Body.String())
	}
	if got := recorder.snapshot(); len(got) != 0 {
		t.Fatalf("只读 invoke 不应写审计，实际 %+v", got)
	}
}

// TestWriteInvokeAudited 声明 system:admin 的插件（写/管理类）invoke 写 invoke.* 审计。
func TestWriteInvokeAudited(t *testing.T) {
	srv, recorder, _ := newAuditHTTPServer(t, map[string][]string{"db-mysql": {"system:admin"}}, nil)
	session, csrf := auditLoginCookies(t, srv)
	recorder.reset()
	rec := auditInvokeRequest(t, srv, session, csrf, "db-mysql", "db-mysql.createDatabase")
	if rec.Code != http.StatusOK {
		t.Fatalf("写 invoke 应 200，实际 %d body=%s", rec.Code, rec.Body.String())
	}
	wantAction := "invoke.db-mysql.db-mysql.createDatabase"
	events := recorder.byAction(wantAction)
	if len(events) != 1 {
		t.Fatalf("应写 1 条 %s，实际 %+v", wantAction, recorder.snapshot())
	}
	ev := events[0]
	if ev.Result != auditResultOK || ev.Subject != "admin" || ev.Plugin != "db-mysql" ||
		ev.Target != "db-mysql/db-mysql.createDatabase" {
		t.Fatalf("invoke 审计字段不符: %+v", ev)
	}
	if _, ok := ev.Detail["duration_ms"]; !ok {
		t.Errorf("detail 应含 duration_ms: %+v", ev.Detail)
	}
	if _, ok := ev.Detail["error_code"]; ok {
		t.Errorf("成功调用不应带 error_code: %+v", ev.Detail)
	}
}

// errInvokeBackend 让 invoke 返回协议错误，验证 result=error + error_code。
type errInvokeBackend struct{ *capDeclBackend }

func (b *errInvokeBackend) Invoke(context.Context, string, string, json.RawMessage, string) (json.RawMessage, error) {
	return nil, &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "方法不存在"}
}

// TestWriteInvokeAuditErrorIncludesCode 失败调用写 result=error 且 detail 带 error_code。
func TestWriteInvokeAuditErrorIncludesCode(t *testing.T) {
	srv, recorder, backend := newAuditHTTPServer(t, map[string][]string{"db-mysql": {"system:admin"}}, nil)
	srv.opts.Backend = &errInvokeBackend{capDeclBackend: backend}
	session, csrf := auditLoginCookies(t, srv)
	recorder.reset()
	rec := auditInvokeRequest(t, srv, session, csrf, "db-mysql", "db-mysql.dropDatabase")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("协议错误应映射 404，实际 %d body=%s", rec.Code, rec.Body.String())
	}
	events := recorder.byAction("invoke.db-mysql.db-mysql.dropDatabase")
	if len(events) != 1 || events[0].Result != auditResultError {
		t.Fatalf("应写 1 条 result=error 的 invoke 审计，实际 %+v", events)
	}
	if events[0].Detail["error_code"] != pluginapi.E_NOTFOUND {
		t.Errorf("error_code 应为 %s，实际 %q", pluginapi.E_NOTFOUND, events[0].Detail["error_code"])
	}
}

// TestInvokeBurstMerged 同一方法 1s 内 12 次：10 条逐条 + 1 条 invoke.burst，后续抑制。
func TestInvokeBurstMerged(t *testing.T) {
	frozen := time.Unix(1_700_000_000, 0)
	srv, recorder, _ := newAuditHTTPServer(t, map[string][]string{"db-mysql": {"system:admin"}}, func(s *Server) {
		s.now = func() time.Time { return frozen }
	})
	session, csrf := auditLoginCookies(t, srv)
	recorder.reset()
	for i := 0; i < 12; i++ {
		if rec := auditInvokeRequest(t, srv, session, csrf, "db-mysql", "db-mysql.createDatabase"); rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次 invoke 应 200，实际 %d", i+1, rec.Code)
		}
	}
	snapshot := recorder.snapshot()
	normal := recorder.byAction("invoke.db-mysql.db-mysql.createDatabase")
	burst := recorder.byAction(auditActionInvokeBurst)
	if len(normal) != invokeBurstThreshold {
		t.Fatalf("阈值内应逐条审计 %d 条，实际 %d（全部事件 %+v）", invokeBurstThreshold, len(normal), snapshot)
	}
	if len(burst) != 1 {
		t.Fatalf("超阈值应合并为 1 条 invoke.burst，实际 %d（全部事件 %+v）", len(burst), snapshot)
	}
	if len(snapshot) != invokeBurstThreshold+1 {
		t.Fatalf("审计总数应为 %d，实际 %d（后续调用必须被抑制）", invokeBurstThreshold+1, len(snapshot))
	}
	ev := burst[0]
	if ev.Detail["method"] != "db-mysql.createDatabase" {
		t.Errorf("burst.detail.method 不符: %q", ev.Detail["method"])
	}
	if ev.Detail["count"] != "11" {
		t.Errorf("burst.detail.count 应为 11，实际 %q", ev.Detail["count"])
	}
	if ev.Detail["window_ms"] != "1000" {
		t.Errorf("burst.detail.window_ms 应为 1000，实际 %q", ev.Detail["window_ms"])
	}
}

// TestInvokeAllAuditsReadOnly audit.invoke_all=true 时只读方法也写审计（调试开关）。
func TestInvokeAllAuditsReadOnly(t *testing.T) {
	srv, recorder, _ := newAuditHTTPServer(t, map[string][]string{"echo": {"system:read"}}, func(s *Server) {
		s.ApplyAuditInvokeAll(true)
	})
	session, csrf := auditLoginCookies(t, srv)
	recorder.reset()
	if rec := auditInvokeRequest(t, srv, session, csrf, "echo", "echo.echo"); rec.Code != http.StatusOK {
		t.Fatalf("只读 invoke 应 200，实际 %d", rec.Code)
	}
	events := recorder.byAction("invoke.echo.echo.echo")
	if len(events) != 1 {
		t.Fatalf("invoke_all=true 应审计只读方法，实际 %+v", recorder.snapshot())
	}
}

// TestMaskIPAndUserAgent 脱敏与截断的边界口径。
func TestMaskIPAndUserAgent(t *testing.T) {
	cases := []struct{ in, want string }{
		{"192.168.1.100", "192.168.1.x"},
		{"10.0.0.1", "10.0.0.x"},
		{"127.0.0.1", "127.0.0.x"},
		{"not-an-ip", "not-an-ip"},
		{"@", "@"},
	}
	for _, c := range cases {
		if got := maskIP(c.in); got != c.want {
			t.Errorf("maskIP(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
	if got := clientHost("192.168.1.100:54321"); got != "192.168.1.100" {
		t.Errorf("clientHost 未剥离端口: %q", got)
	}
	long := strings.Repeat("a", userAgentMaxLen+50)
	if got := truncateUserAgent(long); len([]rune(got)) != userAgentMaxLen {
		t.Errorf("UA 应截断到 %d 字符，实际 %d", userAgentMaxLen, len([]rune(got)))
	}
	if got := sessionIDPrefix("0123456789abcdef"); got != "01234567" {
		t.Errorf("sessionIDPrefix = %q，期望 01234567", got)
	}
}

// TestInvokeBurstWindowRollover 窗口滚过后重新逐条审计（计数不跨窗口累积）。
func TestInvokeBurstWindowRollover(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	srv, recorder, _ := newAuditHTTPServer(t, map[string][]string{"db-mysql": {"system:admin"}}, func(s *Server) {
		s.now = func() time.Time { return now }
	})
	session, csrf := auditLoginCookies(t, srv)
	recorder.reset()
	for i := 0; i < invokeBurstThreshold+1; i++ {
		auditInvokeRequest(t, srv, session, csrf, "db-mysql", "db-mysql.createDatabase")
	}
	if got := len(recorder.byAction(auditActionInvokeBurst)); got != 1 {
		t.Fatalf("首个窗口应有 1 条 burst，实际 %d", got)
	}
	now = now.Add(2 * invokeBurstWindow)
	recorder.reset()
	if rec := auditInvokeRequest(t, srv, session, csrf, "db-mysql", "db-mysql.createDatabase"); rec.Code != http.StatusOK {
		t.Fatalf("窗口滚动后 invoke 应 200，实际 %d", rec.Code)
	}
	if got := len(recorder.byAction("invoke.db-mysql.db-mysql.createDatabase")); got != 1 {
		t.Fatalf("新窗口应重新逐条审计 1 条，实际 %d（%+v）", got, recorder.snapshot())
	}
}
