package httpapi

import (
	"context"
	"net/http"
	"testing"
)

// grantConfirmBackend 在最小后端上额外实现 CapabilityGrantConfirmer，
// 记录启用时是否触发了「启用即确认授予」以及操作者 subject。
type grantConfirmBackend struct {
	fieldsBackend
	confirmed []string
}

func (b *grantConfirmBackend) ConfirmCapabilities(_ context.Context, id, subject string) error {
	b.confirmed = append(b.confirmed, id+"/"+subject)
	return nil
}

// TestEnableConfirmsGrant 验证启用端点调用可选确认接口，单管理员模式回落 admin。
func TestEnableConfirmsGrant(t *testing.T) {
	backend := &grantConfirmBackend{}
	server := New(Options{
		Version: "0.1.0-test",
		Backend: backend,
	}, nil)
	recorder := serve(t, server, http.MethodPost, "/api/v1/plugins/echo/enable")
	if recorder.Code != http.StatusOK {
		t.Fatalf("启用状态码 = %d，期望 200：%s", recorder.Code, recorder.Body.String())
	}
	if len(backend.confirmed) != 1 || backend.confirmed[0] != "echo/admin" {
		t.Fatalf("确认调用 = %v，期望 [echo/admin]（未装配鉴权时回落单管理员 subject）", backend.confirmed)
	}
}

// TestDisableDoesNotConfirmGrant 验证停用不触发授予确认（确认只属于启用动作）。
func TestDisableDoesNotConfirmGrant(t *testing.T) {
	backend := &grantConfirmBackend{}
	server := New(Options{
		Version: "0.1.0-test",
		Backend: backend,
	}, nil)
	if recorder := serve(t, server, http.MethodPost, "/api/v1/plugins/echo/disable"); recorder.Code != http.StatusOK {
		t.Fatalf("停用状态码 = %d，期望 200", recorder.Code)
	}
	if len(backend.confirmed) != 0 {
		t.Fatalf("停用不应写授予确认: %v", backend.confirmed)
	}
}
