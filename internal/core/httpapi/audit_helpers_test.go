package httpapi

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/store"
)

// auditTestBackend 是 audit 查询测试的最小 Backend。
type auditTestBackend struct{}

func (auditTestBackend) Plugins(context.Context) ([]PluginStatus, error) { return nil, nil }
func (auditTestBackend) Plugin(_ context.Context, _ string) (PluginStatus, bool, error) {
	return PluginStatus{}, false, nil
}
func (auditTestBackend) Enable(context.Context, string) error  { return nil }
func (auditTestBackend) Disable(context.Context, string) error { return nil }
func (auditTestBackend) Invoke(_ context.Context, _, _ string, _ json.RawMessage, _ string) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}
func (auditTestBackend) Stats(context.Context) (SupervisorStats, error) {
	return SupervisorStats{}, nil
}

// auditTestLister 返回固定记录，按 action/subject/plugin/result/target/keyword 过滤，
// 支持 offset/limit 分页；OffHours 不在此替身里按时间判断（改由 cmd/kored 适配层测试覆盖），
// 仅回显到 last 供 handler 透传断言。
type auditTestLister struct {
	rows []AuditRecordView
	last AuditQuery
}

func (l *auditTestLister) ListAudit(q AuditQuery) (AuditPage, error) {
	l.last = q
	out := make([]AuditRecordView, 0, len(l.rows))
	for _, r := range l.rows {
		if q.Action != "" && r.Action != q.Action {
			continue
		}
		if q.Subject != "" && r.Subject != q.Subject {
			continue
		}
		if q.Plugin != "" && r.Plugin != q.Plugin {
			continue
		}
		if q.Result == "failed" {
			if r.Result == "ok" {
				continue
			}
		} else if q.Result != "" && r.Result != q.Result {
			continue
		}
		if q.Target != "" && !strings.Contains(strings.ToLower(r.Target), strings.ToLower(q.Target)) {
			continue
		}
		if q.Keyword != "" {
			hay := strings.ToLower(r.Action + " " + r.Target + " " + r.Subject + " " + r.Plugin)
			if !strings.Contains(hay, strings.ToLower(q.Keyword)) {
				continue
			}
		}
		out = append(out, r)
	}
	total := len(out)
	if q.Offset > 0 {
		if q.Offset >= len(out) {
			out = out[:0]
		} else {
			out = out[q.Offset:]
		}
	}
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return AuditPage{Records: out, Total: total}, nil
}

// auditHash 生成测试用口令哈希。
func auditHash(t *testing.T) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key, err := pbkdf2.Key(sha256.New, "audit-password", salt, 1000, 32)
	if err != nil {
		t.Fatalf("派生哈希失败: %v", err)
	}
	return "pbkdf2-sha256$1000$" + base64.StdEncoding.EncodeToString(salt) + "$" +
		base64.StdEncoding.EncodeToString(key)
}

// auditSetup 组装带真实 auth + 注入 lister 的服务器并登录取 cookie。
func auditSetup(t *testing.T, resolver CapabilityResolver, lister AuditLister) (*httptest.Server, string) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := New(Options{
		Version: "0.1.0-audit", Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: auditTestBackend{}, Auth: auth.NewManager(db, auditHash(t), 0, false),
		CapabilityResolver: resolver, AuditLister: lister,
	}, nil)
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
		t.Fatalf("登录未下发会话 cookie（状态 %d）", rec.Code)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, cookie
}

// auditRequest 发 GET /api/v1/audit?query；cookie 为空时不带会话。
func auditRequest(t *testing.T, ts *httptest.Server, cookie, query string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/audit"+query, nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

// adminResolver 是含 system:read 的 admin resolver。
func adminResolver(r *http.Request) (string, []string) {
	if _, err := r.Cookie(auth.CookieName); err != nil {
		return "", nil
	}
	return "admin", []string{"system:admin", "system:read"}
}

// siteOnlyResolver 是仅 site:read 的低权 resolver（审计越权反例）。
func siteOnlyResolver(r *http.Request) (string, []string) {
	if _, err := r.Cookie(auth.CookieName); err != nil {
		return "", nil
	}
	return "plugin-site", []string{"site:read"}
}
