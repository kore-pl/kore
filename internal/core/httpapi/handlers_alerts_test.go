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
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/metrics"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fakeAlertSink 是 AlertSink 的内存实现（测试端点与埋点）。
type fakeAlertSink struct {
	records []AlertView
	unread  int
	seenErr error
	seq     int
}

func (f *fakeAlertSink) PutAlert(severity, source, title, detail string) (AlertView, error) {
	f.seq++
	rec := AlertView{
		ID: fmt.Sprintf("%020d-000000", f.seq), Ts: "2026-11-23T00:00:00Z",
		Severity: severity, Source: source, Title: title, Detail: detail,
	}
	f.records = append(f.records, rec)
	f.unread++
	return rec, nil
}

func (f *fakeAlertSink) ListAlerts(q AlertQuery) ([]AlertView, int, error) {
	// 接口契约：按时间倒序（最新在前）返回。
	all := make([]AlertView, 0, len(f.records))
	for i := len(f.records) - 1; i >= 0; i-- {
		all = append(all, f.records[i])
	}
	out := make([]AlertView, 0)
	for _, rec := range all {
		if q.Severity != "" && rec.Severity != q.Severity {
			continue
		}
		if q.Limit > 0 && len(out) >= q.Limit {
			break
		}
		out = append(out, rec)
	}
	return out, f.unread, nil
}

func (f *fakeAlertSink) MarkAlertSeen(id string) error {
	if f.seenErr != nil {
		return f.seenErr
	}
	for i := range f.records {
		if f.records[i].ID == id && !f.records[i].Seen {
			f.records[i].Seen = true
			f.unread--
		}
	}
	return nil
}

// alertsAuthServer 构造带鉴权 + 可控 resolver + fake sink 的 Server，登录拿
// 会话与 CSRF cookie（写请求需双提交头）。
func alertsAuthServer(t *testing.T, resolver CapabilityResolver, sink *fakeAlertSink) (*Server, string, string) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := New(Options{
		Auth:               auth.NewManager(db, auditHash(t), 0, false),
		CapabilityResolver: resolver,
		Alerts:             sink,
	}, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"audit-password"}`)))
	var session, csrf string
	for _, v := range rec.Result().Cookies() {
		switch v.Name {
		case auth.CookieName:
			session = v.Value
		case csrfCookieName:
			csrf = v.Value
		}
	}
	if session == "" || csrf == "" {
		t.Fatalf("登录未签发会话/CSRF cookie")
	}
	return srv, session, csrf
}

// alertsRequest 发一次请求：session cookie 必带，csrf 非空时加双提交头。
func alertsRequest(t *testing.T, s *Server, method, path, session, csrf string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	if session != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	}
	if csrf != "" {
		req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrf})
		req.Header.Set(csrfHeaderName, csrf)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

// TestAlertsEndpointsNotWired501 验证未装配 AlertSink 时三个端点都回 501。
func TestAlertsEndpointsNotWired501(t *testing.T) {
	s := newTestServer()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/alerts"},
		{http.MethodPost, "/api/v1/alerts"},
		{http.MethodPost, "/api/v1/alerts/x/seen"},
	} {
		rec := serve(t, s, tc.method, tc.path)
		if rec.Code != http.StatusNotImplemented {
			t.Fatalf("%s %s 状态码 = %d，期望 501", tc.method, tc.path, rec.Code)
		}
	}
}

// TestAlertsListCapabilities 验证列表需 system:read（低权 401，授权 200）。
func TestAlertsListCapabilities(t *testing.T) {
	sink := &fakeAlertSink{}
	lowSrv, lowSession, _ := alertsAuthServer(t, siteOnlyResolver, sink)
	rec := alertsRequest(t, lowSrv, http.MethodGet, "/api/v1/alerts", lowSession, "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("低权应 401，实际 %d", rec.Code)
	}
	srv, session, _ := alertsAuthServer(t, adminResolver, sink)
	rec = alertsRequest(t, srv, http.MethodGet, "/api/v1/alerts", session, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("授权列表应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// TestAlertsListBody 验证列表字段：倒序、unread 全局计数、limit 生效。
func TestAlertsListBody(t *testing.T) {
	sink := &fakeAlertSink{}
	_, _ = sink.PutAlert(alertSeverityWarning, alertSourceSlot, "常驻槽位已满（3 / 3）", "")
	_, _ = sink.PutAlert(alertSeverityCritical, alertSourceAudit, "能力校验被拒绝", "")
	srv, session, _ := alertsAuthServer(t, adminResolver, sink)
	rec := alertsRequest(t, srv, http.MethodGet, "/api/v1/alerts?limit=1", session, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("列表状态码 = %d: %s", rec.Code, rec.Body.String())
	}
	var body alertsListBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if body.Count != 1 || body.Unread != 2 || body.Limit != 1 || len(body.Alerts) != 1 {
		t.Fatalf("列表字段异常: %+v", body)
	}
	if body.Alerts[0].Title != "能力校验被拒绝" {
		t.Fatalf("应最新在前: %+v", body.Alerts[0])
	}
	// severity 过滤：只回匹配记录，unread 仍是全局数。
	rec = alertsRequest(t, srv, http.MethodGet, "/api/v1/alerts?severity=warning", session, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("过滤列表状态码 = %d", rec.Code)
	}
	body = alertsListBody{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Count != 1 || body.Alerts[0].Severity != alertSeverityWarning || body.Unread != 2 {
		t.Fatalf("severity 过滤异常: %+v", body)
	}
}

// TestAlertsWriteValidates 验证写入端点的词表/长度校验与成功回显。
func TestAlertsWriteValidates(t *testing.T) {
	sink := &fakeAlertSink{}
	srv, session, csrf := alertsAuthServer(t, adminResolver, sink)
	cases := []struct {
		name string
		body string
		want int
	}{
		{"severity 非法", `{"severity":"high","source":"audit","title":"t"}`, http.StatusBadRequest},
		{"source 非法", `{"severity":"info","source":"web","title":"t"}`, http.StatusBadRequest},
		{"title 为空", `{"severity":"info","source":"audit","title":""}`, http.StatusBadRequest},
		{"成功", `{"severity":"warning","source":"slot","title":"常驻槽位已满","detail":"d"}`, http.StatusOK},
	}
	for _, tc := range cases {
		rec := alertsRequest(t, srv, http.MethodPost, "/api/v1/alerts", session, csrf,
			strings.NewReader(tc.body))
		if rec.Code != tc.want {
			t.Fatalf("%s：状态码 = %d，期望 %d（%s）", tc.name, rec.Code, tc.want, rec.Body.String())
		}
	}
	if len(sink.records) != 1 || sink.records[0].Source != alertSourceSlot {
		t.Fatalf("仅成功用例应落一条: %+v", sink.records)
	}
}

// TestAlertsSeen404 验证未知 id 回 404（不伪装成功）。
func TestAlertsSeen404(t *testing.T) {
	sink := &fakeAlertSink{seenErr: &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "告警不存在"}}
	srv, session, csrf := alertsAuthServer(t, adminResolver, sink)
	rec := alertsRequest(t, srv, http.MethodPost, "/api/v1/alerts/nope/seen", session, csrf,
		strings.NewReader(""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", rec.Code)
	}
}

// TestAlertsSeenMarksUnread 验证标记已读降低未读数。
func TestAlertsSeenMarksUnread(t *testing.T) {
	sink := &fakeAlertSink{}
	id, _ := sink.PutAlert(alertSeverityWarning, alertSourceSlot, "常驻槽位已满", "")
	srv, session, csrf := alertsAuthServer(t, adminResolver, sink)
	rec := alertsRequest(t, srv, http.MethodPost, "/api/v1/alerts/"+id.ID+"/seen", session, csrf,
		strings.NewReader(""))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d: %s", rec.Code, rec.Body.String())
	}
	if _, unread, _ := sink.ListAlerts(AlertQuery{}); unread != 0 {
		t.Fatalf("已读后未读应为 0，实际 %d", unread)
	}
}

// TestLoginStreakAlert 验证 login.failed 连续 ≥3 次合并一条；成功登录清零。
func TestLoginStreakAlert(t *testing.T) {
	sink := &fakeAlertSink{}
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	caps := auth.NewCaptchaStore()
	srv := New(Options{
		Auth: auth.NewManager(db, auditHash(t), 0, false), Alerts: sink, Captchas: caps,
	}, nil)
	tryLogin := func(password string) {
		t.Helper()
		body := `{"username":"admin","password":"` + password + `"}`
		if caps.Required() {
			capRec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(capRec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/captcha", nil))
			var ch captchaBody
			if err := json.Unmarshal(capRec.Body.Bytes(), &ch); err != nil {
				t.Fatal(err)
			}
			var a, b int
			if _, err := fmt.Sscanf(ch.TextQuestion, "%d + %d = ?", &a, &b); err != nil {
				t.Fatal(err)
			}
			body = fmt.Sprintf(`{"username":"admin","password":%q,"captcha_id":%q,"captcha_answer":"%d"}`, password, ch.ID, a+b)
		}
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
			"/api/v1/auth/login", strings.NewReader(body)))
		_ = rec
	}
	tryLogin("wrong")
	tryLogin("wrong")
	if len(sink.records) != 0 {
		t.Fatalf("连续 2 次不应触发告警，实际 %d 条", len(sink.records))
	}
	tryLogin("wrong")
	if len(sink.records) != 1 || sink.records[0].Severity != alertSeverityCritical ||
		sink.records[0].Source != alertSourceAudit {
		t.Fatalf("连续 3 次应触发一条 critical/audit 告警: %+v", sink.records)
	}
	// 计数归零后重新累计满 3 次：再次触发（持久层 5 分钟窗口负责合并成 count）。
	tryLogin("wrong")
	tryLogin("wrong")
	tryLogin("wrong")
	if len(sink.records) != 2 {
		t.Fatalf("重新累计满 3 次应再触发一条，实际 %d 条", len(sink.records))
	}
	// 成功登录清零：再 2 次失败不触发。
	tryLogin("audit-password")
	tryLogin("wrong")
	tryLogin("wrong")
	if n := len(sink.records); n != 2 {
		t.Fatalf("成功登录清零后不应触发告警，实际 %d 条", n)
	}
}

// TestDeniedAlertHook 验证能力拒绝（auditDenied 出口）写一条 critical 告警。
func TestDeniedAlertHook(t *testing.T) {
	sink := &fakeAlertSink{}
	srv, session, _ := alertsAuthServer(t, siteOnlyResolver, sink)
	// siteOnlyResolver 无 system:read：GET /audit 在审计查询前即被拒并走 auditDenied。
	rec := alertsRequest(t, srv, http.MethodGet, "/api/v1/audit?since=2026-11-23T00:00:00Z", session, "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("越权应 401，实际 %d", rec.Code)
	}
	if len(sink.records) != 1 || sink.records[0].Source != alertSourceAudit ||
		sink.records[0].Title != "能力校验被拒绝" {
		t.Fatalf("拒绝应产生一条告警: %+v", sink.records)
	}
}

// TestPluginAlerts 验证 GET /plugins 对 failed / restarts>3 的埋点。
func TestPluginAlerts(t *testing.T) {
	sink := &fakeAlertSink{}
	s := newTestServer()
	s.opts.Backend = versionBackend{plugins: []PluginStatus{
		{ID: "bad", Name: "坏插件", State: "failed", Restarts: 1},
		{ID: "flap", Name: "抖插件", State: "ready", Restarts: 5},
		{ID: "ok", Name: "好插件", State: "ready", Restarts: 0},
	}}
	s.alerts = sink
	rec := serve(t, s, http.MethodGet, "/api/v1/plugins")
	if rec.Code != http.StatusOK {
		t.Fatalf("插件列表状态码 = %d", rec.Code)
	}
	if len(sink.records) != 2 {
		t.Fatalf("应产生 2 条告警，实际 %d: %+v", len(sink.records), sink.records)
	}
	if sink.records[0].Severity != alertSeverityCritical || sink.records[1].Severity != alertSeverityWarning {
		t.Fatalf("severity 不符: %+v", sink.records)
	}
}

// TestMetricsRedlineAlert 验证 RSS>16 MiB / goroutine>20 的红线埋点。
func TestMetricsRedlineAlert(t *testing.T) {
	sink := &fakeAlertSink{}
	s := newTestServer()
	s.metrics = fakeMetricsCollector{snap: metrics.Snapshot{RSSKiB: 16 * 1024, Goroutines: 25, FDs: 10}}
	s.alerts = sink
	rec := serve(t, s, http.MethodGet, "/api/v1/system/metrics")
	if rec.Code != http.StatusOK {
		t.Fatalf("采样状态码 = %d", rec.Code)
	}
	// RSS 恰好等于红线不触发（>），goroutine 25 > 20 触发。
	if len(sink.records) != 1 || sink.records[0].Source != alertSourceResource {
		t.Fatalf("应仅 goroutine 触发一条 resource 告警: %+v", sink.records)
	}
	s.metrics = fakeMetricsCollector{snap: metrics.Snapshot{RSSKiB: 16*1024 + 1, Goroutines: 5, FDs: 10}}
	rec = serve(t, s, http.MethodGet, "/api/v1/system/metrics")
	if rec.Code != http.StatusOK {
		t.Fatalf("采样状态码 = %d", rec.Code)
	}
	if len(sink.records) != 2 || sink.records[1].Title != "主壳内存超红线" {
		t.Fatalf("RSS 超红线应触发: %+v", sink.records)
	}
}

// TestSlotAlert 验证 resident 达硬上限 3 的槽位埋点。
func TestSlotAlert(t *testing.T) {
	sink := &fakeAlertSink{}
	s := newTestServer()
	s.opts.Backend = slotStatsBackend{}
	s.alerts = sink
	rec := serve(t, s, http.MethodGet, "/api/v1/system/info")
	if rec.Code != http.StatusOK {
		t.Fatalf("系统信息状态码 = %d", rec.Code)
	}
	// slotStatsBackend 返回 resident=2（未达 3）不应触发。
	if len(sink.records) != 0 {
		t.Fatalf("resident=2 不应触发槽位告警: %+v", sink.records)
	}
	s.opts.Backend = fullSlotsBackend{}
	rec = serve(t, s, http.MethodGet, "/api/v1/system/info")
	if rec.Code != http.StatusOK {
		t.Fatalf("系统信息状态码 = %d", rec.Code)
	}
	if len(sink.records) != 1 || sink.records[0].Source != alertSourceSlot {
		t.Fatalf("resident=3 应触发槽位告警: %+v", sink.records)
	}
}

// fullSlotsBackend 仅覆盖 Stats 返回满槽。
type fullSlotsBackend struct{ versionBackend }

func (fullSlotsBackend) Stats(context.Context) (SupervisorStats, error) {
	return SupervisorStats{Resident: 3, ResidentMax: 2, LazySlots: 0}, nil
}
