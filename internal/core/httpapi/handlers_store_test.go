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

// storeIndexJSON 与索引仓同形的测试索引（unsigned，用 allow_unsigned 装载）。
var storeIndexJSON = `{"schema_version":1,"plugins":[
 {"id":"echo","name":"Echo","version":"0.1.1","depth_level":"basic","lifecycle":"resident",
  "size_bytes":1,"sha256":"` + strings.Repeat("a", 64) + `","download_url":"file:///x",
  "requires_kore":">=0.1.0 <0.2.0","depends_on":[],"conflicts":[],"scenario_tags":[]}
]}`

// newStoreTestServer 构造带 market 后端的 Server（allow_unsigned=true 仅为测试 fixture）。
func newStoreTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "plugins.json"), []byte(storeIndexJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := market.New(market.Options{IndexDir: dir, AllowUnsigned: true})
	return New(Options{
		Version: "0.1.0-test", Market: svc,
		Report: envprobe.Report{OS: "linux", Arch: "amd64"},
	}, nil)
}

// TestStorePluginsList GET /api/v1/store/plugins 返回索引列表。
func TestStorePluginsList(t *testing.T) {
	rec := serve(t, newStoreTestServer(t), http.MethodGet, "/api/v1/store/plugins")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 %d，期望 200: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"id":"echo"`) {
		t.Fatalf("列表缺少 echo: %s", rec.Body.String())
	}
}

// TestStorePluginDetail GET /api/v1/store/plugins/{id} 命中与未命中。
func TestStorePluginDetail(t *testing.T) {
	s := newStoreTestServer(t)
	if rec := serve(t, s, http.MethodGet, "/api/v1/store/plugins/echo"); rec.Code != http.StatusOK {
		t.Fatalf("详情状态码 %d: %s", rec.Code, rec.Body.String())
	}
	rec := serve(t, s, http.MethodGet, "/api/v1/store/plugins/nope")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "E_NOTFOUND") {
		t.Fatalf("未知插件应 404 E_NOTFOUND，实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestStoreInstallValidation POST /api/v1/store/install 缺字段必 400 E_INVALID。
func TestStoreInstallValidation(t *testing.T) {
	rec := httptest.NewRecorder()
	s := newStoreTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/store/install", strings.NewReader(`{"id":"echo"}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "E_INVALID") {
		t.Fatalf("缺字段应 400 E_INVALID，实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestStoreJobStatus GET /api/v1/store/jobs/{id} M3 固定 E_UNSUPPORTED。
func TestStoreJobStatus(t *testing.T) {
	rec := serve(t, newStoreTestServer(t), http.MethodGet, "/api/v1/store/jobs/echo")
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), "E_UNSUPPORTED") {
		t.Fatalf("job 应 501 E_UNSUPPORTED(M3)，实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestStoreNotAssigned 未装配 market 时端点回 501 不 panic。
func TestStoreNotAssigned(t *testing.T) {
	rec := serve(t, newTestServer(), http.MethodGet, "/api/v1/store/plugins")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("未装配应 501，实际 %d", rec.Code)
	}
}
