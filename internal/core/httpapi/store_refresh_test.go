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

// refreshInstaller 是 market.Installer 的测试替身：安装固定成功，记录调用。
type refreshInstaller struct {
	calls int
}

func (r *refreshInstaller) Install(_, _ string) error {
	r.calls++
	return nil
}

// newRefreshTestServer 构造带可注入回调的 install server（allow_unsigned 仅测试）。
func newRefreshTestServer(t *testing.T, inst market.Installer, refresh func(string) (string, error)) *Server {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(storeIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := market.New(market.Options{IndexDir: dir, AllowUnsigned: true, Installer: inst})
	return New(Options{
		Version: "0.1.0-test", Market: svc,
		Report:         envprobe.Report{OS: "linux", Arch: "amd64"},
		InstallRefresh: refresh,
	}, nil)
}

// TestStoreInstallRefreshesRegistry 验证 POST /store/install 成功后回调被以插件 id
// 调用一次（缺口2：运行时安装不刷新 registry → 装完 enable 404 的直接回归）。
func TestStoreInstallRefreshesRegistry(t *testing.T) {
	var got string
	calls := 0
	s := newRefreshTestServer(t, &refreshInstaller{}, func(id string) (string, error) {
		calls++
		got = id
		return "reloaded", nil
	})
	body := `{"id":"echo","version":"0.1.1","package_path":"/tmp/echo.tar.gz"}`
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/store/install", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("install 状态码 %d: %s", rec.Code, rec.Body.String())
	}
	if calls != 1 || got != "echo" {
		t.Fatalf("InstallRefresh 调用 = %d 次, id=%q，期望 1 次 echo", calls, got)
	}
}

// TestStoreInstallRefreshFailureSurfaces 验证刷新回调失败时返回 500，不吞错、
// 不假装成功（数据已落盘但登记未完成必须显式暴露）。
func TestStoreInstallRefreshFailureSurfaces(t *testing.T) {
	s := newRefreshTestServer(t, &refreshInstaller{}, func(string) (string, error) {
		return "failed", &testRefreshErr{}
	})
	body := `{"id":"echo","version":"0.1.1","package_path":"/tmp/echo.tar.gz"}`
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/store/install", strings.NewReader(body)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("刷新失败应 500，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// testRefreshErr 是带协议语义的假错误（走 writeFailure 映射 E_INTERNAL → 500）。
type testRefreshErr struct{}

func (*testRefreshErr) Error() string { return "registry 登记失败" }
