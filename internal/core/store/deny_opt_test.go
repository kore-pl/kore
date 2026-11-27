package store

import (
	"testing"
	"time"
)

// TestPutAlertCountedSingleTransaction 一次 PutAlertCounted(n) 等价于 n 次拒绝
// 合并到同一条告警：count 累加 n，5 分钟窗口内与既有 PutAlert 合并语义一致。
func TestPutAlertCountedSingleTransaction(t *testing.T) {
	s, err := Open(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	if _, err := s.PutAlertCounted(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "detail", 12); err != nil {
		t.Fatalf("PutAlertCounted 失败: %v", err)
	}
	rows, _, err := s.ListAlerts(AlertFilter{})
	if err != nil {
		t.Fatalf("读取告警失败: %v", err)
	}
	if len(rows) != 1 || rows[0].Count != 12 {
		t.Fatalf("告警应 count=12，实际 %+v", rows)
	}
	// 再累加 3 次：同 title+source 5 分钟窗口内合并，count=15。
	if _, err := s.PutAlertCounted(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "detail2", 3); err != nil {
		t.Fatalf("二次 PutAlertCounted 失败: %v", err)
	}
	rows, _, _ = s.ListAlerts(AlertFilter{})
	if len(rows) != 1 || rows[0].Count != 15 || rows[0].Detail != "detail2" {
		t.Fatalf("告警合并应 count=15 且 detail 取最新，实际 %+v", rows)
	}
	// n<1 拒绝（fail-closed，不写库）。
	if _, err := s.PutAlertCounted(AlertSeverityCritical, AlertSourceAudit, "x", "", 0); err == nil {
		t.Fatal("n=0 必须拒绝")
	}
}

// TestTrimAuditToMax 按量上限：仅删除最旧记录，未到期/新增记录保留，
// batch 限制生效，坏键不参与容量清理。
func TestTrimAuditToMax(t *testing.T) {
	s, err := Open(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	base := time.Unix(1_700_000_000, 0)
	// 写 10 条，时间递增。
	for i := 0; i < 10; i++ {
		putAuditAt(t, s, base.Add(time.Duration(i)*time.Second), i, "deny")
	}
	count, err := s.CountAudit()
	if err != nil || count != 10 {
		t.Fatalf("CountAudit=%d err=%v，期望 10", count, err)
	}
	// 上限 6 → 删 4 条最旧，剩 6 条。
	deleted, more, err := s.TrimAuditToMax(6, 100)
	if err != nil || deleted != 4 || more {
		t.Fatalf("TrimAuditToMax(6,100) = deleted=%d more=%v err=%v", deleted, more, err)
	}
	count, _ = s.CountAudit()
	if count != 6 {
		t.Fatalf("清理后应剩 6 条，实际 %d", count)
	}
	// 最旧 4 条已删（action=deny 剩 6）。
	rows, _ := s.ListAudit(AuditFilter{Action: "deny"})
	if len(rows) != 6 {
		t.Fatalf("按量清理只删最旧，实际剩 %d 条", len(rows))
	}
	// batch=2 限制：上限 3 时需删 3 条，但 batch=2 → 只删 2，more=true。
	deleted, more, err = s.TrimAuditToMax(3, 2)
	if err != nil || deleted != 2 || !more {
		t.Fatalf("batch 限制失败: deleted=%d more=%v err=%v", deleted, more, err)
	}
	count, _ = s.CountAudit()
	if count != 4 {
		t.Fatalf("batch=2 后应剩 4 条，实际 %d", count)
	}
	// 上限 ≥ 总数：不删。
	deleted, more, err = s.TrimAuditToMax(100, 100)
	if err != nil || deleted != 0 || more {
		t.Fatalf("未超上限不应删除: deleted=%d more=%v err=%v", deleted, more, err)
	}
	// 非法参数拒绝。
	if _, _, err := s.TrimAuditToMax(0, 100); err == nil {
		t.Fatal("max=0 必须拒绝")
	}
}
