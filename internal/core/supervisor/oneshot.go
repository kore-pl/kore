package supervisor

import (
	"context"
	"encoding/binary"
	"net"
	"sync"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// ensureOneshot 为 oneshot 插件拉起一次全新进程并执行单次调用。
//
// 与 lazy 的本质区别：lazy 冷启后保留进程 idle_timeout 时长供复用；oneshot
// 每次 invoke 都独占一个新进程，调用完成（读到响应帧或连接关闭）后立即 Stop，
// 空闲时 0 进程。串行令牌保证同一插件的多次 invoke 不重叠（并发上限 1）。
func (m *Manager) ensureOneshot(ctx context.Context, inst *instance) (net.Conn, error) {
	select {
	case <-inst.oneshotIdle:
	case <-ctx.Done():
		return nil, ctxErr(ctx)
	}
	// 上次若残留运行态（异常未回收），先停干净再拉新进程。
	if state := inst.currentState(); state != StateStopped {
		if err := m.Stop(ctx, inst.manifest.ID); err != nil {
			inst.oneshotIdle <- struct{}{}
			return nil, err
		}
	}
	// 不走 startIfNeeded：oneshot 每次全新拉起，不复用 ready 实例。
	err := m.gate(inst.manifest.ID).do(ctx, func(ctx context.Context) error {
		return m.start(ctx, inst)
	})
	if err != nil {
		inst.oneshotIdle <- struct{}{}
		return nil, err
	}
	inst.mu.Lock()
	conn := inst.conn
	inst.mu.Unlock()
	if conn == nil {
		inst.oneshotIdle <- struct{}{}
		return nil, errf(pluginapi.E_UPSTREAM, "插件 %s 未就绪（state=%s）",
			inst.manifest.ID, inst.currentState())
	}
	return &oneshotConn{Conn: conn, finish: func() { m.finishOneshot(inst) }}, nil
}

// finishOneshot 在一次调用结束后回收进程并归还串行令牌。
//
// 异步执行：bus 正在从 Read 返回响应，同步 Stop 会阻塞调用方；放到 goroutine
// 后 bus 拿到 Reply 与进程回收并行发生，下一轮 invoke 等令牌归还后重新拉起。
func (m *Manager) finishOneshot(inst *instance) {
	go func() {
		id := inst.manifest.ID
		if err := m.Stop(context.Background(), id); err != nil {
			m.logger.Warn("oneshot 调用后回收失败", "plugin_id", id, "err", err)
		}
		inst.oneshotIdle <- struct{}{}
	}()
}

// oneshotConn 包装底层 UDS 连接，旁路观察帧边界：读到第一个 response 帧即认定
// 单次调用完成，触发进程回收；连接被关闭（含错误路径）同样触发回收。
//
// 内嵌 net.Conn 透传 Write/SetDeadline/LocalAddr 等方法，不改变 bus 的收发语义。
type oneshotConn struct {
	net.Conn
	once    sync.Once
	finish  func()
	mu      sync.Mutex
	pending []byte
}

// Read 透传底层读取，同时把读到的字节喂给帧观察器。
func (c *oneshotConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.observe(p[:n])
	}
	return n, err
}

// Close 在关闭底层连接前触发回收（覆盖 bus 的错误帧/EOF 关闭路径）。
func (c *oneshotConn) Close() error {
	c.once.Do(c.finish)
	return c.Conn.Close()
}

// FinishCall 实现 bus.CallFinisher：本次调用一旦结束就回收进程并归还串行令牌。
//
// 这条钩子是超时路径的唯一回收出口：bus 超时后为 resident/lazy 保留连接（迟到帧
// 重同步），oneshot 既读不到响应帧、也没人 Close，`finish` 只能由调用边界驱动。
// 幂等由 once 保证（响应帧先到、随后 Close、再随后本钩子，只有第一次生效）。
func (c *oneshotConn) FinishCall() { c.once.Do(c.finish) }

// observe 按 [4 字节大端长度][载荷] 重组帧；解析出 response 即触发一次性回收。
// 非响应帧（event/ping）忽略并继续累积，直到一帧完整或数据非法（停止观察）。
func (c *oneshotConn) observe(chunk []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pending = append(c.pending, chunk...)
	for {
		if len(c.pending) < 4 {
			return
		}
		size := int(binary.BigEndian.Uint32(c.pending[:4]))
		if size < 2 || size > pluginapi.MaxFrameSize {
			return // 非法帧头，放弃观察（不影响上层按原语义处理）
		}
		total := 4 + size
		if len(c.pending) < total {
			return // 半包，等下次 Read 补齐
		}
		payload := c.pending[4:total]
		c.pending = c.pending[total:]
		if env, err := pluginapi.DecodeFrame(payload); err == nil {
			if _, ok := env.(*pluginapi.Response); ok {
				c.once.Do(c.finish)
			}
		}
	}
}
