package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// auditCleanTaskOf 构造一条指向内置清理方法的任务；id 与 params 由调用方给，
// 用来分别验证「任务身份」与「参数下限」两层保护。
func auditCleanTaskOf(id string, params string) Task {
	return Task{ID: id, Name: "审计按龄清理", Plugin: BuiltinPlugin, Method: AuditCleanMethod,
		Params: json.RawMessage(params), IntervalS: 21600, Enabled: true, TimeoutS: auditCleanTimeoutS}
}

// TestAuditCleanShortRetentionRejected 是 P1（审计可被 API 擦掉）的反例回归：
// retention_seconds=1 的清理不得删掉任何审计（最近 1 小时与 120 天前都不行），
// 且这次被拒绝的尝试本身要留下一条 audit.clean（result=error）。
//
// 去掉 minAuditRetentionSeconds 下限后本用例必 FAIL：120 天前的记录会被删、任务返回 ok。
func TestAuditCleanShortRetentionRejected(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	putAuditAt(t, service, clock.Now().Add(-time.Hour), 0, "login.success")
	putAuditAt(t, service, clock.Now().Add(-time.Hour), 1, "login.success")
	putAuditAt(t, service, clock.Now().Add(-120*24*time.Hour), 0, "invoke.root")

	task := auditCleanTaskOf(builtinAuditCleanID, `{"retention_seconds":1,"batch":1000}`)
	run := service.execute(context.Background(), task)
	if run.Status != StatusFailed || !strings.Contains(run.Error, "参数非法") {
		t.Fatalf("retention_seconds=1 必须被拒绝，实际 status=%s err=%s", run.Status, run.Error)
	}
	if got := countAudit(t, service, "login.success"); got != 2 {
		t.Fatalf("最近 1 小时的审计不得删除，实际剩 %d 条（期望 2）", got)
	}
	if got := countAudit(t, service, "invoke.root"); got != 1 {
		t.Fatalf("120 天前的审计也不得被 retention=1s 删掉，实际剩 %d 条（期望 1）", got)
	}
	records, err := service.store.ListAudit(store.AuditFilter{Action: AuditCleanMethod})
	if err != nil || len(records) != 1 {
		t.Fatalf("被拒绝的清理尝试应写 1 条 audit.clean 审计，实际 %d 条（err=%v）", len(records), err)
	}
	if records[0].Result != store.AuditResultError ||
		!strings.Contains(records[0].Detail["error"], "retention_seconds") {
		t.Fatalf("拒绝审计应记 error 与原因，实际 %+v", records[0])
	}
	if records[0].Detail["retention_seconds"] != "1" {
		t.Fatalf("拒绝审计应记录被尝试的 retention_seconds=1，实际 %q", records[0].Detail["retention_seconds"])
	}
}

// TestAuditCleanForeignTaskRejected 验收「只能由固定内置任务触发」：用户自建的
// 任务 id（tsk-*）即使 params 完全合法，也不得执行清理；120 天前的记录必须还在。
//
// 去掉 task.ID == builtinAuditCleanID 校验后本用例必 FAIL（合法 90 天保留期会把旧记录删掉）。
func TestAuditCleanForeignTaskRejected(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	putAuditAt(t, service, clock.Now().Add(-120*24*time.Hour), 0, "invoke.root")

	task := auditCleanTaskOf("tsk-0123456789abcdef", `{"retention_seconds":7776000,"batch":1000}`)
	run := service.execute(context.Background(), task)
	if run.Status != StatusFailed || !strings.Contains(run.Error, "只能由内核内置任务") {
		t.Fatalf("非内置任务不得执行清理，实际 status=%s err=%s", run.Status, run.Error)
	}
	if got := countAudit(t, service, "invoke.root"); got != 1 {
		t.Fatalf("非内置任务的清理不得删除任何记录，实际剩 %d 条（期望 1）", got)
	}
	records, err := service.store.ListAudit(store.AuditFilter{Action: AuditCleanMethod})
	if err != nil || len(records) != 1 || records[0].Result != store.AuditResultError {
		t.Fatalf("冒用清理入口应留一条 error 审计，实际 %+v（err=%v）", records, err)
	}
	if records[0].Detail["retention_seconds"] != "7776000" {
		t.Fatalf("拒绝审计应记录被尝试的 retention_seconds，实际 %q", records[0].Detail["retention_seconds"])
	}
}

// TestCreateRejectsBuiltinPlugin 验收 API 入口：不得创建 plugin=kore 的任务（内置伪插件名
// 只给内核自己写）；普通插件任务不受影响。
func TestCreateRejectsBuiltinPlugin(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	ctx := context.Background()
	_, err := service.Add(ctx, CreateInput{Name: "h", Plugin: BuiltinPlugin, Method: AuditCleanMethod,
		Params: json.RawMessage(`{"retention_seconds":1,"batch":1000}`), IntervalS: 3600, TimeoutS: 60})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("创建 plugin=kore 任务应被拒绝为 ErrInvalid，实际 %v", err)
	}
	if tasks, _ := service.List(ctx); len(tasks) != 0 {
		t.Fatalf("被拒绝的任务不得落库，实际 %d 条", len(tasks))
	}
	if _, err := service.Add(ctx, CreateInput{Name: "ping", Plugin: "echo", Method: "echo.ping",
		IntervalS: 3600, TimeoutS: 60}); err != nil {
		t.Fatalf("普通插件任务应仍可创建，实际 %v", err)
	}
}

// TestAuditCleanLegitRetentionStillWorks 防「修漏洞修成清理失效」：配置口径的 90 天保留期
// 仍然正常清理——91 天前的删除、30 天前的保留。
func TestAuditCleanLegitRetentionStillWorks(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	enableAuditClean(service, 90*24*time.Hour, 6*time.Hour, 1000)
	if err := service.syncAuditCleanTask(); err != nil {
		t.Fatalf("注册内置清理任务失败: %v", err)
	}
	putAuditAt(t, service, clock.Now().Add(-91*24*time.Hour), 0, "invoke.old")
	putAuditAt(t, service, clock.Now().Add(-30*24*time.Hour), 0, "invoke.recent")
	task, err := service.loadTask(builtinAuditCleanID)
	if err != nil {
		t.Fatalf("读取内置清理任务失败: %v", err)
	}
	run := service.execute(context.Background(), task)
	if run.Status != StatusOK {
		t.Fatalf("合法保留期清理应成功，实际 status=%s err=%s", run.Status, run.Error)
	}
	if got := countAudit(t, service, "invoke.old"); got != 0 {
		t.Fatalf("91 天前的记录应被清理，实际剩 %d 条", got)
	}
	if got := countAudit(t, service, "invoke.recent"); got != 1 {
		t.Fatalf("30 天前的记录不得清理，实际剩 %d 条（期望 1）", got)
	}
}
