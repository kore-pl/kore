package supervisor_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// TestHelloTimeoutKillsProcess 是反向用例 R-10①：
// 假插件延迟 2.1s 才发 hello → 2s 硬超时 → SIGKILL + 重启计数 +1 + 状态 failed。
func TestHelloTimeoutKillsProcess(t *testing.T) {
	root := t.TempDir()
	pidFile := filepath.Join(root, "plugin.pid")
	env := newTestEnv(t, "slow", map[string]string{
		"hello_delay": "2100ms",
		"pid_file":    pidFile,
	}, nil)

	err := env.manager.Start(context.Background(), "slow")
	if codeOf(t, err) != pluginapi.E_UPSTREAM {
		t.Fatalf("hello 超时应返回 E_UPSTREAM，实际 %v", err)
	}
	view, ok := env.manager.Snapshot("slow")
	if !ok {
		t.Fatalf("插件 slow 应有运行态视图")
	}
	if view.State != supervisor.StateFailed {
		t.Fatalf("超时后状态应为 failed，实际 %s", view.State)
	}
	if view.Restarts != 1 {
		t.Fatalf("超时后重启计数应为 1，实际 %d", view.Restarts)
	}
	if view.LastError == "" || (!strings.Contains(view.LastError, "超时") && !strings.Contains(view.LastError, "未连接")) {
		t.Fatalf("lastError 应说明握手超时，实际 %q", view.LastError)
	}
	pid := readPID(t, pidFile)
	if processAlive(pid) {
		t.Fatalf("插件进程 %d 应在 hello 超时后被 SIGKILL", pid)
	}
}

// TestOrphanSocketRecovered 是孤儿 socket 三步回收：Lstat → unlink → bind。
func TestOrphanSocketRecovered(t *testing.T) {
	env := newTestEnv(t, "echo", nil, nil)
	socket := filepath.Join(env.runDir, "echo.sock")
	if err := os.WriteFile(socket, []byte("stale-non-socket"), 0o600); err != nil {
		t.Fatalf("预置孤儿文件失败: %v", err)
	}
	if err := env.manager.Start(context.Background(), "echo"); err != nil {
		t.Fatalf("孤儿 socket 应被回收并成功 bind，实际 %v", err)
	}
	info, err := os.Lstat(socket)
	if err != nil {
		t.Fatalf("socket 应存在: %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("回收后应为 socket，实际 mode=%v", info.Mode())
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("socket 权限应为 0600，实际 %04o", perm)
	}
}

// TestEnsureNotEnabled 验证「装但未 enable」返回 E_NOTFOUND（M1 无 lazy 唤醒）。
func TestEnsureNotEnabled(t *testing.T) {
	env := newTestEnv(t, "echo", nil, nil)
	if err := env.catalog.Disable("echo"); err != nil {
		t.Fatalf("disable 失败: %v", err)
	}
	_, err := env.manager.Ensure(context.Background(), "echo")
	if codeOf(t, err) != pluginapi.E_NOTFOUND {
		t.Fatalf("未 enable 应返回 E_NOTFOUND，实际 %v", err)
	}
}

// TestStartIdempotentAndStop 验证重复 start 幂等、优雅停止与 socket 清理。
func TestStartIdempotentAndStop(t *testing.T) {
	env := newTestEnv(t, "echo", nil, nil)
	ctx := context.Background()
	if err := env.manager.Start(ctx, "echo"); err != nil {
		t.Fatalf("首次启动失败: %v", err)
	}
	first, _ := env.manager.Snapshot("echo")
	if first.State != supervisor.StateReady || first.PID == 0 {
		t.Fatalf("启动后应 ready 且有 pid，实际 %+v", first)
	}
	if err := env.manager.Start(ctx, "echo"); err != nil {
		t.Fatalf("重复 start 应幂等，实际 %v", err)
	}
	second, _ := env.manager.Snapshot("echo")
	if second.PID != first.PID {
		t.Fatalf("重复 start 不得换进程：%d → %d", first.PID, second.PID)
	}
	if err := env.manager.Stop(ctx, "echo"); err != nil {
		t.Fatalf("停止失败: %v", err)
	}
	view, _ := env.manager.Snapshot("echo")
	if view.State != supervisor.StateStopped {
		t.Fatalf("停止后状态应为 stopped，实际 %s", view.State)
	}
	if _, err := os.Lstat(filepath.Join(env.runDir, "echo.sock")); !os.IsNotExist(err) {
		t.Fatalf("停止后 socket 应被清理，实际 err=%v", err)
	}
	if processAlive(first.PID) {
		t.Fatalf("停止后进程 %d 不应存活", first.PID)
	}
	if err := env.manager.Stop(ctx, "echo"); err != nil {
		t.Fatalf("重复 stop 应幂等，实际 %v", err)
	}
}

// readPID 读取假插件写下的 pid。
func readPID(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 pid 文件失败: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("pid 文件内容非法: %q", data)
	}
	return pid
}

// processAlive 用 /proc 判定进程是否仍存在（避免在 internal/core 里出现 syscall）。
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	_, err := os.Stat(filepath.Join("/proc", strconv.Itoa(pid)))
	return err == nil
}
