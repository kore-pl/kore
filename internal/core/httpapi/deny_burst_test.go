package httpapi

import (
	"strconv"
	"sync"
	"testing"
	"time"
)

// denyTestKey 构造测试用窗口键。
func denyTestKey(reason string) DenyBurstKey {
	return DenyBurstKey{Subject: "token:abc12345", Plugin: "credentials",
		Target: "", Capability: "", Reason: reason}
}

// tallyDeny 汇总一次 outcome 的守恒量：审计侧逐条+合并 count，告警侧 N。
func tallyDeny(t *testing.T, out DenyBurstOutcome) (auditN, alertN int) {
	t.Helper()
	for _, a := range out.Audits {
		if a.Detail["count"] != "" {
			n, err := strconv.Atoi(a.Detail["count"])
			if err != nil {
				t.Fatalf("合并 detail.count 非法: %q", a.Detail["count"])
			}
			auditN += n
		} else {
			auditN++
		}
	}
	for _, al := range out.Alerts {
		alertN += al.N
	}
	return
}

// TestDenyBurstCountConservation 一个窗口 N=300（<MAX_MERGE）：
// 前 10 逐条 + 第 11 合并(count=1) + 12..300 累计到窗口滚补一条合并记录；
// 审计侧与告警侧 count 都严格守恒 == N。
func TestDenyBurstCountConservation(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	key := denyTestKey("需要 system:admin 能力")
	var totalAudit, totalAlert int
	for i := 1; i <= 300; i++ {
		out := tr.Submit(key, "detail", now)
		a, al := tallyDeny(t, out)
		totalAudit += a
		totalAlert += al
	}
	// 尚未滚窗：alertPending 仍在内存，审计侧也仍有 pending 未落库。
	if totalAlert < DenyBurstThreshold+1 {
		t.Fatalf("窗口内告警应已落首次+触发点两次，实际累计 %d", totalAlert)
	}
	// 窗口滚过后补齐 pending，两侧都应守恒。
	out := tr.Submit(key, "detail", now.Add(2*DenyBurstWindow))
	a, al := tallyDeny(t, out)
	totalAudit += a
	totalAlert += al
	// 300 次窗口内拒绝 + 窗口滚后本次新拒绝（新窗口首条）= 301。
	if totalAudit != 301 {
		t.Fatalf("审计 count 守恒失败: Σ=%d，期望 301", totalAudit)
	}
	if totalAlert != 301 {
		t.Fatalf("告警 count 守恒失败: Σ=%d，期望 301", totalAlert)
	}
}

// TestDenyBurstWindowBoundary 窗口边界：<1s 同窗合并；=1s 视为新窗，重新逐条。
func TestDenyBurstWindowBoundary(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	key := denyTestKey("reason")
	for i := 0; i < DenyBurstThreshold+1; i++ {
		tr.Submit(key, "detail", now.Add(time.Duration(i)*10*time.Millisecond))
	}
	// 仍在窗口内（999ms）：第 12 次被抑制（只有告警补齐待触发，审计无新记录）。
	out := tr.Submit(key, "detail", now.Add(999*time.Millisecond))
	if len(out.Audits) != 0 {
		t.Fatalf("窗口内第 12 次不应逐条写审计，实际 %d 条", len(out.Audits))
	}
	// 恰好 1s：新窗口，先补旧窗口合并记录（count=288，即第 12..299 次累计），
	// 再对新窗口第 1 次逐条审计。两条记录分别可追溯，count 守恒。
	out = tr.Submit(key, "detail", now.Add(DenyBurstWindow))
	if len(out.Audits) != 2 {
		t.Fatalf("窗口边界应有 1 条补齐 + 1 条新逐条，实际 %+v", out.Audits)
	}
	var flush, fresh DenyAuditRecord
	for _, a := range out.Audits {
		if a.Detail["count"] != "" {
			flush = a
		} else {
			fresh = a
		}
	}
	// 旧窗口：循环 11 次（第 11 次已写 count=1 合并）+ 999ms 第 12 次（pending=1）。
	// 滚窗时补写 pending=1，不应重复计入前 10 条逐条或第 11 条合并记录。
	if flush.Detail["count"] != "1" {
		t.Fatalf("旧窗口补齐 count 应为 1（仅 999ms 那次），实际 %q", flush.Detail["count"])
	}
	if fresh.Detail["reason"] != "reason" {
		t.Fatalf("新窗口逐条记录 reason 不符: %+v", fresh)
	}
}

// TestDenyBurstMaxMergeFallsBackToIndividual 超 MAX_MERGE 转逐条：
// 前 10 逐条 + 第 11 合并 + 12..999 pending + 第 1000 补写合并段 + 逐条，
// 第 1001..1005 全逐条（合并不是无限吸收器，持续攻击审计量随强度上升）。
func TestDenyBurstMaxMergeFallsBackToIndividual(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	key := denyTestKey("sustained attack")
	var totalAudit, totalAlert int
	for i := 1; i <= DenyMergeMax+5; i++ {
		out := tr.Submit(key, "detail", now)
		a, al := tallyDeny(t, out)
		totalAudit += a
		totalAlert += al
		if i > DenyMergeMax {
			// 越限后每次都应逐条落一条审计。
			if len(out.Audits) != 1 || out.Audits[0].Detail["count"] != "" {
				t.Fatalf("第 %d 次应逐条审计，实际 %+v", i, out.Audits)
			}
		}
	}
	if totalAudit != DenyMergeMax+5 || totalAlert != DenyMergeMax+5 {
		t.Fatalf("count 守恒失败: audit=%d alert=%d，期望 %d",
			totalAudit, totalAlert, DenyMergeMax+5)
	}
}

// TestDenyBurstEmptyReason detail 空值不 panic，合并记录仍带 reason 键（空串）。
func TestDenyBurstEmptyReason(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	key := denyTestKey("")
	for i := 0; i < DenyBurstThreshold+1; i++ {
		out := tr.Submit(key, "detail", now)
		if i == DenyBurstThreshold {
			if len(out.Audits) != 1 {
				t.Fatalf("第 11 次应写合并记录，实际 %d", len(out.Audits))
			}
			d := out.Audits[0].Detail
			if _, ok := d["reason"]; !ok {
				t.Fatal("空 reason 也应保留 reason 键")
			}
			if d["count"] != "1" || d["window_ms"] != "1000" || d["first_at"] == "" || d["last_at"] == "" {
				t.Fatalf("合并元数据不全: %+v", d)
			}
		}
	}
}

// TestDenyBurstDifferentKeysIsolated 不同 key（不同能力/原因）独立窗口，互不合并。
func TestDenyBurstDifferentKeysIsolated(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	keyA := denyTestKey("reason-a")
	keyB := denyTestKey("reason-b")
	for i := 0; i < DenyBurstThreshold+1; i++ {
		if len(tr.Submit(keyA, "d", now).Audits) == 0 {
			t.Fatal("keyA 前 11 次应逐条/合并写出")
		}
	}
	// keyB 第一次应重新逐条（不继承 keyA 的窗口状态）。
	out := tr.Submit(keyB, "d", now)
	if len(out.Audits) != 1 || out.Audits[0].Detail["count"] != "" {
		t.Fatalf("不同 key 应独立逐条，实际 %+v", out.Audits)
	}
}

// TestDenyBurstConcurrent 并发提交同 key 无 DATA RACE（配合 -race），count 守恒。
func TestDenyBurstConcurrent(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	key := denyTestKey("concurrent")
	const workers, each = 8, 40
	var mu sync.Mutex
	var totalAudit, totalAlert int
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				out := tr.Submit(key, "d", now)
				for _, a := range out.Audits {
					mu.Lock()
					if a.Detail["count"] != "" {
						n, _ := strconv.Atoi(a.Detail["count"])
						totalAudit += n
					} else {
						totalAudit++
					}
					mu.Unlock()
				}
				for _, al := range out.Alerts {
					mu.Lock()
					totalAlert += al.N
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	// 窗口滚后补齐所有 pending + 本次新拒绝，两侧都应精确守恒 == 提交次数 + 1。
	out := tr.Submit(key, "d", now.Add(2*DenyBurstWindow))
	a, al := tallyDeny(t, out)
	totalAudit += a
	totalAlert += al
	want := workers*each + 1
	if totalAudit != want || totalAlert != want {
		t.Fatalf("并发 count 守恒失败: audit=%d alert=%d，期望 %d",
			totalAudit, totalAlert, want)
	}
}
