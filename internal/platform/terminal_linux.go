//go:build linux

package platform

import (
	"syscall"
	"unsafe"
)

// IsTerminal 判断 fd 是否指向终端（用 TCGETS ioctl，不把 /dev/null 这类字符设备误判为 TTY）。
//
// 为什么不用 ModeCharDevice：/dev/null 也是字符设备，会把"非交互"当成"交互"，
// 从而让破坏性操作在没有显式 --yes 时走到交互确认路径。
func IsTerminal(fd uintptr) bool {
	var termios syscall.Termios
	_, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, fd, uintptr(syscall.TCGETS),
		uintptr(unsafe.Pointer(&termios)), 0, 0, 0)
	return errno == 0
}
