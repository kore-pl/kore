package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/installer"
)

// uninstallBackend 是实现了 Backend + PluginUninstaller 的测试后端。
type uninstallBackend struct {
	// calls 记录被请求卸载的 id（顺序）。
	calls []string
	// outcome / err 是预设返回值。
	outcome UninstallOutcome
	err     error
}

func (b *uninstallBackend) Plugins(context.Context) ([]PluginStatus, error) { return nil, nil }

func (b *uninstallBackend) Plugin(context.Context, string) (PluginStatus, bool, error) {
	return PluginStatus{}, false, nil
}

func (b *uninstallBackend) Enable(context.Context, string) error  { return nil }
func (b *uninstallBackend) Disable(context.Context, string) error { return nil }

func (b *uninstallBackend) Invoke(context.Context, string, string, json.RawMessage, string) (json.RawMessage, error) {
	return nil, nil
}

func (b *uninstallBackend) Stats(context.Context) (SupervisorStats, error) {
	return SupervisorStats{}, nil
}

func (b *uninstallBackend) Uninstall(_ context.Context, id string) (UninstallOutcome, error) {
	b.calls = append(b.calls, id)
	return b.outcome, b.err
}

// newUninstallServer 构造注入了卸载后端的 Server。
func newUninstallServer(backend *uninstallBackend) *Server {
	return New(Options{
		Version: "0.1.0-test",
		Report:  envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: backend,
	}, nil)
}

// TestPluginUninstallOK 验证正常卸载返回 200 并透传 outcome。
func TestPluginUninstallOK(t *testing.T) {
	backend := &uninstallBackend{outcome: UninstallOutcome{ID: "echo", Deleted: true, Stopped: true}}
	recorder := serve(t, newUninstallServer(backend), http.MethodDelete, "/api/v1/plugins/echo")
	if recorder.Code != http.StatusOK {
		t.Fatalf("卸载状态码 = %d，期望 200：%s", recorder.Code, recorder.Body.String())
	}
	if len(backend.calls) != 1 || backend.calls[0] != "echo" {
		t.Fatalf("后端调用记录 = %v，期望 [echo]", backend.calls)
	}
	var body UninstallOutcome
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if !body.Deleted || !body.Stopped || body.AlreadyAbsent {
		t.Fatalf("响应体 = %+v，期望 deleted=true stopped=true already_absent=false", body)
	}
}

// TestPluginUninstallAbsentIsIdempotent 验证未安装 id 走 200 + already_absent（幂等口径）。
func TestPluginUninstallAbsentIsIdempotent(t *testing.T) {
	backend := &uninstallBackend{outcome: UninstallOutcome{ID: "ghost", AlreadyAbsent: true}}
	recorder := serve(t, newUninstallServer(backend), http.MethodDelete, "/api/v1/plugins/ghost")
	if recorder.Code != http.StatusOK {
		t.Fatalf("未安装 id 卸载状态码 = %d，期望 200（幂等）：%s", recorder.Code, recorder.Body.String())
	}
	var body UninstallOutcome
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if !body.AlreadyAbsent || body.Deleted {
		t.Fatalf("响应体 = %+v，期望 already_absent=true deleted=false", body)
	}
}

// TestPluginUninstallRejectsTraversal 验证路径穿越与控制字符被 400 拒绝且不触达后端。
func TestPluginUninstallRejectsTraversal(t *testing.T) {
	for _, raw := range []string{
		"/api/v1/plugins/..%2f..%2fetc",
		"/api/v1/plugins/foo%2fbar",
		"/api/v1/plugins/..%252f..%252fetc",
		"/api/v1/plugins/foo..bar",
		"/api/v1/plugins/Echo",
		"/api/v1/plugins/a%00b",
	} {
		backend := &uninstallBackend{}
		recorder := serve(t, newUninstallServer(backend), http.MethodDelete, raw)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s 状态码 = %d，期望 400：%s", raw, recorder.Code, recorder.Body.String())
		}
		if len(backend.calls) != 0 {
			t.Fatalf("%s 不应触达后端卸载逻辑，实际调用 %v", raw, backend.calls)
		}
	}
}

// TestPluginUninstallAuditFailureMaps503 验证审计失败映射为 503（可重试，且不会半删）。
func TestPluginUninstallAuditFailureMaps503(t *testing.T) {
	backend := &uninstallBackend{err: fmt.Errorf("%w: 审计库不可写", installer.ErrAudit)}
	recorder := serve(t, newUninstallServer(backend), http.MethodDelete, "/api/v1/plugins/echo")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("审计失败状态码 = %d，期望 503：%s", recorder.Code, recorder.Body.String())
	}
}

// TestPluginUninstallUnsupportedWhenNotWired 验证未实现卸载的装配回 501，不假装成功。
func TestPluginUninstallUnsupportedWhenNotWired(t *testing.T) {
	server := New(Options{
		Version: "0.1.0-test",
		Report:  envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: versionBackend{},
	}, nil)
	recorder := serve(t, server, http.MethodDelete, "/api/v1/plugins/echo")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("未装配卸载时状态码 = %d，期望 501：%s", recorder.Code, recorder.Body.String())
	}
}

// TestPluginUninstallRequiresAdmin 验证卸载要求 system:admin（缺能力回 401，且不触达卸载）。
func TestPluginUninstallRequiresAdmin(t *testing.T) {
	backend := &uninstallBackend{outcome: UninstallOutcome{ID: "echo", Deleted: true}}
	ts, cookie := capSetup(t, capLowPrivResolver, nil, backend)
	req, err := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/plugins/echo", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	req.AddCookie(&http.Cookie{Name: "kore_csrf", Value: "csrf"})
	req.Header.Set("X-Kore-CSRF", "csrf")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无 system:admin 时状态码 = %d，期望 401", resp.StatusCode)
	}
	if len(backend.calls) != 0 {
		t.Fatalf("越权请求不应触达卸载逻辑，实际 %v", backend.calls)
	}
}
