package supervisor

import (
	"context"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// ensureLazy 为 lazy 插件做槽位准入 + 按需冷启；全程由 slotMu 串行，
// 保证并发唤醒不会突破「resident + 活跃 lazy ≤ MaxSlots」的硬上限。
func (m *Manager) ensureLazy(ctx context.Context, inst *instance) error {
	m.slotMu.Lock()
	defer m.slotMu.Unlock()
	if inst.currentState() == StateReady {
		return nil // 已在运行：直接复用，空闲计时由 Ensure 侧刷新
	}
	inst.usedAt(m.nextSeq()) // 冷启即视为一次使用，避免刚拉起就被 LRU 选中
	if err := m.admitSlot(inst); err != nil {
		return err
	}
	return m.gate(inst.manifest.ID).do(ctx, func(ctx context.Context) error {
		return m.startIfNeeded(ctx, inst)
	})
}

// admitSlot 确保有空槽：统计其它在跑的实例（resident + 活跃 lazy），
// 达到上限时驱逐最久未用的 lazy；resident 永不驱逐，全是 resident 则拒绝唤醒。
func (m *Manager) admitSlot(inst *instance) error {
	peers := m.runningPeers(inst)
	if len(peers) < m.opts.MaxSlots {
		return nil
	}
	victim := leastRecentlyUsedLazy(peers)
	if victim == nil {
		return errf(pluginapi.E_RATELIMIT,
			"常驻槽位已满（上限 %d，均为 resident），无法唤醒 lazy 插件 %s",
			m.opts.MaxSlots, inst.manifest.ID)
	}
	m.logger.Info("驱逐最久未用的 lazy 插件",
		"victim", victim.manifest.ID, "wakeup", inst.manifest.ID)
	return m.Stop(context.Background(), victim.manifest.ID)
}

// runningPeers 返回除 self 外所有在跑的实例（ready/starting/draining 都占槽）。
// 先取指针再读状态，避免 m.mu 与 inst.mu 嵌套加锁。
func (m *Manager) runningPeers(self *instance) []*instance {
	m.mu.Lock()
	all := make([]*instance, 0, len(m.plugins))
	for _, inst := range m.plugins {
		if inst != self {
			all = append(all, inst)
		}
	}
	m.mu.Unlock()
	peers := make([]*instance, 0, len(all))
	for _, inst := range all {
		switch inst.currentState() {
		case StateReady, StateStarting, StateDraining:
			peers = append(peers, inst)
		}
	}
	return peers
}

// leastRecentlyUsedLazy 返回 lastUsed 最小的 lazy；resident 跳过（不可驱逐）。
func leastRecentlyUsedLazy(peers []*instance) *instance {
	var victim *instance
	var oldest uint64
	for _, inst := range peers {
		if !inst.isLazy() {
			continue
		}
		used := inst.lastUsed.Load()
		if victim == nil || used < oldest {
			victim, oldest = inst, used
		}
	}
	return victim
}
