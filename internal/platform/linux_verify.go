//go:build linux

package platform

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
	"syscall"
)

// VerifyOwner 校验 path 的属主名、属组名与权限位（K3：受控写落盘后的 root:root 0644 复核）。
//
// 只设 mode 不设属主是真实缺口：kored 以 root 运行时临时文件天然是 root，但 setgid
// 目录、挂载选项、外部预置文件都会让属组偏离；而 conf.d 片段会被 **root master** 解析，
// 属组错误的文件同样是隐患。这里把「期望的属主/属组/权限」显式比对，不猜。
//
// os/user 与 syscall.Stat_t 属平台专有 API，按 G-16 收在 internal/platform。
func VerifyOwner(path, owner, group string, mode os.FileMode) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("platform: 读取 %s 属性: %w", path, err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("platform: %s 无 stat 信息，无法复核属主", path)
	}
	ownerName, err := user.LookupId(strconv.FormatUint(uint64(stat.Uid), 10))
	if err != nil {
		return fmt.Errorf("platform: 解析 %s 属主 uid=%d: %w", path, stat.Uid, err)
	}
	groupName, err := user.LookupGroupId(strconv.FormatUint(uint64(stat.Gid), 10))
	if err != nil {
		return fmt.Errorf("platform: 解析 %s 属组 gid=%d: %w", path, stat.Gid, err)
	}
	if ownerName.Username != owner {
		return fmt.Errorf("platform: %s 属主是 %q，要求 %q", path, ownerName.Username, owner)
	}
	if groupName.Name != group {
		return fmt.Errorf("platform: %s 属组是 %q，要求 %q", path, groupName.Name, group)
	}
	if perm := info.Mode().Perm(); perm != mode.Perm() {
		return fmt.Errorf("platform: %s 权限是 %04o，要求 %04o", path, perm, mode.Perm())
	}
	return nil
}
