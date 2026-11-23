//go:build linux

package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// readPasswordNoEcho 关闭终端回显读一行口令，返回前恢复原终端属性（Linux）。
//
// 关闭回显只改 ICANON 保留行缓冲：逐字符读取会让退格键失效，而口令输入
// 需要退格。终端属性恢复走 defer，任何路径都不会把用户终端留在无回显状态。
func readPasswordNoEcho(f *os.File) (string, error) {
	fd := f.Fd()
	var old syscall.Termios
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, fd, uintptr(syscall.TCGETS),
		uintptr(unsafe.Pointer(&old)), 0, 0, 0); errno != 0 {
		return "", fmt.Errorf("读取终端属性失败: %v", errno)
	}
	raw := old
	raw.Lflag &^= syscall.ECHO
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, fd, uintptr(syscall.TCSETS),
		uintptr(unsafe.Pointer(&raw)), 0, 0, 0); errno != 0 {
		return "", fmt.Errorf("关闭终端回显失败: %v", errno)
	}
	defer func() {
		_, _, _ = syscall.Syscall6(syscall.SYS_IOCTL, fd, uintptr(syscall.TCSETS),
			uintptr(unsafe.Pointer(&old)), 0, 0, 0)
	}()
	line, err := bufio.NewReader(f).ReadString('\n')
	fmt.Fprintln(os.Stderr)
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
