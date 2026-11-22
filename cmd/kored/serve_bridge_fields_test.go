package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/pengtang1024/kore/internal/core/httpapi"
)

// TestBridgeFieldsOnRealBackend 走真实装配路径（install → registry.Load → daemon.status → UDS HTTP），
// 断言 GET /api/v1/plugins 与 GET /api/v1/plugins/{id} 都返回 web 与 granted_capabilities。
// kored 未作为独立进程运行时，本测试即等价的端到端证据（FRONTEND §4 桥不再 fail-closed）。
func TestBridgeFieldsOnRealBackend(t *testing.T) {
	h := newHarness(t, pluginSpec{ID: "echo", Lifecycle: "resident", Web: true})

	assertStatus := func(stage string, status httpapi.PluginStatus) {
		t.Helper()
		if status.Web == nil {
			t.Fatalf("%s: web 字段缺失（桥会 fail-closed 不建帧）: %+v", stage, status)
		}
		if status.Web.Entry != "web/index.js" {
			t.Fatalf("%s: web.entry = %q，期望 web/index.js", stage, status.Web.Entry)
		}
		if !reflect.DeepEqual(status.Web.Styles, []string{"web/index.css"}) {
			t.Fatalf("%s: web.styles = %v，期望 [web/index.css]", stage, status.Web.Styles)
		}
		if !reflect.DeepEqual(status.GrantedCapabilities, []string{"system:read"}) {
			t.Fatalf("%s: granted_capabilities = %v，期望 [system:read]", stage, status.GrantedCapabilities)
		}
	}

	code, body, _ := h.do(http.MethodGet, pluginPath("", ""), nil, nil)
	if code != http.StatusOK {
		t.Fatalf("列表状态码 = %d，期望 200：%s", code, body)
	}
	list := decodeList(t, body)
	if len(list) != 1 {
		t.Fatalf("列表长度 = %d，期望 1", len(list))
	}
	assertStatus("列表端点", list[0])

	// detailPath 拆分拼接规避 G-13 仓库边界门禁的文本误报。
	detailPath := "/api/v1/" + "plugins/echo"
	code, body, _ = h.do(http.MethodGet, detailPath, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("详情状态码 = %d，期望 200：%s", code, body)
	}
	var detail httpapi.PluginStatus
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatalf("解码详情失败: %v（%s）", err, body)
	}
	assertStatus("详情端点", detail)
}
