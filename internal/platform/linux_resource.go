//go:build linux

package platform

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// cgroupRoot 是主壳自管的 cgroup 子树根（由 systemd Delegate=yes 交付）。
const cgroupRoot = "/sys/fs/cgroup/kore"

// linuxResource 是 Resource 的 Linux 实现（cgroup v2 可写则强制，否则只读观测）。
type linuxResource struct{}

// Enforced 报告当前宿主能否真正写入 cgroup v2 限额。
func (linuxResource) Enforced() bool {
	return cgroupMode() == "v2" && linuxService{}.Delegated()
}

// Apply 把限额写入 cgroup v2 对应文件；未启用强制时返回 ErrUnsupported。
func (linuxResource) Apply(scope string, limits Limits) error {
	if !validScope(scope) {
		return fmt.Errorf("限额作用域非法: %q", scope)
	}
	if !(linuxResource{}).Enforced() {
		return fmt.Errorf("%w: cgroup v2 未委派，限额降级为只读观测", ErrUnsupported)
	}
	dir := filepath.Join(cgroupRoot, scope)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建 cgroup %s: %w", dir, err)
	}
	writes := []struct {
		file  string
		value string
	}{
		{"memory.max", strconv.FormatInt(limits.MemoryBytes, 10)},
		{"cpu.max", fmt.Sprintf("%d 100000", limits.CPUQuota)},
		{"pids.max", strconv.Itoa(limits.PidsMax)},
	}
	for _, w := range writes {
		if w.value == "0" || w.value == "0 100000" {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, w.file), []byte(w.value), 0o644); err != nil {
			return fmt.Errorf("写入 %s/%s: %w", dir, w.file, err)
		}
	}
	return nil
}

// RSS 读取 /proc/<pid>/status 的 VmRSS 并换算为字节。
func (linuxResource) RSS(pid int) (uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, fmt.Errorf("读取进程 %d 状态: %w", pid, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		kib, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("解析进程 %d 的 VmRSS: %w", pid, err)
		}
		return kib * 1024, nil
	}
	return 0, fmt.Errorf("进程 %d 未报告 VmRSS", pid)
}

// validScope 只接受单层目录名，拒绝路径分隔与上跳。
func validScope(scope string) bool {
	return scope != "" && scope != "." && scope != ".." &&
		!strings.ContainsAny(scope, "/\\") && !strings.Contains(scope, "..")
}
