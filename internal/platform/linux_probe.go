//go:build linux

package platform

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// linuxService 是 Service 的 Linux 实现（全部只读，探测后不留残留）。
type linuxService struct{}

// Host 一次性采集 init、内核、OS、cgroup、SELinux、AppArmor 事实。
func (linuxService) Host() (HostInfo, error) {
	release, major, minor, err := kernelInfo()
	if err != nil {
		return HostInfo{}, err
	}
	return HostInfo{
		InitSystem:  initSystem(),
		Kernel:      release,
		KernelMajor: major,
		KernelMinor: minor,
		OSVersion:   osVersion(release),
		CgroupMode:  cgroupMode(),
		SELinux:     selinuxMode(),
		AppArmor:    pathExists("/sys/kernel/security/apparmor"),
	}, nil
}

// Delegated 通过真实建目录 + 写 memory.max 探测 cgroup 委派，探测后回滚。
func (linuxService) Delegated() bool {
	const base = "/sys/fs/cgroup/kore"
	_, statErr := os.Stat(base)
	createdBase := statErr != nil
	if err := os.MkdirAll(base, 0o755); err != nil {
		return false
	}
	if createdBase {
		defer func() { _ = os.Remove(base) }()
	}
	probe := fmt.Sprintf("%s/.probe-%d", base, os.Getpid())
	if err := os.Mkdir(probe, 0o755); err != nil {
		return false
	}
	defer func() { _ = os.RemoveAll(probe) }()
	return os.WriteFile(probe+"/memory.max", []byte("max"), 0o644) == nil
}

// kernelInfo 读取 uname 并解析主次版本号。
func kernelInfo() (string, int, int, error) {
	var uts syscall.Utsname
	if err := syscall.Uname(&uts); err != nil {
		return "", 0, 0, fmt.Errorf("读取内核版本: %w", err)
	}
	release := int8sToString(uts.Release[:])
	major, minor, err := parseKernelRelease(release)
	if err != nil {
		return release, 0, 0, err
	}
	return release, major, minor, nil
}

// int8sToString 把 Utsname 的定长 int8 数组转成字符串。
func int8sToString(buf []int8) string {
	out := make([]byte, 0, len(buf))
	for _, b := range buf {
		if b == 0 {
			break
		}
		out = append(out, byte(b))
	}
	return string(out)
}

// parseKernelRelease 解析 "6.8.0-45-generic" 形态的内核版本，取主次版本。
func parseKernelRelease(release string) (int, int, error) {
	parts := strings.SplitN(release, ".", 3)
	if len(parts) < 2 {
		return 0, 0, fmt.Errorf("内核版本不可解析: %q", release)
	}
	major, err := leadingNumber(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("内核主版本不可解析: %q", release)
	}
	minor, err := leadingNumber(parts[1])
	if err != nil {
		return 0, 0, fmt.Errorf("内核次版本不可解析: %q", release)
	}
	return major, minor, nil
}

// leadingNumber 取字符串开头的十进制数字（忽略发行版后缀）。
func leadingNumber(s string) (int, error) {
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, fmt.Errorf("无数字前缀: %q", s)
	}
	return strconv.Atoi(s[:end])
}

// initSystem 依据运行期目录判定服务管理器形态，不看 PID 1 的名字。
func initSystem() string {
	switch {
	case pathExists("/run/systemd/system"):
		return "systemd"
	case pathExists("/run/openrc"):
		return "openrc"
	}
	return "none"
}

// osVersion 读取 /etc/os-release 的 PRETTY_NAME，缺失时回退内核 release。
func osVersion(fallback string) string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return fallback
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "PRETTY_NAME=") {
			continue
		}
		value := strings.TrimPrefix(line, "PRETTY_NAME=")
		if unquoted, err := strconv.Unquote(value); err == nil {
			return unquoted
		}
		return strings.Trim(value, `"'`)
	}
	return fallback
}

// cgroupMode 判定 cgroup 形态：v2 需 /proc/self/cgroup 首行 0::/ 且 controllers 可读。
func cgroupMode() string {
	const controllers = "/sys/fs/cgroup/cgroup.controllers"
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "none"
	}
	first := strings.TrimSpace(strings.SplitN(string(data), "\n", 2)[0])
	if strings.HasPrefix(first, "0::") && pathExists(controllers) {
		return "v2"
	}
	for _, controller := range []string{"memory", "cpu", "pids"} {
		if pathExists("/sys/fs/cgroup/" + controller + "/cgroup.procs") {
			return "v1"
		}
	}
	return "none"
}

// selinuxMode 读取 SELinux 强制状态；selinuxfs 不存在记为 disabled。
func selinuxMode() string {
	data, err := os.ReadFile("/sys/fs/selinux/enforce")
	if err != nil {
		return "disabled"
	}
	if strings.TrimSpace(string(data)) == "1" {
		return "enforcing"
	}
	return "permissive"
}

// pathExists 报告路径是否存在（不跟随语义由调用方决定）。
func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
