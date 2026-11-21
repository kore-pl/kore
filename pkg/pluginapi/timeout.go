package pluginapi

// 超时口径常量（见 PLUGIN-PROTOCOL §7.2 / §10）。
const (
	// DefaultTimeoutMS 是业务调用未显式指定 timeout_ms 时的默认超时（毫秒）。
	DefaultTimeoutMS = 15000
	// MinTimeoutMS 是业务调用允许的最小超时（毫秒）。
	MinTimeoutMS = 1000
	// MaxTimeoutMS 是业务调用允许的最大超时（毫秒）。
	MaxTimeoutMS = 120000
)

// Timeout 把 envelope 里的 timeout_ms 规范化为实际生效值。
//
// 语义按协议文档选定：timeout_ms <= 0 视为「未设置」（JSON 省略与显式 0 无法区分），
// 取默认 15000，不报错；0 < ms < 1000 提升到下限 1000；ms > 120000 截断到上限 120000，
// 需要 WARN 的由调用方在截断处打印（本包不写日志）。
func Timeout(ms int) int {
	switch {
	case ms <= 0:
		return DefaultTimeoutMS
	case ms < MinTimeoutMS:
		return MinTimeoutMS
	case ms > MaxTimeoutMS:
		return MaxTimeoutMS
	default:
		return ms
	}
}
