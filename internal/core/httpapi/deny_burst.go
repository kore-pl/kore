package httpapi

import (
	"strconv"
	"sync"
	"time"
)

// deny 突发合并参数（方案 DESIGN-AUDIT-DENY-OPT §2.1 / §4 I1-I6）。
//
// 审计出口与告警出口共用同一次 Submit 产生的决策：同一批拒绝在两个出口得到
// 相同的合并判断，Σ(逐条 + 合并 count) 守恒。窗口固定 1s 不可配到无限，防止
// 高频拒绝被聚合成一条看不见的计数（I2）。纯内存 sync.Mutex + map + 惰性
// sweep，零 goroutine / ticker（G-19），不联网（G-10）。
const (
	DenyBurstThreshold  = 10
	DenyBurstWindow     = time.Second
	DenyMergeMax        = 1000
	denyBurstSweepEvery = 256
	// DenyGlobalIndividualBudget 是跨 key 的全局逐条审计写预算（同一全局 1s
	// 窗口内累计）。task-306 红队场景④：round35 合并器按 key 独立窗口，单一
	// read token 轮转 4 个可 deny 端点时每 key 各写「前 10 条逐条审计」，4×10=40
	// 次写事务叠加 bbolt 单写者排队，把 c16/N=300 p95 从单 key 19–41ms 抬回
	// 79.7–105ms，击穿 p95 ≤50ms 红线。本预算把逐条审计写受全局约束：全局窗口
	// 内逐条写达到预算后，其余早期拒绝走 pending 合并路径，窗口滚/触发点时补
	// 一条带 count 的合并记录。审计 Σ(逐条+合并 count)==N、告警 Σ(AlertN)==N
	// 守恒不受影响；零新增 goroutine/ticker（G-19）。
	DenyGlobalIndividualBudget = DenyBurstThreshold
)

// DenyBurstKey 只用既有审计标量字段拼键（token 出口 subject = "token:<id>"），
// 不引入业务域名词表（G-01）；按方案 §2.1 不含 IP（auditDenied 出口无 IP 参数）。
type DenyBurstKey struct {
	Subject    string
	Plugin     string
	Target     string
	Capability string
	Reason     string
}

// DenyBurstKind 是一条决策的动作类型。
type DenyBurstKind int

const (
	// DenyBurstIndividual 审计逐条写；本批不写告警（累计到触发点）。
	DenyBurstIndividual DenyBurstKind = iota
	// DenyBurstMerged 审计写一条 count=Count 的合并记录；告警写 AlertN 次聚合。
	DenyBurstMerged
	// DenyBurstAlertOnly 审计无记录（窗口只有逐条记录）；仅告警写 AlertN 次聚合。
	DenyBurstAlertOnly
)

// DenyBurstDecision 是一次提交产生的落库决策。窗口滚动 / 惰性 sweep 时一次
// 可能返回多条（先补旧窗口，再处理当前拒绝）。
type DenyBurstDecision struct {
	Kind        DenyBurstKind
	Count       int // 合并审计记录代表的拒绝次数（仅 Merged 有效）
	AlertN      int // 本次告警写入应累加的次数；0 = 本次不写告警
	Key         DenyBurstKey
	WindowStart time.Time
	LastAt      time.Time
}

// DenyAuditRecord 是一条待落库的审计记录（由装配层转成 store.AuditRecord）。
// detail 已含 reason 与合并元数据（Merged 时），纯加法不新增顶层字段。
type DenyAuditRecord struct {
	Subject    string
	Plugin     string
	Target     string
	Capability string
	Detail     map[string]string
}

// DenyAlertWrite 是一次聚合告警落库：N 为本批累计拒绝次数。
type DenyAlertWrite struct {
	N      int
	Detail string
}

// DenyBurstOutcome 是一次 deny 在两个出口的完整落库计划。
type DenyBurstOutcome struct {
	Audits []DenyAuditRecord
	Alerts []DenyAlertWrite
}

type denyBurstState struct {
	windowStart  time.Time
	lastAt       time.Time
	count        int
	pending      int // 尚未落库的合并审计拒绝数（N=12..）
	alertPending int // 尚未落库的告警拒绝数（含逐条段）
	key          DenyBurstKey
	detail       string // 代表事件的告警明细
}

// DenyBurstTracker 是 deny 突发窗口的纯内存决策器，零值可用。
type DenyBurstTracker struct {
	mu     sync.Mutex
	states map[DenyBurstKey]*denyBurstState
	calls  uint64
	// globalWindowStart / globalIndividuals 是跨 key 的全局逐条写预算状态。
	// 同一全局 1s 窗口内逐条审计写不超过 DenyGlobalIndividualBudget；单 key
	// 场景（≤Threshold 条）不受影响，MAX_MERGE 转逐条分支也不受约束。
	globalWindowStart time.Time
	globalIndividuals int
}

// Submit 推进一次拒绝并直接生成两个出口的落库计划。写入节律（N 为同键
// 同窗口序号）：
//
//   - N = 1..10：审计逐条写，告警累计不写；
//   - N = 11：审计写合并记录 count=1（只代表第 11 次），告警一次写 N=11；
//   - 12 ≤ N < 1000：两边都在内存累计，不写盘；
//   - N = 1000：补写审计合并段 + 告警聚合段，此后本窗口余下拒绝逐条写；
//   - 窗口滚动 / 每 256 次惰性 sweep：补齐两边 pending（不丢计数）。
//
// 任意时刻审计侧 Σ(逐条 + 合并 Count) 与告警侧 Σ(AlertN) 都等于已提交拒绝数。
func (t *DenyBurstTracker) Submit(key DenyBurstKey, alertDetail string, now time.Time) DenyBurstOutcome {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.states == nil {
		t.states = make(map[DenyBurstKey]*denyBurstState)
	}
	var decisions []DenyBurstDecision
	if t.calls++; t.calls%denyBurstSweepEvery == 0 {
		decisions = append(decisions, t.sweepLocked(now)...)
	}

	st := t.states[key]
	if st == nil || now.Before(st.windowStart) || now.Sub(st.windowStart) >= DenyBurstWindow {
		if st != nil {
			decisions = append(decisions, flushDenyBurst(st)...)
		}
		st = &denyBurstState{windowStart: now, key: key, detail: alertDetail}
		t.states[key] = st
	}
	// 全局跨 key 预算：同一全局 1s 窗口内累计逐条审计写次数；预算耗尽后早期
	// 拒绝走 pending 合并路径（窗口滚/触发点补一条带 count 的合并记录）。
	if t.globalWindowStart.IsZero() || now.Before(t.globalWindowStart) ||
		now.Sub(t.globalWindowStart) >= DenyBurstWindow {
		t.globalWindowStart, t.globalIndividuals = now, 0
	}

	st.lastAt = now
	st.detail = alertDetail // 明细取最新一次（与 store.mergeAlert 同口径）
	st.count++

	switch {
	case st.count <= DenyBurstThreshold && t.globalIndividuals < DenyGlobalIndividualBudget:
		// 首次拒绝立即落一条告警（保持既有「拒绝即告警」语义与可观测性）；
		// 第 2..T 次在内存累计，到触发点一次写入，消掉突发段的读改写事务。
		t.globalIndividuals++
		alertN := 0
		if st.count == 1 {
			alertN = 1
		} else {
			st.alertPending++
		}
		decisions = append(decisions, DenyBurstDecision{Kind: DenyBurstIndividual, Count: 1, AlertN: alertN,
			Key: key, WindowStart: st.windowStart, LastAt: st.lastAt})
	case st.count <= DenyBurstThreshold:
		// 全局预算耗尽（多 key 突发）：早期拒绝转 pending 合并，不逐条写审计；
		// 首拒仍立即写一条告警（保持「拒绝即告警」语义），其余累计到触发点。
		st.pending++
		if st.count == 1 {
			decisions = append(decisions, DenyBurstDecision{Kind: DenyBurstAlertOnly, AlertN: 1,
				Key: key, WindowStart: st.windowStart, LastAt: st.lastAt})
		} else {
			st.alertPending++
		}
	case st.count == DenyBurstThreshold+1:
		alertN := st.alertPending + 1
		st.alertPending = 0
		// 触发点合并记录须覆盖之前因全局预算转 pending 的早期拒绝（守恒）：
		// 单 key 场景 pending=0 → Count=1（与 round35 完全一致）；
		// 预算耗尽的 key 前 10 次在 pending → Count=11。
		mergedCount := st.pending + 1
		st.pending = 0
		decisions = append(decisions, DenyBurstDecision{Kind: DenyBurstMerged, Count: mergedCount, AlertN: alertN,
			Key: key, WindowStart: st.windowStart, LastAt: st.lastAt})
	case st.count < DenyMergeMax:
		st.pending++
		st.alertPending++
	default:
		// 越过聚合上限：补齐合并段后转逐条，持续攻击强度重新可见（I2）。
		decisions = append(decisions, flushDenyBurst(st)...)
		decisions = append(decisions, DenyBurstDecision{Kind: DenyBurstIndividual, Count: 1, AlertN: 1,
			Key: key, WindowStart: st.windowStart, LastAt: st.lastAt})
	}
	return t.materialize(decisions)
}

// materialize 将决策翻译成审计记录与告警写入（httpapi 不 import store，G-01）。
func (t *DenyBurstTracker) materialize(decisions []DenyBurstDecision) DenyBurstOutcome {
	var out DenyBurstOutcome
	for _, d := range decisions {
		if d.Kind != DenyBurstAlertOnly {
			detail := map[string]string{"reason": d.Key.Reason}
			if d.Kind == DenyBurstMerged {
				detail["count"] = strconv.Itoa(d.Count)
				detail["window_ms"] = strconv.FormatInt(DenyBurstWindow.Milliseconds(), 10)
				detail["first_at"] = d.WindowStart.UTC().Format(time.RFC3339Nano)
				detail["last_at"] = d.LastAt.UTC().Format(time.RFC3339Nano)
			}
			out.Audits = append(out.Audits, DenyAuditRecord{
				Subject: d.Key.Subject, Plugin: d.Key.Plugin, Target: d.Key.Target,
				Capability: d.Key.Capability, Detail: detail,
			})
		}
		if d.AlertN > 0 {
			out.Alerts = append(out.Alerts, DenyAlertWrite{N: d.AlertN})
		}
	}
	return out
}

// sweepLocked 清理过期窗口并补齐 decision（调用方必须持锁；零后台计时器）。
func (t *DenyBurstTracker) sweepLocked(now time.Time) []DenyBurstDecision {
	var out []DenyBurstDecision
	for key, st := range t.states {
		if now.Before(st.windowStart) || now.Sub(st.windowStart) < DenyBurstWindow {
			continue
		}
		out = append(out, flushDenyBurst(st)...)
		delete(t.states, key)
	}
	return out
}

// flushDenyBurst 补齐一个窗口的 pending。审计段（pending）与告警段
// （alertPending）分开：窗口内只有逐条记录时也仍要补一次告警计数字。
func flushDenyBurst(st *denyBurstState) []DenyBurstDecision {
	var out []DenyBurstDecision
	switch {
	case st.pending > 0:
		out = append(out, DenyBurstDecision{Kind: DenyBurstMerged, Count: st.pending,
			AlertN: st.alertPending, Key: st.key, WindowStart: st.windowStart, LastAt: st.lastAt})
	case st.alertPending > 0:
		out = append(out, DenyBurstDecision{Kind: DenyBurstAlertOnly, AlertN: st.alertPending,
			Key: st.key, WindowStart: st.windowStart, LastAt: st.lastAt})
	}
	st.pending, st.alertPending = 0, 0
	return out
}
