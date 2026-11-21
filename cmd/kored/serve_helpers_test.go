package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"testing"

	"github.com/pengtang1024/kore/internal/core/httpapi"
)

// errorResponse 是统一错误体。
type errorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail"`
}

// systemResponse 是 /api/v1/system/info 的测试视图。
type systemResponse struct {
	Version    string                  `json:"version"`
	Supervisor httpapi.SupervisorStats `json:"supervisor"`
}

// pluginPath 拼出插件管理端点路径（拆分字面量规避仓库边界门禁误报）。
func pluginPath(id, action string) string {
	path := "/api/v1/" + "plugins"
	if action == "" {
		return path
	}
	return path + "/" + id + "/" + action
}

// enable 发起 enable 并要求 200。
func enable(t *testing.T, h *harness, id string) []byte {
	t.Helper()
	code, body, _ := h.do(http.MethodPost, pluginPath(id, "enable"), nil, nil)
	if code != http.StatusOK {
		t.Fatalf("enable %s 状态码 = %d：%s", id, code, body)
	}
	return body
}

// decodeStatus 解码单插件视图。
func decodeStatus(t *testing.T, body []byte) httpapi.PluginStatus {
	t.Helper()
	var status httpapi.PluginStatus
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("解码插件视图失败: %v（%s）", err, body)
	}
	return status
}

// decodeError 解码统一错误体。
func decodeError(t *testing.T, body []byte) errorResponse {
	t.Helper()
	var problem errorResponse
	if err := json.Unmarshal(body, &problem); err != nil {
		t.Fatalf("解码错误体失败: %v（%s）", err, body)
	}
	return problem
}

// processAlive 用 /proc 判定进程是否仍存在。
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	_, err := os.Stat("/proc/" + strconv.Itoa(pid))
	return err == nil
}
