//go:build linux

package metrics

import (
	"testing"
	"time"
)

// TestCollect 校验首次采样建立基线、第二次按差值给出非零 CPU，且各字段合理。
func TestCollect(t *testing.T) {
	c := New(t.TempDir())
	first, err := c.Collect()
	if err != nil {
		t.Fatalf("首次采样失败: %v", err)
	}
	if first.CPUPercent != 0 {
		t.Fatalf("首次采样应返回 0（仅缓存基线），实际 %v", first.CPUPercent)
	}
	if first.RSSKiB == 0 {
		t.Fatal("RSSKiB 应 > 0")
	}
	if first.DiskTotalKiB == 0 {
		t.Fatal("DiskTotalKiB 应 > 0")
	}
	if first.DiskUsedKiB > first.DiskTotalKiB {
		t.Fatalf("磁盘已用 %d KiB 不应超过总量 %d KiB", first.DiskUsedKiB, first.DiskTotalKiB)
	}
	if first.Load1 < 0 {
		t.Fatalf("Load1 不应为负: %v", first.Load1)
	}
	if first.Goroutines <= 0 {
		t.Fatalf("Goroutines 应 > 0: %d", first.Goroutines)
	}
	if first.FDs <= 0 {
		t.Fatalf("FDs 应 > 0: %d", first.FDs)
	}

	// 制造可观测的 CPU 增量，证明第二次用的是新基线而不是重放常量。
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
	}
	second, err := c.Collect()
	if err != nil {
		t.Fatalf("第二次采样失败: %v", err)
	}
	if second.CPUPercent < 0 || second.CPUPercent > 100 {
		t.Fatalf("CPUPercent 应在 0–100，实际 %v", second.CPUPercent)
	}
	if second.CPUPercent == 0 {
		t.Fatalf("有 CPU 忙等后第二次采样应 > 0，实际 %v（基线可能未推进）", second.CPUPercent)
	}
	if !second.TakenAt.After(first.TakenAt) {
		t.Fatalf("两次采样时间应递增: %v -> %v", first.TakenAt, second.TakenAt)
	}
	if second.DiskTotalKiB == 0 || second.RSSKiB == 0 || second.Load1 < 0 {
		t.Fatalf("第二次采样字段不完整: %+v", second)
	}
}
