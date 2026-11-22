package registry_test

import (
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// rootAction 返回一条合法 root_actions 元素。
func rootAction(id string) map[string]any {
	return map[string]any{
		"id": id, "argv": []string{"ufw", "status", "verbose"},
		"timeout_s": 5, "description": "读取 ufw 状态", "irreversible": false,
	}
}

// TestParseRootActions 合法声明被完整解析（requires_root + 固定 argv + irreversible）。
func TestParseRootActions(t *testing.T) {
	manifest := baseManifest()
	action := rootAction("ufw-status")
	action["irreversible"] = true
	manifest["requires_root"] = true
	manifest["root_actions"] = []any{action}
	got := parse(t, manifest)
	if !got.RequiresRoot || len(got.RootActions) != 1 {
		t.Fatalf("requires_root/root_actions 未落位: %+v", got)
	}
	if got.RootActions[0].ID != "ufw-status" || strings.Join(got.RootActions[0].Argv, " ") != "ufw status verbose" {
		t.Fatalf("动作解析错误: %+v", got.RootActions[0])
	}
	if !got.RootActions[0].Irreversible || got.RootActions[0].TimeoutS != 5 {
		t.Fatalf("irreversible/timeout_s 未落位: %+v", got.RootActions[0])
	}
}

// TestParseRootActionsRejects 校验非法声明逐条被拒（E_INVALID）。
func TestParseRootActionsRejects(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"有 root_actions 但未声明 requires_root", func(m map[string]any) {
			m["root_actions"] = []any{rootAction("ufw-status")}
		}},
		{"id 重复", func(m map[string]any) {
			m["requires_root"] = true
			m["root_actions"] = []any{rootAction("ufw-status"), rootAction("ufw-status")}
		}},
		{"id 语法非法", func(m map[string]any) {
			m["requires_root"] = true
			m["root_actions"] = []any{rootAction("UFW_Status")}
		}},
		{"argv0 不在白名单", func(m map[string]any) {
			action := rootAction("evil")
			action["argv"] = []string{"rm", "-rf", "/"}
			m["requires_root"] = true
			m["root_actions"] = []any{action}
		}},
		{"timeout 越界", func(m map[string]any) {
			action := rootAction("ufw-status")
			action["timeout_s"] = 0
			m["requires_root"] = true
			m["root_actions"] = []any{action}
		}},
		{"超过 16 条", func(m map[string]any) {
			actions := make([]any, 0, 17)
			for i := 0; i < 17; i++ {
				actions = append(actions, rootAction("action-"+string(rune('a'+i))))
			}
			m["requires_root"] = true
			m["root_actions"] = actions
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			manifest := baseManifest()
			tc.mutate(manifest)
			_, err := registry.Parse(encode(t, manifest))
			if err == nil {
				t.Fatalf("应拒绝，实际通过")
			}
			if code := codeOf(t, err); code != pluginapi.E_INVALID {
				t.Fatalf("应 E_INVALID，实际 %s: %v", code, err)
			}
		})
	}
}
