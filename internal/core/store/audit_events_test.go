package store

import (
	"context"
	"os"
	"testing"

	"github.com/pengtang1024/kore/internal/core/supervisor"
)

// TestAuditEventPersistence 四类事件各写一条、写完即可查、无请求也落库（M3-C）：
// Start→plugin.enable；SIGKILL 就绪进程→plugin.crash；再次 Start→plugin.retry；
// Stop→plugin.disable。全程只有 supervisor 事件与 store：无 HTTP 请求、无对账步骤。
func TestAuditEventPersistence(t *testing.T) {
	env := newAuditEnv(t)
	ctx := context.Background()

	// ① enable：事件发生即落库（Start 返回前已完成写入）。
	if err := env.manager.Start(ctx, env.id); err != nil {
		t.Fatalf("首次启动失败: %v", err)
	}

	// ② crash：SIGKILL 就绪进程，等 reaper 把 plugin.crash 落库（异步回收）。
	pid := readAuditPid(t, env.pidFile)
	proc, err := os.FindProcess(pid)
	if err != nil {
		t.Fatalf("查找进程 %d 失败: %v", pid, err)
	}
	if err := proc.Kill(); err != nil {
		t.Fatalf("SIGKILL 进程 %d 失败: %v", pid, err)
	}
	waitAuditAction(t, env.db, supervisor.AuditCrash)

	// ③ retry（失败后重启）：failed 状态再启动，不重复记 enable。
	if err := env.manager.Start(ctx, env.id); err != nil {
		t.Fatalf("恢复启动失败: %v", err)
	}
	view, ok := env.manager.Snapshot(env.id)
	if !ok || view.State != supervisor.StateReady {
		t.Fatalf("恢复后应 ready，实际 %+v", view)
	}

	// ④ disable。
	if err := env.manager.Stop(ctx, env.id); err != nil {
		t.Fatalf("停止失败: %v", err)
	}

	// 写完即可查：此刻立即读库，不发任何请求、不跑对账。
	got, err := env.db.ListAudit(AuditFilter{})
	if err != nil {
		t.Fatalf("ListAudit 失败: %v", err)
	}
	wantActions := []string{
		supervisor.AuditEnable, supervisor.AuditCrash,
		supervisor.AuditRestart, supervisor.AuditDisable,
	}
	if len(got) != len(wantActions) {
		t.Fatalf("四类事件应各落 1 条（共 %d），实际 %d 条: %+v", len(wantActions), len(got), got)
	}
	wantSubjects := []string{"admin", "system", "system", "admin"}
	wantResults := []string{"ok", "error", "ok", "ok"}
	keys := make([]string, 0, len(got))
	for i, rec := range got {
		keys = append(keys, rec.Key)
		if rec.Action != wantActions[i] {
			t.Errorf("第 %d 条 action=%q，期望 %q", i, rec.Action, wantActions[i])
		}
		if rec.Subject != wantSubjects[i] {
			t.Errorf("第 %d 条 subject=%q，期望 %q", i, rec.Subject, wantSubjects[i])
		}
		if rec.Result != wantResults[i] {
			t.Errorf("第 %d 条 result=%q，期望 %q", i, rec.Result, wantResults[i])
		}
		if rec.Plugin != env.id {
			t.Errorf("第 %d 条 plugin=%q，期望 %q", i, rec.Plugin, env.id)
		}
	}
	if got[1].Detail["pid"] == "" {
		t.Errorf("crash 记录应带 pid detail，实际 %v", got[1].Detail)
	}
	if got[2].Detail["from"] != string(supervisor.StateFailed) {
		t.Errorf("retry 记录 detail.from 应为 failed，实际 %v", got[2].Detail)
	}
	assertAuditKeys(t, keys)
}
