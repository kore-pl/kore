//go:build linux

package privilege

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 本文件是 ADR-0049 直接执行的**真实进程**用例（无需 root、无需 systemd）：
//   - 真实退出码透传（exit 42 → 42）；
//   - 超时后整棵进程树被回收（父子都死，pgrep -g 验证）；
//   - 无 systemd 宿主仍能执行（systemdRuntimeDir 指到不存在的路径）。
//
// 反例自证（人工执行，不入 CI）：把 platform/procgroup_unix.go 的
// `cmd.SysProcAttr.Setpgid = true` 删掉 → TestProcessGroupKilledOnTimeout 必须 FAIL。

// directExecOutputs 建两个输出文件路径（execRunner 会自己创建 / 截断）。
func directExecOutputs(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "stdout"), filepath.Join(dir, "stderr")
}

// requirePgrep 要求 pgrep 可用（procps / busybox 任一）：进程组回收的判据就是它。
func requirePgrep(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("pgrep"); err != nil {
		t.Skip("跳过：pgrep 不在 PATH，无法按进程组断言")
	}
}

// TestDirectExecRealExitCode 真实退出码必须是被调命令的退出码（不是中间层退出码）。
func TestDirectExecRealExitCode(t *testing.T) {
	stdoutPath, stderrPath := directExecOutputs(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exitCode, err := (execRunner{}).Run(ctx, []string{"/bin/sh", "-c", "exit 42"}, stdoutPath, stderrPath)
	if err != nil {
		t.Fatalf("直接执行不应返回错误（非 0 退出码不是执行失败）：%v", err)
	}
	if exitCode != 42 {
		t.Fatalf("真实退出码应为 42，实际 %d", exitCode)
	}
}

// TestDirectExecCapturesStdoutStderr 输出必须落盘（systemd-run --pipe 时代曾静默丢失）。
func TestDirectExecCapturesStdoutStderr(t *testing.T) {
	stdoutPath, stderrPath := directExecOutputs(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exitCode, err := (execRunner{}).Run(ctx,
		[]string{"/bin/sh", "-c", "echo out-line; echo err-line >&2; exit 3"}, stdoutPath, stderrPath)
	if err != nil {
		t.Fatalf("直接执行失败：%v", err)
	}
	if exitCode != 3 {
		t.Fatalf("exit code 应为 3，实际 %d", exitCode)
	}
	stdout, err := os.ReadFile(stdoutPath)
	if err != nil {
		t.Fatalf("读取 stdout 失败：%v", err)
	}
	stderr, err := os.ReadFile(stderrPath)
	if err != nil {
		t.Fatalf("读取 stderr 失败：%v", err)
	}
	if !strings.Contains(string(stdout), "out-line") || !strings.Contains(string(stderr), "err-line") {
		t.Fatalf("输出未落盘：stdout=%q stderr=%q", stdout, stderr)
	}
}

// TestProcessGroupKilledOnTimeout 是 ADR-0049 P1 的核心用例：
// 命令 fork 出一个孙进程后超时 → **父与孙都必须死**，用 `pgrep -g <pgid>` 证明。
//
// 命令刻意让 sh 把自己的 pid（== pgid，因为 Setpgid）写进 pidfile，再起两个
// `sleep`（一个后台、一个前台）。超时后：
//  1. `pgrep -g <pgid>` 必须为空（整个组被回收）；
//  2. 两个 sleep 的独特秒数也必须查不到（防止「组长死了、孙进程换组/逃逸」）。
func TestProcessGroupKilledOnTimeout(t *testing.T) {
	requirePgrep(t)
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pgid")
	stdoutPath := filepath.Join(dir, "stdout")
	stderrPath := filepath.Join(dir, "stderr")
	// 两个按进程号派生的独特秒数：并发跑测时不会互相命中（固定数字会命中上一次
	// 失败运行残留的 sleep，制造假红）；pgrep 用锚定模式 ^sleep <N>$，只匹配 sleep
	// 本身，不匹配 `sh -c "… sleep <N> …"` 包装进程。
	childSleep := strconv.Itoa(200000 + os.Getpid()%100000)
	grandchildSleep := strconv.Itoa(200000 + os.Getpid()%100000 + 1)
	script := "echo $$ > " + pidFile + "; sleep " + childSleep + " & sleep " + grandchildSleep

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	type outcome struct {
		code int
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		code, err := (execRunner{}).Run(ctx,
			[]string{"/bin/sh", "-c", script}, stdoutPath, stderrPath)
		done <- outcome{code: code, err: err}
	}()

	pgid := waitForPIDFile(t, pidFile)
	// 超时前必须能看到「父进程 + 孙进程」都在同一个组里，否则本用例是空转。
	if live := waitForGroupSize(t, pgid, 2, 1200*time.Millisecond); live < 2 {
		// 诊断：进程组不成立时，把「命令是否还活着」一并打出来——去掉 Setpgid 后
		// 组长不再是 pgid，这一行会显示 sleep 仍在跑（正是要抓的泄漏）。
		leaderAlive := processExists(pgid)
		var leaked []string
		for _, seconds := range []string{childSleep, grandchildSleep} {
			if out, err := exec.Command("pgrep", "-f", "^sleep "+seconds+"$").CombinedOutput(); err == nil {
				leaked = append(leaked, strings.TrimSpace(string(out)))
			}
		}
		t.Fatalf("超时前进程组 %s 内非僵尸进程只有 %d 个（组长存活=%v，残留 sleep=%v）："+
			"进程组没有建立，超时 kill 无法按组回收", pgid, live, leaderAlive, leaked)
	}

	var got outcome
	select {
	case got = <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("超时后 Run 未返回：kill 路径可能没有生效")
	}
	if !errors.Is(got.err, context.DeadlineExceeded) {
		t.Fatalf("超时应返回 context.DeadlineExceeded，实际 %v", got.err)
	}
	if got.code != -1 {
		t.Fatalf("超时退出码应归一为 -1，实际 %d", got.code)
	}

	// 断言整组被回收（给 SIGKILL 与 re-parent 留最多 3s）。
	if live := waitForGroupSize(t, pgid, 0, 3*time.Second); live != 0 {
		dump, _ := exec.Command("ps", "-o", "pid,ppid,pgid,stat,args", "-g", pgid).CombinedOutput()
		t.Fatalf("超时后进程组 %s 内仍有 %d 个非僵尸进程存活（父子未全回收）：\n%s", pgid, live, dump)
	}
	for _, seconds := range []string{childSleep, grandchildSleep} {
		pattern := "^sleep " + seconds + "$"
		if out, err := exec.Command("pgrep", "-f", pattern).CombinedOutput(); err == nil {
			t.Fatalf("%q 仍在运行（孙进程逃逸）：%s", pattern, out)
		}
	}
}

// waitForPIDFile 等 pidfile 出现并返回里面的 pid（即进程组 id）。
func waitForPIDFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(path)
		if err == nil {
			value := strings.TrimSpace(string(raw))
			if pid, convErr := strconv.Atoi(value); convErr == nil && pid > 1 {
				return value
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("5s 内未等到 pidfile %s", path)
	return ""
}

// waitForGroupSize 等进程组内非僵尸进程数达到 want（want=0 表示等清空），返回最终数量。
func waitForGroupSize(t *testing.T, pgid string, want int, timeout time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	live := -1
	for {
		live = len(liveProcessesInGroup(t, pgid))
		if live == want || time.Now().After(deadline) {
			return live
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// liveProcessesInGroup 返回进程组内**非僵尸**的 pid：
// 被 SIGKILL 的孙进程会短暂处于 Z 状态（re-parent 后由 init 回收），那不算「还活着」。
func liveProcessesInGroup(t *testing.T, pgid string) []string {
	t.Helper()
	out, err := exec.Command("pgrep", "-g", pgid).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return nil // pgrep 无匹配
		}
		t.Fatalf("pgrep -g %s 失败：%v", pgid, err)
	}
	var live []string
	for _, field := range strings.Fields(string(out)) {
		if state, ok := processState(field); ok && state != "Z" {
			live = append(live, field)
		}
	}
	return live
}

// processState 从 /proc/<pid>/stat 读进程状态；进程已消失时返回 ok=false。
func processState(pid string) (string, bool) {
	raw, err := os.ReadFile(filepath.Join("/proc", pid, "stat"))
	if err != nil {
		return "", false
	}
	// 格式：pid (comm) state ...；comm 可能含空格与括号，取最后一个 ')' 之后。
	text := string(raw)
	index := strings.LastIndex(text, ")")
	if index < 0 || index+2 >= len(text) {
		return "", false
	}
	return strings.TrimSpace(text[index+1 : index+2]), true
}

// TestExecuteWithoutSystemdMarker 模拟「/run/systemd/system 不存在」：探测必须报 false，
// 而 Service.Execute 仍能真实执行（exit 42 一路透传到 Result 与 end 审计）。
func TestExecuteWithoutSystemdMarker(t *testing.T) {
	saved := systemdRuntimeDir
	systemdRuntimeDir = filepath.Join(t.TempDir(), "no-systemd-here")
	defer func() { systemdRuntimeDir = saved }()

	if ok, detail := DetectSystemd(); ok {
		t.Fatalf("systemdRuntimeDir 指向不存在路径时应探测为 false，实际 true（%s）", detail)
	}

	// 用受控命令名 nginx（在 root 动作形状白名单里）+ PATH 前置的测试夹具：
	// 夹具退出 42，用来同时验证「无 systemd 仍执行」与「真实退出码进审计」。
	fixtureDir := t.TempDir()
	fixture := filepath.Join(fixtureDir, "nginx")
	script := "#!/bin/sh\necho fixture-nginx-ran\nexit 42\n"
	if err := os.WriteFile(fixture, []byte(script), 0o755); err != nil {
		t.Fatalf("写测试夹具失败：%v", err)
	}
	t.Setenv("PATH", fixtureDir+":"+os.Getenv("PATH"))

	auditor := &fakeAuditor{}
	svc := New(Options{
		Auditor: auditor,
		Root:    func() bool { return true },
		TempDir: t.TempDir(),
	})
	result, err := svc.Execute(context.Background(), Request{
		Actor: "verifier", PluginID: "selftest",
		Action: pluginapi.RootAction{ID: "nginx-check", Argv: []string{"nginx", "-t"}, TimeoutS: 10},
	})
	if err != nil {
		t.Fatalf("无 systemd 宿主不应影响执行（ADR-0049）：%v", err)
	}
	if result.ExitCode != 42 {
		t.Fatalf("真实退出码应为 42，实际 %+v", result)
	}
	if !strings.Contains(result.Stdout, "fixture-nginx-ran") {
		t.Fatalf("stdout 未透传：%q", result.Stdout)
	}
	if len(auditor.events) != 2 {
		t.Fatalf("应有 begin/end 两条审计，实际 %d：%+v", len(auditor.events), auditor.events)
	}
	if end := auditor.events[1]; end.Phase != PhaseEnd || end.ExitCode != 42 {
		t.Fatalf("end 审计必须带真实退出码 42：%+v", end)
	}
}

// processExists 报告 /proc/<pid> 是否仍存在（不做 kill(0)：G-16 禁止在 internal/core
// 直接接触 syscall，测试也遵守同一口径）。
func processExists(pid string) bool {
	_, err := os.Stat(filepath.Join("/proc", pid))
	return err == nil
}
