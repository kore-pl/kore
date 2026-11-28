//go:build !linux

package main

// closeInheritedFDs 在非 Linux（Tier B 降级）上无操作：procfs fd 清点依赖
// Linux /proc/self/fd；降级平台由进程管理器（launchd / SCM）传递干净 fd 表，
// 不引入平台专有 syscall（G-16）。
func closeInheritedFDs() int { return 0 }

// countOpenFDs 在非 Linux 上不可用，返回 -1（信息入口，不阻断）。
func countOpenFDs() int { return -1 }
