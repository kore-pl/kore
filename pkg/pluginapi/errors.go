package pluginapi

import "encoding/json"

// 协议错误码（字符串常量，见 PLUGIN-PROTOCOL §9）；错误体统一为 {code,message,detail}。
const (
	// E_INVALID 参数/帧格式非法，含超限帧、非法 JSON：修参数后重试，不可重试同一请求。
	E_INVALID = "E_INVALID"
	// E_UNAUTHORIZED 未登录、session 失效、capability 不足、签名/来源不符：申请授权，不重试。
	E_UNAUTHORIZED = "E_UNAUTHORIZED"
	// E_NOTFOUND 插件/方法/资源不存在：校正 id/method，不重试。
	E_NOTFOUND = "E_NOTFOUND"
	// E_CONFLICT 状态冲突（升级中/未 ready/重复操作、包 sha256 不符）：重读状态后再决定。
	E_CONFLICT = "E_CONFLICT"
	// E_UPSTREAM 插件进程无响应/崩溃/连接中断/握手失败：仅幂等方法可重试。
	E_UPSTREAM = "E_UPSTREAM"
	// E_INTERNAL 内核自身错误（写库失败、序列化失败）：不重试，查内核日志。
	E_INTERNAL = "E_INTERNAL"
	// E_UNSUPPORTED 协议主版本不符、能力未实现、平台不支持：升级内核或插件，不重试。
	E_UNSUPPORTED = "E_UNSUPPORTED"
	// E_RATELIMIT 触发限流（登录、oneshot 并发队列满）：按 Retry-After 退避后重试。
	E_RATELIMIT = "E_RATELIMIT"
)

// Error 是协议统一错误体 {code,message,detail}，同时实现 error 接口，
// 便于 handler 直接返回 *Error 并由调用方按 Code 映射错误码。
type Error struct {
	// Code 是错误码，取 E_* 常量之一。
	Code string `json:"code"`
	// Message 是人类可读的错误说明，不得包含凭据、token 等敏感信息。
	Message string `json:"message"`
	// Detail 是结构化细节 JSON 对象，允许省略（等价于空对象）。
	Detail json.RawMessage `json:"detail,omitempty"`
}

// Error 实现 error 接口，返回 "code: message" 形式；nil 接收者返回 "<nil>" 以免误用崩溃。
func (e *Error) Error() string {
	if e == nil {
		return "<nil>"
	}
	return e.Code + ": " + e.Message
}
