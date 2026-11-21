// Package supervisor 管理插件进程生命周期：拉起、hello 握手、状态机与优雅停止。
//
// 薄壳边界：本包只做进程与 socket 的调度，不处理 HTTP、不解析业务参数、不写插件数据。
// 隔离模型（G-04）：socket 由主壳以 server 身份 bind（插件无权自建），插件进程以
// client 身份 connect；2s 硬超时内未完成 kore.hello 即 SIGKILL 并置 failed。
//
// M1 只实现 resident：lazy/oneshot 由 registry 在 enable 阶段拒绝（E_UNSUPPORTED）。
// 退避重启、心跳探测、热升级、run.json 孤儿进程核对按任务拆分归 M1-12/13，本包不含
// 任何 ticker/轮询（G-19）：状态变化全部由调用事件驱动。
package supervisor

import (
	"context"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// State 是插件运行状态（M1 覆盖 resident 的四态 + 失败态）。
type State string

// 运行状态取值；与 ARCHITECTURE §7 同名，演进为 draining 以对齐 M1 任务口径。
const (
	// StateStopped 未运行：进程与 socket 均已清理。
	StateStopped State = "stopped"
	// StateStarting 冷启动中：已 exec，等 hello（≤2s）。
	StateStarting State = "starting"
	// StateReady 就绪：hello 校验通过，可转发请求。
	StateReady State = "ready"
	// StateDraining 停止中：已发 kore.shutdown，等在途退出（≤5s）。
	StateDraining State = "draining"
	// StateFailed 启动失败：进程已 SIGKILL，需人工 enable 才重试。
	StateFailed State = "failed"
)

// 默认值与协议常量；HelloTimeout 是「exec→hello 完成」的硬超时，不是冷启动 p95 SLO。
const (
	defaultHelloTimeout  = 2 * time.Second
	defaultShutdownGrace = 5 * time.Second
	defaultKillWait      = 2 * time.Second
	defaultQueueLimit    = 32
)

// Manager 是插件进程监督器；并发安全，状态变更加锁，冷启动由每插件闸门串行。
type Manager struct {
	opts    Options
	logger  *slog.Logger
	mu      sync.Mutex
	plugins map[string]*instance
	gates   map[string]*gate
}

// New 构造 Manager；Transport / Manifests / RunDir 缺一即返回 E_INTERNAL。
func New(opts Options) (*Manager, error) {
	if opts.Transport == nil || opts.Manifests == nil || opts.RunDir == "" {
		return nil, errf(pluginapi.E_INTERNAL, "supervisor 缺少 Transport/Manifests/RunDir")
	}
	opts.withDefaults()
	return &Manager{
		opts:    opts,
		logger:  opts.Logger,
		plugins: make(map[string]*instance),
		gates:   make(map[string]*gate),
	}, nil
}

// Start 幂等启动插件：已 ready 直接返回，failed/stopped 重新冷启动。
func (m *Manager) Start(ctx context.Context, id string) error {
	inst, err := m.instance(id)
	if err != nil {
		return err
	}
	return m.gate(id).do(ctx, func(ctx context.Context) error {
		return m.startIfNeeded(ctx, inst)
	})
}

// Ensure 确保插件就绪并返回主壳持有的 UDS 连接（bus 的转发入口）。
func (m *Manager) Ensure(ctx context.Context, id string) (net.Conn, error) {
	if err := m.Start(ctx, id); err != nil {
		return nil, err
	}
	inst, ok := m.lookup(id)
	if !ok {
		return nil, errf(pluginapi.E_NOTFOUND, "插件 %s 未登记", id)
	}
	inst.mu.Lock()
	defer inst.mu.Unlock()
	if inst.conn == nil {
		return nil, errf(pluginapi.E_UPSTREAM, "插件 %s 未就绪（state=%s）", id, inst.state)
	}
	return inst.conn, nil
}

// instance 取（或创建）插件运行态；未安装、未 enable、非 resident 都在此拦截。
func (m *Manager) instance(id string) (*instance, error) {
	if !m.opts.Manifests.Enabled(id) {
		return nil, errf(pluginapi.E_NOTFOUND,
			"插件 %s 未安装或未 enable（M1 只支持已 enable 的 resident 插件）", id)
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

// lookup 只查不建，供状态读取与停止路径使用。
func (m *Manager) lookup(id string) (*instance, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	inst, ok := m.plugins[id]
	return inst, ok
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
