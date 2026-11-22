package supervisor_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/supervisor"
)

// TestOneShotEnableNoProcess 验证 oneshot enable 不起进程（同 lazy）。
func TestOneShotEnableNoProcess(t *testing.T) {
	env := newOneshotEnv(t, map[string]string{"os-a": "oneshot"})
	if err := env.manager.Start(context.Background(), "os-a"); err != nil {
		t.Fatalf("oneshot Start（enable 阶段）应成功: %v", err)
	}
	view, ok := env.manager.Snapshot("os-a")
	if !ok || view.State != supervisor.StateStopped || view.PID != 0 {
		t.Fatalf("oneshot enable 不应拉起进程，实际 %+v", view)
	}
	// 空闲时 socket 也不应存在。
	if _, err := os.Lstat(filepath.Join(env.runDir, "os-a.sock")); !os.IsNotExist(err) {
		t.Fatalf("oneshot enable 后不应有 socket，实际 err=%v", err)
	}
}

// TestOneShotInvokeStarts 验证 invoke 拉起进程（enable 后首次冷启）。
func TestOneShotInvokeStarts(t *testing.T) {
	env := newOneshotEnv(t, map[string]string{"os-b": "oneshot"})
	conn, err := env.manager.Ensure(context.Background(), "os-b")
	if err != nil {
		t.Fatalf("oneshot 首次 invoke 应拉起: %v", err)
	}
	_ = conn // 不调用：进程应一直保持 ready，证明拉起由 invoke 触发
	started, _ := env.manager.Snapshot("os-b")
	if started.State != supervisor.StateReady || started.PID <= 0 || !processAlive(started.PID) {
		t.Fatalf("invoke 后应 ready 且进程存活，实际 %+v", started)
	}
}

// TestOneShotProcessGoneAfterInvoke 验证单次调用完成后进程立即消失（空闲 0 进程证据）。
func TestOneShotProcessGoneAfterInvoke(t *testing.T) {
	env := newOneshotEnv(t, map[string]string{"os-d": "oneshot"})
	conn, err := env.manager.Ensure(context.Background(), "os-d")
	if err != nil {
		t.Fatalf("oneshot invoke 失败: %v", err)
	}
	started, _ := env.manager.Snapshot("os-d")
	invokeOnce(t, conn)
	// 进程消失证据：/proc/<pid> 不存在 + 状态 stopped + View.PID 归零。
	waitStopped(t, env.manager, "os-d", 3*time.Second)
	if processAlive(started.PID) {
		t.Fatalf("调用完成后进程 %d 必须消失（/proc/<pid> 仍存在）", started.PID)
	}
	view, _ := env.manager.Snapshot("os-d")
	if view.PID != 0 || view.State != supervisor.StateStopped {
		t.Fatalf("调用完成后应 stopped 且 PID=0，实际 %+v", view)
	}
	if _, err := os.Lstat(filepath.Join(env.runDir, "os-d.sock")); !os.IsNotExist(err) {
		t.Fatalf("调用完成后 socket 应清理，实际 err=%v", err)
	}
}

// TestOneShotSecondInvokeRespawns 验证二次 invoke 重新拉起（换 PID），不复用实例。
func TestOneShotSecondInvokeRespawns(t *testing.T) {
	env := newOneshotEnv(t, map[string]string{"os-c": "oneshot"})
	first, err := env.manager.Ensure(context.Background(), "os-c")
	if err != nil {
		t.Fatalf("首次 invoke 失败: %v", err)
	}
	invokeOnce(t, first)
	waitStopped(t, env.manager, "os-c", 3*time.Second)
	before, _ := env.manager.Snapshot("os-c")

	second, err := env.manager.Ensure(context.Background(), "os-c")
	if err != nil {
		t.Fatalf("二次 invoke 应重新拉起: %v", err)
	}
	after, _ := env.manager.Snapshot("os-c")
	if after.PID <= 0 || after.PID == before.PID || !processAlive(after.PID) {
		t.Fatalf("二次 invoke 应换新进程：%d → %d", before.PID, after.PID)
	}
	invokeOnce(t, second)
	waitStopped(t, env.manager, "os-c", 3*time.Second)
	if processAlive(after.PID) {
		t.Fatalf("二次调用完成后进程 %d 必须消失", after.PID)
	}
}

// TestOneShotDoesNotAffectLazyResident 验证 oneshot 与 lazy/resident 互不干扰。
func TestOneShotDoesNotAffectLazyResident(t *testing.T) {
	env := newOneshotEnv(t, map[string]string{
		"os-x": "oneshot", "lz-y": "lazy", "rs-z": "resident",
	})
	ctx := context.Background()
	// oneshot 完成一次调用并退出。
	conn, err := env.manager.Ensure(ctx, "os-x")
	if err != nil {
		t.Fatalf("oneshot invoke 失败: %v", err)
	}
	osBefore, _ := env.manager.Snapshot("os-x")
	invokeOnce(t, conn)
	waitStopped(t, env.manager, "os-x", 3*time.Second)

	// lazy 冷启后应保持 ready（不因 oneshot 回收而退出）。
	lz, err := env.manager.Ensure(ctx, "lz-y")
	if err != nil {
		t.Fatalf("lazy invoke 失败: %v", err)
	}
	_ = lz
	lazyView, _ := env.manager.Snapshot("lz-y")
	if lazyView.State != supervisor.StateReady || !processAlive(lazyView.PID) {
		t.Fatalf("lazy 应保持 ready 存活，实际 %+v", lazyView)
	}
	// resident enable 后常驻。
	if err := env.manager.Start(ctx, "rs-z"); err != nil {
		t.Fatalf("resident Start 失败: %v", err)
	}
	resView, _ := env.manager.Snapshot("rs-z")
	if resView.State != supervisor.StateReady || !processAlive(resView.PID) {
		t.Fatalf("resident 应常驻，实际 %+v", resView)
	}
	if processAlive(osBefore.PID) {
		t.Fatalf("oneshot 进程 %d 不应影响其它插件后仍存活", osBefore.PID)
	}
}
