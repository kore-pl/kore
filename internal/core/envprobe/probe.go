package envprobe

import "fmt"

// Probe 按硬要求判定环境并产出 Report；硬要求不满足时返回包装了 ErrUnsupportedEnv 的错误。
func Probe(f Facts) (Report, error) {
	if err := checkHard(f); err != nil {
		return Report{}, err
	}
	report := Report{
		OS:         f.GOOS,
		OSVersion:  f.OSVersion,
		Arch:       f.GOARCH,
		Kernel:     f.Kernel,
		CgroupMode: f.CgroupMode,
		Delegation: f.Delegation,
		Systemd:    f.InitSystem == "systemd",
		SELinux:    f.SELinux,
		AppArmor:   f.AppArmor,
		FSType:     f.FSType,
	}
	report.Warnings = warnings(f)
	return report, nil
}

// checkHard 校验四类硬要求：平台 / 架构、OS 版本下限、状态目录文件系统、探测源可读。
func checkHard(f Facts) error {
	switch f.GOARCH {
	case "amd64", "arm64":
	default:
		return fmt.Errorf("%w: 架构 %q（仅支持 amd64 / arm64）", ErrUnsupportedEnv, f.GOARCH)
	}
	switch f.GOOS {
	case "linux":
	case "windows", "darwin":
		return fmt.Errorf("%w: 平台 %q 的运行期实现归 M2/M3（M1 仅 Linux）", ErrUnsupportedEnv, f.GOOS)
	default:
		return fmt.Errorf("%w: 不支持的平台 %q", ErrUnsupportedEnv, f.GOOS)
	}
	if f.Kernel == "" {
		return fmt.Errorf("%w: 内核版本不可读，无法判定下限 %d.%d",
			ErrUnsupportedEnv, MinKernelMajor, MinKernelMinor)
	}
	if f.KernelMajor < MinKernelMajor ||
		(f.KernelMajor == MinKernelMajor && f.KernelMinor < MinKernelMinor) {
		return fmt.Errorf("%w: 内核 %s 低于下限 %d.%d",
			ErrUnsupportedEnv, f.Kernel, MinKernelMajor, MinKernelMinor)
	}
	if rejectedFS(f.FSType) {
		return fmt.Errorf("%w: 状态目录位于 %s 文件系统（有静默损坏风险）", ErrUnsupportedEnv, f.FSType)
	}
	return nil
}

// rejectedFS 判定状态目录文件系统是否属于硬拒绝集合。
//
// nfs / smb 来自 CORE §2.11 与 COMPATIBILITY §8；fuse 与 platform.Paths.Ensure
// 保持同一口径（用户态文件系统同样会破坏 bbolt 的写入语义）。
func rejectedFS(name string) bool {
	switch name {
	case "nfs", "smb", "cifs", "fuse":
		return true
	}
	return false
}

// warnings 汇总软要求缺失项：只降级、不阻断。
func warnings(f Facts) []string {
	out := make([]string, 0, 5)
	if f.CgroupMode != "v2" {
		out = append(out, fmt.Sprintf("cgroup v2 不可用（%s），限额降级为只读观测", fallback(f.CgroupMode)))
	}
	if !f.Delegation {
		out = append(out, "cgroup 委派不可写，限额不生效")
	}
	if f.InitSystem != "systemd" {
		out = append(out, fmt.Sprintf("未检测到 systemd（init=%s），无开机自启", fallback(f.InitSystem)))
	}
	if f.SELinux != "enforcing" {
		out = append(out, fmt.Sprintf("SELinux 未强制（%s），策略拦截不可依赖", fallback(f.SELinux)))
	}
	if !f.AppArmor {
		out = append(out, "AppArmor 不可用")
	}
	if f.FSType == "tmpfs" {
		out = append(out, "状态目录位于 tmpfs，重启后数据不保留")
	}
	return out
}

// fallback 把空串归一为 unknown，避免日志出现空值。
func fallback(v string) string {
	if v == "" {
		return "unknown"
	}
	return v
}
