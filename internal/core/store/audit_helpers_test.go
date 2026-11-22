package store

import (
	"path/filepath"
	"testing"
)

// openAuditStore 打开一个独立状态库，测试结束自动关闭。
func openAuditStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "state"), testLogger())
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// assertAuditKeys 断言键为 %020d-%06d 且按字典序严格递增（字典序 = 时间序）。
func assertAuditKeys(t *testing.T, keys []string) {
	t.Helper()
	previous := ""
	for _, key := range keys {
		if len(key) != 27 || key[20] != '-' {
			t.Fatalf("审计键格式应为 %%020d-%%06d（27 字符、第 21 位为 '-'），实际 %q", key)
		}
		if _, _, ok := parseAuditKey(key); !ok {
			t.Fatalf("审计键两段应为十进制数字（%%020d-%%06d），实际 %q", key)
		}
		if previous != "" && key <= previous {
			t.Fatalf("审计键应严格递增（字典序 = 时间序）：%q <= %q", key, previous)
		}
		previous = key
	}
}
