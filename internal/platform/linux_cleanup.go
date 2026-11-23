//go:build linux

package platform

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// 可注入点：测试用临时 passwd 文件与假 exec，绝不触碰真实系统用户。
var (
	// passwdPath 是系统账户库；测试覆盖为临时文件。
	passwdPath = "/etc/passwd"
	// userdelCandidates 是删除账户的工具固定候选路径（不查 PATH：kored 以 root 运行时
	// PATH 可能被改写，固定路径避免"PATH 里放一个同名 userdel"接管 root 权限）。
	userdelCandidates = []string{"/usr/sbin/userdel", "/usr/bin/userdel", "/sbin/userdel"}
	// systemctlCandidates 是 systemctl 的固定候选路径。
	systemctlCandidates = []string{"/bin/systemctl", "/usr/bin/systemctl"}
	// cleanupExec 是执行外部命令的注入点（测试替换为记录器）。
	cleanupExec = func(name string, args ...string) ([]byte, error) {
		return exec.Command(name, args...).CombinedOutput()
	}
)

// systemCleanup 返回 Linux 实现。
func systemCleanup() Cleanup { return linuxCleanup{} }

// linuxCleanup 是 Cleanup 的 Linux 实现。
type linuxCleanup struct{}

// RemoveServiceUnit 按 stop → disable → rm → daemon-reload 清理 unit。
//
// 顺序不可颠倒：先停再 disable（否则 disable 后 systemd 仍持有运行中的单元）；
// rm 之后必须 daemon-reload，否则 systemctl 仍按旧 unit 缓存。
func (linuxCleanup) RemoveServiceUnit(unitName, unitPath string, dryRun bool) (UnitCleanup, error) {
	out := UnitCleanup{UnitName: unitName, UnitPath: unitPath}
	if _, err := os.Stat(unitPath); err == nil {
		out.Present = true
	} else if !os.IsNotExist(err) {
		return out, fmt.Errorf("探测 unit %s 失败: %w", unitPath, err)
	}
	systemctl := firstExecutable(systemctlCandidates)
	if out.Present && systemctl != "" {
		if _, err := cleanupExec(systemctl, "is-active", "--quiet", unitName); err == nil {
			out.Active = true
		}
	}
	if !out.Present && !out.Active {
		out.Actions = append(out.Actions, "unit 不存在且未运行，跳过")
		return out, nil
	}
	if out.Active {
		out.Actions = append(out.Actions, "systemctl stop "+unitName)
		if !dryRun {
			if _, err := cleanupExec(systemctl, "stop", unitName); err != nil {
				return out, fmt.Errorf("停止 %s 失败: %w", unitName, err)
			}
		}
	}
	if out.Present {
		out.Actions = append(out.Actions, "systemctl disable "+unitName)
		if !dryRun {
			// disable 对未 enable 的 unit 返回非零，属幂等场景：忽略错误继续删文件。
			_, _ = cleanupExec(systemctl, "disable", unitName)
		}
		out.Actions = append(out.Actions, "rm -f "+unitPath)
		if !dryRun {
			if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
				return out, fmt.Errorf("删除 unit %s 失败: %w", unitPath, err)
			}
		}
		out.Actions = append(out.Actions, "systemctl daemon-reload")
		if !dryRun {
			if _, err := cleanupExec(systemctl, "daemon-reload"); err != nil {
				return out, fmt.Errorf("daemon-reload 失败: %w", err)
			}
		}
	}
	return out, nil
}

// ListAccountsByPrefix 读系统账户库（默认 /etc/passwd）并按前缀过滤。
//
// 刻意不依赖 state 目录 / 插件清单：用户可能先删了状态目录，卸载仍要清干净。
// 这是"删目录即卸载"对豁免 #2 仍成立的关键。
func (linuxCleanup) ListAccountsByPrefix(prefix string) ([]string, error) {
	file, err := os.Open(passwdPath)
	if err != nil {
		return nil, fmt.Errorf("打开账户库 %s 失败: %w", passwdPath, err)
	}
	defer file.Close()
	var names []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, _, ok := strings.Cut(line, ":")
		if !ok || name == "" {
			continue
		}
		if strings.HasPrefix(name, prefix) {
			names = append(names, name)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("读取账户库 %s 失败: %w", passwdPath, err)
	}
	sort.Strings(names)
	return names, nil
}

// RemoveAccountsByPrefix 删账户：userdel -r 会一并删主组与 home。
//
// 安全前提：插件 home 建为 /nonexistent，`-r` 不会误删真实数据目录；
// 删除前仍用与建用户相同的正则（validateAccountName）再校验一遍再拼 argv。
func (linuxCleanup) RemoveAccountsByPrefix(prefix string, dryRun bool) (AccountCleanup, error) {
	names, err := linuxCleanup{}.ListAccountsByPrefix(prefix)
	if err != nil {
		return AccountCleanup{Prefix: prefix}, err
	}
	out := AccountCleanup{Prefix: prefix, Matched: names}
	if dryRun {
		out.Removed = append(out.Removed, names...)
		return out, nil
	}
	tool := firstExecutable(userdelCandidates)
	if len(names) > 0 && tool == "" {
		return out, fmt.Errorf("未找到 userdel（候选 %v），请安装 shadow-utils", userdelCandidates)
	}
	for _, name := range names {
		if err := validateAccountName(name); err != nil {
			out.Failed = append(out.Failed, name)
			continue
		}
		if _, err := cleanupExec(tool, "-r", name); err != nil {
			// 幂等：账户已不存在视为成功。
			if strings.Contains(strings.ToLower(err.Error()), "does not exist") {
				out.Removed = append(out.Removed, name)
				continue
			}
			out.Failed = append(out.Failed, name)
			continue
		}
		out.Removed = append(out.Removed, name)
	}
	return out, nil
}

// firstExecutable 返回候选路径中第一个存在的可执行文件。
func firstExecutable(candidates []string) string {
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	return ""
}

// UnitFileName 返回 unit 文件的绝对路径（供 CLI 拼装）。
func UnitFileName(dir, name string) string { return strings.TrimRight(dir, "/") + "/" + name }
