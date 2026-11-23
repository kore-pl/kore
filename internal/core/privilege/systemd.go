package privilege

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Runner 是提权命令的执行抽象：真实实现经 systemd-run 拉起 transient unit，
// 测试注入 fake 以校验 argv 固定、超时 kill 与输出上限。
type Runner interface {
	// Run 执行一次 unit；stdout/stderr 写入给定文件；返回退出码。
	// 返回非 nil error 表示连 systemd-run 都没跑起来（或超时）。
	Run(ctx context.Context, unit string, argv []string, stdoutPath, stderrPath string) (int, error)
	// KillUnit 在超时后尽力终止 unit（不阻塞、不返回错误）。
	KillUnit(unit string)
}

// BuildSystemdRunArgv 返回 systemd-run 的**完整 argv 原文**：
//
//	systemd-run --uid=0 --collect --wait \
//	  -p StandardOutput=file:<stdout> -p StandardError=file:<stderr> \
//	  --unit=<unit> -- <argv...>
//
// 不含 shell：整条命令是固定参数数组，插件只能选 action id 与追加参数。
//
// **不能加 --pipe**：--pipe 会把 unit 的 stdout/stderr 接管成到 systemd-run 父进程的
// 管道，此时 `-p StandardOutput=file:` / `-p StandardError=file:` 被 systemd 静默忽略，
// unit 输出不会落到文件，内核读到的 stdout/stderr 永远为空（本机 systemd 259 实测：
// 文件不创建、systemd-run 仍退出 0）。等待完成与退出码透传由 --wait 负责，不需要 --pipe。
func BuildSystemdRunArgv(unit, stdoutPath, stderrPath string, argv []string) []string {
	out := []string{
		"systemd-run", "--uid=0", "--collect", "--wait",
		"-p", "StandardOutput=file:" + stdoutPath,
		"-p", "StandardError=file:" + stderrPath,
		"--unit=" + unit, "--",
	}
	return append(out, argv...)
}

// execRunner 是真实执行器。
type execRunner struct{}

// Run 调 systemd-run 并等待 unit 退出；超时返回 ctx 错误由上层 kill unit。
func (execRunner) Run(ctx context.Context, unit string, argv []string, stdoutPath, stderrPath string) (int, error) {
	runArgv := BuildSystemdRunArgv(unit, stdoutPath, stderrPath, argv)
	command := exec.CommandContext(ctx, runArgv[0], runArgv[1:]...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	command.Env = append(os.Environ(), "LC_ALL=C")
	err := command.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return -1, ctx.Err()
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			// systemd-run --wait 以非 0 退出表示 unit 失败；具体命令退出码由
			// systemd 决定，这里只透传 systemd-run 的退出码（已在 RUNBOOK 说明）。
			return exitErr.ExitCode(), nil
		}
		return -1, fmt.Errorf("执行 systemd-run 失败：%w（%s）", err, strings.TrimSpace(stderr.String()))
	}
	return 0, nil
}

// KillUnit 尽力 kill 并 stop unit；失败只忽略（unit 已 --collect，可能自然消失）。
func (execRunner) KillUnit(unit string) {
	for _, argv := range [][]string{
		{"systemctl", "kill", "--signal=SIGKILL", unit},
		{"systemctl", "stop", unit},
	} {
		command := exec.Command(argv[0], argv[1:]...)
		command.Env = append(os.Environ(), "LC_ALL=C")
		command.Stdout, command.Stderr = nil, nil
		_ = command.Run()
	}
}

// DetectRoot 报告当前进程是否 root。
func DetectRoot() bool { return os.Geteuid() == 0 }

// DetectSystemd 报告提权通道依赖是否可用：/run/systemd/system + systemd-run + systemctl。
func DetectSystemd() (bool, string) {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return false, "/run/systemd/system 不存在（系统未以 systemd 引导）"
	}
	for _, binary := range []string{"systemd-run", "systemctl"} {
		if _, err := exec.LookPath(binary); err != nil {
			return false, binary + " 不在 PATH"
		}
	}
	return true, ""
}
