package supervisor

import (
	"context"
	"time"
)

// watchIdleOnce 是一次性空闲观察：单次 NewTimer + defer Stop，
// 零 Ticker / AfterFunc（G-19）。每次 invoke 由 rearmIdleLocked 取消旧观察、起新观察。
func (m *Manager) watchIdleOnce(inst *instance, cancel <-chan struct{}, gen uint64,
	exited <-chan struct{}, timeout time.Duration) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-timer.C:
		m.idleExitIfCurrent(inst, gen, exited)
	case <-cancel: // 被下一次 invoke 重置
	case <-exited: // 进程已退出（停止/崩溃/驱逐）
	}
}

// idleExitIfCurrent 仅当本观察仍是最新代次、进程仍 ready 且未换进程时才真正退出，
// 避免旧计时器误杀已被重新拉起的新进程。
func (m *Manager) idleExitIfCurrent(inst *instance, gen uint64, exited <-chan struct{}) {
	inst.mu.Lock()
	if inst.idleGen != gen || inst.state != StateReady || inst.exited != exited {
		inst.mu.Unlock()
		return
	}
	inst.idleCancel = nil
	id := inst.manifest.ID
	inst.mu.Unlock()
	if err := m.Stop(context.Background(), id); err != nil {
		m.logger.Warn("lazy 空闲退出失败", "plugin_id", id, "err", err)
		return
	}
	m.logger.Info("lazy 插件空闲退出", "plugin_id", id)
}

// rearmIdleLocked 在 inst.mu 持有下重置空闲计时：取消旧观察并起新观察。
// 仅 lazy 计时；resident 常驻不退出。
func (m *Manager) rearmIdleLocked(inst *instance) {
	if !inst.isLazy() {
		return
	}
	gen := inst.idleGen + 1
	inst.idleGen = gen
	if inst.idleCancel != nil {
		close(inst.idleCancel)
	}
	cancel := make(chan struct{})
	inst.idleCancel = cancel
	exited := inst.exited // 已在 inst.mu 下，直接读取
	go m.watchIdleOnce(inst, cancel, gen, exited, m.idleTimeoutFor(inst))
}

// idleTimeoutFor 返回该 lazy 的有效空闲时长：清单 idle_timeout_s 优先，否则用 Options。
func (m *Manager) idleTimeoutFor(inst *instance) time.Duration {
	if seconds := inst.manifest.IdleTimeoutS; seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return m.opts.IdleTimeout
}
