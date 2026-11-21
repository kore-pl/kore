package registry_test

import (
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/registry"
)

// TestDetectCycleNoCycle 验证无环图返回 nil（含缺失依赖节点）。
func TestDetectCycleNoCycle(t *testing.T) {
	graph := map[string][]string{
		"site":     {"db-mysql"},
		"monitor":  {"site", "db-mysql"},
		"db-mysql": nil,
		"ext":      {"未安装的依赖"},
	}
	if cycle := registry.DetectCycle(graph); cycle != nil {
		t.Fatalf("无环图不应返回环，实际 %v", cycle)
	}
}

// TestDetectCycleThreeNodes 验证 a→b→c→a 的环路径首尾闭合。
func TestDetectCycleThreeNodes(t *testing.T) {
	graph := map[string][]string{
		"a": {"b"},
		"b": {"c"},
		"c": {"a"},
	}
	cycle := registry.DetectCycle(graph)
	if len(cycle) != 4 {
		t.Fatalf("环路径应有 4 个节点（含闭合），实际 %v", cycle)
	}
	if cycle[0] != cycle[len(cycle)-1] {
		t.Fatalf("环路径应首尾同一节点，实际 %v", cycle)
	}
	joined := strings.Join(cycle, ",")
	for _, id := range []string{"a", "b", "c"} {
		if !strings.Contains(joined, id) {
			t.Fatalf("环路径缺少 %s：%v", id, cycle)
		}
	}
}

// TestDetectCycleSelfReference 验证自依赖 a→a 也被识别为环。
func TestDetectCycleSelfReference(t *testing.T) {
	cycle := registry.DetectCycle(map[string][]string{"a": {"a"}})
	if len(cycle) != 2 || cycle[0] != "a" || cycle[1] != "a" {
		t.Fatalf("自依赖应返回 a→a，实际 %v", cycle)
	}
}

// TestDetectCycleEmpty 空图返回 nil。
func TestDetectCycleEmpty(t *testing.T) {
	if cycle := registry.DetectCycle(nil); cycle != nil {
		t.Fatalf("空图不应有环，实际 %v", cycle)
	}
}
