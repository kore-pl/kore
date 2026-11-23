package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// rootActionBackend 在最小 Backend 之上实现 RootActionLookup。
type rootActionBackend struct {
	auditTestBackend
	action pluginapi.RootAction
}

func (b rootActionBackend) RootAction(_ context.Context, pluginID, actionID string) (pluginapi.RootAction, bool, error) {
	if pluginID == "firewall" && actionID == b.action.ID {
		return b.action, true, nil
	}
	return pluginapi.RootAction{}, false, nil
}

// discardPrivilegeAuditor 是测试用审计出口（不落库）。
type discardPrivilegeAuditor struct{}

func (discardPrivilegeAuditor) Record(context.Context, privilege.Event) error { return nil }

// newRootActionServer 启动带真实 auth + 提权服务（非 root 探针）的测试服务器，
// 返回服务器、会话 cookie 与 CSRF token。
func newRootActionServer(t *testing.T, backend Backend, pluginAuth PluginTokenAuth) (*httptest.Server, string, string) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	priv := privilege.New(privilege.Options{
		Auditor: discardPrivilegeAuditor{}, TempDir: t.TempDir(),
		Root:    func() bool { return false }, // 本环境非 root：拒绝路径
		Systemd: func() (bool, string) { return true, "" },
	})
	srv := New(Options{
		Version: "0.1.0-rootaction", Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: backend, Auth: auth.NewManager(db, auditHash(t), 0, false),
		Privilege: priv, PluginAuth: pluginAuth,
	}, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"password":"audit-password"}`)))
	var session, csrf string
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case auth.CookieName:
			session = c.Value
		case csrfCookieName:
			csrf = c.Value
		}
	}
	if session == "" || csrf == "" {
		t.Fatalf("登录应同时下发 session 与 csrf cookie（状态 %d）", rec.Code)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, session, csrf
}

// doRootAction 发一次带会话 + CSRF 的提权请求。
func doRootAction(t *testing.T, ts *httptest.Server, session, csrf, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/plugins/firewall/root-action",
		strings.NewReader(body))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: csrf})
	req.Header.Set(csrfHeaderName, csrf)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

// TestRootActionNeedRoot 非 root 环境：403 + E_NEED_ROOT + hint（集成拒绝路径）。
func TestRootActionNeedRoot(t *testing.T) {
	backend := rootActionBackend{action: pluginapi.RootAction{
		ID: "ufw-status", Argv: []string{"ufw", "status"}, TimeoutS: 5,
	}}
	ts, session, csrf := newRootActionServer(t, backend, nil)
	status, body := doRootAction(t, ts, session, csrf, `{"action_id":"ufw-status"}`)
	if status != http.StatusForbidden {
		t.Fatalf("非 root 应 403，实际 %d body=%s", status, body)
	}
	var got struct {
		Code string `json:"code"`
		Hint string `json:"hint"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v body=%s", err, body)
	}
	if got.Code != pluginapi.E_NEED_ROOT || !strings.Contains(got.Hint, "sudo") {
		t.Fatalf("应为 E_NEED_ROOT + sudo hint，实际 %+v body=%s", got, body)
	}
}

// TestRootActionNotFound 未声明的 action → 404 E_NOTFOUND。
func TestRootActionNotFound(t *testing.T) {
	backend := rootActionBackend{action: pluginapi.RootAction{ID: "ufw-status", Argv: []string{"ufw", "status"}, TimeoutS: 5}}
	ts, session, csrf := newRootActionServer(t, backend, nil)
	status, body := doRootAction(t, ts, session, csrf, `{"action_id":"ufw-allow"}`)
	if status != http.StatusNotFound || !strings.Contains(string(body), pluginapi.E_NOTFOUND) {
		t.Fatalf("未声明动作应 404 E_NOTFOUND，实际 %d body=%s", status, body)
	}
}

// TestRootActionInvalidBody 未知字段 / 非法 action_id → 400 E_INVALID。
func TestRootActionInvalidBody(t *testing.T) {
	backend := rootActionBackend{action: pluginapi.RootAction{ID: "ufw-status", Argv: []string{"ufw", "status"}, TimeoutS: 5}}
	ts, session, csrf := newRootActionServer(t, backend, nil)
	for _, body := range []string{`{"action_id":"ufw-status","argv":["rm"]}`, `{"action_id":"UFW"}`, `{}`} {
		status, raw := doRootAction(t, ts, session, csrf, body)
		if status != http.StatusBadRequest || !strings.Contains(string(raw), pluginapi.E_INVALID) {
			t.Fatalf("body=%s 应 400 E_INVALID，实际 %d %s", body, status, raw)
		}
	}
}

// TestRootActionConfirmToken 不可回滚动作：缺令牌 401；签发后可用；令牌一次性。
func TestRootActionConfirmToken(t *testing.T) {
	backend := rootActionBackend{action: pluginapi.RootAction{
		ID: "ufw-allow", Argv: []string{"ufw", "allow"}, TimeoutS: 5, Irreversible: true,
	}}
	ts, session, csrf := newRootActionServer(t, backend, nil)
	status, body := doRootAction(t, ts, session, csrf, `{"action_id":"ufw-allow"}`)
	if status != http.StatusUnauthorized || !strings.Contains(string(body), pluginapi.E_UNAUTHORIZED) {
		t.Fatalf("缺 confirm 应 401，实际 %d body=%s", status, body)
	}

	req, _ := http.NewRequest(http.MethodGet,
		ts.URL+"/api/v1/plugins/firewall/root-action/ufw-allow/confirm-token", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("签发请求失败: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("签发应 200，实际 %d body=%s", resp.StatusCode, raw)
	}
	var grant struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &grant); err != nil || grant.Token == "" || grant.ExpiresAt == "" {
		t.Fatalf("签发响应不完整: %v body=%s", err, raw)
	}

	// 带令牌：通过 confirm 后进到 root 检查 → 仍是 E_NEED_ROOT（非 root）。
	status, body = doRootAction(t, ts, session, csrf,
		`{"action_id":"ufw-allow","confirm":"`+grant.Token+`"}`)
	if status != http.StatusForbidden || !strings.Contains(string(body), pluginapi.E_NEED_ROOT) {
		t.Fatalf("带有效令牌应通过 confirm 后报 E_NEED_ROOT，实际 %d body=%s", status, body)
	}
	// 用完即废：同一令牌再用 → 401。
	status, body = doRootAction(t, ts, session, csrf,
		`{"action_id":"ufw-allow","confirm":"`+grant.Token+`"}`)
	if status != http.StatusUnauthorized {
		t.Fatalf("令牌复用应 401，实际 %d body=%s", status, body)
	}
}

// TestConfirmTokenRejectsNonIrreversible 非不可回滚动作不签发令牌。
func TestConfirmTokenRejectsNonIrreversible(t *testing.T) {
	backend := rootActionBackend{action: pluginapi.RootAction{ID: "ufw-status", Argv: []string{"ufw", "status"}, TimeoutS: 5}}
	ts, session, _ := newRootActionServer(t, backend, nil)
	req, _ := http.NewRequest(http.MethodGet,
		ts.URL+"/api/v1/plugins/firewall/root-action/ufw-status/confirm-token", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("非不可回滚动作应 400，实际 %d", resp.StatusCode)
	}
}

// TestRootActionPluginBearer 插件 bearer 身份：只允许自己的动作且需要 system:admin。
func TestRootActionPluginBearer(t *testing.T) {
	backend := rootActionBackend{action: pluginapi.RootAction{ID: "ufw-status", Argv: []string{"ufw", "status"}, TimeoutS: 5}}
	pluginAuth := func(token string) (string, []string, bool) {
		switch token {
		case "good":
			return "firewall", []string{"system:admin"}, true
		case "no-admin":
			return "firewall", []string{"firewall:read"}, true
		case "other":
			return "site", []string{"system:admin"}, true
		}
		return "", nil, false
	}
	ts, _, _ := newRootActionServer(t, backend, pluginAuth)
	post := func(token string) (int, string) {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/plugins/firewall/root-action",
			strings.NewReader(`{"action_id":"ufw-status"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(raw)
	}
	if status, body := post(""); status != http.StatusUnauthorized {
		t.Fatalf("空 bearer 应 401，实际 %d %s", status, body)
	}
	if status, body := post("bad"); status != http.StatusUnauthorized {
		t.Fatalf("无效 token 应 401，实际 %d %s", status, body)
	}
	if status, body := post("no-admin"); status != http.StatusUnauthorized {
		t.Fatalf("缺 system:admin 应 401，实际 %d %s", status, body)
	}
	if status, body := post("other"); status != http.StatusUnauthorized {
		t.Fatalf("跨插件调用应 401，实际 %d %s", status, body)
	}
	// 有效插件身份同样走真实提权检查 → 非 root 403 + E_NEED_ROOT。
	if status, body := post("good"); status != http.StatusForbidden || !strings.Contains(body, pluginapi.E_NEED_ROOT) {
		t.Fatalf("合法插件身份应 403 E_NEED_ROOT，实际 %d %s", status, body)
	}
}
