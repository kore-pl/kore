package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/pengtang1024/kore/internal/core/envprobe"
)

// fieldsBackend 是只服务于本文件正例的最小后端：返回带 web/granted_capabilities 的插件视图。
type fieldsBackend struct{}

func (fieldsBackend) Plugins(context.Context) ([]PluginStatus, error) {
	return []PluginStatus{echoStatusWithFields()}, nil
}

func (fieldsBackend) Plugin(_ context.Context, id string) (PluginStatus, bool, error) {
	if id != "echo" {
		return PluginStatus{}, false, nil
	}
	return echoStatusWithFields(), true, nil
}

func (fieldsBackend) Enable(context.Context, string) error  { return nil }
func (fieldsBackend) Disable(context.Context, string) error { return nil }
func (fieldsBackend) Invoke(context.Context, string, string, json.RawMessage, string) (json.RawMessage, error) {
	return nil, nil
}
func (fieldsBackend) Stats(context.Context) (SupervisorStats, error) { return SupervisorStats{}, nil }

func echoStatusWithFields() PluginStatus {
	return PluginStatus{
		ID: "echo", Name: "Echo 验证插件", Version: "0.1.1",
		Lifecycle: "resident", DepthLevel: "basic", State: "ready", Desired: "enabled",
		Enabled: true,
		Web: &PluginWeb{
			Entry:  "web/index.js",
			Styles: []string{"web/index.css"},
		},
		GrantedCapabilities: []string{"system:read"},
	}
}

func newFieldsTestServer() *Server {
	return New(Options{
		Version: "0.1.0-test",
		Report: envprobe.Report{
			OS: "linux", Arch: "amd64", Kernel: "6.8.0", CgroupMode: "v2", FSType: "ext4",
		},
		Backend: fieldsBackend{},
	}, nil)
}

// assertFields 断言 JSON 中的 web / granted_capabilities 与期望值一致。
func assertFields(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var got struct {
		Web                 *PluginWeb `json:"web"`
		GrantedCapabilities []string   `json:"granted_capabilities"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("解码插件视图失败: %v（%s）", err, raw)
	}
	want := echoStatusWithFields()
	if got.Web == nil {
		t.Fatalf("web 字段缺失或为 null: %s", raw)
	}
	if !reflect.DeepEqual(got.Web, want.Web) {
		t.Fatalf("web = %+v，期望 %+v", got.Web, want.Web)
	}
	if !reflect.DeepEqual(got.GrantedCapabilities, want.GrantedCapabilities) {
		t.Fatalf("granted_capabilities = %v，期望 %v", got.GrantedCapabilities, want.GrantedCapabilities)
	}
}

// TestPluginListCarriesBridgeFields 验证 GET /api/v1/plugins 列表端点透传新字段。
func TestPluginListCarriesBridgeFields(t *testing.T) {
	recorder := serve(t, newFieldsTestServer(), http.MethodGet, "/api/v1/plugins")
	if recorder.Code != http.StatusOK {
		t.Fatalf("列表状态码 = %d，期望 200：%s", recorder.Code, recorder.Body.String())
	}
	var list struct {
		Plugins []json.RawMessage `json:"plugins"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatalf("解码列表失败: %v", err)
	}
	if len(list.Plugins) != 1 {
		t.Fatalf("列表长度 = %d，期望 1", len(list.Plugins))
	}
	assertFields(t, list.Plugins[0])
}

// TestPluginDetailCarriesBridgeFields 验证 GET /api/v1/plugins/{id} 详情端点透传新字段。
func TestPluginDetailCarriesBridgeFields(t *testing.T) {
	recorder := serve(t, newFieldsTestServer(), http.MethodGet, "/api/v1/plugins/echo")
	if recorder.Code != http.StatusOK {
		t.Fatalf("详情状态码 = %d，期望 200：%s", recorder.Code, recorder.Body.String())
	}
	assertFields(t, recorder.Body.Bytes())
}
