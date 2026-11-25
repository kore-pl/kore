package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/store"
)

// auditListerFromStore 把真实 store 记录转成 httpapi 视图（端到端装配模拟）。
// 与 cmd/kored/audit.go 的适配器同口径，测试内独立实现以覆盖 httpapi 层。
type auditListerFromStore struct{ db *store.Store }

func (l *auditListerFromStore) ListAudit(q AuditQuery) (AuditPage, error) {
	rows, err := l.db.ListAudit(store.AuditFilter{Action: q.Action})
	if err != nil {
		return AuditPage{}, err
	}
	lower := q.Since.UnixNano()
	out := make([]AuditRecordView, 0, len(rows))
	for _, rec := range rows {
		dash := strings.IndexByte(rec.Key, '-')
		if dash <= 0 {
			continue
		}
		ts, err := strconv.ParseInt(rec.Key[:dash], 10, 64)
		if err != nil || ts < lower {
			continue
		}
		out = append(out, AuditRecordView{
			Key: rec.Key, Subject: rec.Subject, Action: rec.Action, Plugin: rec.Plugin,
			Target: rec.Target, Result: rec.Result, Detail: rec.Detail,
		})
	}
	total := len(out)
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return AuditPage{Records: out, Total: total}, nil
}

// TestAuditQuerySinceKeyFilter 验证 since 下界过滤按 key 纳秒比较正确（真实 store 数据）。
func TestAuditQuerySinceKeyFilter(t *testing.T) {
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, action := range []string{"plugins.enable", "plugins.disable"} {
		if err := db.PutAudit(store.AuditRecord{
			Subject: "admin", Action: action, Plugin: "site", Result: store.AuditResultOK,
			Detail: map[string]string{"k": "v"},
		}); err != nil {
			t.Fatalf("写审计失败: %v", err)
		}
	}
	lister := &auditListerFromStore{db: db}
	page, err := lister.ListAudit(AuditQuery{Since: time.Unix(0, 0), Limit: 100})
	if err != nil || len(page.Records) != 2 || page.Total != 2 {
		t.Fatalf("since=epoch 应返回 2 条（total=2），实际 %d total=%d err=%v", len(page.Records), page.Total, err)
	}
	page, err = lister.ListAudit(AuditQuery{Since: time.Now().Add(time.Hour), Limit: 100})
	if err != nil || len(page.Records) != 0 {
		t.Fatalf("未来 since 应过滤全部，实际 %d err=%v", len(page.Records), err)
	}
}

// TestAuditQueryEndToEnd 端到端：真实 store 注入事件 → 真实 HTTP GET /api/v1/audit
// → 200 且有结果；无 since → 400；越权 → 401。等价于"起 kored 注入事件后 curl"。
func TestAuditQueryEndToEnd(t *testing.T) {
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	if err := db.PutAudit(store.AuditRecord{
		Subject: "admin", Action: "plugins.enable", Plugin: "site", Target: "site",
		Result: store.AuditResultOK, Detail: map[string]string{"version": "0.1.0"},
	}); err != nil {
		t.Fatalf("注入审计事件失败: %v", err)
	}

	// 真实 Server + auth + auditLister；admin 持 system:read。
	srv := New(Options{
		Version: "0.1.0-e2e", Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: auditTestBackend{}, Auth: auth.NewManager(db, auditHash(t), 0, false),
		CapabilityResolver: adminResolver, AuditLister: &auditListerFromStore{db: db},
	}, nil)
	// 登录取 session cookie（真实 auth 签发）。
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"audit-password"}`)))
	var cookie string
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.CookieName {
			cookie = c.Value
		}
	}
	if cookie == "" {
		t.Fatalf("登录未下发 cookie（状态 %d）", rec.Code)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1) 带 since + 有效 session → 200 且有目标事件。
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/audit?since=2000-01-01T00%3A00%3A00Z", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("GET 审计失败: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("带 since 查询应 200，实际 %d body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), "plugins.enable") || !strings.Contains(string(body), "site") {
		t.Fatalf("200 响应应含注入的事件，实际 %s", body)
	}

	// 2) 无 since → 400（全量导出拒绝）。
	req2, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/audit", nil)
	req2.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	resp2, err := ts.Client().Do(req2)
	if err != nil {
		t.Fatalf("GET 审计（无 since）失败: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("无 since 应 400，实际 %d", resp2.StatusCode)
	}

	// 3) 越权（site:read）→ 401。
	lowSrv := New(Options{
		Version: "0.1.0-e2e", Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: auditTestBackend{}, Auth: auth.NewManager(db, auditHash(t), 0, false),
		CapabilityResolver: siteOnlyResolver, AuditLister: &auditListerFromStore{db: db},
	}, nil)
	lowRec := httptest.NewRecorder()
	lowSrv.Handler().ServeHTTP(lowRec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"audit-password"}`)))
	var lowCookie string
	for _, c := range lowRec.Result().Cookies() {
		if c.Name == auth.CookieName {
			lowCookie = c.Value
		}
	}
	lowTS := httptest.NewServer(lowSrv.Handler())
	defer lowTS.Close()
	req3, _ := http.NewRequest(http.MethodGet, lowTS.URL+"/api/v1/audit?since=2000-01-01T00%3A00%3A00Z", nil)
	req3.AddCookie(&http.Cookie{Name: auth.CookieName, Value: lowCookie})
	resp3, err := lowTS.Client().Do(req3)
	if err != nil {
		t.Fatalf("越权 GET 审计失败: %v", err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("site:read 越权应 401，实际 %d", resp3.StatusCode)
	}
}
