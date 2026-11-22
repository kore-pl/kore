package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/market"
)

// forceHTTPInstaller 记录本地/下载两条强制重装路径的调用。
type forceHTTPInstaller struct {
	forceCalls int
	forceID    string
}

func (f *forceHTTPInstaller) Install(_, _ string) error { return nil }

func (f *forceHTTPInstaller) InstallForce(id, _, _ string) error {
	f.forceCalls++
	f.forceID = id
	return nil
}

// newForceServer 构造带 ForceInstaller 与刷新回调的 install server。
func newForceServer(t *testing.T, inst market.Installer, reload func(string) (string, error)) *Server {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(storeIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := market.New(market.Options{IndexDir: dir, AllowUnsigned: true, Installer: inst})
	return New(Options{
		Version: "0.1.0-test", Market: svc,
		Report:         envprobe.Report{OS: "linux", Arch: "amd64"},
		InstallRefresh: reload,
	}, nil)
}

// TestStoreInstallForceRoutes 请求体 force=true 必须走 ForceInstaller，
// 响应携带 reload 结果，且刷新回调仍被调用（安装后真正重载）。
func TestStoreInstallForceRoutes(t *testing.T) {
	fake := &forceHTTPInstaller{}
	reloads := 0
	s := newForceServer(t, fake, func(id string) (string, error) {
		reloads++
		return "restarted", nil
	})
	body := `{"id":"echo","version":"0.1.1","package_path":"/tmp/echo.tar.gz","force":true}`
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/store/install", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("force install 状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if fake.forceCalls != 1 || fake.forceID != "echo" {
		t.Fatalf("force 路径未命中 ForceInstaller: %+v", fake)
	}
	if reloads != 1 {
		t.Fatalf("刷新回调调用 %d 次，期望 1", reloads)
	}
	if !strings.Contains(rec.Body.String(), `"reload":"restarted"`) {
		t.Fatalf("响应缺 reload=restarted: %s", rec.Body.String())
	}
}

// TestStoreBitsSignatureFailureRequiresRestart 验签失败必须回 401 且带 requires_restart。
func TestStorePluginsSignatureFailureRequiresRestart(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(storeIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(Options{
		Version: "0.1.0-test", Market: market.New(market.Options{IndexDir: dir}),
		Report: envprobe.Report{OS: "linux", Arch: "amd64"},
	}, nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/store/plugins", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未签名索引应 401，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"requires_restart":true`) {
		t.Fatalf("401 响应缺 requires_restart:true: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "重启 kored") {
		t.Fatalf("401 响应缺重启指引: %s", rec.Body.String())
	}
}
