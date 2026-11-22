package supervisor_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/supervisor"
)

// TestLazyColdStartP95 采两轮独立的 lazy 冷启样本，报告 p50/p95/max 与冷启次数。
//
// 真冷启口径（提案 0003 §2/§3-R2/§4.2）：每个样本前先让 lazy 进程空闲退出
// （复用 M2 idle timeout，非 20 连打），确认上一 PID 已消失后才开始计时；
// 以新 PID != 旧 PID 证明本次确为冷启。20 样本全冷启才写「冷启次数=20」。
// 两轮 p95 漂移 >100ms 判该轮无效并 Fatal，不以 WARN 放行；
// p95 ≤300ms 是软 SLO，超阈值只 WARN 留真实数据、不判 FAIL。
func TestLazyColdStartP95(t *testing.T) {
	const (
		sampleCount = 20
		pluginID    = "coldp95"
		softSLOMs   = 300
		driftLimit  = 100 * time.Millisecond
	)
	// 极短 idle：每次 invoke 后 lazy 自动空闲退出，确保下一样本是冷启。
	env := newLazyEnv(t, []string{pluginID}, "lazy", 60*time.Millisecond)
	ctx := context.Background()

	head := gitOutput(t, "rev-parse", "HEAD")
	t.Logf("HEAD=%s", head)
	t.Logf("后台任务快照(采样进程)=pid=%d goroutine 由 go test 托管，无周期性定时器", os.Getpid())

	round1 := collectColdStarts(t, ctx, env, pluginID, sampleCount)
	round2 := collectColdStarts(t, ctx, env, pluginID, sampleCount)
	p95_1, p50_1, max_1 := stats(round1)
	p95_2, p50_2, max_2 := stats(round2)

	printSamples(t, "第一轮", round1, p50_1, p95_1, max_1)
	printSamples(t, "第二轮", round2, p50_2, p95_2, max_2)

	drift := p95_1 - p95_2
	if drift < 0 {
		drift = -drift
	}
	t.Logf("两轮 p95 漂移=%v（阈值 %v）", drift, driftLimit)
	if drift > driftLimit {
		t.Fatalf("两轮 p95 漂移 %v > %v，判该轮无效需重测，不以 WARN 放行", drift, driftLimit)
	}
	for i, p95 := range []time.Duration{p95_1, p95_2} {
		if p95 > softSLOMs*time.Millisecond {
			t.Logf("WARN: 第%d轮 p95=%v 超软 SLO %dms（软 SLO 不判 FAIL，留真实数据）", i+1, p95, softSLOMs)
		}
	}
}

// collectColdStarts 采一轮 20 个冷启样本（毫秒）；每样本前确认 lazy 空闲退出、
// 换 PID，确保 20 连打不是 1 冷 19 热。
func collectColdStarts(t *testing.T, ctx context.Context, env *lazyEnv, id string, n int) []time.Duration {
	t.Helper()
	// 轮次开头读取可能仍在跑的进程（上一轮 idle 退出是异步的）：
	// 把它作为 prevPID，令首样本同样走「等退出 + 换 PID」双断言，
	// 避免首样本复用上一轮热进程导致「冷启次数=20」虚标。
	prevPID := 0
	if view, _ := env.manager.Snapshot(id); view.PID > 0 {
		prevPID = view.PID
	}
	samples := make([]time.Duration, 0, n)
	for i := 0; i < n; i++ {
		// 确保上一进程已空闲退出（复用 idle timeout 机制），否则本轮不算冷启。
		if prevPID != 0 {
			waitStopped(t, env.manager, id, 3*time.Second)
			if processAlive(prevPID) {
				t.Fatalf("样本 %d 前上一 PID=%d 未退出，非真冷启", i+1, prevPID)
			}
		}
		start := time.Now()
		if _, err := env.manager.Ensure(ctx, id); err != nil {
			t.Fatalf("样本 %d Ensure 失败: %v", i+1, err)
		}
		elapsed := time.Since(start)
		if elapsed <= 0 {
			t.Fatalf("样本 %d 耗时 %v ≤0，疑似复用热进程而非冷启", i+1, elapsed)
		}
		view, _ := env.manager.Snapshot(id)
		if view.State != supervisor.StateReady || view.PID <= 0 {
			t.Fatalf("样本 %d 未 ready: %+v", i+1, view)
		}
		if view.PID == prevPID {
			t.Fatalf("样本 %d PID 未换（%d），非冷启", i+1, view.PID)
		}
		samples = append(samples, elapsed)
		prevPID = view.PID
	}
	return samples
}

// stats 返回 p95/p50/max；p95 用 nearest-rank ⌈0.95n⌉。
func stats(in []time.Duration) (p95, p50, max time.Duration) {
	sorted := append([]time.Duration(nil), in...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	n := len(sorted)
	return sorted[(95*n+99)/100-1], sorted[n/2], sorted[n-1]
}

// printSamples 打印 20 样本数组 + 统计 + 冷启次数=20（证据文件格式）。
func printSamples(t *testing.T, label string, s []time.Duration, p50, p95, max time.Duration) {
	t.Helper()
	ms := make([]string, len(s))
	for i, d := range s {
		ms[i] = fmt.Sprintf("%.2f", float64(d.Microseconds())/1000)
	}
	t.Logf("%s 样本数组(ms)=[%s]", label, strings.Join(ms, ", "))
	t.Logf("%s p50=%v p95=%v max=%v 冷启次数=%d", label, p50, p95, max, len(s))
}

// gitOutput 只读获取 HEAD 等 git 信息（测试失败时返回 unknown，不阻断采样）。
func gitOutput(t *testing.T, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}
