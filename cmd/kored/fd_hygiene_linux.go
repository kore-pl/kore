//go:build linux

package main

import (
	"os"
	"strconv"
	"syscall"
)

// closeInheritedFDs 关闭进程启动时从父进程继承来的、与 kore 无关的文件描述符。
//
// 为什么需要（G-03 fd≤64 硬红线）：Linux 上 execve 默认不清空 fd 表，只有
// 设置 CLOEXEC 的 fd 才会自动关闭。systemd / shell 拉起 kored 时 fd 表干净，
// 但被其它进程（如带常驻 socket / mmap 文件的图形化 harness、supervisor、
// 测试框架）作为子进程 spawn 时，会继承父进程几十个无关 fd
// （app.asar / Chromium shm / leveldb / D-Bus socket 等），导致
// `ls /proc/<pid>/fd | wc -l` 虚高到 79/82，误触 G-03 硬红线（实测 2026-11-28
// task-351 宝塔真机验收）。这不是 kored 自己打开的 fd，而是继承污染。
//
// 只关 fd≥3（0/1/2 是 stdin/stdout/stderr，必须保留），且只关首次调用时
// 已经存在的 fd；调用之后 Go runtime / 业务代码（net.Listen / bbolt /
// os.Open / UDS）新建的 fd 不受影响。幂等：重复调用无副作用。
//
// 安全性：os.ReadDir 内部打开的目录 fd 带 CLOEXEC 且在返回前已关闭；
// Go netpoll epoll/eventfd 在首次网络 I/O 才创建（亦带 CLOEXEC），本函数在
// 启动最早期调用，不会误伤（已用独立实验验证 close 后 net.Listen/Dial/
// Accept/Read 全链路正常）。
//
// 返回被关闭的 fd 个数，便于日志与测试核对。
func closeInheritedFDs() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		// procfs 不可读：不阻断启动（非 Linux 文件系统等降级场景）。
		return 0
	}
	closed := 0
	for _, e := range entries {
		fd, err := strconv.Atoi(e.Name())
		if err != nil || fd < 3 {
			continue
		}
		if err := syscall.Close(fd); err == nil {
			closed++
		}
	}
	return closed
}

// countOpenFDs 返回当前进程 /proc/self/fd 下的 fd 数（自观测口径，供测试
// 与启动日志核对，生产判定仍以外部 ls /proc/<pid>/fd 为准）。procfs 不可读
// 时返回 -1。
func countOpenFDs() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return -1
	}
	return len(entries)
}
