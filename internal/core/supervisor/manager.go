// Package supervisor 管理插件进程生命周期：拉起、hello 握手、状态机与优雅停止。
//
// 薄壳边界：本包只做进程与 socket 的调度，不处理 HTTP、不解析业务参数、不写插件数据。
// 隔离模型（G-04）：socket 由主壳以 server 身份 bind（插件无权自建），插件进程以
// client 身份 connect；2s 硬超时内未完成 kore.hello 即 SIGKILL 并置 failed。
//
// 三种 lifecycle 全部支持：resident 常驻、lazy 冷启+空闲退出、oneshot 单次调用
// 用完即停（见 oneshot.go）。退避重启、心跳探测、热升级、run.json 孤儿进程核对
// 按任务拆分归 M1-12/13，本包不含任何 ticker/轮询（G-19）：状态变化全部由事件驱动。
package supervisor

import (
	"context"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// State 是插件运行状态（M1 覆盖 resident 的四态 + 失败态）；定义与取值见 instance.go。
// 默认值与协议常量；HelloTimeout 是「exec→hello 完成」的硬超时，不是冷启动 p95 SLO。
const (
	defaultHelloTimeout  = 2 * time.Second
	defaultShutdownGrace = 5 * time.Second
	defaultKillWait      = 2 * time.Second
	defaultQueueLimit    = 32
	// defaultMaxSlots 是同时常驻槽位上限：resident + 活跃 lazy ≤3（提案 §4 / G-03）。
	defaultMaxSlots = 3
	// defaultResidentMaxSlots 是 resident 插件独占配额上限：lazy 至少保留
	// MaxSlots-2=1 个槽位（RESOURCE-MODEL §2.6 候选 A，事故 CS-20261123-01）。
	defaultResidentMaxSlots = 2
	// defaultIdleTimeout 是 lazy 冷启后的空闲退出时长（G-19，任务指定 60s）。
	defaultIdleTimeout = 60 * time.Second
)

// Manager 是插件进程监督器；并发安全，状态变更加锁，冷启动由每插件闸门串行。
type Manager struct {
	opts    Options
	logger  *slog.Logger
	mu      sync.Mutex
	plugins map[string]*instance
	gates   map[string]*gate
	// slotMu 串行全部槽位准入 + 冷启（resident enable/invoke 与 lazy 唤醒），
	// 保证并发启用/唤醒既不突破 maxSlots，也不突破 resident 独占配额。
	slotMu sync.Mutex
	// useSeq 是全局单调使用序号，供 lazy LRU 比较；零值即可用。
	useSeq atomic.Uint64
}

// New 构造 Manager；Transport / Manifests / RunDir 缺一即返回 E_INTERNAL。
func New(opts Options) (*Manager, error) {
	if opts.Transport == nil || opts.Manifests == nil || opts.RunDir == "" {
		return nil, errf(pluginapi.E_INTERNAL, "supervisor 缺少 Transport/Manifests/RunDir")
	}
	opts.withDefaults()
	if opts.ResidentMax >= opts.MaxSlots {
		opts.Logger.Warn("槽位保护已关闭：resident_max 等于 max_slots，lazy 可能被 resident 饿死",
			"resident_max", opts.ResidentMax, "max_slots", opts.MaxSlots)
	}
	return &Manager{
		opts:    opts,
		logger:  opts.Logger,
		plugins: make(map[string]*instance),
		gates:   make(map[string]*gate),
	}, nil
}

// Start 确保插件就绪。resident 走冷启动；lazy / oneshot 在 enable 阶段是 no-op
// （只标记 desired=enabled，进程由首次 Ensure/invoke 按需拉起）。
//
// M3-C：enable 动作在发生时直接落审计（plugin.enable），不等下次请求对账；
// 从 failed 状态恢复的启动由 start() 记 plugin.retry，这里不重复记 enable。
func (m *Manager) Start(ctx context.Context, id string) error {
	inst, err := m.instance(id)
	if err != nil {
		m.record(ctx, AuditEvent{
			Subject: AuditSubjectAdmin, Action: AuditEnable, Plugin: id,
			Result: AuditResultError, Detail: detail("err", err.Error()),
		})
		return err
	}
	if inst.isLazy() || inst.isOneshot() {
		m.record(ctx, AuditEvent{
			Subject: AuditSubjectAdmin, Action: AuditEnable, Plugin: id,
			Result: AuditResultOK, Detail: detail("lifecycle", string(inst.manifest.Lifecycle)),
		})
		return nil // lazy/oneshot：enable 不拉起进程，首次 invoke 才冷启
	}
	recovering := inst.currentState() == StateFailed
	err = m.startResident(ctx, inst)
	if !recovering {
		event := AuditEvent{
			Subject: AuditSubjectAdmin, Action: AuditEnable, Plugin: id,
			Result: AuditResultOK, Detail: detail("state", string(inst.currentState())),
		}
		if err != nil {
			event.Result = AuditResultError
			event.Detail = detail("err", err.Error())
		}
		m.record(ctx, event)
		return err
	}
	// 从 failed 重试的正常起停由 start() 记 plugin.retry；只有配额拒绝没进入
	// start()，这里补一条 enable 失败审计，保证「拒绝启用」留痕。
	if err != nil {
		m.record(ctx, AuditEvent{
			Subject: AuditSubjectAdmin, Action: AuditEnable, Plugin: id,
			Result: AuditResultError, Detail: detail("err", err.Error()),
		})
	}
	return err
}

// Ensure 确保插件就绪并返回主壳持有的 UDS 连接（bus 的转发入口 = invoke 冷启点）。
// resident 直接取连接；lazy 先过槽位准入（必要时驱逐 LRU），再冷启并重置空闲计时；
// oneshot 每次 invoke 都走全新冷启，调用完成后 wrapped conn 自行 Stop（空闲 0 进程）。
func (m *Manager) Ensure(ctx context.Context, id string) (net.Conn, error) {
	inst, err := m.instance(id)
	if err != nil {
		return nil, err
	}
	if inst.isOneshot() {
		return m.ensureOneshot(ctx, inst)
	}
	if inst.isLazy() {
		if err := m.ensureLazy(ctx, inst); err != nil {
			return nil, err
		}
	} else if err := m.startResident(ctx, inst); err != nil {
		// resident 的 invoke 冷启与 enable 走同一准入闸门：绕过 enable 直接调用
		// 也不能突破 resident 配额或总槽位上限。
		return nil, err
	}
	inst.mu.Lock()
	defer inst.mu.Unlock()
	if inst.conn == nil {
		return nil, errf(pluginapi.E_UPSTREAM, "插件 %s 未就绪（state=%s）", id, inst.state)
	}
	// 每次 invoke 刷新 LRU 序号与空闲计时（resident 不计时）。
	if inst.isLazy() {
		inst.usedAt(m.nextSeq())
		m.rearmIdleLocked(inst)
	}
	return inst.conn, nil
}

// startResident 是 resident 的唯一拉起闸门：enable 与 invoke 冷启都走这里。
//
// 准入（resident 配额 + 总槽位）只在 slotMu 内做一次占位，随后释放锁进入每插件
// 冷启动闸门——同插件的并发请求仍按队列上限排队，不会因串行化把 429 变成全成功。
// 已在 ready 的实例直接放行；占位在该次启动结束（成功或失败）后释放。
func (m *Manager) startResident(ctx context.Context, inst *instance) error {
	m.slotMu.Lock()
	if inst.currentState() == StateReady {
		m.slotMu.Unlock()
		return nil
	}
	if !inst.slotReserved {
		if err := m.admitResident(inst); err != nil {
			m.slotMu.Unlock()
			return err
		}
		inst.slotReserved = true
	}
	m.slotMu.Unlock()

	err := m.gate(inst.manifest.ID).do(ctx, func(ctx context.Context) error {
		return m.startIfNeeded(ctx, inst)
	})

	m.slotMu.Lock()
	inst.slotReserved = false
	m.slotMu.Unlock()
	return err
}

// SlotLimits 返回槽位上限配置：maxSlots（resident + 活跃 lazy 总数）与
// residentMax（resident 独占上限），供 /api/v1/system/info 展示。
func (m *Manager) SlotLimits() (maxSlots, residentMax int) {
	return m.opts.MaxSlots, m.opts.ResidentMax
}

// nextSeq 返回下一个全局使用序号。
func (m *Manager) nextSeq() uint64 {
	return m.useSeq.Add(1)
}

// instance 取（或创建）插件运行态；未安装、未 enable、非法 lifecycle 都在此拦截。
func (m *Manager) instance(id string) (*instance, error) {
	if !m.opts.Manifests.Enabled(id) {
		return nil, errf(pluginapi.E_NOTFOUND,
			"插件 %s 未安装或未 enable", id)
	}
	manifest, ok := m.opts.Manifests.Manifest(id)
	if !ok {
		return nil, errf(pluginapi.E_NOTFOUND, "插件 %s 未登记", id)
	}
	if err := manifest.RuntimeSupported(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if inst, ok := m.plugins[id]; ok {
		return inst, nil
	}
	inst := newInstance(manifest, m.socketPath(id))
	m.plugins[id] = inst
	return inst, nil
}

// PluginToken 返回插件当前进程的 KORE_PLUGIN_TOKEN（root-action 通道鉴权用）；
// 未运行或未注入时 ok=false。token 只在进程生命周期内有效，停止/退出即清空。
func (m *Manager) PluginToken(id string) (string, bool) {
	inst, ok := m.lookup(id)
	if !ok {
		return "", false
	}
	token := inst.tokenValue()
	return token, token != ""
}

// lookup 只查不建，供状态读取与停止路径使用。
func (m *Manager) lookup(id string) (*instance, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	inst, ok := m.plugins[id]
	return inst, ok
}

// Forget 丢弃插件的运行态登记，供热升级在 Stop 之后重建 instance。
//
// instance 在创建时绑定 manifest（含版本目录）；catalog 替换清单后若继续复用旧
// instance，Start/Ensure 仍会 exec 旧版本二进制。调用方必须确保进程已退出
// （Stop 返回）再丢弃，否则会留下无主进程与 socket。
func (m *Manager) Forget(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.plugins, id)
	delete(m.gates, id)
}

// gate 返回（必要时创建）该插件的冷启动闸门。
func (m *Manager) gate(id string) *gate {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gates[id]
	if !ok {
		g = newGate(m.opts.QueueLimit)
		m.gates[id] = g
	}
	return g
}

// startIfNeeded 幂等启动：ready 直接返回，draining 拒绝，其余走一次冷启动。
func (m *Manager) startIfNeeded(ctx context.Context, inst *instance) error {
	switch inst.currentState() {
	case StateReady:
		return nil
	case StateDraining:
		return errf(pluginapi.E_CONFLICT, "插件 %s 正在停止，拒绝启动", inst.manifest.ID)
	default:
		return m.start(ctx, inst)
	}
}
