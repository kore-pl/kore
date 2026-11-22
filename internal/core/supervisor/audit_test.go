package supervisor_test

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/supervisor"
)

// recordingAuditor 记录事件载荷（不落库；落库链路由 store 包的
// TestAuditEventPersistence 端到端证明）。
type recordingAuditor struct {
	mu     sync.Mutex
	events []supervisor.AuditEvent
}

// Record 实现 supervisor.Auditor。
func (r *recordingAuditor) Record(_ context.Context, ev supervisor.AuditEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
	return nil
}

// snapshot 返回事件副本。
func (r *recordingAuditor) snapshot() []supervisor.AuditEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]supervisor.AuditEvent, len(r.events))
	copy(out, r.events)
	return out
}

// hasAction 报告是否已收到指定动作的事件。
func (r *recordingAuditor) hasAction(action string) bool {
	for _, ev := range r.snapshot() {
		if ev.Action == action {
			return true
		}
	}
	return false
}

// TestAuditLifecycleEvents 四类事件在发生时各发一条（M3-C）：
// Start→plugin.enable、SIGKILL 就绪进程→plugin.crash、failed 再启动→plugin.retry、
// Stop→plugin.disable。全程无 HTTP 请求、无对账触发；nil Auditor 路径由其余生命周期
// 测试（未注入）覆盖，不会 panic。
func TestAuditLifecycleEvents(t *testing.T) {
	rec := &recordingAuditor{}
	root := t.TempDir()
	pidFile := filepath.Join(root, "plugin.pid")
	env := newTestEnv(t, "echo", map[string]string{"pid_file": pidFile}, func(o *supervisor.Options) {
		o.Auditor = rec
	})
	ctx := context.Background()

	// ① enable
	if err := env.manager.Start(ctx, "echo"); err != nil {
		t.Fatalf("首次启动失败: %v", err)
	}

	// ② crash：SIGKILL 就绪进程，等 reaper 发出 plugin.crash（异步回收）。
	pid := readPID(t, pidFile)
	proc, err := os.FindProcess(pid)
	if err != nil {
		t.Fatalf("查找进程 %d 失败: %v", pid, err)
	}
	if err := proc.Kill(); err != nil {
		t.Fatalf("SIGKILL 进程 %d 失败: %v", pid, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !rec.hasAction(supervisor.AuditCrash) {
		if time.Now().After(deadline) {
			t.Fatalf("等待 crash 审计事件超时（5s）")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if view, ok := env.manager.Snapshot("echo"); !ok || view.State != supervisor.StateFailed {
		t.Fatalf("crash 后状态应为 failed，实际 %+v ok=%v", view, ok)
	}

	// ③ restart：failed 状态再启动。
	if err := env.manager.Start(ctx, "echo"); err != nil {
		t.Fatalf("恢复启动失败: %v", err)
	}

	// ④ disable
	if err := env.manager.Stop(ctx, "echo"); err != nil {
		t.Fatalf("停止失败: %v", err)
	}

	events := rec.snapshot()
	if len(events) != 4 {
		t.Fatalf("四类事件应各发 1 条（共 4），实际 %d 条: %+v", len(events), events)
	}
	want := []struct {
		action  string
		subject string
		result  string
	}{
		{supervisor.AuditEnable, supervisor.AuditSubjectAdmin, supervisor.AuditResultOK},
		{supervisor.AuditCrash, supervisor.AuditSubjectSystem, supervisor.AuditResultError},
		{supervisor.AuditRestart, supervisor.AuditSubjectSystem, supervisor.AuditResultOK},
		{supervisor.AuditDisable, supervisor.AuditSubjectAdmin, supervisor.AuditResultOK},
	}
	for i, w := range want {
		ev := events[i]
		if ev.Action != w.action || ev.Subject != w.subject || ev.Result != w.result {
			t.Errorf("第 %d 条事件应为 {action=%s subject=%s result=%s}，实际 %+v",
				i, w.action, w.subject, w.result, ev)
		}
		if ev.Plugin != "echo" {
			t.Errorf("第 %d 条 plugin=%q，期望 echo", i, ev.Plugin)
		}
	}
	if events[1].Detail["pid"] == "" {
		t.Errorf("crash 事件应带 pid detail，实际 %v", events[1].Detail)
	}
	if events[2].Detail["from"] != string(supervisor.StateFailed) {
		t.Errorf("restart 事件 detail.from 应为 failed，实际 %v", events[2].Detail)
	}
}
