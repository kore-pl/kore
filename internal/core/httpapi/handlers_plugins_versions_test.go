package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/envprobe"
)

// versionBackend 返回固定插件视图，供版本对齐测试使用。
type versionBackend struct {
	plugins []PluginStatus
}

func (b versionBackend) Plugins(context.Context) ([]PluginStatus, error) { return b.plugins, nil }
func (b versionBackend) Plugin(_ context.Context, id string) (PluginStatus, bool, error) {
	for _, p := range b.plugins {
		if p.ID == id {
			return p, true, nil
		}
	}
	return PluginStatus{}, false, nil
}
func (b versionBackend) Enable(context.Context, string) error  { return nil }
func (b versionBackend) Disable(context.Context, string) error { return nil }
func (b versionBackend) Invoke(context.Context, string, string, json.RawMessage, string) (json.RawMessage, error) {
	return nil, nil
}
func (b versionBackend) Stats(context.Context) (SupervisorStats, error) {
	return SupervisorStats{}, nil
}

// TestPluginListAlignsIndexVersions 验证 GET /api/v1/plugins 把索引版本对齐进已装视图：
// 版本不同 → update_available=true；索引未收录 → latest_* 为空且 update_available=false。
func TestPluginListAlignsIndexVersions(t *testing.T) {
	s := newStoreTestServer(t)
	s.opts.Backend = versionBackend{plugins: []PluginStatus{
		{ID: "echo", Version: "0.1.0", State: "ready", Desired: "enabled", Enabled: true},
		{ID: "local-only", Version: "0.1.0", State: "stopped", Desired: "disabled"},
	}}
	rec := serve(t, s, http.MethodGet, "/api/v1/plugins")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d，期望 200：%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Plugins []PluginStatus `json:"plugins"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if len(body.Plugins) != 2 {
		t.Fatalf("插件数 = %d，期望 2", len(body.Plugins))
	}
	echo := body.Plugins[0]
	if echo.LatestVersion != "0.1.1" || echo.LatestSHA256 == "" || !echo.UpdateAvailable {
		t.Fatalf("echo 对齐结果不符: %+v", echo)
	}
	local := body.Plugins[1]
	if local.LatestVersion != "" || local.LatestSHA256 != "" || local.UpdateAvailable {
		t.Fatalf("索引未收录插件不应带 latest 字段: %+v", local)
	}
}

// TestPluginListIndexFailureKeepsList 验证索引不可读时插件列表仍 200（仅缺 latest 字段）。
func TestPluginListIndexFailureKeepsList(t *testing.T) {
	s := New(Options{
		Version: "0.1.0-test",
		Report:  envprobe.Report{OS: "linux", Arch: "amd64"},
		Backend: versionBackend{plugins: []PluginStatus{{ID: "echo", Version: "0.1.0"}}},
	}, nil)
	rec := serve(t, s, http.MethodGet, "/api/v1/plugins")
	if rec.Code != http.StatusOK {
		t.Fatalf("无 market 时列表应 200，实际 %d：%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"id":"echo"`) {
		t.Fatalf("列表缺少 echo: %s", rec.Body.String())
	}
}
