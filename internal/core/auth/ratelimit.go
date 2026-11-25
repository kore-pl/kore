package auth

import (
	"context"
	"sync"
	"time"
)

// 登录失败限速默认口径（docs/SECURITY §3.5、DATA-MODEL security.login_rate_limit）。
const (
	// DefaultMaxFailures 是免延迟的失败次数（ADR-0057 T4：宽容 5→1）。
	// 第 1 次口令错误 0s（触发验证码），第 2 次起 1s→2s→4s→8s→16s→30s。
	DefaultMaxFailures = 1
	// DefaultWindow 是失败计数窗口：窗口内失败达到 MaxFailures 即进入惩罚模式。
	DefaultWindow = 60 * time.Second
	// DefaultLockout 是惩罚等级的记忆窗口：连续失败后安静这么久，惩罚等级归零。
	DefaultLockout = 300 * time.Second
	// PenaltyBase 是错误口令递增延迟的起点（第 MaxFailures+1 次失败）。
	PenaltyBase = time.Second
	// PenaltyCap 是递增延迟的上限：再多的失败也只延迟这么久。
	PenaltyCap = 30 * time.Second
	// sweepEvery 是惰性全表清理的调用间隔（按调用次数，不依赖 ticker，G-19）。
	sweepEvery = 128
)

// LoginLimiter 是登录失败限速器。
//
// 设计口径（P1 DoS 修复，docs/SECURITY §3.5）：**先校验口令，再对错误口令施加
// 递增延迟**。锁定期不存在，因此不存在"任意本地进程用错口令把管理员永久锁死"；
// 正确口令在任何时候都短路放行（不等待、不计惩罚），错误口令在连续失败达到
// MaxFailures 后按 1s→2s→4s→…→30s 递增延迟，把串行爆破速率压到 1/30s。
//
// 单管理员体系下调用方用固定 key "admin"；key 参数保留，未来按 per-IP 分桶
// 无需改本类型（但 UDS / 本机回环下所有来源同 IP，per-IP 桶等价全局桶）。
//
// 零 ticker / 零 AfterFunc / 零后台 goroutine（G-19）：过期条目在调用路径上
// 惰性清理，空闲零 CPU 开销；状态只在进程内存，重启清零。
type LoginLimiter struct {
	mu      sync.Mutex
	max     int
	window  time.Duration
	lockout time.Duration
	// now / sleep 是时间源与等待实现，测试可替换（生产零开销）。
	now   func() time.Time
	sleep func(ctx context.Context, d time.Duration) bool
	// verify 是单飞信号量：PBKDF2 校验串行化，并行爆破的猜测吞吐被压到
	// 「1 / 单次哈希耗时」，不会随连接数线性放大（防爆破不被 DoS 修复放宽）。
	verify  chan struct{}
	entries map[string]*limitEntry
	calls   uint64
}

// limitEntry 是单 key 状态：窗口内失败时刻（升序）、连续失败数、惩罚开关。
type limitEntry struct {
	failures    []time.Time
	strikes     int
	lastFailure time.Time
	penalty     bool
}

// NewLoginLimiter 构造限速器；非正参数按默认口径归一，调用方可安全传配置零值。
func NewLoginLimiter(maxFailures int, window, lockout time.Duration) *LoginLimiter {
	l := &LoginLimiter{
		now:     time.Now,
		sleep:   sleepContext,
		verify:  make(chan struct{}, 1),
		entries: make(map[string]*limitEntry),
	}
	l.SetPolicy(maxFailures, window, lockout)
	return l
}

// SetPolicy 热更阈值与时长（SIGHUP 白名单 security.login_rate_limit.*）。
// 已累计的连续失败与进行中的惩罚等级保持不变，只影响之后的判定与新增惩罚。
func (l *LoginLimiter) SetPolicy(maxFailures int, window, lockout time.Duration) {
	if maxFailures <= 0 {
		maxFailures = DefaultMaxFailures
	}
	if window <= 0 {
		window = DefaultWindow
	}
	if lockout <= 0 {
		lockout = DefaultLockout
	}
	l.mu.Lock()
	l.max, l.window, l.lockout = maxFailures, window, lockout
	l.mu.Unlock()
}

// BeginVerify 申请一次口令校验名额（单飞，最多 1 个并发 PBKDF2），返回释放函数。
// ctx 取消（客户端断开）时返回 ok=false，调用方不应再校验口令。
//
// 单飞的目的不是限速正确口令，而是让并行爆破的**猜测吞吐**受限于单次哈希耗时，
// 否则修掉硬锁后攻击者可以用 N 条并发连接把猜测速率放大 N 倍。
func (l *LoginLimiter) BeginVerify(ctx context.Context) (release func(), ok bool) {
	select {
	case l.verify <- struct{}{}:
		return func() { <-l.verify }, true
	case <-ctx.Done():
		return nil, false
	}
}

// RecordFailure 记一次错误口令，返回本次应答前应等待的延迟（正确口令不会走到这里）。
//
// 延迟阶梯（ADR-0057 T4）：连续失败数 n ≤ max 时为 0（容忍一次手误，同时
// 触发图形验证码）；n = max+k（k≥1）时为 min(PenaltyCap, PenaltyBase·2^(k-1))，
// 即 1s→2s→4s→8s→16s→30s 封顶。延迟由调用方在应答前施加，正确口令
// 不经过本方法，所以永远不等待。
func (l *LoginLimiter) RecordFailure(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now)
	entry := l.entries[key]
	// 静默超过 lockout：惩罚等级与计数一起归零（不依赖全表 sweep 的调用次数）。
	if entry != nil && now.Sub(entry.lastFailure) > l.lockout {
		delete(l.entries, key)
		entry = nil
	}
	if entry == nil {
		entry = &limitEntry{}
		l.entries[key] = entry
	}
	entry.failures = append(entry.failures, now)
	entry.prune(now.Add(-l.window))
	entry.strikes++
	entry.lastFailure = now
	// 窗口内失败达到阈值即进入惩罚模式；进入后只能靠成功或静默 lockout 退出，
	// 不允许"等一个窗口再白拿 attempts 次猜测"（那会放宽爆破防护）。
	if len(entry.failures) >= l.max {
		entry.penalty = true
	}
	if !entry.penalty {
		return 0
	}
	return penaltyFor(entry.strikes - l.max)
}

// NextPenalty 返回该 key 下一次错误口令将施加的延迟，供 Retry-After 使用。
func (l *LoginLimiter) NextPenalty(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entries[key]
	if entry == nil || !entry.penalty {
		return 0
	}
	return penaltyFor(entry.strikes + 1 - l.max)
}

// Wait 施加一次惩罚延迟；返回 false 表示客户端已断开，调用方无需再写应答。
// 延迟是"错误口令的代价"，正确口令不经过本方法（见 RecordSuccess 短路）。
func (l *LoginLimiter) Wait(ctx context.Context, d time.Duration) bool {
	return l.sleep(ctx, d)
}

// RecordSuccess 在登录成功后清零该 key 的失败计数、惩罚等级与锁定状态。
func (l *LoginLimiter) RecordSuccess(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// PenaltyFor 返回连续失败 strikes 次的错误口令本次应延迟的时长（纯函数，供测试
// 与文档的数字表核对；strikes ≤ DefaultMaxFailures（现为 1）时为 0）。
func PenaltyFor(maxFailures, strikes int) time.Duration {
	if maxFailures <= 0 {
		maxFailures = DefaultMaxFailures
	}
	if strikes <= maxFailures {
		return 0
	}
	return penaltyFor(strikes - maxFailures)
}

// penaltyFor 按"超出阈值的阶数"返回延迟：1 阶 1s、2 阶 2s、…、封顶 30s。
func penaltyFor(step int) time.Duration {
	if step <= 0 {
		return 0
	}
	d := PenaltyBase
	for i := 1; i < step; i++ {
		if d >= PenaltyCap {
			break
		}
		d *= 2
	}
	if d > PenaltyCap {
		d = PenaltyCap
	}
	return d
}

// sweepLocked 惰性清理过期条目：每 sweepEvery 次调用或表规模达该数量时全表扫，
// 删掉静默超过 lockout 的条目（惩罚等级随条目一起归零）。调用方必须持锁。
func (l *LoginLimiter) sweepLocked(now time.Time) {
	l.calls++
	if l.calls%sweepEvery != 0 && len(l.entries) < sweepEvery {
		return
	}
	for key, entry := range l.entries {
		if now.Sub(entry.lastFailure) > l.lockout {
			delete(l.entries, key)
		}
	}
}

// prune 丢弃早于 cutoff 的失败记录（failures 递增有序，从头截断即可）。
func (e *limitEntry) prune(cutoff time.Time) {
	drop := 0
	for drop < len(e.failures) && !e.failures[drop].After(cutoff) {
		drop++
	}
	if drop > 0 {
		e.failures = e.failures[drop:]
	}
}

// sleepContext 在 ctx 未取消时等待 d；返回 false 表示客户端已断开、调用方无需应答。
func sleepContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
