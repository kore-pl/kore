package supervisor_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/bus"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// oneshot 超时回收测试。
//
// oneshot 的回收挂在「调用边界」上（读到响应帧或连接被关闭），而 bus 在超时路径上
// 故意保留连接（resident/lazy 还要靠它重同步迟到帧）。两者叠加的结果是：超时的
// oneshot 调用既没有响应帧，也没有 Close，`finish` 永不触发 → 进程不回收、串行
// 令牌不归还 → 后续 oneshot 调用被永久阻塞。
//
// 这里用真实子进程（假插件 hold_method 占着请求不写响应）复现，断言三件事：
//  1. 超时后进程在限定时间内被回收（僵尸同样保留 /proc/<pid>，一并被拦）；
//  2. 串行令牌已归还：紧接着的下一次调用能正常完成，不卡到 ctx 截止；
//  3. 连续多次超时不累积僵尸进程。

const (
	// oneshotCallTimeout 是测试用单次调用超时：远小于回收/令牌断言窗口。
	oneshotCallTimeout = 300 * time.Millisecond
	// oneshotReclaimLimit 是超时后允许的回收上限：ShutdownGrace(200ms) +
	// SIGKILL 等待(2s) + 调度余量。
	oneshotReclaimLimit = 4 * time.Second
	// oneshotRounds 是连续超时轮数（僵尸累积断言用）。
	oneshotRounds = 3
	// oneshotHoldMethod 是假插件「占着请求不回响应」的方法名。
	oneshotHoldMethod = "echo.hold"
)

// TestOneShotTimeoutReclaimsProcess 断言超时后进程仍被回收：每轮超时都必须在
// oneshotReclaimLimit 内完成「进程消失 + 状态 stopped + socket 清理」。
func TestOneShotTimeoutReclaimsProcess(t *testing.T) {
	env, client, pidFile := newOneshotTimeoutEnv(t, "os-t")
	socket := filepath.Join(env.runDir, "os-t.sock")

	var pids []int
	for round := 1; round <= oneshotRounds; round++ {
		callMustTimeOut(t, client, "os-t", oneshotHoldMethod, round)
		// 调用超时时该进程是真实存活过的：pid 文件由假插件启动即写。
		pid := readPidFile(t, pidFile)
		pids = append(pids, pid)
		waitReclaimed(t, env.manager, "os-t", pid, socket, round)
	}
	for _, pid := range pids {
		if processAlive(pid) {
			t.Fatalf("连续 %d 次超时后仍有残留进程（僵尸同样保留 /proc/<pid>）：\n%s",
				oneshotRounds, psLine(pid))
		}
	}
}

// TestOneShotTimeoutReturnsToken 断言超时后串行令牌已归还：超时调用之后的下一次
// 调用必须在短时间内完成，而不是永久排队等令牌（修复前会一直卡到 ctx 截止）。
func TestOneShotTimeoutReturnsToken(t *testing.T) {
	_, client, _ := newOneshotTimeoutEnv(t, "os-t")

	callMustTimeOut(t, client, "os-t", oneshotHoldMethod, 1)
	// 令牌归还窗口：Stop（ShutdownGrace 200ms）完成即归还，这里给 3s 余量。
	callMustSucceed(t, client, "os-t", "echo.run", 3*time.Second)

	// 第二次超时后再调用：证明令牌可重复归还，不是一次性补丁。
	callMustTimeOut(t, client, "os-t", oneshotHoldMethod, 2)
	callMustSucceed(t, client, "os-t", "echo.run", 3*time.Second)
}

// newOneshotTimeoutEnv 装配一个 oneshot 插件：hold_method 占请求、pid_file 取证，
// 并把 ShutdownGrace 收紧到 200ms（默认 5s 会拖长测试但仍能通过）。
func newOneshotTimeoutEnv(t *testing.T, id string) (*oneshotEnv, *bus.Bus, string) {
	t.Helper()
	env := newOneshotEnvWith(t,
		map[string]string{id: "oneshot"},
		func(root string) map[string]string {
			return map[string]string{
				"hold_method": oneshotHoldMethod,
				"hold_delay":  "30s",
				"pid_file":    filepath.Join(root, "oneshot-timeout.pid"),
			}
		},
		func(o *supervisor.Options) { o.ShutdownGrace = 200 * time.Millisecond },
	)
	client, err := bus.New(env.manager, bus.Options{
		CallTimeout: oneshotCallTimeout,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}
	return env, client, filepath.Join(env.root, "oneshot-timeout.pid")
}

// callMustTimeOut 发起一次必须超时的调用，并核对错误是 E_UPSTREAM + 超时口径。
func callMustTimeOut(t *testing.T, client *bus.Bus, plugin, method string, round int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	_, err := client.Call(ctx, plugin, method, json.RawMessage(`{"round":1}`), "")
	if err == nil {
		t.Fatalf("第 %d 轮 %s/%s 应因调用超时失败，实际成功返回", round, plugin, method)
	}
	if code := codeOf(t, err); code != pluginapi.E_UPSTREAM {
		t.Fatalf("第 %d 轮超时错误码应为 %s，实际 %s（%v）", round, pluginapi.E_UPSTREAM, code, err)
	}
	if !strings.Contains(err.Error(), "超时") {
		t.Fatalf("第 %d 轮错误信息应说明超时，实际：%v", round, err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("第 %d 轮超时判定耗时异常：%v", round, elapsed)
	}
}

// callMustSucceed 发起一次必须成功的调用（限时）：令牌未归还时会阻塞到 ctx 截止。
func callMustSucceed(t *testing.T, client *bus.Bus, plugin, method string, limit time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	start := time.Now()
	reply, err := client.Call(ctx, plugin, method, json.RawMessage(`{"probe":true}`), "")
	if err != nil {
		t.Fatalf("超时后 %s/%s 调用失败（串行令牌可能未归还，耗时 %v）：%v",
			plugin, method, time.Since(start).Round(time.Millisecond), err)
	}
	if reply == nil || len(reply.Result) == 0 {
		t.Fatalf("超时后 %s/%s 调用返回空结果：%+v", plugin, method, reply)
	}
}

// waitReclaimed 等到超时调用对应的进程真正消失：进程消失 + stopped + PID 归零 +
// socket 清理，四者同时成立才算回收完成；超时则贴 ps 原文作为失败证据。
func waitReclaimed(t *testing.T, m *supervisor.Manager, id string, pid int, socket string, round int) {
	t.Helper()
	deadline := time.Now().Add(oneshotReclaimLimit)
	for time.Now().Before(deadline) {
		view, _ := m.Snapshot(id)
		_, sockErr := os.Lstat(socket)
		if !processAlive(pid) && view.State == supervisor.StateStopped && view.PID == 0 && os.IsNotExist(sockErr) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	view, _ := m.Snapshot(id)
	t.Fatalf("第 %d 轮超时后 %.1fs 内未完成回收：state=%s view.pid=%d\nps 证据：\n%s",
		round, oneshotReclaimLimit.Seconds(), view.State, view.PID, psLine(pid))
}

// readPidFile 读假插件启动时写下的 pid（每次拉起覆盖为当前进程）。
func readPidFile(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 pid 文件 %s 失败: %v", path, err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		t.Fatalf("pid 文件内容非法：%q（err=%v）", data, err)
	}
	return pid
}

// psLine 返回 ps 原文，用于失败时证明进程仍存活（含僵尸态 Z）。
func psLine(pid int) string {
	out, err := exec.Command("ps", "-o", "pid,ppid,stat,etimes,cmd", "-p", strconv.Itoa(pid)).CombinedOutput()
	if err != nil {
		return fmt.Sprintf("ps -p %d 执行失败：%v %s", pid, err, out)
	}
	return strings.TrimSpace(string(out))
}
