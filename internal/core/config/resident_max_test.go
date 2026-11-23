package config

import (
	"os"
	"strings"
	"testing"
)

// TestResidentMaxDefaultsAndParse 验证 resident_max 默认 2、可从 resources 段覆盖。
func TestResidentMaxDefaultsAndParse(t *testing.T) {
	if got := Default().Resources.ResidentMax; got != 2 {
		t.Fatalf("默认 resident_max = %d，期望 2", got)
	}
	path := writeConfig(t, t.TempDir(), "resources:\n  resident_max: 1\n")
	snap, _, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("resident_max=1 应合法，实际: %v", err)
	}
	if snap.Resources.ResidentMax != 1 {
		t.Fatalf("resident_max = %d，期望 1", snap.Resources.ResidentMax)
	}
}

// TestResidentMaxValidation 验证范围 1–3：3 允许（放弃保护），0 / 4 拒绝。
func TestResidentMaxValidation(t *testing.T) {
	cases := []struct {
		name  string
		value string
		ok    bool
	}{
		{"下界1", "1", true},
		{"默认2", "2", true},
		{"放弃保护3", "3", true},
		{"越界0", "0", false},
		{"越界4", "4", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, t.TempDir(), "resources:\n  resident_max: "+tc.value+"\n")
			_, _, err := loadFile(t, path)
			if tc.ok {
				if err != nil {
					t.Fatalf("resident_max=%s 应合法，实际: %v", tc.value, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("resident_max=%s 应被拒绝，实际通过", tc.value)
			}
			if !strings.Contains(err.Error(), "resources.resident_max") {
				t.Fatalf("错误信息应包含字段名，实际: %v", err)
			}
		})
	}
}

// TestReloadResidentMaxRequiresRestart 验证槽位配额不热更：保留旧值并给出
// 「不可热更，需重启内核」WARN，避免配置显示值与运行值漂移。
func TestReloadResidentMaxRequiresRestart(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "resources:\n  resident_max: 2\n")
	old, _, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("初始加载失败: %v", err)
	}
	if err := os.WriteFile(path, []byte("resources:\n  resident_max: 1\n"), 0o600); err != nil {
		t.Fatalf("改写配置失败: %v", err)
	}
	next, warnings, err := old.Reload(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	if next.Resources.ResidentMax != 2 {
		t.Fatalf("resident_max 不可热更，应保留旧值 2，实际 %d", next.Resources.ResidentMax)
	}
	found := false
	for _, w := range warnings {
		if w.Key == "resources.resident_max" && strings.Contains(w.Message, "不可热更") {
			found = true
		}
	}
	if !found {
		t.Fatalf("缺少 resources.resident_max 不可热更 WARN: %v", warnings)
	}
}
