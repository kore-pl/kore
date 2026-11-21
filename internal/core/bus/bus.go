// Package bus 负责插件帧转发：请求-响应关联、req_id 透传、帧上限与调用超时。
//
// 薄壳边界：本包只搬运帧，不做业务路由、不持久化消息、不自动重试业务失败。
// 帧编解码复用 pkg/pluginapi（4 字节大端长度 + JSON 载荷，单帧上限 8 MiB）。
//
// 连接模型（M1）：主壳是 UDS server，插件 connect 后连接由 supervisor 持有并交给本包；
// 同一连接上的调用按连接锁串行，避免两个 goroutine 的帧头交错。多路复用与 pending map
// 归 M1-09（需要每连接独立读循环），不在本包范围内。
package bus

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// defaultCallTimeout 是未显式指定时的单次调用上限（协议默认 15s）。
const defaultCallTimeout = 15 * time.Second

// Provider 是 bus 对插件运行时的最小依赖（supervisor.Manager 实现）。
type Provider interface {
	// Ensure 确保插件就绪并返回主壳持有的 UDS 连接；
	// 未安装/未 enable 返回 E_NOTFOUND，冷启动排队满返回 E_RATELIMIT。
	Ensure(ctx context.Context, id string) (net.Conn, error)
}

// Options 是 Bus 的构造参数。
type Options struct {
	// CallTimeout 是单次调用超时，默认 15s（会被 ctx 截止时间收紧）。
	CallTimeout time.Duration
	// Logger 可空，默认 slog.Default()。
	Logger *slog.Logger
}

// Reply 是一次调用的结果；ReqID 是插件回显的跨进程追踪标识，调用方据此核对透传。
type Reply struct {
	// ReqID 响应回显的 req_id，必须与请求一致。
	ReqID string
	// Result 成功结果的 JSON 值。
	Result json.RawMessage
}

// Bus 把内部调用转成协议帧并等待响应；并发安全（按连接串行）。
type Bus struct {
	provider Provider
	opts     Options
	logger   *slog.Logger
	mu       sync.Mutex
	locks    map[net.Conn]*sync.Mutex
}

// New 构造 Bus；Provider 为空返回错误（装配错误，不属于运行期降级）。
func New(provider Provider, opts Options) (*Bus, error) {
	if provider == nil {
		return nil, errf(pluginapi.E_INTERNAL, "bus 缺少 Provider")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Bus{provider: provider, opts: opts, logger: opts.Logger, locks: make(map[net.Conn]*sync.Mutex)}, nil
}

// connLock 取该连接专用的串行锁，保证同一连接上的帧写入不交错。
func (b *Bus) connLock(conn net.Conn) *sync.Mutex {
	b.mu.Lock()
	defer b.mu.Unlock()
	lock, ok := b.locks[conn]
	if !ok {
		lock = &sync.Mutex{}
		b.locks[conn] = lock
	}
	return lock
}

// dropConnLock 在连接被判定不可用时回收锁记录，避免 map 随重启无限增长。
func (b *Bus) dropConnLock(conn net.Conn) {
	b.mu.Lock()
	delete(b.locks, conn)
	b.mu.Unlock()
}

// timeout 计算本次调用超时：默认值，再被 ctx 截止时间收紧。
func (b *Bus) timeout(ctx context.Context) time.Duration {
	timeout := b.opts.CallTimeout
	if timeout <= 0 {
		timeout = defaultCallTimeout
	}
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < timeout {
			timeout = remaining
		}
	}
	return timeout
}

// errf 构造带协议错误码的统一错误体。
func errf(code, format string, args ...any) *pluginapi.Error {
	return &pluginapi.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
