package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// capDeclBackend 是能力校验测试后端：按插件 id 返回清单声明的能力集，并记录真实 invoke。
// 只实现 Backend（不实现 PluginCapabilityLookup），用于覆盖 httpapi 的回退读法。
type capDeclBackend struct {
	caps       map[string][]string
	methodCaps map[string]map[string]string
	invoked    []string
}

func (b *capDeclBackend) Plugins(_ context.Context) ([]PluginStatus, error) { return nil, nil }

func (b *capDeclBackend) Plugin(_ context.Context, id string) (PluginStatus, bool, error) {
	caps, ok := b.caps[id]
	if !ok {
		return PluginStatus{}, false, nil
	}
	return PluginStatus{
		ID: id, State: "ready", Desired: "enabled", Enabled: true,
		GrantedCapabilities: caps, MethodCapabilities: b.methodCaps[id],
	}, true, nil
}

func (b *capDeclBackend) Enable(context.Context, string) error  { return nil }
func (b *capDeclBackend) Disable(context.Context, string) error { return nil }

func (b *capDeclBackend) Invoke(_ context.Context, plugin, method string, _ json.RawMessage, _ string) (json.RawMessage, error) {
	b.invoked = append(b.invoked, plugin+"/"+method)
	return json.RawMessage(`{"ok":true}`), nil
}

func (b *capDeclBackend) Stats(context.Context) (SupervisorStats, error) {
	return SupervisorStats{}, nil
}

// capLookupBackend 在 capDeclBackend 之上实现 PluginCapabilityLookup（首选读法）。
type capLookupBackend struct {
	*capDeclBackend
	lookups []string
}

func (b *capLookupBackend) PluginCapabilities(_ context.Context, id string) ([]string, bool, error) {
	b.lookups = append(b.lookups, id)
	caps, ok := b.caps[id]
	if !ok {
		return nil, false, nil
	}
	return caps, true, nil
}

// capInvokeRequest 发一次 invoke 请求（带会话 cookie 与 CSRF 双提交 token）。
func capInvokeRequest(t *testing.T, ts *httptest.Server, cookie, plugin, method string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost,
		ts.URL+"/api/v1/invoke/"+plugin+"/"+method, strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: "kore_session", Value: cookie})
	req.AddCookie(&http.Cookie{Name: "kore_csrf", Value: "csrf"})
	req.Header.Set("X-Kore-CSRF", "csrf")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

// capFullAdminResolver 返回持有 6 项特权能力的 admin 身份。
func capFullAdminResolver(*http.Request) (string, []string) {
	return "admin", adminCapabilities
}

// capNetWriteResolver 返回仅持 net:write（无 system:admin）的身份。
func capNetWriteResolver(*http.Request) (string, []string) {
	return "plugin-net", []string{"net:write"}
}

// TestRequiredInvokeCapability 覆盖能力声明 → 授权要求的分类表（G-01：只看前缀与动作级）。
func TestRequiredInvokeCapability(t *testing.T) {
	cases := []struct {
		name        string
		declared    []string
		wantName    string
		wantAdmin   bool
		wantUnsuppd bool
	}{
		{"无声明", nil, "", false, false},
		{"空数组", []string{}, "", false, false},
		{"system:read 任意会话", []string{"system:read"}, "", false, false},
		{"net:read 任意会话", []string{"net:read"}, "", false, false},
		{"proc:read 任意会话", []string{"proc:read"}, "", false, false},
		{"system:admin 需 admin", []string{"system:admin"}, "system:admin", true, false},
		{"net:write 需 admin", []string{"net:write"}, "net:write", true, false},
		{"proc:write 需 admin", []string{"proc:write"}, "proc:write", true, false},
		{"system:write 需 admin", []string{"system:write"}, "system:write", true, false},
		{"只读 + 写取最高", []string{"system:read", "net:write"}, "net:write", true, false},
		{"插件自有能力不解释", []string{"site:write", "site:read"}, "", false, false},
		{"插件自有 + 只读", []string{"site:write", "proc:read"}, "", false, false},
		{"未知宿主动作 fail-closed", []string{"system:superuser"}, "system:superuser", false, true},
		{"未知宿主动作压过已知写", []string{"system:admin", "net:root"}, "net:root", false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := requiredInvokeCapability(c.declared)
			if got.name != c.wantName || got.needAdmin != c.wantAdmin || got.unsupported != c.wantUnsuppd {
				t.Fatalf("requiredInvokeCapability(%v) = %+v，期望 name=%q admin=%v unsupported=%v",
					c.declared, got, c.wantName, c.wantAdmin, c.wantUnsuppd)
			}
		})
	}
}

// TestInvokeCapabilityDeniedWithoutAdmin：插件声明 system:admin，低权会话 → 403 + 审计 denied + 不执行。
func TestInvokeCapabilityDeniedWithoutAdmin(t *testing.T) {
	type denied struct{ subject, plugin, target, capability, reason string }
	var records []denied
	auditor := func(subject, plugin, target, capability, reason string) {
		records = append(records, denied{subject, plugin, target, capability, reason})
	}
	backend := &capDeclBackend{caps: map[string][]string{"db-mysql": {"system:admin", "db-mysql:drop"}}}
	ts, cookie := capSetup(t, capLowPrivResolver, auditor, backend)

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.dropDatabase")
	if status != http.StatusForbidden {
		t.Fatalf("无 system:admin 的会话调用 system:admin 插件应 403，实际 %d body=%s", status, body)
	}
	var got errorBody
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("解析错误体失败: %v body=%s", err, body)
	}
	if got.Code != "E_UNAUTHORIZED" {
		t.Errorf("错误码应为 E_UNAUTHORIZED，实际 %q", got.Code)
	}
	if !strings.Contains(got.Message, "该方法需要 system:admin 权限") {
		t.Errorf("message 应写明所需能力，实际 %q", got.Message)
	}
	if len(backend.invoked) != 0 {
		t.Errorf("越权请求不得触达 Invoke，实际 %v", backend.invoked)
	}
	if len(records) != 1 {
		t.Fatalf("应写一条 capability.denied 审计，实际 %+v", records)
	}
	want := denied{"plugin-site", "db-mysql", "db-mysql.dropDatabase", "system:admin", "调用该插件需要 system:admin 能力"}
	if records[0] != want {
		t.Errorf("审计记录 = %+v，期望 %+v", records[0], want)
	}
}

// TestInvokeCapabilityAdminAllowed：admin 会话调用声明 system:admin 的插件 → 200 且真实执行。
func TestInvokeCapabilityAdminAllowed(t *testing.T) {
	backend := &capDeclBackend{caps: map[string][]string{"db-mysql": {"system:admin"}}}
	ts, cookie := capSetup(t, capFullAdminResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.dropDatabase")
	if status != http.StatusOK {
		t.Fatalf("admin 应可调用，实际 %d body=%s", status, body)
	}
	if len(backend.invoked) != 1 || backend.invoked[0] != "db-mysql/db-mysql.dropDatabase" {
		t.Errorf("应真实执行一次 invoke，实际 %v", backend.invoked)
	}
}

// TestInvokeCapabilityReadOnlyAllowed：只读能力 → 任意已登录会话可调。
func TestInvokeCapabilityReadOnlyAllowed(t *testing.T) {
	for _, readOnly := range []string{"system:read", "net:read", "proc:read"} {
		backend := &capDeclBackend{caps: map[string][]string{"site": {readOnly}}}
		ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)
		status, body := capInvokeRequest(t, ts, cookie, "site", "site.list")
		if status != http.StatusOK {
			t.Fatalf("只读能力 %s 应允许任意会话，实际 %d body=%s", readOnly, status, body)
		}
	}
}

// TestInvokeCapabilityNoDeclared：插件未声明任何能力 → 无需特权，放行。
func TestInvokeCapabilityNoDeclared(t *testing.T) {
	backend := &capDeclBackend{caps: map[string][]string{"echo": {}}}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "echo", "echo.run")
	if status != http.StatusOK {
		t.Fatalf("无声明插件应放行，实际 %d body=%s", status, body)
	}
}

// TestInvokeCapabilityPluginOwnedIgnored：插件自有 <id>:<action> 不属宿主特权，内核不解释。
func TestInvokeCapabilityPluginOwnedIgnored(t *testing.T) {
	backend := &capDeclBackend{caps: map[string][]string{"site": {"site:write", "site:read"}}}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "site", "site.deploy")
	if status != http.StatusOK {
		t.Fatalf("插件自有能力不应触发宿主校验，实际 %d body=%s", status, body)
	}
}

// TestInvokeCapabilitySpecificGranted：会话能力集含该能力（非 system:admin）也应放行。
func TestInvokeCapabilitySpecificGranted(t *testing.T) {
	backend := &capDeclBackend{caps: map[string][]string{"cert": {"net:write"}}}
	ts, cookie := capSetup(t, capNetWriteResolver, nil, backend)

	status, body := capInvokeRequest(t, ts, cookie, "cert", "cert.renew")
	if status != http.StatusOK {
		t.Fatalf("会话持有 net:write 应放行，实际 %d body=%s", status, body)
	}
}

// TestInvokeCapabilityUnsupportedHostAction：未知宿主动作 → 501 E_UNSUPPORTED + 审计 denied。
func TestInvokeCapabilityUnsupportedHostAction(t *testing.T) {
	type denied struct{ subject, plugin, target, capability, reason string }
	var records []denied
	auditor := func(subject, plugin, target, capability, reason string) {
		records = append(records, denied{subject, plugin, target, capability, reason})
	}
	backend := &capDeclBackend{caps: map[string][]string{"evil": {"system:superuser"}}}
	ts, cookie := capSetup(t, capFullAdminResolver, auditor, backend)

	status, body := capInvokeRequest(t, ts, cookie, "evil", "evil.run")
	if status != http.StatusNotImplemented {
		t.Fatalf("未知宿主动作应 501，实际 %d body=%s", status, body)
	}
	var got errorBody
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("解析错误体失败: %v", err)
	}
	if got.Code != "E_UNSUPPORTED" {
		t.Errorf("错误码应为 E_UNSUPPORTED，实际 %q", got.Code)
	}
	if !strings.Contains(got.Message, "system:superuser") {
		t.Errorf("message 应包含未知能力名，实际 %q", got.Message)
	}
	if len(backend.invoked) != 0 {
		t.Errorf("fail-closed 不得触达 Invoke，实际 %v", backend.invoked)
	}
	if len(records) != 1 || records[0].plugin != "evil" || records[0].target != "evil.run" || records[0].capability != "system:superuser" {
		t.Errorf("应写一条 capability.denied 审计（capability=system:superuser），实际 %+v", records)
	}
}

// TestInvokeCapabilityLookupPreferred：装配层实现 PluginCapabilityLookup 时走清单直读。
func TestInvokeCapabilityLookupPreferred(t *testing.T) {
	backend := &capLookupBackend{capDeclBackend: &capDeclBackend{
		caps: map[string][]string{"db-mysql": {"system:admin"}},
	}}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, _ := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.dropDatabase")
	if status != http.StatusForbidden {
		t.Fatalf("低权会话应被拒，实际 %d", status)
	}
	if len(backend.lookups) != 1 || backend.lookups[0] != "db-mysql" {
		t.Errorf("应经 PluginCapabilityLookup 读取一次，实际 %v", backend.lookups)
	}
}

// TestInvokeCapabilityFallbackToPluginStatus：未实现可选查询时回退 Backend.Plugin。
func TestInvokeCapabilityFallbackToPluginStatus(t *testing.T) {
	backend := &capDeclBackend{caps: map[string][]string{"db-mysql": {"system:admin"}}}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)

	status, _ := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.dropDatabase")
	if status != http.StatusForbidden {
		t.Fatalf("回退路径下低权会话也应被拒，实际 %d", status)
	}
}

// TestInvokeCapabilityDegradedWarn：未注入 CapabilityResolver 时按 admin 放行并打一次降级 WARN。
func TestInvokeCapabilityDegradedWarn(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(old) })

	backend := &capDeclBackend{caps: map[string][]string{"db-mysql": {"system:admin"}}}
	ts, cookie := capSetup(t, nil, nil, backend) // resolver=nil → 默认单管理员全权

	status, body := capInvokeRequest(t, ts, cookie, "db-mysql", "db-mysql.dropDatabase")
	if status != http.StatusOK {
		t.Fatalf("降级 admin 模式应放行，实际 %d body=%s", status, body)
	}
	if !strings.Contains(buf.String(), "降级为 admin 模式") {
		t.Errorf("应打一次降级 WARN，实际日志 %q", buf.String())
	}
}
