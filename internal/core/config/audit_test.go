package config

import "testing"

// TestAuditInvokeAllDefaultAndParse audit.invoke_all 默认 false，显式 true 可解析。
func TestAuditInvokeAllDefaultAndParse(t *testing.T) {
	base, _, err := loadFile(t, writeConfig(t, t.TempDir(), ""))
	if err != nil {
		t.Fatalf("空配置加载失败: %v", err)
	}
	if base.Audit.InvokeAll {
		t.Fatal("audit.invoke_all 默认必须为 false")
	}
	snap, _, err := loadFile(t, writeConfig(t, t.TempDir(), "audit:\n  invoke_all: true\n"))
	if err != nil {
		t.Fatalf("audit.invoke_all 解析失败: %v", err)
	}
	if !snap.Audit.InvokeAll {
		t.Fatal("audit.invoke_all=true 应解析为 true")
	}
}

// TestAuditInvokeAllHotReload audit.invoke_all 在热更白名单内（SIGHUP 立即生效）。
func TestAuditInvokeAllHotReload(t *testing.T) {
	base, _, err := loadFile(t, writeConfig(t, t.TempDir(), "audit:\n  invoke_all: false\n"))
	if err != nil {
		t.Fatalf("基线配置加载失败: %v", err)
	}
	nextPath := writeConfig(t, t.TempDir(), "audit:\n  invoke_all: true\n")
	merged, _, err := base.Reload(Options{FlagPath: nextPath, Logger: testLogger()})
	if err != nil {
		t.Fatalf("热重载失败: %v", err)
	}
	if !merged.Audit.InvokeAll {
		t.Fatal("audit.invoke_all 应作为热更字段合并为 true")
	}
}
