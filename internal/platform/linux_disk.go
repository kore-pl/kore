//go:build linux

package platform

import (
	"fmt"
	"syscall"
)

// DiskUsage 返回 path 所在文件系统的已用与总容量（KiB）。
//
// 已用 = 总块数 - 空闲块数（Bfree），与 df 的 Used/Size 口径一致；
// 只有 Linux 提供实现，其它平台由 stub_disk.go 返回 ErrUnsupported。
func DiskUsage(path string) (usedKiB, totalKiB uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, fmt.Errorf("读取 %s 文件系统容量: %w", path, err)
	}
	block := uint64(st.Bsize)
	total := st.Blocks * block
	used := total - st.Bfree*block
	return used / 1024, total / 1024, nil
}
