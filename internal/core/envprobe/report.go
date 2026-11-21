// Package envprobe 在启动期一次性探测宿主环境能力，产出不可变 Report。
//
// 分工：platform 层采集原始事实（Facts），本包只做纯判定——不访问 syscall、
// 不联网、不起 goroutine、不留定时器（G-19）。硬要求不满足返回 ErrUnsupportedEnv，
// cmd/kored 据此 exit 6；软要求缺失只记 Warnings，不阻断启动。
package envprobe

import (
	"errors"
	"fmt"
)

// ErrUnsupportedEnv 表示环境硬要求不满足（平台 / 架构 / 内核 / 状态目录文件系统）。
var ErrUnsupportedEnv = errors.New("envprobe: 环境硬要求不满足")

// 运行下限：Linux 内核 4.18（RHEL 8 基线）。
const (
	// MinKernelMajor 支持的最小内核主版本。
	MinKernelMajor = 4
	// MinKernelMinor 支持的最小内核次版本。
	MinKernelMinor = 18
)

// Facts 是 platform 层采集的宿主原始事实，判定层只读不改。
type Facts struct {
	// GOOS 目标操作系统（runtime.GOOS）。
	GOOS string
	// GOARCH 目标架构（runtime.GOARCH）。
	GOARCH string
	// OSVersion 发行版标识。
	OSVersion string
	// Kernel 内核 release 原文。
	Kernel string
	// KernelMajor 内核主版本。
	KernelMajor int
	// KernelMinor 内核次版本。
	KernelMinor int
	// CgroupMode cgroup 形态：v1 / v2 / none。
	CgroupMode string
	// Delegation cgroup 委派是否可写。
	Delegation bool
	// InitSystem 服务管理器形态：systemd / openrc / none。
	InitSystem string
	// SELinux SELinux 强制状态。
	SELinux string
	// AppArmor 是否可用。
	AppArmor bool
	// FSType 状态目录文件系统类型。
	FSType string
}

// Report 是 capability report，由 /api/v1/system/info 原样返回（JSON 可序列化）。
type Report struct {
	// OS 操作系统。
	OS string `json:"os"`
	// OSVersion 发行版标识。
	OSVersion string `json:"os_version"`
	// Arch 架构。
	Arch string `json:"arch"`
	// Kernel 内核 release。
	Kernel string `json:"kernel"`
	// CgroupMode cgroup 形态：v1 / v2 / none。
	CgroupMode string `json:"cgroup_mode"`
	// Delegation cgroup 委派是否可写。
	Delegation bool `json:"delegation"`
	// Systemd 是否存在 systemd。
	Systemd bool `json:"systemd"`
	// SELinux SELinux 强制状态：enforcing / permissive / disabled。
	SELinux string `json:"selinux"`
	// AppArmor 是否可用。
	AppArmor bool `json:"apparmor"`
	// FSType 状态目录文件系统类型。
	FSType string `json:"fs_type"`
	// Warnings 软要求缺失项，不阻断启动。
	Warnings []string `json:"warnings,omitempty"`
}

// String 便于日志打印一行摘要。
func (r Report) String() string {
	return fmt.Sprintf("os=%s arch=%s kernel=%s cgroup=%s delegation=%t systemd=%t fs=%s",
		r.OS, r.Arch, r.Kernel, r.CgroupMode, r.Delegation, r.Systemd, r.FSType)
}
