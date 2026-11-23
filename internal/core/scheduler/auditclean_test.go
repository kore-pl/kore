package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// enableAuditClean 把服务切到"启用审计清理"的配置，便于逐项断言。
func enableAuditClean(service *Service, retention time.Duration, interval time.Duration, batch int) {
	service.auditEnabled = true
	service.auditRetention = retention
	service.auditInterval = interval
	service.auditBatch = batch
}

// putAuditAt 直接写一条指定时刻的审计记录（绕过 PutAudit 的 time.Now）。
func putAuditAt(t *testing.T, service *Service, at time.Time, seq int, action string) {
	t.Helper()
	key := fmt.Sprintf("%020d-%06d", at.UnixNano(), seq)
	value, err := json.Marshal(store.AuditRecord{Subject: "admin", Action: action, Result: store.AuditResultOK})
	if err != nil {
		t.Fatalf("序列化审计记录失败: %v", err)
	}
	if err := service.store.Update(func(tx *store.Tx) error { return tx.Put("audit", key, value) }); err != nil {
		t.Fatalf("写入审计记录失败: %v", err)
	}
}

// countAudit 统计指定 action 的审计条数（用读取路径，代表"清理后仍可读"）。
func countAudit(t *testing.T, service *Service, action string) int {
	t.Helper()
	records, err := service.store.ListAudit(store.AuditFilter{Action: action})
	if err != nil {
		t.Fatalf("读取审计失败: %v", err)
	}
	return len(records)
}

// TestSyncAuditCleanTask 验收挂载点：配置映射为 scheduler 内置任务，
// 周期与参数落库、重启不推迟下次执行、关闭后禁用。
func TestSyncAuditCleanTask(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	enableAuditClean(service, 90*24*time.Hour, 6*time.Hour, 500)
	if err := service.syncAuditCleanTask(); err != nil {
		t.Fatalf("注册内置清理任务失败: %v", err)
	}
	task, err := service.loadTask(builtinAuditCleanID)
	if err != nil {
		t.Fatalf("读取内置清理任务失败: %v", err)
	}
	if !task.Enabled || task.IntervalS != 21600 || task.Plugin != BuiltinPlugin || task.Method != AuditCleanMethod {
		t.Fatalf("内置清理任务不符合预期: %+v", task)
	}
	if task.Schedule != "" || task.TimeoutS != auditCleanTimeoutS {
		t.Fatalf("清理任务应是 interval 型且带超时: %+v", task)
	}
	if !strings.Contains(string(task.Params), `"retention_seconds":7776000`) ||
		!strings.Contains(string(task.Params), `"batch":500`) {
		t.Fatalf("任务参数应携带保留期与单次上限，实际 %s", task.Params)
	}
	if !task.NextRunAt.Equal(clock.Now().Add(6 * time.Hour)) {
		t.Fatalf("首次下次执行应为 now+6h，实际 %v", task.NextRunAt)
	}
	// 参数未变：同步（模拟重启）不得把 next_run_at 再推后一个周期。
	clock.Set(clock.Now().Add(2 * time.Hour))
	if err := service.syncAuditCleanTask(); err != nil {
		t.Fatalf("二次同步失败: %v", err)
	}
	again, _ := service.loadTask(builtinAuditCleanID)
	if !again.NextRunAt.Equal(task.NextRunAt) {
		t.Fatalf("参数未变时不应推迟下次执行：%v → %v", task.NextRunAt, again.NextRunAt)
	}
	// 关闭开关 → 任务禁用（不删任务，保留最近执行记录）。
	service.auditEnabled = false
	if err := service.syncAuditCleanTask(); err != nil {
		t.Fatalf("关闭内置清理任务失败: %v", err)
	}
	if disabled, _ := service.loadTask(builtinAuditCleanID); disabled.Enabled {
		t.Fatalf("关闭后应禁用内置清理任务: %+v", disabled)
	}
}

// TestAuditCleanTaskDeletesOnlyExpired 验收：通过 scheduler 执行内置任务，
// 只删过期记录，且清理本身写一条审计（可观测）。
func TestAuditCleanTaskDeletesOnlyExpired(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	enableAuditClean(service, 90*24*time.Hour, 6*time.Hour, 1000)
	if err := service.syncAuditCleanTask(); err != nil {
		t.Fatalf("注册内置清理任务失败: %v", err)
	}
	for i := 0; i < 3; i++ {
		putAuditAt(t, service, clock.Now().Add(-91*24*time.Hour), i, "login.failed")
	}
	for i := 0; i < 2; i++ {
		putAuditAt(t, service, clock.Now().Add(-24*time.Hour), i, "invoke.echo.ping")
	}
	task, err := service.loadTask(builtinAuditCleanID)
	if err != nil {
		t.Fatalf("读取任务失败: %v", err)
	}
	run := service.execute(context.Background(), task)
	if run.Status != StatusOK {
		t.Fatalf("清理任务应执行成功，实际 status=%s err=%s", run.Status, run.Error)
	}
	if got := countAudit(t, service, "login.failed"); got != 0 {
		t.Fatalf("过期记录应全部删除，实际仍剩 %d 条", got)
	}
	if got := countAudit(t, service, "invoke.echo.ping"); got != 2 {
		t.Fatalf("未过期记录不得删除，实际剩 %d 条（期望 2）", got)
	}
	if got := countAudit(t, service, AuditCleanMethod); got != 1 {
		t.Fatalf("每次清理应写一条 audit.clean 审计，实际 %d 条", got)
	}
	cleanRecords, err := service.store.ListAudit(store.AuditFilter{Action: AuditCleanMethod})
	if err != nil || len(cleanRecords) != 1 {
		t.Fatalf("读取清理审计失败: %v（%d 条）", err, len(cleanRecords))
	}
	if cleanRecords[0].Result != store.AuditResultOK || cleanRecords[0].Detail["deleted"] != "3" {
		t.Fatalf("清理审计应记录 ok 与 deleted=3，实际 %+v", cleanRecords[0])
	}
	// 重复执行幂等：再跑一次不再删除，但会再写一条审计。
	second := service.execute(context.Background(), task)
	if second.Status != StatusOK {
		t.Fatalf("第二次清理应成功，实际 status=%s err=%s", second.Status, second.Error)
	}
	after, _ := service.store.ListAudit(store.AuditFilter{Action: AuditCleanMethod})
	if len(after) != 2 || after[1].Detail["deleted"] != "0" {
		t.Fatalf("第二次清理应 deleted=0，实际 %+v", after)
	}
}

// TestAuditCleanBatchLimit 验收单次上限：batch=2 时无需遍历全表即可分批收敛。
func TestAuditCleanBatchLimit(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	for i := 0; i < 5; i++ {
		putAuditAt(t, service, clock.Now().Add(-100*24*time.Hour), i, "login.failed")
	}
	params := json.RawMessage(`{"retention_seconds":7776000,"batch":2}`)
	wantDeleted, wantMore := []int{2, 2, 1}, []bool{true, true, false}
	for i := range wantDeleted {
		out, err := service.cleanAudit(context.Background(), params)
		if err != nil {
			t.Fatalf("第 %d 次清理失败: %v", i+1, err)
		}
		var result auditCleanResult
		if err := json.Unmarshal(out, &result); err != nil {
			t.Fatalf("解析清理结果失败: %v", err)
		}
		if result.Deleted != wantDeleted[i] || result.More != wantMore[i] || result.Batch != 2 {
			t.Fatalf("第 %d 次清理应为 deleted=%d more=%v batch=2，实际 %+v",
				i+1, wantDeleted[i], wantMore[i], result)
		}
	}
	if got := countAudit(t, service, "login.failed"); got != 0 {
		t.Fatalf("分批清理后过期记录应清空，实际剩 %d 条", got)
	}
}

// TestAuditCleanFailureKeepsReadsWorking 验收：清理失败不影响读取、不 panic、
// 只落一条 failed 运行记录（主流程继续）。
func TestAuditCleanFailureKeepsReadsWorking(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	putAuditAt(t, service, clock.Now().Add(-100*24*time.Hour), 0, "login.failed")
	putAuditAt(t, service, clock.Now().Add(-time.Hour), 1, "invoke.echo.ping")
	bad := Task{ID: builtinAuditCleanID, Name: "审计按龄清理", Plugin: BuiltinPlugin,
		Method: AuditCleanMethod, Params: json.RawMessage(`{"retention_seconds":0,"batch":0}`),
		IntervalS: 21600, Enabled: true, TimeoutS: auditCleanTimeoutS}
	run := service.execute(context.Background(), bad)
	if run.Status != StatusFailed || !strings.Contains(run.Error, "参数非法") {
		t.Fatalf("非法参数应记 failed 并说明原因，实际 status=%s err=%s", run.Status, run.Error)
	}
	if got := countAudit(t, service, "login.failed"); got != 1 {
		t.Fatalf("清理失败时不得删除任何记录，实际剩 %d 条", got)
	}
	if got := countAudit(t, service, "invoke.echo.ping"); got != 1 {
		t.Fatalf("清理失败不应影响读取，实际剩 %d 条", got)
	}
	if _, err := service.loadTasks(); err != nil {
		t.Fatalf("清理失败不应影响调度器读取任务: %v", err)
	}
}
