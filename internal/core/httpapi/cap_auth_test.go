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

// capBackend 是能力校验测试的最小 Backend：记录 Enable 调用并回读插件视图。
type capBackend struct {
	enabled   map[string]bool
	enableLog []string
}

func (b *capBackend) Plugins(_ context.Context) ([]PluginStatus, error) { return nil, nil }
func (b *capBackend) Plugin(_ context.Context, id string) (PluginStatus, bool, error) {
	if !b.enabled[id] {
		return PluginStatus{}, false, nil
	}
	return PluginStatus{ID: id, State: "ready", Desired: "enabled", Enabled: true}, true, nil
}
func (b *capBackend) Enable(_ context.Context, id string) error {
	b.enableLog = append(b.enableLog, id)
	b.enabled[id] = true
	return nil
}
func (b *capBackend) Disable(_ context.Context, id string) error {
	b.enabled[id] = false
	return nil
}
func (b *capBackend) Invoke(_ context.Context, _, _ string, _ json.RawMessage, _ string) (json.RawMessage, error) {
	return json.RawMessage(`{"ok":true}`), nil
}
func (b *capBackend) Stats(_ context.Context) (SupervisorStats, error) { return SupervisorStats{}, nil }

// capHash 生成测试用 pbkdf2 口令哈希。
func capHash(t *testing.T) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key, err := pbkdf2.Key(sha256.New, "cap-password", salt, 1000, 32)
	if err != nil {
		t.Fatalf("派生哈希失败: %v", err)
	}
	return "pbkdf2-sha256$1000$" + base64.StdEncoding.EncodeToString(salt) + "$" +
		base64.StdEncoding.EncodeToString(key)
}

// capSetup 组装带真实 auth 的服务器并登录取 session cookie。
// resolver 为 nil 时用默认 admin 全权；auditor 可注入以断言审计。
func capSetup(t *testing.T, resolver CapabilityResolver, auditor CapabilityAuditor,
	backend Backend) (*httptest.Server, string) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := New(Options{
		Version: "0.1.0-cap", Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: backend, Auth: auth.NewManager(db, capHash(t), 0, false),
		CapabilityResolver: resolver, CapabilityAuditor: auditor,
	}, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"password":"cap-password"}`)))
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

// capLowPrivResolver 返回"有效 session 但仅 site:read"的低权身份（复现 confused deputy）。
func capLowPrivResolver(r *http.Request) (string, []string) {
	if _, err := r.Cookie(auth.CookieName); err != nil {
		return "", nil
	}
	return "plugin-site", []string{"site:read"}
}

// capEnableRequest 发 enable 请求；cookie 为空时不带会话。
func capEnableRequest(t *testing.T, ts *httptest.Server, cookie string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/plugins/system-admin/enable", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
		req.AddCookie(&http.Cookie{Name: "kore_csrf", Value: "csrf"})
		req.Header.Set("X-Kore-CSRF", "csrf")
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

// TestCapabilityDeniedWritesAudit 低权 subject 访问管理端点 → 401、不触发 Enable、审计收到一条 denied。
func TestCapabilityDeniedWritesAudit(t *testing.T) {
	type denied struct{ subject, plugin, reason string }
	var records []denied
	auditor := func(subject, plugin, reason string) {
		records = append(records, denied{subject, plugin, reason})
	}
	backend := &capBackend{enabled: make(map[string]bool)}
	ts, cookie := capSetup(t, capLowPrivResolver, auditor, backend)

	status, body := capEnableRequest(t, ts, cookie)
	if status != http.StatusUnauthorized {
		t.Errorf("低权 subject 应 401，实际 %d body=%s", status, body)
	}
	if len(backend.enableLog) != 0 {
		t.Errorf("越权不得触发 Enable，实际 %v", backend.enableLog)
	}
	if len(records) != 1 || records[0].plugin != "system-admin" || records[0].subject != "plugin-site" {
		t.Errorf("应有一条 capability.denied 审计，实际 %+v", records)
	}
}

// TestCapabilityAdminAllowed 默认 admin 全权语义下管理端点仍放行（保生产路径不变）。
func TestCapabilityAdminAllowed(t *testing.T) {
	backend := &capBackend{enabled: make(map[string]bool)}
	ts, cookie := capSetup(t, nil, nil, backend)

	status, body := capEnableRequest(t, ts, cookie)
	if status != http.StatusOK {
		t.Errorf("admin 应可 enable，实际 %d body=%s", status, body)
	}
	if len(backend.enableLog) != 1 || backend.enableLog[0] != "system-admin" {
		t.Errorf("admin enable 应记录一次调用，实际 %v", backend.enableLog)
	}
}

// TestCapabilityInvokeUnaffected invoke 路径不受 capability 注入影响，保持方法合法即放行。
func TestCapabilityInvokeUnaffected(t *testing.T) {
	backend := &capBackend{enabled: make(map[string]bool)}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/invoke/site/run", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	req.AddCookie(&http.Cookie{Name: "kore_csrf", Value: "csrf"})
	req.Header.Set("X-Kore-CSRF", "csrf")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("invoke 应保持放行，实际 %d", resp.StatusCode)
	}
}
