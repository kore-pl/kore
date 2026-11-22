package auth

import (
	"sync"
	"time"
)

// 登录限速默认口径（docs/SECURITY §3.5、DATA-MODEL security.login_rate_limit）。
const (
	// DefaultMaxFailures 是计数窗口内允许的失败次数。
	DefaultMaxFailures = 5
	// DefaultWindow 是失败计数窗口。
	DefaultWindow = 60 * time.Second
	// DefaultLockout 是达到阈值后的锁定时长。
	DefaultLockout = 300 * time.Second
	// sweepEvery 是惰性全表清理的调用间隔（按调用次数，不依赖 ticker，G-19）。
	sweepEvery = 128
)

// LoginLimiter 是登录失败限速器：纯内存滑动窗口计数 + 锁定期。
//
// 零 ticker / 零 AfterFunc / 零后台 goroutine（G-19）：过期条目清理搭在
// Allow/Record* 的调用路径上惰性完成，空闲时零 CPU 开销。状态只在进程内存，
// 重启清零（不假装持久化，见 docs/SECURITY §3.5）。
//
// 单管理员体系下调用方用固定 key "admin" 构成全局桶；key 参数保留，
// 后续要做 per-IP 桶按客户端标识分桶即可，无需改本类型。
type LoginLimiter struct {
	mu      sync.Mutex
	max     int
	window  time.Duration
	lockout time.Duration
	now     func() time.Time
	entries map[string]*limitEntry
	calls   uint64
}

// limitEntry 是单 key 状态：窗口内失败时刻（升序）与锁定到期时刻。
type limitEntry struct {
	failures    []time.Time
	lockedUntil time.Time
}

// NewLoginLimiter 构造限速器；非正参数按默认口径归一，调用方可安全传配置零值。
func NewLoginLimiter(maxFailures int, window, lockout time.Duration) *LoginLimiter {
	l := &LoginLimiter{now: time.Now, entries: make(map[string]*limitEntry)}
	l.SetPolicy(maxFailures, window, lockout)
	return l
}

// SetPolicy 热更阈值与时长（SIGHUP 白名单 security.login_rate_limit.*）。
// 已累计的窗口计数与进行中的锁定保持不变，只影响之后的判定与新增锁定。
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

// Allow 判断该 key 当前是否允许尝试；拒绝时返回剩余锁定时间（> 0）。
//
// 锁定到期即删条目，窗口计数随之清零：解锁后从零累计，避免"刚解锁一次
// 就被上一轮失败再次锁死"。
func (l *LoginLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now)
	entry, ok := l.entries[key]
	if !ok {
		return true, 0
	}
	if !entry.lockedUntil.IsZero() {
		if now.Before(entry.lockedUntil) {
			return false, entry.lockedUntil.Sub(now)
		}
		delete(l.entries, key)
		return true, 0
	}
	entry.prune(now.Add(-l.window))
	if len(entry.failures) >= l.max {
		// 边界（阈值被调小等）：窗口内失败已满但未标锁 → 就地锁定。
		entry.lockedUntil = now.Add(l.lockout)
		return false, l.lockout
	}
	return true, 0
}

// RecordFailure 记一次失败；窗口内失败数达阈值即置锁。锁定期内不重复累加
// （调用方应先 Allow 拒绝并提前返回）。
func (l *LoginLimiter) RecordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now)
	entry := l.entries[key]
	if entry == nil {
		entry = &limitEntry{}
		l.entries[key] = entry
	}
	if now.Before(entry.lockedUntil) {
		return
	}
	entry.failures = append(entry.failures, now)
	entry.prune(now.Add(-l.window))
	if len(entry.failures) >= l.max {
		entry.lockedUntil = now.Add(l.lockout)
	}
}

// RecordSuccess 在登录成功后清零该 key 的失败计数与锁定状态。
func (l *LoginLimiter) RecordSuccess(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// sweepLocked 惰性清理过期条目：每 sweepEvery 次调用或表规模达该数量时全表扫，
// 删掉锁定已到期与窗口内无失败的条目。调用方必须持锁。
func (l *LoginLimiter) sweepLocked(now time.Time) {
	l.calls++
	if l.calls%sweepEvery != 0 && len(l.entries) < sweepEvery {
		return
	}
	cutoff := now.Add(-l.window)
	for key, entry := range l.entries {
		if !entry.lockedUntil.IsZero() {
			if !now.Before(entry.lockedUntil) {
				delete(l.entries, key)
			}
			continue
		}
		entry.prune(cutoff)
		if len(entry.failures) == 0 {
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
