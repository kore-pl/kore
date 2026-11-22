//go:build !linux

package platform

import "fmt"

// DiskUsage 在非 Linux 平台返回 ErrUnsupported（Tier B 降级，不静默）。
func DiskUsage(path string) (usedKiB, totalKiB uint64, err error) {
	return 0, 0, fmt.Errorf("%w: 磁盘容量采样仅 Linux（%s）", ErrUnsupported, path)
}
