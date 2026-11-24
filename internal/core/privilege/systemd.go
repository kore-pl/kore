package privilege

// 本文件只剩**内核自管理**（重启 / 停止 / 卸载自己这个 unit）用的 systemctl 调用。
//
// 提权动作的执行已改为内核直接 exec（ADR-0049，见 exec.go）：不再经
// `systemd-run` transient unit、不再依赖 polkit、不再把 `/run/systemd/system`
// 与 `systemd-run` 当准入条件。这里保留的 systemctl 是「kore 自己的服务生命周期」
// 需要，与插件 root 动作的执行路径无关。

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

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
