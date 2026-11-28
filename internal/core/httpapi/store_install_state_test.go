package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/market"
)

// installStateServer 构造带 Backend 的 install server，可指定安装后插件的启用态。
// P1-2 / hands-on-r51：验证 store/install 响应如实回报 enabled + 白话 hint，
// 且"只读不启"的默认行为不被改动（不自动调 Enable）。
func installStateServer(t *testing.T, enabled bool) (*Server, *capBackend) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(storeIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := market.New(market.Options{IndexDir: dir, AllowUnsigned: true, Installer: &refreshInstaller{}})
	backend := &capBackend{enabled: make(map[string]bool)}
	if enabled {
		backend.enabled["echo"] = true
	}
	return New(Options{
		Version: "0.1.0-test", Market: svc,
		Report:         envprobe.Report{OS: "linux", Arch: "amd64"},
		InstallRefresh: func(string) (string, error) { return "reloaded", nil },
		Backend:        backend,
	}, nil), backend
}

// postInstallState 发一次 store/install 并返回原始响应体。
func postInstallState(t *testing.T, s *Server) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	body := `{"id":"echo","version":"0.1.1","package_path":"/tmp/echo.tar.gz"}`
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/store/install", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("install 状态码 %d: %s", rec.Code, rec.Body.String())
	}
	return rec
}

// TestStoreInstallReportsNotEnabled 验证新装（默认禁用）插件的响应带 enabled=false
// 与白话 hint，且 hint 不暴露内部 API 动词/路径；安装路径本身不调用 Enable。
func TestStoreInstallReportsNotEnabled(t *testing.T) {
	s, backend := installStateServer(t, false)
	rec := postInstallState(t, s)
	var resp struct {
		Enabled bool   `json:"enabled"`
		Hint    string `json:"hint"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解码 install 响应失败: %v（%s）", err, rec.Body.String())
	}
	if resp.Enabled {
		t.Fatalf("新装默认禁用插件不应报 enabled=true: %s", rec.Body.String())
	}
	if !strings.Contains(resp.Hint, "启用") || !strings.Contains(resp.Hint, "软件商店") {
		t.Fatalf("未启用 hint 应白话并给出真实入口，实际 %q", resp.Hint)
	}
	for _, leak := range []string{"POST", "/api/v1/", "/enable"} {
		if strings.Contains(resp.Hint, leak) {
			t.Fatalf("hint 不得暴露内部 API 动词 %q：%q", leak, resp.Hint)
		}
	}
	if len(backend.enableLog) != 0 {
		t.Fatalf("store/install 不应自动启用插件（默认行为不变），实际 Enable 调用 %v", backend.enableLog)
	}
}

// TestStoreInstallReportsEnabled 验证已启用插件（升级/重装 desired=enabled）响应
// enabled=true 且不带多余 hint。
func TestStoreInstallReportsEnabled(t *testing.T) {
	s, _ := installStateServer(t, true)
	rec := postInstallState(t, s)
	var resp struct {
		Enabled bool   `json:"enabled"`
		Hint    string `json:"hint"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解码 install 响应失败: %v（%s）", err, rec.Body.String())
	}
	if !resp.Enabled {
		t.Fatalf("已启用插件应报 enabled=true: %s", rec.Body.String())
	}
	if resp.Hint != "" {
		t.Fatalf("已启用插件不应带启用提示，实际 %q", resp.Hint)
	}
}
