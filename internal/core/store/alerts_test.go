package store

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// newAlertStore 打开测试状态库并返回可注入时间源的句柄。
func newAlertStore(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	s, err := Open(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	cur := time.Now()
	s.now = func() time.Time { return cur }
	return s, &cur
}

// TestPutAlertAndListDesc 验证写入后按时间倒序返回（最新在前），id/ts 回填。
func TestPutAlertAndListDesc(t *testing.T) {
	s, cur := newAlertStore(t)
	first, err := s.PutAlert(AlertSeverityWarning, AlertSourceSlot, "常驻槽位已满（3 / 3）", "上限")
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if first.Key == "" || first.TsNs <= 0 || first.Count != 1 || first.Seen {
		t.Fatalf("首条记录字段异常: %+v", first)
	}
	*cur = cur.Add(time.Minute)
	second, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "subject=admin")
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	rows, unread, err := s.ListAlerts(AlertFilter{})
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(rows) != 2 || unread != 2 {
		t.Fatalf("应 2 条 / 未读 2，实际 %d / %d", len(rows), unread)
	}
	if rows[0].Key != second.Key || rows[1].Key != first.Key {
		t.Fatalf("倒序错误: %s, %s", rows[0].Key, rows[1].Key)
	}
}

// TestPutAlertDedupMerge 验证同 title+source 5 分钟内合并：count+1、时刻改写为
// 本次、seen 归 false、不新增条目。
func TestPutAlertDedupMerge(t *testing.T) {
	s, cur := newAlertStore(t)
	first, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "第一次")
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := s.MarkAlertSeen(first.Key); err != nil {
		t.Fatalf("标记已读失败: %v", err)
	}
	rows, unread, err := s.ListAlerts(AlertFilter{})
	if err != nil || len(rows) != 1 || unread != 0 {
		t.Fatalf("已读后应 1 条 / 未读 0，实际 %d / %d（err=%v）", len(rows), unread, err)
	}
	// 窗口内再次发生：合并进同一条，count+1、seen 复位、detail 取最新。
	*cur = cur.Add(2 * time.Minute)
	merged, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "第二次")
	if err != nil {
		t.Fatalf("合并写入失败: %v", err)
	}
	if merged.Count != 2 || merged.Seen || merged.Key == first.Key || merged.Detail != "第二次" {
		t.Fatalf("合并结果异常: %+v", merged)
	}
	rows, unread, err = s.ListAlerts(AlertFilter{})
	if err != nil || len(rows) != 1 || unread != 1 {
		t.Fatalf("合并后应仍 1 条 / 未读 1，实际 %d / %d（err=%v）", len(rows), unread, err)
	}
}

// TestPutAlertMergeWindowExpiry 验证同 title+source 超过 5 分钟后不再合并，新起一条。
func TestPutAlertMergeWindowExpiry(t *testing.T) {
	s, cur := newAlertStore(t)
	if _, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "a"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	*cur = cur.Add(5 * time.Minute)
	if _, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "b"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	rows, _, err := s.ListAlerts(AlertFilter{})
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(rows) != 2 || rows[0].Count != 1 || rows[1].Count != 1 {
		t.Fatalf("窗口过期应 2 条各自 count=1，实际 %+v", rows)
	}
}

// TestPutAlertDifferentTitleOrSource 验证去重键是 title+source：任一不同不合并。
func TestPutAlertDifferentTitleOrSource(t *testing.T) {
	s, _ := newAlertStore(t)
	if _, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "能力校验被拒绝", "a"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if _, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "root 提权动作被拒绝", "b"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if _, err := s.PutAlert(AlertSeverityWarning, AlertSourcePlugin, "能力校验被拒绝", "c"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	rows, _, err := s.ListAlerts(AlertFilter{})
	if err != nil || len(rows) != 3 {
		t.Fatalf("不同 title/source 应各成一条，实际 %d（err=%v）", len(rows), err)
	}
}

// TestAlertsTrimToMax 验证超过 500 条时裁掉最旧、保留最近 500 条。
func TestAlertsTrimToMax(t *testing.T) {
	s, cur := newAlertStore(t)
	oldestKey := ""
	for i := 0; i < AlertMaxRecords+5; i++ {
		rec, err := s.PutAlert(AlertSeverityInfo, AlertSourceResource,
			fmt.Sprintf("裁剪测试（第 %03d 条）", i), "")
		if err != nil {
			t.Fatalf("第 %d 条写入失败: %v", i, err)
		}
		if i == 0 {
			oldestKey = rec.Key
		}
		*cur = cur.Add(10 * time.Second)
	}
	rows, _, err := s.ListAlerts(AlertFilter{})
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(rows) != AlertMaxRecords {
		t.Fatalf("裁剪后应 %d 条，实际 %d", AlertMaxRecords, len(rows))
	}
	// 最旧的 5 条被裁掉：首条键不应再出现。
	for _, r := range rows {
		if r.Key == oldestKey {
			t.Fatalf("最旧记录 %s 未被裁剪", oldestKey)
		}
	}
}

// TestMarkAlertSeen 验证已读标记与未知 id 报错。
func TestMarkAlertSeen(t *testing.T) {
	s, _ := newAlertStore(t)
	rec, err := s.PutAlert(AlertSeverityWarning, AlertSourcePlugin, "插件 failed 运行失败", "")
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := s.MarkAlertSeen(rec.Key); err != nil {
		t.Fatalf("标记失败: %v", err)
	}
	rows, unread, err := s.ListAlerts(AlertFilter{})
	if err != nil || len(rows) != 1 || !rows[0].Seen || unread != 0 {
		t.Fatalf("标记后 seen 应为 true 且未读 0: %+v unread=%d err=%v", rows, unread, err)
	}
	if err := s.MarkAlertSeen("00000000000000000000-000000"); err == nil || !errors.Is(err, ErrNotFound) {
		t.Fatalf("未知 id 应 ErrNotFound，实际 %v", err)
	}
}

// TestPutAlertInvalid 验证 severity/source/title/detail 的写入前校验（不落库）。
func TestPutAlertInvalid(t *testing.T) {
	s, _ := newAlertStore(t)
	cases := []struct{ name, sev, src, title, detail string }{
		{"severity 非法", "high", AlertSourceAudit, "t", ""},
		{"source 非法", AlertSeverityInfo, "frontend", "t", ""},
		{"title 为空", AlertSeverityInfo, AlertSourceAudit, "", ""},
		{"title 超长", AlertSeverityInfo, AlertSourceAudit, string(make([]rune, alertTitleMaxRunes+1)), ""},
		{"detail 超长", AlertSeverityInfo, AlertSourceAudit, "t", string(make([]rune, alertDetailMaxRunes+1))},
	}
	for _, c := range cases {
		if _, err := s.PutAlert(c.sev, c.src, c.title, c.detail); err == nil {
			t.Errorf("%s：应拒绝写入", c.name)
		}
	}
	rows, _, err := s.ListAlerts(AlertFilter{})
	if err != nil || len(rows) != 0 {
		t.Fatalf("非法记录不应落库，实际 %d（err=%v）", len(rows), err)
	}
}

// TestListAlertsSeverityFilter 验证 severity 过滤与未读总数不受过滤影响。
func TestListAlertsSeverityFilter(t *testing.T) {
	s, _ := newAlertStore(t)
	if _, err := s.PutAlert(AlertSeverityCritical, AlertSourceAudit, "critical 一", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutAlert(AlertSeverityInfo, AlertSourceResource, "info 一", ""); err != nil {
		t.Fatal(err)
	}
	rows, unread, err := s.ListAlerts(AlertFilter{Severity: AlertSeverityCritical})
	if err != nil || len(rows) != 1 || rows[0].Severity != AlertSeverityCritical {
		t.Fatalf("severity 过滤异常: %+v err=%v", rows, err)
	}
	if unread != 2 {
		t.Fatalf("未读总数应不受过滤影响（2），实际 %d", unread)
	}
}
