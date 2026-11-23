package privilege

import (
	"bytes"
	"context"
	"errors"
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

// 自管理（self-manage）用的固定路径候选：与 platform/linux_cleanup.go 同口径，
// **不查 PATH**——内核自己以 root 运行时，PATH 里放一个同名 systemctl 就是提权面。
var (
	selfCtlCandidates = []string{"/bin/systemctl", "/usr/bin/systemctl"}
	// selfCtlExec 是执行注入点（测试替换为记录器，绝不真的停/重启 unit）。
	selfCtlExec = func(name string, args ...string) ([]byte, error) {
		command := exec.Command(name, args...)
		command.Env = append(os.Environ(), "LC_ALL=C")
		return command.CombinedOutput()
	}
)

// findSelfCtl 返回可用的 systemctl 绝对路径；找不到返回空串。
func findSelfCtl() string {
	for _, candidate := range selfCtlCandidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

// BuildRestartArgv 返回"不阻塞地重启一个 unit"的**完整 argv 原文**：
//
//	systemctl --no-block restart <unit>
//
// 为什么必须 --no-block：同步 restart 会等 job 完成，而 job 的第一步就是给本进程
// 发 SIGTERM——调用方（内核自己）还没拿到结果就被替换，表现为"升级报错但实际成功"
// 的假失败。--no-block 只提交 job 就返回，调用方能先把结论写完。
func BuildRestartArgv(unit string) []string {
	return []string{"systemctl", "--no-block", "restart", unit}
}

// RestartUnitNoBlock 以 --no-block 提交自重启；只回报"job 是否提交成功"。
func RestartUnitNoBlock(unit string) error {
	return runSelfCtl("--no-block", "restart", unit)
}

// StopUnitNoBlock 以 --no-block 提交自停止（卸载的最后一步：文件都删完才停自己）。
func StopUnitNoBlock(unit string) error {
	return runSelfCtl("--no-block", "stop", unit)
}

// DisableAndRemoveUnit 为"自卸载"删除 unit 文件，但**不停当前进程**：
// disable → rm unit → daemon-reload。停止动作必须留到最后由 StopUnitNoBlock 异步提交，
// 否则 systemctl stop 会把正在执行卸载的自己杀掉，卸载变成"删一半"。
func DisableAndRemoveUnit(unitName, unitPath string) ([]string, error) {
	systemctl := findSelfCtl()
	if systemctl == "" {
		return nil, fmt.Errorf("找不到 systemctl（候选 %v）：无法自卸载", selfCtlCandidates)
	}
	actions := []string{"systemctl disable " + unitName}
	// disable 对未 enable 的 unit 返回非零，属幂等场景：忽略错误继续删文件。
	_, _ = selfCtlExec(systemctl, "disable", unitName)
	actions = append(actions, "rm -f "+unitPath)
	if err := os.Remove(unitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return actions, fmt.Errorf("删除 unit %s 失败: %w", unitPath, err)
	}
	actions = append(actions, "systemctl daemon-reload")
	if _, err := selfCtlExec(systemctl, "daemon-reload"); err != nil {
		return actions, fmt.Errorf("daemon-reload 失败: %w", err)
	}
	return actions, nil
}

// UnitMainPID 返回 unit 的主进程 pid；unit 不存在或未运行时返回 0 与错误。
// 用途：让内核判断"要停的这个 unit 是不是我自己"。
func UnitMainPID(unit string) (int, error) {
	systemctl := findSelfCtl()
	if systemctl == "" {
		return 0, fmt.Errorf("找不到 systemctl（候选 %v）", selfCtlCandidates)
	}
	out, err := selfCtlExec(systemctl, "show", "-p", "MainPID", "--value", unit)
	if err != nil {
		return 0, fmt.Errorf("systemctl show %s 失败: %w（%s）", unit, err, strings.TrimSpace(string(out)))
	}
	pid := 0
	if _, scanErr := fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &pid); scanErr != nil {
		return 0, fmt.Errorf("解析 %s 的 MainPID 失败: %w", unit, scanErr)
	}
	return pid, nil
}

// runSelfCtl 用固定路径的 systemctl 执行一次自管理动作。
func runSelfCtl(args ...string) error {
	systemctl := findSelfCtl()
	if systemctl == "" {
		return fmt.Errorf("找不到 systemctl（候选 %v）：无法自管理 systemd unit", selfCtlCandidates)
	}
	if out, err := selfCtlExec(systemctl, args...); err != nil {
		return fmt.Errorf("systemctl %s 失败: %w（%s）", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
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
