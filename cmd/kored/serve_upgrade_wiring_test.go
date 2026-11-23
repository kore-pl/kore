package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// TestSelfUpdateEndpointsWiredThroughDaemon 是**装配级**回归测试。
//
// 覆盖的是单测覆盖不到的盲区：`selfUpdater` 本体单测只证明实现正确，
// `httpapi/selfupdate_test.go` 用的是 fakeSelfUpdater，也只证明 HTTP 契约正确——
// 两者都不检查「真实 daemon 有没有实现 httpapi.SelfUpdater」。曾经 `serve_runtime.go`
// 只把实现赋给 `daemon.selfUpdate` 而没有转发方法，HTTP 层类型断言失败，四个端点全 501，
// 而上述两类测试全绿。本测试用真实 `buildService` 装配 + 真实 `httpapi`，断言非 501。
func TestSelfUpdateEndpointsWiredThroughDaemon(t *testing.T) {
	h := newHarness(t) // 真实 buildService（含 selfUpdate 注入）+ 真实 httpapi（不是假 backend）

	if h.svc.backend.selfUpdate == nil {
		t.Fatal("装配断线：buildService 未给 daemon.selfUpdate 注入实现")
	}
	// 把 euid 钉成非 root：POST 在 preflight 的 root 检查处返回，
	// 不会真正启动升级子进程，也不碰工作区里的 bin/kored。
	h.svc.backend.selfUpdate.deps.euid = func() int { return 1000 }

	// 1) GET 状态：必须是 200 + 可解析的 SelfUpdateStatus（非 root → can_upgrade=false 且有原因）。
	code, body, _ := h.do(http.MethodGet, "/api/v1/system/upgrade", nil, nil)
	if code == http.StatusNotImplemented {
		t.Fatalf("GET /system/upgrade 仍是 501：Backend 未实现 httpapi.SelfUpdater（装配断线）；body=%s", body)
	}
	if code != http.StatusOK {
		t.Fatalf("GET /system/upgrade 状态码 = %d，期望 200；body=%s", code, body)
	}
	var status httpapi.SelfUpdateStatus
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("状态响应不是 SelfUpdateStatus：%v；body=%s", err, body)
	}
	if status.Current.Path == "" {
		t.Fatalf("状态响应缺少 current.path：%+v", status)
	}
	if status.CanUpgrade || status.Reason == "" {
		t.Fatalf("非 root 时 can_upgrade 应为 false 且给出原因：%+v", status)
	}

	// 2) POST 发起升级：必须真正进入 selfUpdater（非 root → 403 E_NEED_ROOT），不能是 501。
	jsonHeader := map[string]string{"Content-Type": "application/json"}
	startBody := `{"source_path":"/nonexistent/kored","sha256":"` + strings.Repeat("a", 64) + `","confirm":true}`
	code, body, _ = h.do(http.MethodPost, "/api/v1/system/upgrade", []byte(startBody), jsonHeader)
	assertEnteredSelfUpdater(t, "POST /system/upgrade", code, body, pluginapi.E_NEED_ROOT)

	// 3) GET 任务进度：进入 selfUpdater 后未知任务 → 404，不是 501。
	code, body, _ = h.do(http.MethodGet, "/api/v1/system/upgrade/jobs/does-not-exist", nil, nil)
	if code == http.StatusNotImplemented {
		t.Fatalf("GET /system/upgrade/jobs/{id} 仍是 501：装配断线；body=%s", body)
	}
	if code != http.StatusNotFound {
		t.Fatalf("未知 job 状态码 = %d，期望 404；body=%s", code, body)
	}

	// 4) POST 回滚：同样必须进入 selfUpdater（非 root → 403 E_NEED_ROOT）。
	code, body, _ = h.do(http.MethodPost, "/api/v1/system/upgrade/rollback", []byte(`{"confirm":true}`), jsonHeader)
	assertEnteredSelfUpdater(t, "POST /system/upgrade/rollback", code, body, pluginapi.E_NEED_ROOT)
}

// assertEnteredSelfUpdater 断言请求已穿过 HTTP 层进入 selfUpdater（而不是在类型断言处 501）。
//
// wantCode 是 selfUpdater 返回的协议错误码（这里固定 E_NEED_ROOT，因为 euid 已钉成非 root）。
func assertEnteredSelfUpdater(t *testing.T, what string, code int, body []byte, wantCode string) {
	t.Helper()
	if code == http.StatusNotImplemented {
		t.Fatalf("%s 仍是 501：Backend 未实现 httpapi.SelfUpdater（装配断线）；body=%s", what, body)
	}
	if code != http.StatusForbidden {
		t.Fatalf("%s 状态码 = %d，期望 403（E_NEED_ROOT）；body=%s", what, code, body)
	}
	var errBody struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &errBody); err != nil {
		t.Fatalf("%s 错误响应不可解析：%v；body=%s", what, err, body)
	}
	if errBody.Code != wantCode {
		t.Fatalf("%s 错误码 = %q，期望 %q；body=%s", what, errBody.Code, wantCode, body)
	}
}
