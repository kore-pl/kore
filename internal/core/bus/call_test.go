package bus_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/bus"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// countingProvider 记录 Ensure 调用次数与返回的连接，用来断言「同一次调用没有换连接」。
type countingProvider struct {
	conn  net.Conn
	calls atomic.Int32
}

// Ensure 实现 bus.Provider：始终返回同一个连接并计数。
func (p *countingProvider) Ensure(context.Context, string) (net.Conn, error) {
	p.calls.Add(1)
	return p.conn, nil
}

// trackedConn 记录关闭次数，用来断言迟到帧是「丢弃并继续读」还是「弃连接」。
type trackedConn struct {
	net.Conn
	closes atomic.Int32
}

// Close 记录关闭次数后透传给底层连接。
func (c *trackedConn) Close() error {
	c.closes.Add(1)
	return c.Conn.Close()
}

// socketPair 用真实 UDS 建一对连接的 client/plugin 端；内核侧是带缓冲的流式 socket，
// 与 supervisor 交给 bus 的连接语义一致（net.Pipe 零缓冲，无法复现迟到帧先于下一次
// 请求写入的场景）。
func socketPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	socketPath := filepath.Join(t.TempDir(), "bus.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("监听 UDS 失败: %v", err)
	}
	accepted := make(chan net.Conn, 1)
	acceptErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			acceptErr <- err
			return
		}
		accepted <- conn
	}()
	client, err := net.Dial("unix", socketPath)
	if err != nil {
		_ = listener.Close()
		t.Fatalf("连接 UDS 失败: %v", err)
	}
	plugin, err := awaitConn(accepted, acceptErr)
	if err != nil {
		_ = listener.Close()
		_ = client.Close()
		t.Fatalf("接受 UDS 连接失败: %v", err)
	}
	_ = listener.Close()
	t.Cleanup(func() {
		_ = client.Close()
		_ = plugin.Close()
	})
	return client, plugin
}

// awaitConn 等 accept 结果，避免测试永久挂起。
func awaitConn(accepted <-chan net.Conn, acceptErr <-chan error) (net.Conn, error) {
	select {
	case conn := <-accepted:
		return conn, nil
	case err := <-acceptErr:
		return nil, err
	case <-time.After(2 * time.Second):
		return nil, fmt.Errorf("accept 超时")
	}
}

// newBusWith 用指定连接与超时构造 Bus。
func newBusWith(t *testing.T, conn net.Conn, timeout time.Duration) *bus.Bus {
	t.Helper()
	instance, err := bus.New(&countingProvider{conn: conn}, bus.Options{CallTimeout: timeout})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}
	return instance
}

// runScript 在插件侧执行脚本，返回结束信号（错误由测试主 goroutine 处理）。
func runScript(plugin net.Conn, script func(net.Conn) error) <-chan error {
	done := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("插件脚本 panic: %v", recovered)
			}
		}()
		done <- script(plugin)
	}()
	return done
}

// waitScript 等插件脚本结束；脚本报错即测试失败。
func waitScript(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("插件脚本失败: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("插件脚本 5s 内未结束")
	}
}

// readRequest 读一帧并断言是 request 信封。
func readRequest(conn net.Conn) (*pluginapi.Request, error) {
	payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
	if err != nil {
		return nil, err
	}
	envelope, err := pluginapi.DecodeFrame(payload)
	if err != nil {
		return nil, err
	}
	request, ok := envelope.(*pluginapi.Request)
	if !ok {
		return nil, fmt.Errorf("首帧不是 request，实际 %T", envelope)
	}
	return request, nil
}

// replyWith 按请求回写一帧成功响应（id 与 req_id 原样回显）。
func replyWith(conn net.Conn, request *pluginapi.Request, result string) error {
	return pluginapi.WriteJSON(conn, &pluginapi.Response{
		Type:   pluginapi.TypeResponse,
		ID:     request.ID,
		ReqID:  request.ReqID,
		Result: json.RawMessage(result),
	})
}

// TestTimeoutThenNextCallSucceeds 是缺陷复现与回归的核心用例：
// 第一次调用超时 → 插件迟到写回响应帧 → 第二次正常调用必须成功。
//
// 修复前：第二次调用读到旧 id 的迟到帧，replyOf 判 E_INVALID（HTTP 400），
// 用户看到「参数不合法」，与真实原因（上一次超时）无关。
func TestTimeoutThenNextCallSucceeds(t *testing.T) {
	client, plugin := socketPair(t)
	tracked := &trackedConn{Conn: client}
	provider := &countingProvider{conn: tracked}
	instance, err := bus.New(provider, bus.Options{CallTimeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}

	done := runScript(plugin, func(conn net.Conn) error {
		first, err := readRequest(conn)
		if err != nil {
			return err
		}
		t.Logf("第一次请求帧: type=%s id=%s req_id=%s method=%s", first.Type, first.ID, first.ReqID, first.Method)
		// 越过 200ms 调用超时后再写回，模拟慢插件/卡住的插件迟到响应。
		time.Sleep(300 * time.Millisecond)
		stale := &pluginapi.Response{
			Type:   pluginapi.TypeResponse,
			ID:     first.ID,
			ReqID:  first.ReqID,
			Result: json.RawMessage(`{"stale":true}`),
		}
		if err := pluginapi.WriteJSON(conn, stale); err != nil {
			return err
		}
		t.Logf("迟到响应帧已写回连接: type=%s id=%s req_id=%s result=%s",
			stale.Type, stale.ID, stale.ReqID, stale.Result)
		second, err := readRequest(conn)
		if err != nil {
			return err
		}
		if err := replyWith(conn, second, `{"ok":2}`); err != nil {
			return err
		}
		third, err := readRequest(conn)
		if err != nil {
			return err
		}
		return replyWith(conn, third, `{"ok":3}`)
	})

	if _, callErr := instance.Call(context.Background(), "echo", "echo.one", nil, "r-first"); codeOf(t, callErr) != pluginapi.E_UPSTREAM {
		t.Fatalf("第一次调用应因超时返回 E_UPSTREAM，实际 %v", callErr)
	}

	reply, err := instance.Call(context.Background(), "echo", "echo.two", nil, "r-second")
	if err != nil {
		t.Fatalf("超时后下一次调用应成功，实际返回 %v（迟到帧被当成了本次响应）", err)
	}
	if reply.ReqID != "r-second" {
		t.Fatalf("第二次调用应拿到 r-second 的响应，实际 req_id=%q", reply.ReqID)
	}
	if string(reply.Result) != `{"ok":2}` {
		t.Fatalf("第二次调用结果应为 {\"ok\":2}，实际 %s（迟到帧未被丢弃）", reply.Result)
	}

	// 第三次调用立即成功：迟到帧已在第二次调用里被消费，连接上没有残留。
	thirdReply, err := instance.Call(context.Background(), "echo", "echo.three", nil, "r-third")
	if err != nil {
		t.Fatalf("第三次调用应成功（迟到帧不应残留），实际 %v", err)
	}
	if string(thirdReply.Result) != `{"ok":3}` {
		t.Fatalf("第三次调用结果应为 {\"ok\":3}，实际 %s", thirdReply.Result)
	}
	if got := provider.calls.Load(); got != 3 {
		t.Fatalf("每次调用都应经 Ensure 取连接，期望 3 次，实际 %d", got)
	}
	if got := tracked.closes.Load(); got != 0 {
		t.Fatalf("帧流重同步不应断开连接，实际 close 了 %d 次", got)
	}
	waitScript(t, done)
}

// TestLateResponseDiscardedWithoutClosingConnection 断言迟到帧的处置方式：
// 丢弃（debug 记录）并继续读同一连接，不重连、不关闭；夹在中间的 event 帧也不影响。
func TestLateResponseDiscardedWithoutClosingConnection(t *testing.T) {
	client, plugin := socketPair(t)
	tracked := &trackedConn{Conn: client}
	provider := &countingProvider{conn: tracked}
	instance, err := bus.New(provider, bus.Options{CallTimeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}

	done := runScript(plugin, func(conn net.Conn) error {
		first, err := readRequest(conn)
		if err != nil {
			return err
		}
		time.Sleep(300 * time.Millisecond)
		if err := replyWith(conn, first, `{"stale":true}`); err != nil {
			return err
		}
		if err := pluginapi.WriteJSON(conn, &pluginapi.Event{
			Type:  pluginapi.TypeEvent,
			Event: "plugin.log",
			TS:    time.Now().UTC().Format(time.RFC3339),
			Data:  json.RawMessage(`{"level":"info"}`),
		}); err != nil {
			return err
		}
		second, err := readRequest(conn)
		if err != nil {
			return err
		}
		return replyWith(conn, second, `{"fresh":true}`)
	})

	if _, callErr := instance.Call(context.Background(), "echo", "echo.one", nil, "r-first"); codeOf(t, callErr) != pluginapi.E_UPSTREAM {
		t.Fatalf("第一次调用应因超时返回 E_UPSTREAM，实际 %v", callErr)
	}
	reply, err := instance.Call(context.Background(), "echo", "echo.two", nil, "r-second")
	if err != nil {
		t.Fatalf("丢弃迟到帧后第二次调用应成功，实际 %v", err)
	}
	if string(reply.Result) != `{"fresh":true}` || reply.ReqID != "r-second" {
		t.Fatalf("应返回第二次调用的新鲜响应，实际 req_id=%q result=%s", reply.ReqID, reply.Result)
	}
	if got := provider.calls.Load(); got != 2 {
		t.Fatalf("两次调用各取一次连接（不重连），期望 2 次 Ensure，实际 %d", got)
	}
	if provider.conn != tracked {
		t.Fatalf("Ensure 返回的连接不应被替换")
	}
	if got := tracked.closes.Load(); got != 0 {
		t.Fatalf("处置方式是「丢弃迟到帧并保留连接」，期望 close 0 次，实际 %d 次", got)
	}
	waitScript(t, done)
}

// TestConsecutiveTimeoutsDoNotAccumulateStaleFrames 断言连续多次超时后迟到帧按序被消费：
// 3 次超时留下的 3 个迟到帧由下一次调用一次跳过，该次调用成功，且再下一次立即成功
// （连接上不留垃圾帧）。
func TestConsecutiveTimeoutsDoNotAccumulateStaleFrames(t *testing.T) {
	client, plugin := socketPair(t)
	tracked := &trackedConn{Conn: client}
	instance, err := bus.New(&countingProvider{conn: tracked}, bus.Options{CallTimeout: 120 * time.Millisecond})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}

	done := runScript(plugin, func(conn net.Conn) error {
		// 先读走 3 次超时调用的请求 + 第 4 次调用，再统一回写：确保 3 个迟到帧
		// 一定排在第 4 次调用的响应之前，且都不早于前三次调用的超时时刻。
		requests := make([]*pluginapi.Request, 0, 3)
		for i := 0; i < 3; i++ {
			request, err := readRequest(conn)
			if err != nil {
				return err
			}
			requests = append(requests, request)
		}
		fourth, err := readRequest(conn)
		if err != nil {
			return err
		}
		for _, request := range requests {
			if err := replyWith(conn, request, `{"late":true}`); err != nil {
				return err
			}
		}
		if err := replyWith(conn, fourth, `{"ok":4}`); err != nil {
			return err
		}
		fifth, err := readRequest(conn)
		if err != nil {
			return err
		}
		return replyWith(conn, fifth, `{"ok":5}`)
	})

	for i := 0; i < 3; i++ {
		reqID := fmt.Sprintf("r-timeout-%d", i)
		if _, callErr := instance.Call(context.Background(), "echo", "echo.slow", nil, reqID); codeOf(t, callErr) != pluginapi.E_UPSTREAM {
			t.Fatalf("第 %d 次调用应超时返回 E_UPSTREAM，实际 %v", i+1, callErr)
		}
	}
	reply, err := instance.Call(context.Background(), "echo", "echo.four", nil, "r-four")
	if err != nil {
		t.Fatalf("连续 3 次超时后第 4 次调用应成功，实际 %v", err)
	}
	if string(reply.Result) != `{"ok":4}` || reply.ReqID != "r-four" {
		t.Fatalf("第 4 次调用应拿到自己的响应，实际 req_id=%q result=%s", reply.ReqID, reply.Result)
	}
	after, err := instance.Call(context.Background(), "echo", "echo.five", nil, "r-five")
	if err != nil {
		t.Fatalf("第 5 次调用应成功（迟到帧已被清空），实际 %v", err)
	}
	if string(after.Result) != `{"ok":5}` {
		t.Fatalf("第 5 次调用结果应为 {\"ok\":5}，实际 %s", after.Result)
	}
	if got := tracked.closes.Load(); got != 0 {
		t.Fatalf("整段重同步不应弃连接，实际 close 了 %d 次", got)
	}
	waitScript(t, done)
}

// TestTimeoutMidFrameClosesConnection 断言安全边界：超时发生在半个帧里时帧边界已丢失，
// 无法重同步，必须弃连接并给出与真实原因一致的错误（而不是让下一次调用误报 E_INVALID）。
func TestTimeoutMidFrameClosesConnection(t *testing.T) {
	client, plugin := socketPair(t)
	tracked := &trackedConn{Conn: client}
	instance, err := bus.New(&countingProvider{conn: tracked}, bus.Options{CallTimeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatalf("构造 bus 失败: %v", err)
	}

	done := runScript(plugin, func(conn net.Conn) error {
		if _, err := readRequest(conn); err != nil {
			return err
		}
		// 只写 4 字节长度前缀的一半，制造半个帧头；随后等内核侧弃连接。
		if _, err := conn.Write([]byte{0x00, 0x00}); err != nil {
			return err
		}
		var probe [1]byte
		if _, err := conn.Read(probe[:]); err == nil {
			return fmt.Errorf("内核侧关闭连接后仍读到数据")
		}
		return nil
	})

	_, callErr := instance.Call(context.Background(), "echo", "echo.half", nil, "r-half")
	if codeOf(t, callErr) != pluginapi.E_UPSTREAM {
		t.Fatalf("半帧超时应返回 E_UPSTREAM，实际 %v", callErr)
	}
	if !strings.Contains(callErr.Error(), "帧读取中断") {
		t.Fatalf("半帧超时的错误应说明帧读取中断，实际 %v", callErr)
	}
	if got := tracked.closes.Load(); got != 1 {
		t.Fatalf("半帧超时必须弃连接（close 1 次），实际 %d 次", got)
	}
	// 连接已被弃用：下一次调用必须明确失败，不能给出误导性的 E_INVALID。
	if _, callErr := instance.Call(context.Background(), "echo", "echo.half", nil, "r-half-2"); codeOf(t, callErr) != pluginapi.E_UPSTREAM {
		t.Fatalf("弃连接后的调用应返回 E_UPSTREAM，实际 %v", callErr)
	}
	waitScript(t, done)
}
