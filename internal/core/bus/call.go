package bus

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"time"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// Call 转发一次方法调用并等待响应。
//
// reqID 是跨进程追踪标识：非空时原样写入请求帧，插件必须回显；为空时自动生成
// （r-<8 位 hex>）。插件回显不一致或缺 req_id 按协议违规处理（E_INVALID）。
func (b *Bus) Call(ctx context.Context, plugin, method string, params json.RawMessage, reqID string) (*Reply, error) {
	if plugin == "" || method == "" {
		return nil, errf(pluginapi.E_INVALID, "插件 id 与方法名不能为空")
	}
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	conn, err := b.provider.Ensure(ctx, plugin)
	if err != nil {
		return nil, err
	}
	requestID, err := randomHex(16)
	if err != nil {
		return nil, errf(pluginapi.E_INTERNAL, "生成请求 id 失败：%v", err)
	}
	if reqID == "" {
		reqID = "r-" + requestID[:8]
	}
	timeout := b.timeout(ctx)
	request := &pluginapi.Request{
		Type:      pluginapi.TypeRequest,
		ID:        requestID,
		ReqID:     reqID,
		Method:    method,
		Params:    params,
		TimeoutMS: pluginapi.Timeout(int(timeout / time.Millisecond)),
	}
	lock := b.connLock(conn)
	lock.Lock()
	defer lock.Unlock()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		b.dropConnLock(conn)
		return nil, errf(pluginapi.E_UPSTREAM, "设置调用超时失败：%v", err)
	}
	if err := pluginapi.WriteJSON(conn, request); err != nil {
		b.dropConnLock(conn)
		return nil, errf(pluginapi.E_UPSTREAM, "插件 %s 写请求帧失败：%v", plugin, err)
	}
	reply, err := b.readReply(conn, plugin, requestID, reqID)
	_ = conn.SetDeadline(time.Time{})
	return reply, err
}

// readReply 读帧直到匹配到本次请求的响应；事件与 ping 不算响应。
func (b *Bus) readReply(conn net.Conn, plugin, requestID, reqID string) (*Reply, error) {
	for {
		payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
		if err != nil {
			return nil, b.frameError(conn, plugin, reqID, err)
		}
		env, err := pluginapi.DecodeFrame(payload)
		if err != nil {
			return nil, errf(pluginapi.E_INVALID, "插件 %s 响应不是合法信封：%v", plugin, err)
		}
		reply, done, err := b.handleFrame(conn, plugin, env, requestID, reqID)
		if err != nil {
			return nil, err
		}
		if done {
			return reply, nil
		}
	}
}

// handleFrame 处理一帧：命中响应即返回 done，事件丢弃、ping 回 pong 后继续等。
func (b *Bus) handleFrame(conn net.Conn, plugin string, env any, requestID, reqID string) (*Reply, bool, error) {
	switch value := env.(type) {
	case *pluginapi.Response:
		if value.ID != requestID {
			return nil, false, errf(pluginapi.E_INVALID,
				"响应 id=%s 与请求 id=%s 不匹配，连接不再可信", value.ID, requestID)
		}
		if value.ReqID != reqID {
			return nil, false, errf(pluginapi.E_INVALID,
				"响应未回显 req_id（期望 %s，实际 %q）", reqID, value.ReqID)
		}
		if value.Error != nil {
			return nil, false, value.Error
		}
		return &Reply{ReqID: value.ReqID, Result: value.Result}, true, nil
	case *pluginapi.Event:
		b.logger.Debug("插件事件暂未接入 SSE，丢弃", "plugin_id", plugin, "event", value.Event)
		return nil, false, nil
	case *pluginapi.Ping:
		_ = pluginapi.WriteJSON(conn, &pluginapi.Pong{Type: pluginapi.TypePong, TS: value.TS})
		return nil, false, nil
	default:
		return nil, false, errf(pluginapi.E_INVALID, "协议违规：等待响应却收到 %T", env)
	}
}

// frameError 把读帧失败映射成协议错误；超限帧断开连接并记审计日志。
func (b *Bus) frameError(conn net.Conn, plugin, reqID string, err error) error {
	b.dropConnLock(conn)
	if errors.Is(err, pluginapi.ErrFrameTooLarge) {
		b.logger.Warn("响应帧超过 8 MiB 上限，断开连接",
			"plugin_id", plugin, "req_id", reqID, "limit", pluginapi.MaxFrameSize)
		_ = conn.Close()
		return errf(pluginapi.E_INVALID, "插件 %s 响应帧超过 8 MiB 上限，连接已断开", plugin)
	}
	if errors.Is(err, io.EOF) {
		_ = conn.Close()
		return errf(pluginapi.E_UPSTREAM, "插件 %s 连接已断开", plugin)
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return errf(pluginapi.E_UPSTREAM, "插件 %s 调用超时", plugin)
	}
	_ = conn.Close()
	return errf(pluginapi.E_UPSTREAM, "插件 %s 响应读取失败：%v", plugin, err)
}

// randomHex 生成 n 字节随机数的 hex 串；失败按内核内部错误处理。
func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
