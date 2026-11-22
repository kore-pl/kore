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

// newStoreServer 构造带 market 后端的 Server；allowUnsigned 控制索引信任门的严格程度。
func newStoreServer(t *testing.T, allowUnsigned bool) *Server {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(storeIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := market.New(market.Options{IndexDir: dir, AllowUnsigned: allowUnsigned})
	return New(Options{
		Version: "0.1.0-test", Market: svc,
		Report: envprobe.Report{OS: "linux", Arch: "amd64"},
	}, nil)
}

// postInstall 发一次 store/install 并返回响应。
func postInstall(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec,
		httptest.NewRequest(http.MethodPost, "/api/v1/store/install", strings.NewReader(body)))
	return rec
}

// TestInstallSourceSelection 三选一参数校验：两者同给 = 歧义；都不给 = 无法确定来源。
func TestInstallSourceSelection(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"both", `{"id":"echo","version":"0.1.1","package_path":"/tmp/echo.tar.gz","download":true}`, "歧义"},
		{"neither", `{"id":"echo","version":"0.1.1"}`, "package_path"},
		{"no_id", `{"download":true}`, "id/version 必填"},
		{"no_version", `{"id":"echo","package_path":"/tmp/e.tar.gz"}`, "id/version 必填"},
	}
	for _, tc := range cases {
		rec := postInstall(t, newStoreServer(t, true), tc.body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "E_INVALID") {
			t.Fatalf("%s: 应 400 E_INVALID，实际 %d %s", tc.name, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), tc.want) {
			t.Fatalf("%s: 提示应含 %q，实际 %s", tc.name, tc.want, rec.Body.String())
		}
	}
}

// TestInstallDownloadRequiresVerifiedIndex 下载路径先过验签门：未签名索引默认拒绝且不触达安装器。
func TestInstallDownloadRequiresVerifiedIndex(t *testing.T) {
	rec := postInstall(t, newStoreServer(t, false), `{"id":"echo","version":"0.1.1","download":true}`)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "E_UNAUTHORIZED") {
		t.Fatalf("未签名索引下载安装应 401 E_UNAUTHORIZED，实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestInstallDownloadRouted download=true 走下载分支：后端未装配安装器时明确 501，不假装成功。
func TestInstallDownloadRouted(t *testing.T) {
	rec := postInstall(t, newStoreServer(t, true), `{"id":"echo","version":"0.1.1","download":true}`)
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), "E_UNSUPPORTED") {
		t.Fatalf("下载分支应到安装后端（未装配 → 501 E_UNSUPPORTED），实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestInstallLocalPackageRouted 只给 package_path 时仍走本地包分支（后端未装配 → 501）。
func TestInstallLocalPackageRouted(t *testing.T) {
	rec := postInstall(t, newStoreServer(t, true), `{"id":"echo","version":"0.1.1","package_path":"/tmp/echo.tar.gz"}`)
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), "E_UNSUPPORTED") {
		t.Fatalf("本地包分支应到安装后端，实际 %d %s", rec.Code, rec.Body.String())
	}
}
