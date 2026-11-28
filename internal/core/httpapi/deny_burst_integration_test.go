package httpapi

import (
	"strconv"
	"testing"
	"time"
)

// countingCapabilityAuditor 记录 AuditWithDetail 的 detail，断言合并元数据落库。
type countingCapabilityAuditor struct {
	details []map[string]string
}

func (a *countingCapabilityAuditor) AuditWithDetail(_, _, _, _ string, detail map[string]string) {
	cp := make(map[string]string, len(detail))
	for k, v := range detail {
		cp[k] = v
	}
	a.details = append(a.details, cp)
}

// countingDenyAlertSink 记录每次 PutAlertCounted 的 n；实现 AlertSink 其余方法为 no-op。
type countingDenyAlertSink struct {
	counts []int
}

func (s *countingDenyAlertSink) PutAlert(_, _, _, _ string) (AlertView, error) {
	return AlertView{}, nil
}
func (s *countingDenyAlertSink) PutAlertCounted(_, _, _, _ string, n int) (AlertView, error) {
	s.counts = append(s.counts, n)
	return AlertView{Count: n}, nil
}
func (s *countingDenyAlertSink) ListAlerts(AlertQuery) ([]AlertView, int, error) {
	return nil, 0, nil
}
func (s *countingDenyAlertSink) MarkAlertSeen(string) error { return nil }

// newDenyBurstServer 组装带固定时钟的 Server，注入计数审计/告警出口。
func newDenyBurstServer(t *testing.T, now time.Time) (*Server, *countingCapabilityAuditor, *countingDenyAlertSink) {
	t.Helper()
	auditor := &countingCapabilityAuditor{}
	sink := &countingDenyAlertSink{}
	srv := New(Options{CapabilityAuditorDetailed: auditor, Alerts: sink}, nil)
	srv.now = func() time.Time { return now }
	return srv, auditor, sink
}

// TestAuditDeniedMergedEndToEnd 真 auditDenied 出口：同键 12 次拒绝 →
// 审计 10 逐条 + 1 合并(count=1)，告警首次立即 1 + 触发点一次 11（守恒 12）。
func TestAuditDeniedMergedEndToEnd(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	srv, auditor, sink := newDenyBurstServer(t, now)
	for i := 0; i < DenyBurstThreshold+2; i++ {
		srv.auditDenied("token:abc12345", "credentials", "", "", "需要 system:admin 能力")
	}
	// 审计：10 条逐条 + 1 条 count=1 合并（第 12 次 pending，未滚窗未补齐）。
	if len(auditor.details) != DenyBurstThreshold+1 {
		t.Fatalf("审计记录数应为 %d，实际 %d", DenyBurstThreshold+1, len(auditor.details))
	}
	merged := 0
	for _, d := range auditor.details {
		if d["count"] != "" {
			merged++
			if d["count"] != "1" || d["window_ms"] != "1000" ||
				d["first_at"] == "" || d["last_at"] == "" || d["reason"] == "" {
				t.Fatalf("合并元数据非法: %+v", d)
			}
		}
	}
	if merged != 1 {
		t.Fatalf("应有 1 条合并记录，实际 %d", merged)
	}
	// 告警：首次 1 + 触发点 10 = 11（第 12 次仍在 pending，滚窗才补齐）。
	alertTotal := 0
	for _, n := range sink.counts {
		alertTotal += n
	}
	if alertTotal != DenyBurstThreshold+1 {
		t.Fatalf("告警 count 应为首次+触发点=%d，实际 Σ=%d（counts=%v）",
			DenyBurstThreshold+1, alertTotal, sink.counts)
	}
	// 关键：突发段的 12 次拒绝只有 2 次 PutAlertCounted 调用（首次 + 触发点），
	// 消掉了每拒绝一次一次读改写事务（方案候选②）。
	if len(sink.counts) != 2 {
		t.Fatalf("PutAlertCounted 调用次数应为 2，实际 %d（%v）", len(sink.counts), sink.counts)
	}
	// 滚窗补齐 pending：审计侧补第 12 次 count=1，告警侧补第 12 次 count=1，
	// 本次新拒绝（新窗口首条）各再计 1 → 两侧均守恒 == 12+1=13。
	now2 := now.Add(2 * DenyBurstWindow)
	srv.now = func() time.Time { return now2 }
	srv.auditDenied("token:abc12345", "credentials", "", "", "需要 system:admin 能力")
	auditTotal, alertTotalAll := 0, 0
	for _, d := range auditor.details {
		if d["count"] != "" {
			n, _ := strconv.Atoi(d["count"])
			auditTotal += n
		} else {
			auditTotal++
		}
	}
	for _, n := range sink.counts {
		alertTotalAll += n
	}
	if auditTotal != DenyBurstThreshold+3 || alertTotalAll != DenyBurstThreshold+3 {
		t.Fatalf("滚窗后守恒失败: audit=%d alert=%d，期望 %d",
			auditTotal, alertTotalAll, DenyBurstThreshold+3)
	}
}

// TestDenyBurstOtherKeyNotMerged 不同窗口键（不同插件/目标）互不合并：
// root.action 通道拒绝（plugin=system,target=root-action）与凭据拒绝是不同键，
// 连续 30 次通道拒绝独立成窗，不会并入凭据拒绝的合并记录。
func TestDenyBurstOtherKeyNotMerged(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	srv, auditor, sink := newDenyBurstServer(t, now)
	// deny 出口连续 12 次：触发合并。
	for i := 0; i < DenyBurstThreshold+2; i++ {
		srv.auditDenied("token:abc12345", "credentials", "", "", "需要 system:admin 能力")
	}
	denyRecords := len(auditor.details)
	alertCalls := len(sink.counts)
	// 通道拒绝（不同 key）：独立窗口。
	const channelDenials = 30
	for i := 0; i < channelDenials; i++ {
		srv.auditDenied("channel", "system", "root-action", "", "插件不得调用系统重启")
	}
	// 该键独立成窗，但逐条审计写受全局预算约束（task-307）：凭据键已用掉
	// Threshold 条逐条预算，通道键前 10 次走 pending，第 11 次触发一条
	// count=Threshold+1 的合并记录（第 30 次的 pending 未滚窗未补齐）。
	if got := len(auditor.details) - denyRecords; got != 1 {
		t.Fatalf("全局预算耗尽后不同键触发点应写 1 条合并记录，实际新增 %d 条", got)
	}
	merged := auditor.details[len(auditor.details)-1]
	if merged["count"] != strconv.Itoa(DenyBurstThreshold+1) {
		t.Fatalf("通道键合并 count 应为 %d，实际 %q", DenyBurstThreshold+1, merged["count"])
	}
	// 两键的告警也各自独立计数，不串台。
	if len(sink.counts) <= alertCalls {
		t.Fatal("不同键应各自写告警")
	}
}
