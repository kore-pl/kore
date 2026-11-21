package main

import (
	"math"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"testing"
)

// metricUint64 读取一个 uint64 型运行时指标（只读，无副作用）。
func metricUint64(t *testing.T, name string) uint64 {
	t.Helper()
	samples := []metrics.Sample{{Name: name}}
	metrics.Read(samples)
	if samples[0].Value.Kind() != metrics.KindUint64 {
		t.Fatalf("指标 %s 不是 uint64（kind=%v）", name, samples[0].Value.Kind())
	}
	return samples[0].Value.Uint64()
}

// numGC 读取本进程已完成的 GC 次数。
func numGC() uint32 {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return stats.NumGC
}

// TestRuntimeLimitsKeepGCEnabled 断言启动期资源锚点不会关闭 GC。
//
// 回归目标：日志里若用"设置即读取"的副作用 API 回读 GC 百分比，会把 GC 关掉，
// 导致 GOGC 三档消融全部失效——本用例通过 /gc/gogc:percent 指标直接抓这种改写。
func TestRuntimeLimitsKeepGCEnabled(t *testing.T) {
	t.Setenv("GOGC", "")
	t.Setenv("GOMEMLIMIT", "")
	t.Setenv("GOMAXPROCS", "")
	originalProcs := runtime.GOMAXPROCS(0)
	t.Cleanup(func() {
		debug.SetGCPercent(100)
		debug.SetMemoryLimit(math.MaxInt64)
		runtime.GOMAXPROCS(originalProcs)
	})

	limits := setRuntimeLimits()
	logRuntimeLimits(limits)

	if limits.MaxProcs != runtime.GOMAXPROCS(0) || limits.MaxProcs <= 0 {
		t.Fatalf("记录值 MaxProcs=%d 与运行时 %d 不一致", limits.MaxProcs, runtime.GOMAXPROCS(0))
	}
	if limits.GOGC != defaultGOGC {
		t.Fatalf("记录值 GOGC=%d，期望 %d", limits.GOGC, defaultGOGC)
	}
	if got := metricUint64(t, "/gc/gogc:percent"); got != uint64(defaultGOGC) {
		t.Fatalf("GC 百分比被改写：/gc/gogc:percent=%d，期望 %d（GC 被副作用 API 关掉了）", got, defaultGOGC)
	}
	if got := metricUint64(t, "/gc/gomemlimit:bytes"); got != uint64(defaultMemLimit) {
		t.Fatalf("内存上限被改写：/gc/gomemlimit:bytes=%d，期望 %d", got, defaultMemLimit)
	}
	before := numGC()
	for i := 0; i < 8; i++ {
		buf := make([]byte, 16<<20)
		buf[0] = 1
		runtime.KeepAlive(buf)
	}
	if numGC() == before {
		t.Fatal("分配 128 MiB 后 GC 没有运行：GC 疑似被关闭")
	}
}

// TestRuntimeLimitsHonorEnv 断言外部环境变量覆盖被解析并记录（消融实验依赖此行为）。
//
// 注意：GOGC / GOMEMLIMIT 由运行时在 init 阶段读取，测试内 t.Setenv 只影响本函数的
// 解析逻辑，不回写运行时；这里断言"记录值"，运行时生效值由启动日志与实机消融验证。
func TestRuntimeLimitsHonorEnv(t *testing.T) {
	t.Setenv("GOGC", "200")
	t.Setenv("GOMEMLIMIT", "8MiB")
	t.Setenv("GOMAXPROCS", "3")
	originalProcs := runtime.GOMAXPROCS(0)
	t.Cleanup(func() {
		debug.SetGCPercent(100)
		debug.SetMemoryLimit(math.MaxInt64)
		runtime.GOMAXPROCS(originalProcs)
	})

	limits := setRuntimeLimits()
	logRuntimeLimits(limits)

	if limits.GOGC != 200 {
		t.Fatalf("GOGC 覆盖未生效：记录 %d，期望 200", limits.GOGC)
	}
	if limits.MemLimitBytes != 8<<20 {
		t.Fatalf("GOMEMLIMIT 覆盖未生效：记录 %d，期望 %d", limits.MemLimitBytes, 8<<20)
	}
	// GOMAXPROCS 由运行时在 init 阶段读取，测试内 t.Setenv 不回写运行时；
	// 这里只断言"记录值与运行时实际值一致"，环境覆盖的端到端证据由实机启动日志提供。
	if limits.MaxProcs != runtime.GOMAXPROCS(0) || limits.MaxProcs <= 0 {
		t.Fatalf("记录值 MaxProcs=%d 与运行时 %d 不一致", limits.MaxProcs, runtime.GOMAXPROCS(0))
	}
}
