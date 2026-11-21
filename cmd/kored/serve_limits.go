package main

import (
	"log/slog"
	"math"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
)

// 资源锚点默认值（口径见 docs/CORE.md 资源调优一节 +
// docs/DECISIONS/0015-runtime-resource-anchors.md）。
const (
	// defaultGOGC 是默认档 GC 目标比例（未设 GOGC 时生效）。
	defaultGOGC = 50
	// defaultMemLimit 是默认档 Go 堆软上限（未设 GOMEMLIMIT 时生效）。
	defaultMemLimit int64 = 6 << 20
	// maxProcs 是主壳并行度上限（未设 GOMAXPROCS 且 CPU 核数超限时收敛）。
	maxProcs = 8
)

// runtimeLimits 记录本次实际应用到运行时的资源锚点，供启动日志与回归测试使用。
//
// 只记录"自己设置的值"：禁止用副作用式 API 回读运行时配置（G-21）。
type runtimeLimits struct {
	// GOGC 实际生效的 GC 目标比例；-1 表示 off。
	GOGC int
	// MaxProcs 实际生效的 P 数量上限。
	MaxProcs int
	// MemLimitBytes 实际生效的 Go 堆软上限（字节）。
	MemLimitBytes int64
}

// setRuntimeLimits 应用主壳的资源锚点并返回实际生效值。
//
//   - 堆软上限：GOMEMLIMIT 已由环境设置时尊重环境（消融对照用），否则取默认档；
//   - GC 目标比例：GOGC 已设置时尊重环境（消融对照用），否则取默认档；
//   - 并行度上限：GOMAXPROCS 已设置时尊重环境，否则仅在 CPU 核数超限时收敛。
func setRuntimeLimits() runtimeLimits {
	limits := runtimeLimits{GOGC: defaultGOGC, MemLimitBytes: defaultMemLimit}
	if raw := os.Getenv("GOMEMLIMIT"); raw != "" {
		limits.MemLimitBytes = parseMemLimit(raw)
	} else {
		debug.SetMemoryLimit(defaultMemLimit)
	}
	if raw := os.Getenv("GOGC"); raw != "" {
		limits.GOGC = parseGOGC(raw)
	} else {
		debug.SetGCPercent(defaultGOGC)
	}
	if os.Getenv("GOMAXPROCS") == "" && runtime.NumCPU() > maxProcs {
		runtime.GOMAXPROCS(maxProcs)
	}
	limits.MaxProcs = runtime.GOMAXPROCS(0) // GOMAXPROCS(0) 只读，无副作用
	return limits
}

// parseGOGC 解析 GOGC 环境变量；无法解析时按 off(-1) 记录并告警。
func parseGOGC(raw string) int {
	if raw == "off" {
		return -1
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		slog.Warn("GOGC 无法解析，按 off 记录", "raw", raw)
		return -1
	}
	return value
}

// parseMemLimit 解析 GOMEMLIMIT 环境变量（纯字节数或 KiB/MiB/GiB/TiB 后缀）。
func parseMemLimit(raw string) int64 {
	if raw == "off" || raw == "max" {
		return math.MaxInt64
	}
	value, err := parseByteSize(raw)
	if err != nil {
		slog.Warn("GOMEMLIMIT 无法解析，按 -1 记录", "raw", raw)
		return -1
	}
	return value
}

// parseByteSize 解析带二进制单位后缀的字节数。
func parseByteSize(raw string) (int64, error) {
	units := []struct {
		suffix     string
		multiplier int64
	}{
		{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}, {"TiB", 1 << 40},
	}
	for _, unit := range units {
		if strings.HasSuffix(raw, unit.suffix) {
			value, err := strconv.ParseInt(strings.TrimSuffix(raw, unit.suffix), 10, 64)
			if err != nil {
				return 0, err
			}
			return value * unit.multiplier, nil
		}
	}
	return strconv.ParseInt(raw, 10, 64)
}

// logRuntimeLimits 打印实际生效的资源锚点（只读入参，不触碰运行时状态）。
func logRuntimeLimits(limits runtimeLimits) {
	slog.Info("资源锚点", "gogc_percent", limits.GOGC,
		"gomemlimit_bytes", limits.MemLimitBytes, "gomaxprocs", limits.MaxProcs)
}
