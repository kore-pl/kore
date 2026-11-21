package supervisor

import (
	"context"
	"sync"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// gate 是单插件的冷启动闸门：同一时刻只允许一次启动，其余请求并入队列等同一结果。
//
// 队列上限按「并发进入闸门的请求数」计（含正在启动的那一个）：上限 32 时，40 个并发
// 请求中 32 个被接纳、8 个立即返回 E_RATELIMIT。这样上限口径与 ARCHITECTURE §3.1
// 「排队上限 32，超限 E_RATELIMIT」一致，且不会因为计数口径产生 1 个的歧义。
type gate struct {
	slots chan struct{}

	mu       sync.Mutex
	inflight *startCall
}

// startCall 是一次在飞启动，done 关闭后 err 对所有等待者可见。
type startCall struct {
	done chan struct{}
	err  error
}

// newGate 创建容量为 limit 的闸门。
func newGate(limit int) *gate {
	return &gate{slots: make(chan struct{}, limit)}
}

// do 在闸门内执行一次启动。
//
// 排队已满返回 E_RATELIMIT（message 带 Retry-After 语义）；已有启动在飞时等待它的
// 结果，不重复拉起（冷启动互斥）。ctx 取消只影响等待者，不打断已开始的启动。
func (g *gate) do(ctx context.Context, start func(context.Context) error) error {
	select {
	case g.slots <- struct{}{}:
	case <-ctx.Done():
		return ctxErr(ctx)
	default:
		return errf(pluginapi.E_RATELIMIT,
			"插件冷启动队列已满（上限 %d），请按 Retry-After 退避后重试", cap(g.slots))
	}
	defer func() { <-g.slots }()

	call, leader := g.join()
	if !leader {
		select {
		case <-call.done:
			return call.err
		case <-ctx.Done():
			return ctxErr(ctx)
		}
	}
	call.err = start(ctx)
	g.finish(call)
	return call.err
}

// join 加入队列：返回在飞的启动或把自己提升为 leader。
func (g *gate) join() (*startCall, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.inflight != nil {
		return g.inflight, false
	}
	g.inflight = &startCall{done: make(chan struct{})}
	return g.inflight, true
}

// finish 结束本次启动并唤醒所有等待者。
func (g *gate) finish(call *startCall) {
	g.mu.Lock()
	g.inflight = nil
	g.mu.Unlock()
	close(call.done)
}

// ctxErr 把 ctx 错误转成协议错误码（取消/超时都按上游不可用对待）。
func ctxErr(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return errf(pluginapi.E_UPSTREAM, "冷启动等待被取消：%v", err)
	}
	return errf(pluginapi.E_UPSTREAM, "冷启动等待被取消")
}
