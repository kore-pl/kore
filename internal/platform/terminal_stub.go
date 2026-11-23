//go:build !linux

package platform

import "os"

// IsTerminal 在非 Linux 上退化为字符设备判断（Tier B 降级）。
func IsTerminal(fd uintptr) bool {
	info, err := os.Stdin.Stat()
	if err != nil || fd != os.Stdin.Fd() {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}
