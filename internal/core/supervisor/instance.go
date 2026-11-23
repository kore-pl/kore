package supervisor

import (
	"net"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
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

// instance 是单个插件的运行态；所有字段读写都在 mu 下，避免与 reaper 竞争。
type instance struct {
	manifest *registry.Manifest
	socket   string

	mu       sync.Mutex
	state    State
	cmd      *exec.Cmd
	token    string // 本进程的 KORE_PLUGIN_TOKEN（root-action 通道鉴权用）
	conn     net.Conn
	listener net.Listener
	restarts int
	lastErr  string
	startAt  time.Time
	exited   chan struct{}

	// lazy 相关字段：lastUsed 是最近一次 invoke 的单调序号（LRU 依据），
	// idleGen 是空闲计时代次，idleCancel 非空时持有的计时观察须被取消。
	lastUsed   atomic.Uint64
	idleGen    uint64
	idleCancel chan struct{}

	// oneshotIdle 是调用串行令牌（容量 1、预填 1）：Ensure 取走、本次调用回收后归还。
	oneshotIdle chan struct{}

	// slotReserved 表示该 resident 已通过槽位准入、正在排队/冷启动，尚未进入
	// starting 状态。由 Manager.slotMu 保护（读写都必须持锁），供并发 enable/invoke
	// 不重复占位，也供 lazy 准入把「正在起来的 resident」计入总槽位。
	slotReserved bool
}

// isLazy 报告该实例是否为惰性生命周期。
func (i *instance) isLazy() bool {
	return i.manifest.Lifecycle == registry.LifecycleLazy
}

// isOneshot 报告该实例是否为一次性生命周期（用完即走，空闲 0 进程）。
func (i *instance) isOneshot() bool {
	return i.manifest.Lifecycle == registry.LifecycleOneshot
}

// usedAt 记录一次 invoke 的使用序号（返回新序号，供 LRU 比较）。
func (i *instance) usedAt(seq uint64) uint64 {
	i.lastUsed.Store(seq)
	return seq
}

// newInstance 创建未启动的运行态。
func newInstance(manifest *registry.Manifest, socket string) *instance {
	inst := &instance{manifest: manifest, socket: socket, state: StateStopped}
	if inst.isOneshot() {
		inst.oneshotIdle = make(chan struct{}, 1)
		inst.oneshotIdle <- struct{}{}
	}
	return inst
}

// setToken 记录本次进程的插件 token（spawn 成功后写入）。
func (i *instance) setToken(token string) {
	i.mu.Lock()
	i.token = token
	i.mu.Unlock()
}

// clearToken 在进程退出后清除 token，避免旧凭证残留。
func (i *instance) clearToken() {
	i.mu.Lock()
	i.token = ""
	i.mu.Unlock()
}

// tokenValue 读当前 token（未运行时为空）。
func (i *instance) tokenValue() string {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.token
}

// currentState 读当前状态。
func (i *instance) currentState() State {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.state
}

// setState 覆盖状态。
func (i *instance) setState(state State) {
	i.mu.Lock()
	i.state = state
	i.mu.Unlock()
}

// beginStart 进入 starting：重置失败原因与开始时间，并为本次启动新建退出信号。
func (i *instance) beginStart() {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.state = StateStarting
	i.startAt = time.Now()
	i.lastErr = ""
	i.exited = make(chan struct{})
}

// deadline 返回本次启动的 hello 硬截止时间；已过期时第二返回值为 false。
func (i *instance) deadline(timeout time.Duration) (time.Time, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.startAt.IsZero() {
		return time.Time{}, false
	}
	limit := i.startAt.Add(timeout)
	return limit, time.Now().Before(limit)
}

// attachListener 登记本次启动的监听器。
func (i *instance) attachListener(listener net.Listener) {
	i.mu.Lock()
	i.listener = listener
	i.mu.Unlock()
}

// listenerRef 取当前监听器（可能在并发停止后为 nil）。
func (i *instance) listenerRef() net.Listener {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.listener
}

// attachProcess 登记已成功 exec 的进程。
func (i *instance) attachProcess(cmd *exec.Cmd) {
	i.mu.Lock()
	i.cmd = cmd
	i.mu.Unlock()
}

// exitedRef 取本次启动的退出信号；未启动时为 nil。
func (i *instance) exitedRef() chan struct{} {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.exited
}

// takeRuntime 取出并清空 listener/conn/cmd，调用方负责关闭。
func (i *instance) takeRuntime() (net.Listener, net.Conn, *exec.Cmd) {
	i.mu.Lock()
	defer i.mu.Unlock()
	listener, conn, cmd := i.listener, i.conn, i.cmd
	i.listener, i.conn, i.cmd = nil, nil, nil
	return listener, conn, cmd
}

// markReady 记录握手成功：连接交给 bus 转发使用。
func (i *instance) markReady(conn net.Conn) {
	i.mu.Lock()
	i.state = StateReady
	i.conn = conn
	i.mu.Unlock()
}

// markFailed 记录启动失败并累计重启次数。
func (i *instance) markFailed(cause error) {
	i.mu.Lock()
	i.state = StateFailed
	i.restarts++
	i.lastErr = cause.Error()
	i.mu.Unlock()
}

// markStopped 记录已停止。
func (i *instance) markStopped() {
	i.mu.Lock()
	i.state = StateStopped
	i.mu.Unlock()
}

// snapshot 生成运行时视图（PID 取自进程句柄，进程已回收时为 0）。
func (i *instance) snapshot() View {
	i.mu.Lock()
	defer i.mu.Unlock()
	pid := 0
	if i.cmd != nil && i.cmd.Process != nil {
		pid = i.cmd.Process.Pid
	}
	return View{
		ID:        i.manifest.ID,
		State:     i.state,
		PID:       pid,
		Restarts:  i.restarts,
		LastError: i.lastErr,
		Socket:    i.socket,
		StartedAt: i.startAt,
	}
}
