package main

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/store"
)

// TestRootActionNeedRootIntegration 隔离装配的 kored（非 root）调用 root-action：
// 期望 403 + E_NEED_ROOT + hint，并落一条 root.action 的 deny 审计。
//
// 本机非 root 时这是环境的真实结果；若以 root 跑测试则跳过（避免真的拉 systemd unit）。
func TestRootActionNeedRootIntegration(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("当前以 root 运行，跳过拒绝路径断言（真实提权需单独验证）")
	}
	h := newHarness(t, pluginSpec{
		ID: "firewall", Lifecycle: "lazy", RequiresRoot: true,
		RootActions: []map[string]any{{
			"id": "ufw-status", "argv": []string{"ufw", "status", "verbose"},
			"timeout_s": 5, "description": "读取 ufw 状态",
		}},
	})

	// 插件视图应暴露 requires_root + root_actions（UI 启用确认用）。
	code, body, _ := h.do(http.MethodGet, pluginPath("firewall", ""), nil, nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"requires_root":true`) ||
		!strings.Contains(string(body), `"ufw-status"`) {
		t.Fatalf("插件视图应含 requires_root/root_actions，状态 %d body=%s", code, body)
	}

	code, body, _ = h.do(http.MethodPost, "/api/v1/plugins/firewall/root-action",
		[]byte(`{"action_id":"ufw-status"}`), map[string]string{"Content-Type": "application/json"})
	if code != http.StatusForbidden {
		t.Fatalf("非 root 应 403，实际 %d body=%s", code, body)
	}
	if !strings.Contains(string(body), "E_NEED_ROOT") || !strings.Contains(string(body), `"hint"`) {
		t.Fatalf("响应应为 E_NEED_ROOT + hint，实际 %s", body)
	}

	records, err := h.svc.db.ListAudit(store.AuditFilter{Action: "root.action", Plugin: "firewall"})
	if err != nil {
		t.Fatalf("读取审计失败: %v", err)
	}
	if len(records) != 1 || records[0].Result != "denied" ||
		records[0].Detail["decision"] != "deny" || records[0].Detail["deny_reason"] != "not_root" {
		t.Fatalf("应有且仅有一条 deny 审计，实际 %+v", records)
	}
}
