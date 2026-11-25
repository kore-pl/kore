package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/metrics"
	"github.com/pengtang1024/kore/internal/core/store"
)

type fakeMetricsCollector struct {
	snap metrics.Snapshot
	err  error
}

func (f fakeMetricsCollector) Collect() (metrics.Snapshot, error) { return f.snap, f.err }

// metricsSetup 组装带真实 auth 与注入采样器的服务器并登录。
func metricsSetup(t *testing.T, resolver CapabilityResolver, c MetricsCollector) (*httptest.Server, string) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	srv := New(Options{
		Auth:               auth.NewManager(db, auditHash(t), 0, false),
		CapabilityResolver: resolver, Metrics: c,
	}, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"audit-password"}`)))
	var cookie string
	for _, v := range rec.Result().Cookies() {
		if v.Name == auth.CookieName {
			cookie = v.Value
		}
	}
	if cookie == "" {
		t.Fatalf("登录未下发会话 cookie（状态 %d）", rec.Code)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, cookie
}

func metricsGet(t *testing.T, ts *httptest.Server, cookie string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/system/metrics", nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: cookie})
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

// TestSystemMetricsOK 校验字段契约与 200。
func TestSystemMetricsOK(t *testing.T) {
	want := metrics.Snapshot{CPUPercent: 12.5, RSSKiB: 8000, DiskUsedKiB: 1 << 20,
		DiskTotalKiB: 2 << 20, Load1: 0.5, Goroutines: 12, FDs: 9, UptimeSec: 42}
	ts, cookie := metricsSetup(t, adminResolver, fakeMetricsCollector{snap: want})
	status, body := metricsGet(t, ts, cookie)
	if status != http.StatusOK {
		t.Fatalf("管理员查询应 200，实际 %d body=%s", status, body)
	}
	var got metricsBody
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v body=%s", err, body)
	}
	if got.CPUPercent != want.CPUPercent || got.RSSKiB != want.RSSKiB ||
		got.DiskUsedKiB != want.DiskUsedKiB || got.DiskTotalKiB != want.DiskTotalKiB ||
		got.Load1 != want.Load1 || got.Goroutines != want.Goroutines ||
		got.FDs != want.FDs || got.UptimeSec != want.UptimeSec {
		t.Fatalf("字段映射不一致: %+v", got)
	}
	for _, key := range []string{"cpu_pct", "rss_kib", "disk_used_kib", "disk_total_kib",
		"load1", "goroutines", "fds", "uptime_sec"} {
		if !strings.Contains(string(body), `"`+key+`"`) {
			t.Fatalf("响应缺少契约字段 %q: %s", key, body)
		}
	}
}

// TestSystemMetricsNoCookie 无会话 → 401（withAuth 拦截）。
func TestSystemMetricsNoCookie(t *testing.T) {
	ts, _ := metricsSetup(t, adminResolver, fakeMetricsCollector{})
	if status, body := metricsGet(t, ts, ""); status != http.StatusUnauthorized {
		t.Fatalf("无 session 应 401，实际 %d body=%s", status, body)
	}
}

// TestSystemMetricsLowCapability 仅 site:read → 401（fail-closed）。
func TestSystemMetricsLowCapability(t *testing.T) {
	ts, cookie := metricsSetup(t, siteOnlyResolver, fakeMetricsCollector{})
	status, body := metricsGet(t, ts, cookie)
	if status != http.StatusUnauthorized || !strings.Contains(string(body), "system:read") {
		t.Fatalf("低权访问应 401 且说明 system:read，实际 %d body=%s", status, body)
	}
}

// TestSystemMetricsUnsupported 非 Linux 的 ErrUnsupported 映射为 501 E_UNSUPPORTED。
func TestSystemMetricsUnsupported(t *testing.T) {
	ts, cookie := metricsSetup(t, adminResolver, fakeMetricsCollector{err: metrics.ErrUnsupported})
	status, body := metricsGet(t, ts, cookie)
	if status != http.StatusNotImplemented || !strings.Contains(string(body), "E_UNSUPPORTED") {
		t.Fatalf("不支持平台应 501 E_UNSUPPORTED，实际 %d body=%s", status, body)
	}
}
