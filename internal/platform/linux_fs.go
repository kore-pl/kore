//go:build linux

package platform

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Linux 文件系统魔数（statfs f_type），用于识别状态目录所在文件系统。
const (
	magicNFS   = 0x6969
	magicSMB   = 0x517B
	magicCIFS  = 0xFF534D42
	magicSMB2  = 0xFE534D42
	magicFUSE  = 0x65735546
	magicTmpfs = 0x01021994
	magicExt   = 0xEF53
	magicXFS   = 0x58465342
	magicBtrfs = 0x9123683E
)

// existingAncestor 从给定路径向上找到第一个已存在的目录（探测先于建目录）。
func existingAncestor(path string) (string, error) {
	cur := filepath.Clean(path)
	for {
		if _, err := os.Stat(cur); err == nil {
			return cur, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("确认 %s 是否存在: %w", cur, err)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", fmt.Errorf("路径 %s 无已存在祖先", path)
		}
		cur = parent
	}
}

// fsName 把 statfs 魔数翻译成文件系统类型名；未知魔数保留十六进制便于排查。
func fsName(magic uint32) string {
	switch magic {
	case magicNFS:
		return "nfs"
	case magicSMB, magicSMB2, magicCIFS:
		return "smb"
	case magicFUSE:
		return "fuse"
	case magicTmpfs:
		return "tmpfs"
	case magicExt:
		return "ext4"
	case magicXFS:
		return "xfs"
	case magicBtrfs:
		return "btrfs"
	}
	return fmt.Sprintf("unknown(0x%x)", magic)
}

// isNetworkOrFuseFS 判断状态目录是否落在不受支持的文件系统上。
func isNetworkOrFuseFS(name string) bool {
	switch name {
	case "nfs", "smb", "cifs", "fuse":
		return true
	}
	return false
}
