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

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// maxStaleResponses 是单次调用允许丢弃的迟到响应帧上限。
//
// 上一次调用超时后插件写回的响应帧会留在同一连接上；下一次调用读到旧 id 的帧时
// 必须丢弃并继续读（帧流重同步），否则用户看到的是与真实原因无关的 E_INVALID。
// 超过上限说明对端在持续灌入无法关联的响应帧，连接按不可信处理（关闭并返回
// E_INVALID），避免在垃圾帧上无限消耗调用预算。
const maxStaleResponses = 32

// Call 转发一次方法调用并等待响应。
//
// reqID 是跨进程追踪标识：非空时原样写入请求帧，插件必须回显；为空时自动生成
// （r-<8 位 hex>）。插件回显不一致或缺 req_id 按协议违规处理（E_INVALID）。
//
// 超时语义：超时本身不关闭连接（插件可能只是慢，迟到帧由下一次调用重同步），
// 只有帧边界已丢失（超时发生在半个帧里）或读到无法关联的帧超过上限时才弃连接。
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
	reader := &readCounter{r: conn}
	reply, err := b.readReply(conn, reader, plugin, requestID, reqID)
	_ = conn.SetDeadline(time.Time{})
	return reply, err
}

// readCounter 记录本连接累计读到的字节数，用于判定超时是否停在帧边界：
// 只有「本次读帧一个字节都没读到」时字节流仍然对齐，迟到帧才能靠丢弃重同步；
// 半帧超时说明帧边界已丢失，必须弃连接。
type readCounter struct {
	r io.Reader
	n int
}

// Read 透传读并累计字节数。
func (c *readCounter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

// readReply 读帧直到匹配到本次请求的响应；事件与 ping 不算响应。
//
// 帧流重同步：上一次调用超时后，插件写回的迟到响应会留在同一连接上。读到 id 与
// 本次请求不一致的 Response 时丢弃并继续读，而不是直接判 E_INVALID——连接上的
// 帧边界仍然完整，没有理由把「上一次超时的残留」报成「本次参数不合法」。
//
// 解析期 any 的唯一收口点：DecodeFrame 返回 any，这里立即断言成
// *pluginapi.Response / *Event / *Ping 三个具体类型，出口（Reply）不携带 any。
func (b *Bus) readReply(conn net.Conn, reader *readCounter, plugin, requestID, reqID string) (*Reply, error) {
	stale := 0
	for {
		before := reader.n
		payload, err := pluginapi.ReadFrame(reader, pluginapi.MaxFrameSize)
		if err != nil {
			return nil, b.frameError(conn, plugin, reqID, err, reader.n == before)
		}
		envelope, err := pluginapi.DecodeFrame(payload)
		if err != nil {
			return nil, errf(pluginapi.E_INVALID, "插件 %s 响应不是合法信封：%v", plugin, err)
		}
		switch value := envelope.(type) {
		case *pluginapi.Response:
			if value.ID == requestID {
				return replyOf(value, requestID, reqID)
			}
			stale++
			if stale > maxStaleResponses {
				b.discardConn(conn)
				return nil, errf(pluginapi.E_INVALID,
					"插件 %s 连续 %d 个响应帧无法关联到本次请求（req_id=%s），连接已断开",
					plugin, stale, reqID)
			}
			b.logger.Debug("丢弃迟到的响应帧（帧流重同步）",
				"plugin_id", plugin, "req_id", reqID,
				"stale_id", value.ID, "stale_req_id", value.ReqID)
		case *pluginapi.Event:
			b.logger.Debug("插件事件暂未接入 SSE，丢弃", "plugin_id", plugin, "event", value.Event)
		case *pluginapi.Ping:
			_ = pluginapi.WriteJSON(conn, &pluginapi.Pong{Type: pluginapi.TypePong, TS: value.TS})
		default:
			return nil, errf(pluginapi.E_INVALID, "协议违规：等待响应却收到 %T", envelope)
		}
	}
}

// replyOf 校验响应的 id 与 req_id 并转成 Reply；错误体原样透传。
func replyOf(response *pluginapi.Response, requestID, reqID string) (*Reply, error) {
	if response.ID != requestID {
		return nil, errf(pluginapi.E_INVALID,
			"响应 id=%s 与请求 id=%s 不匹配，连接不再可信", response.ID, requestID)
	}
	if response.ReqID != reqID {
		return nil, errf(pluginapi.E_INVALID,
			"响应未回显 req_id（期望 %s，实际 %q）", reqID, response.ReqID)
	}
	if response.Error != nil {
		return nil, response.Error
	}
	return &Reply{ReqID: response.ReqID, Result: response.Result}, nil
}

// discardConn 把连接标记为不可用：回收连接锁记录并关闭连接。
//
// 顺序与既有语义一致（先回收锁表再关闭），避免已关闭连接在锁表里留下记录。
func (b *Bus) discardConn(conn net.Conn) {
	b.dropConnLock(conn)
	_ = conn.Close()
}

// frameError 把读帧失败映射成协议错误；帧边界是否完整决定连接能否继续使用。
//
// atFrameBoundary 为 true 表示本次读帧一个字节都没读到（连接停在上一次响应帧的
// 边界上）：迟到帧还能靠丢弃重同步，保留连接。false（半帧、EOF、超限等）说明
// 字节流已不可信，弃连接。
func (b *Bus) frameError(conn net.Conn, plugin, reqID string, err error, atFrameBoundary bool) error {
	if errors.Is(err, pluginapi.ErrFrameTooLarge) {
		b.discardConn(conn)
		b.logger.Warn("响应帧超过 8 MiB 上限，断开连接",
			"plugin_id", plugin, "req_id", reqID, "limit", pluginapi.MaxFrameSize)
		return errf(pluginapi.E_INVALID, "插件 %s 响应帧超过 8 MiB 上限，连接已断开", plugin)
	}
	if errors.Is(err, io.EOF) {
		b.discardConn(conn)
		return errf(pluginapi.E_UPSTREAM, "插件 %s 连接已断开", plugin)
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		if !atFrameBoundary {
			b.discardConn(conn)
			return errf(pluginapi.E_UPSTREAM, "插件 %s 调用超时（帧读取中断，连接已断开）", plugin)
		}
		// 帧边界上超时：字节流仍对齐，保留连接与连接锁，由下一次调用重同步迟到帧。
		return errf(pluginapi.E_UPSTREAM, "插件 %s 调用超时", plugin)
	}
	b.discardConn(conn)
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
