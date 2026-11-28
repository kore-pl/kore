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

// TestDenyBurstDifferentKeysIsolated 不同 key（不同能力/原因）独立窗口，互不合并；
// 但逐条审计写受**全局**预算约束（task-307 修 redteam key 轮换 p95 回弹）：
// 全局窗口内预算耗尽后，后续 key 的早期拒绝走 pending 合并而非各自 10 条逐条。
// 守恒仍严格成立，窗口状态仍按 key 独立（keyB 不继承 keyA 的 count）。
func TestDenyBurstDifferentKeysIsolated(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	keyA := denyTestKey("reason-a")
	keyB := denyTestKey("reason-b")
	var totalAudit, totalAlert int
	for i := 0; i < DenyBurstThreshold+1; i++ {
		out := tr.Submit(keyA, "d", now)
		a, al := tallyDeny(t, out)
		totalAudit += a
		totalAlert += al
		if len(out.Audits) == 0 {
			t.Fatal("keyA 前 11 次应逐条/合并写出")
		}
	}
	// keyB 第一次：全局预算已耗尽（keyA 用掉 Threshold 条逐条），故不逐条写
	// 审计，但仍立即写一条告警（拒绝即告警语义不破坏）。
	out := tr.Submit(keyB, "d", now)
	if len(out.Audits) != 0 {
		t.Fatalf("全局预算耗尽后不同 key 首拒不应逐条审计，实际 %+v", out.Audits)
	}
	if len(out.Alerts) != 1 || out.Alerts[0].N != 1 {
		t.Fatalf("不同 key 首拒仍应立即写一条告警，实际 %+v", out.Alerts)
	}
	a, al := tallyDeny(t, out)
	totalAudit += a
	totalAlert += al
	// keyB 独立窗口：其 count 从 1 开始，到第 Threshold+1 次触发合并记录
	// count=Threshold+1（前 10 次 pending + 第 11 次），不与 keyA 串台。
	for i := 1; i < DenyBurstThreshold; i++ {
		tr.Submit(keyB, "d", now)
	}
	out = tr.Submit(keyB, "d", now)
	a, al = tallyDeny(t, out)
	totalAudit += a
	totalAlert += al
	if len(out.Audits) != 1 || out.Audits[0].Detail["count"] != strconv.Itoa(DenyBurstThreshold+1) {
		t.Fatalf("keyB 触发点应合并 count=%d，实际 %+v", DenyBurstThreshold+1, out.Audits)
	}
	// 两 key 各 11 次拒绝 = 22，审计与告警两侧都守恒。
	if totalAudit != 2*(DenyBurstThreshold+1) || totalAlert != 2*(DenyBurstThreshold+1) {
		t.Fatalf("跨 key 守恒失败: audit=%d alert=%d，期望 %d",
			totalAudit, totalAlert, 2*(DenyBurstThreshold+1))
	}
}

// TestDenyBurstGlobalBudgetConservation 跨 key 全局逐条审计写预算守恒
// （task-307 / redteam 场景④）：单一 read token 轮转 4 个可 deny 端点（4 个
// 固定 key），每 key N=176 次拒绝（合计 704，与红队双出口守恒口径一致）后滚窗。
// 断言：① 逐条审计写总数 ≤ DenyGlobalIndividualBudget（写事务受全局约束）；
// ② 审计 Σ(逐条+合并 detail.count) == 告警 Σ(AlertN) == 704（零丢、零重复）；
// ③ 每个 key 的窗口状态独立（4 个合并记录各带自己的 count）。
func TestDenyBurstGlobalBudgetConservation(t *testing.T) {
	var tr DenyBurstTracker
	now := time.Unix(1_700_000_000, 0)
	keys := []DenyBurstKey{
		{Subject: "token:abc12345", Plugin: "credentials", Reason: "需要 system:admin 能力"},
		{Subject: "token:abc12345", Plugin: "scheduler", Target: "list", Reason: "缺少 system:admin 特权能力"},
		{Subject: "token:abc12345", Plugin: "scheduler", Target: "runs", Reason: "缺少 system:admin 特权能力"},
		{Subject: "token:abc12345", Plugin: "migrate", Target: "export", Reason: "缺少 system:admin 特权能力"},
	}
	const perKey = 176
	total := perKey * len(keys) // 704
	var totalAudit, totalAlert, individuals int
	for _, key := range keys {
		for i := 0; i < perKey; i++ {
			out := tr.Submit(key, "d", now)
			a, al := tallyDeny(t, out)
			totalAudit += a
			totalAlert += al
			for _, rec := range out.Audits {
				if rec.Detail["count"] == "" {
					individuals++
				}
			}
		}
	}
	// 第一个全局 1s 窗口内 704 次跨 key 拒绝，逐条审计写必须 ≤ 全局预算
	// （round35 旧行为 4×10=40 条逐条写 → bbolt 单写者排队 → p95 回弹）。
	if individuals > DenyGlobalIndividualBudget {
		t.Fatalf("跨 key 逐条审计写 %d 超过全局预算 %d（p95 回弹根因未消除）",
			individuals, DenyGlobalIndividualBudget)
	}
	// 逐 key 滚窗补齐各自 pending（固定时钟下惰性 sweep 不触发，须显式推进每个
	// key 的窗口，与真机请求驱动 flush 同口径）。这 4 次 Submit 属于新全局窗口。
	for _, key := range keys {
		out := tr.Submit(key, "detail", now.Add(2*DenyBurstWindow))
		a, al := tallyDeny(t, out)
		totalAudit += a
		totalAlert += al
	}
	// 4 次滚窗新拒绝也计入，故期望 total+4。
	if totalAudit != total+len(keys) || totalAlert != total+len(keys) {
		t.Fatalf("跨 key 双出口守恒失败: audit=%d alert=%d，期望 %d",
			totalAudit, totalAlert, total+len(keys))
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
