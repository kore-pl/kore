package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pengtang1024/kore/internal/core/envprobe"
)

// newTestServer 构造只测路由的 Server（不绑定监听器，transport 置 nil）。
func newTestServer() *Server {
	return New(Options{
		Version: "0.1.0-test",
		Report: envprobe.Report{
			OS: "linux", Arch: "amd64", Kernel: "6.8.0", CgroupMode: "v2", FSType: "ext4",
		},
	}, nil)
}

// serve 在内存中执行一次请求，不经过真实网络。
func serve(t *testing.T, s *Server, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
	return recorder
}

// TestHealthz 验证探活端点返回 200 + {"status":"ok"}。
func TestHealthz(t *testing.T) {
	recorder := serve(t, newTestServer(), http.MethodGet, "/-/healthz")
	if recorder.Code != http.StatusOK {
		t.Fatalf("健康检查状态码 = %d，期望 200", recorder.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status = %q，期望 ok", body["status"])
	}
}

// TestSystemInfo 验证系统信息包含 capability report 字段与版本。
func TestSystemInfo(t *testing.T) {
	recorder := serve(t, newTestServer(), http.MethodGet, "/api/v1/system/info")
	if recorder.Code != http.StatusOK {
		t.Fatalf("系统信息状态码 = %d，期望 200", recorder.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	for _, key := range []string{"os", "os_version", "arch", "kernel", "cgroup_mode", "delegation",
		"systemd", "selinux", "apparmor", "fs_type", "version"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("系统信息缺少字段 %q: %v", key, body)
		}
	}
	if body["version"] != "0.1.0-test" {
		t.Fatalf("version = %v，期望 0.1.0-test", body["version"])
	}
}

// TestNotFound 验证未知路由返回统一 JSON 错误体。
func TestNotFound(t *testing.T) {
	recorder := serve(t, newTestServer(), http.MethodGet, "/api/v1/nope")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知路由状态码 = %d，期望 404", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if body["code"] != "E_NOTFOUND" || body["message"] == "" {
		t.Fatalf("错误体不符合 {code,message,detail}: %v", body)
	}
}
