package pluginapi

import (
	"encoding/json"
	"errors"
	"fmt"
)

// 信封解码哨兵错误，供调用方用 errors.Is 区分失败类型。
var (
	// ErrInvalidJSON 表示载荷不是合法 JSON 对象、缺少 type 字段或字段类型不符。
	ErrInvalidJSON = errors.New("pluginapi: 帧载荷不是合法 JSON 信封")
	// ErrUnknownType 表示 type 取值不在协议枚举内；协议要求回 E_UNSUPPORTED 并断开。
	ErrUnknownType = errors.New("pluginapi: 未知帧类型")
)

// 帧类型取值，写在 JSON 载荷的 type 字段里（不是帧头，见 ADR-0007）。
const (
	// TypeRequest 方法调用请求。
	TypeRequest = "request"
	// TypeResponse 方法调用响应。
	TypeResponse = "response"
	// TypeEvent 插件→内核的单向事件，走 kore.event 通道。
	TypeEvent = "event"
	// TypePing 传输层探活。
	TypePing = "ping"
	// TypePong 对 ping 的应答，原样回填 ts。
	TypePong = "pong"
)

// Request 是方法调用请求帧（type 固定 "request"）。
type Request struct {
	// Type 固定为 TypeRequest。
	Type string `json:"type"`
	// ID 是连接内请求标识：32 位小写 hex（16 字节随机），内核生成、插件原样回填；
	// 同一连接内并发按 id 匹配且不得复用。
	ID string `json:"id"`
	// ReqID 是跨进程追踪标识（HTTP 侧生成并透传，如 r-01JC8Q3A）；请求帧必带，
	// 响应帧必须原样回显同一值。它不参与连接内匹配。
	ReqID string `json:"req_id,omitempty"`
	// Method 是 <plugin>.<verb> 形式的方法名（kore.* 是协议保留方法）。
	Method string `json:"method"`
	// Params 是业务参数 JSON 对象，缺省 {}；字段向后兼容只能追加可选字段。
	Params json.RawMessage `json:"params,omitempty"`
	// TimeoutMS 是调用方期望的超时（毫秒），缺省 15000；规范化见 Timeout。
	TimeoutMS int `json:"timeout_ms,omitempty"`
}

// Response 是方法调用响应帧（type 固定 "response"）。
// result 与 error 二者只出现一个，本结构不强制互斥（互斥由调用方按协议保证）。
type Response struct {
	// Type 固定为 TypeResponse。
	Type string `json:"type"`
	// ID 回显对应请求帧的 id，用于连接内匹配。
	ID string `json:"id"`
	// ReqID 必须原样回显对应请求帧的 req_id（跨进程追踪）。
	ReqID string `json:"req_id,omitempty"`
	// Result 是成功结果的 JSON 值。
	Result json.RawMessage `json:"result,omitempty"`
	// Error 是失败错误体，与 Result 互斥。
	Error *Error `json:"error,omitempty"`
}

// Event 是插件→内核的单向事件帧（type 固定 "event"，事件通道 kore.event）。
type Event struct {
	// Type 固定为 TypeEvent。
	Type string `json:"type"`
	// Event 是事件名，如 plugin.log / plugin.health / plugin.state / system.event。
	Event string `json:"event"`
	// Seq 是每连接单调递增序号，重连后从 0 重置；内核只按 TS 落盘，不保证全局有序。
	Seq uint64 `json:"seq,omitempty"`
	// TS 是事件发生时间（RFC 3339 带时区字符串），内核按它落盘。
	TS string `json:"ts,omitempty"`
	// Data 是事件负载 JSON 对象，字段由事件类型定义。
	Data json.RawMessage `json:"data,omitempty"`
}

// Ping 是传输层探活帧（type 固定 "ping"）；kore.ping 是应用层方法，两者不可互相替代。
type Ping struct {
	// Type 固定为 TypePing。
	Type string `json:"type"`
	// TS 是发送时刻的 Unix 纳秒时间戳。
	TS int64 `json:"ts"`
}

// Pong 是 ping 的应答帧（type 固定 "pong"），必须原样回填 ping 的 ts。
type Pong struct {
	// Type 固定为 TypePong。
	Type string `json:"type"`
	// TS 原样回填对应 ping 的时间戳（Unix 纳秒）。
	TS int64 `json:"ts"`
}

// DecodeFrame 解析一帧载荷并按 type 返回具体信封类型
// （*Request / *Response / *Event / *Ping / *Pong）。
//
// 非 JSON、非对象、缺少 type 或字段类型不符返回 ErrInvalidJSON；未知 type 返回
// ErrUnknownType（协议要求回 E_UNSUPPORTED 并断开，不做猜测兼容）；空载荷返回
// ErrEmptyPayload。未识别的可选字段按协议演进规则忽略。
func DecodeFrame(payload []byte) (any, error) {
	if len(payload) == 0 {
		return nil, ErrEmptyPayload
	}
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidJSON, err)
	}
	switch env.Type {
	case TypeRequest:
		return decodeAs[Request](payload)
	case TypeResponse:
		return decodeAs[Response](payload)
	case TypeEvent:
		return decodeAs[Event](payload)
	case TypePing:
		return decodeAs[Ping](payload)
	case TypePong:
		return decodeAs[Pong](payload)
	case "":
		return nil, fmt.Errorf("%w: 缺少 type 字段", ErrInvalidJSON)
	default:
		return nil, fmt.Errorf("%w: 未知帧类型 %q", ErrUnknownType, env.Type)
	}
}

// decodeAs 把载荷解码为具体信封类型；字段类型不符按 ErrInvalidJSON 返回。
func decodeAs[T any](payload []byte) (any, error) {
	var v T
	if err := json.Unmarshal(payload, &v); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidJSON, err)
	}
	return &v, nil
}
