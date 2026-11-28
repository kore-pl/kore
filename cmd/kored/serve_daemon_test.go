package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestServeWalkingSkeleton 打通 enable → invoke ping → kill -9 → 重启计数 → disable。
func TestServeWalkingSkeleton(t *testing.T) {
	h := newHarness(t, pluginSpec{ID: "echo", Lifecycle: "resident"})
	code, body, header := h.do(http.MethodPost, pluginPath("echo", "enable"), nil,
		map[string]string{"X-Request-ID": "r-e2e-0001"})
	if code != http.StatusOK {
		t.Fatalf("enable 状态码 = %d，期望 200：%s", code, body)
	}
	if got := header.Get("X-Request-ID"); got != "r-e2e-0001" {
		t.Fatalf("X-Request-ID 应回显 r-e2e-0001，实际 %q", got)
	}
	status := decodeStatus(t, body)
	if status.State != "ready" || status.PID == 0 {
		t.Fatalf("enable 后应 ready 且有 pid，实际 %+v", status)
	}
	if !status.Enabled || status.Desired != "enabled" {
		t.Fatalf("enable 后 enabled/desired 不符：%+v", status)
	}

	code, body, _ = h.do(http.MethodPost, "/api/v1/invoke/echo/ping", []byte(`{}`), nil)
	if code != http.StatusOK {
		t.Fatalf("invoke ping 状态码 = %d，期望 200：%s", code, body)
	}
	if got := strings.TrimSpace(string(body)); got != `{"pong":true}` {
		t.Fatalf("invoke ping 结果 = %s，期望 {\"pong\":true}", got)
	}

	code, body, _ = h.do(http.MethodGet, "/api/v1/system/info", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("system/info 状态码 = %d", code)
	}
	var info systemResponse
	if err := json.Unmarshal(body, &info); err != nil {
		t.Fatalf("解码 system/info 失败: %v", err)
	}
	if info.Supervisor.Resident != 1 {
		t.Fatalf("system/info resident = %d，期望 1", info.Supervisor.Resident)
	}

	pid := status.PID
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatalf("定位插件进程失败: %v", err)
	}
	if err := process.Kill(); err != nil {
		t.Fatalf("kill -9 插件失败: %v", err)
	}
	_ = process.Release()
	crashed := h.waitState("echo", 3*time.Second, "failed")
	if crashed.Restarts < 1 {
		t.Fatalf("kill -9 后 restarts 应 ≥1，实际 %+v", crashed)
	}

	code, body, _ = h.do(http.MethodPost, pluginPath("echo", "disable"), nil, nil)
	if code != http.StatusOK {
		t.Fatalf("disable 状态码 = %d，期望 200：%s", code, body)
	}
	if got := decodeStatus(t, body); got.State != "stopped" {
		t.Fatalf("disable 后 state 应为 stopped，实际 %+v", got)
	}
	if processAlive(pid) {
		t.Fatalf("disable 后进程 %d 不应存活", pid)
	}
}

// TestEnableIdempotent 验证重复 enable 不换进程、不增重启计数。
func TestEnableIdempotent(t *testing.T) {
	h := newHarness(t, pluginSpec{ID: "echo", Lifecycle: "resident"})
	first := decodeStatus(t, enable(t, h, "echo"))
	second := decodeStatus(t, enable(t, h, "echo"))
	if first.PID == 0 || first.PID != second.PID {
		t.Fatalf("重复 enable 不得换进程：%d → %d", first.PID, second.PID)
	}
	if second.Restarts != 0 {
		t.Fatalf("重复 enable 不应增加重启计数，实际 %d", second.Restarts)
	}
}

// TestDisableStopsProcess 验证 disable 幂等且进程消失。
func TestDisableStopsProcess(t *testing.T) {
	h := newHarness(t, pluginSpec{ID: "echo", Lifecycle: "resident"})
	pid := decodeStatus(t, enable(t, h, "echo")).PID
	for i := 0; i < 2; i++ {
		code, body, _ := h.do(http.MethodPost, pluginPath("echo", "disable"), nil, nil)
		if code != http.StatusOK {
			t.Fatalf("第 %d 次 disable 状态码 = %d：%s", i+1, code, body)
		}
	}
	if processAlive(pid) {
		t.Fatalf("disable 后进程 %d 不应存活", pid)
	}
	code, body, _ := h.do(http.MethodGet, pluginPath("", ""), nil, nil)
	if code != http.StatusOK {
		t.Fatalf("列表状态码 = %d", code)
	}
	status := decodeList(t, body)[0]
	if status.State != "stopped" || status.PID != 0 || status.Desired != "disabled" {
		t.Fatalf("disable 后列表视图不符：%+v", status)
	}
}

// TestInvokeNotEnabledConflict 验证未启用插件调用返回 409 E_CONFLICT（CORE §2.4）。
// P1-3 / hands-on-r51：message 主文案必须白话、指真实入口，不得甩内部 API 动词。
func TestInvokeNotEnabledConflict(t *testing.T) {
	h := newHarness(t, pluginSpec{ID: "echo", Lifecycle: "resident"})
	code, body, _ := h.do(http.MethodPost, "/api/v1/invoke/echo/ping", []byte(`{}`), nil)
	if code != http.StatusConflict {
		t.Fatalf("未启用调用状态码 = %d，期望 409：%s", code, body)
	}
	problem := decodeError(t, body)
	if got := problem.Code; got != "E_CONFLICT" {
		t.Fatalf("错误码 = %q，期望 E_CONFLICT", got)
	}
	// 白话锚点：给"怎么办"且指向真实存在的「软件商店 → 插件管理」入口。
	if !strings.Contains(problem.Message, "软件商店") || !strings.Contains(problem.Message, "启用") {
		t.Fatalf("未启用文案应白话并给出可操作入口，实际 %q", problem.Message)
	}
	// 内部 API 动词 / 路径不得进 message 与 detail（detail 会被前端当 hint 展示）。
	for _, leak := range []string{"POST", "/api/v1/", "/enable"} {
		if strings.Contains(problem.Message, leak) || strings.Contains(problem.Detail, leak) {
			t.Fatalf("未启用文案不得暴露内部 API 动词 %q：message=%q detail=%q", leak, problem.Message, problem.Detail)
		}
	}
}

// TestEnableUnknownNotFound 验证未安装插件 enable 返回 404 E_NOTFOUND。
func TestEnableUnknownNotFound(t *testing.T) {
	h := newHarness(t)
	code, body, _ := h.do(http.MethodPost, pluginPath("ghost", "enable"), nil, nil)
	if code != http.StatusNotFound {
		t.Fatalf("未安装插件 enable 状态码 = %d，期望 404：%s", code, body)
	}
	if got := decodeError(t, body).Code; got != "E_NOTFOUND" {
		t.Fatalf("错误码 = %q，期望 E_NOTFOUND", got)
	}
}

// TestLazyEnableAccepted 验证 M2：lazy 插件 enable 返回 200，只标记 desired=enabled 不起进程。
func TestLazyEnableAccepted(t *testing.T) {
	h := newHarness(t, pluginSpec{ID: "lazy", Lifecycle: "lazy"})
	code, body, _ := h.do(http.MethodPost, pluginPath("lazy", "enable"), nil, nil)
	if code != http.StatusOK {
		t.Fatalf("lazy enable 状态码 = %d，期望 200：%s", code, body)
	}
	_, listBody, _ := h.do(http.MethodGet, pluginPath("", ""), nil, nil)
	status := decodeList(t, listBody)[0]
	if status.State != "stopped" || status.Desired != "enabled" || status.PID != 0 {
		t.Fatalf("lazy enable 后应 desired=enabled 且未起进程，实际 %+v", status)
	}
}
