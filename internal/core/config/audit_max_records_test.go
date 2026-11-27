package config

import "testing"

// TestAuditMaxRecordsDefaultParseValidate audit.max_records 默认 100000，
// 显式值可解析、越界值被校验拒绝、热更不生效（冷字段，重启才重建任务参数）。
func TestAuditMaxRecordsDefaultParseValidate(t *testing.T) {
	base, _, err := loadFile(t, writeConfig(t, t.TempDir(), ""))
	if err != nil {
		t.Fatalf("空配置加载失败: %v", err)
	}
	if base.Audit.MaxRecords != 100000 {
		t.Fatalf("audit.max_records 默认应为 100000，实际 %d", base.Audit.MaxRecords)
	}
	snap, warns, err := loadFile(t, writeConfig(t, t.TempDir(),
		"audit:\n  max_records: 50000\n"))
	if err != nil {
		t.Fatalf("显式 max_records 解析失败: %v", err)
	}
	if len(warns) > 0 {
		t.Fatalf("合规 max_records 不应有校验 WARN: %v", warns)
	}
	if snap.Audit.MaxRecords != 50000 {
		t.Fatalf("max_records 解析错误: %d", snap.Audit.MaxRecords)
	}
	// 越界：>1000000 必须校验拒绝（validate 是硬错误，不是 WARN）。
	_, _, err = loadFile(t, writeConfig(t, t.TempDir(),
		"audit:\n  max_records: 2000000\n"))
	if err == nil {
		t.Fatal("max_records=2000000 应被配置校验拒绝")
	}
}
