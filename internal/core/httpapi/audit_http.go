package httpapi

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// HTTP 侧审计动作名（docs/DATA-MODEL.md §9 审计动作表）。
const (
	// auditActionLoginSuccess 登录成功（result=ok）。
	auditActionLoginSuccess = "login.success"
	// auditActionLoginFailed 登录失败（result=denied；限速命中与口令错误都落这里）。
	auditActionLoginFailed = "login.failed"
	// auditActionInvokePrefix 方法调用审计前缀；完整动作是 invoke.<plugin>.<method>。
	auditActionInvokePrefix = "invoke."
	// auditActionInvokeBurst 同一方法 1 秒内超过阈值的合并记录。
	auditActionInvokeBurst = "invoke.burst"
)

// 审计结果取值（与 store.AuditRecord 的 ok/denied/error 同口径；本包不 import store）。
const (
	auditResultOK     = "ok"
	auditResultDenied = "denied"
	auditResultError  = "error"
)

// 登录审计脱敏与 invoke 突发合并口径。
const (
	// sessionPrefixLen 是 session_id_prefix 保留的字符数（token 为 base64url，截断后不可还原）。
	sessionPrefixLen = 8
	// userAgentMaxLen 是 user_agent 的字符上限（按 rune 计，超出截断）。
	userAgentMaxLen = 100
	// invokeBurstThreshold 是同一方法在窗口内允许逐条审计的上限；超过即合并。
	invokeBurstThreshold = 10
	// invokeBurstWindow 是突发合并的滑动窗口。
	invokeBurstWindow = time.Second
	// invokeBurstSweepEvery 是突发状态惰性清理的调用间隔（零 goroutine/ticker，G-19）。
	invokeBurstSweepEvery = 256
)

// AuditEvent 是一条 HTTP 侧审计事件（显式字段，detail 仅标量字符串）。
//
// Action 是最终动作名（login.success / login.failed / invoke.<plugin>.<method> /
// invoke.burst）；Plugin/Target 为空表示与插件无关（登录）。
type AuditEvent struct {
	// Subject 操作者：登录固定为 admin（单管理员）；invoke 为会话 subject。
	Subject string
	// Action 动作名。
	Action string
	// Plugin 涉及插件 id；登录事件为空。
	Plugin string
	// Target 动作目标：invoke 为 <plugin>/<method>。
	Target string
	// Result 结果：ok / denied / error。
	Result string
	// Detail 附加信息（受控 map[string]string，DATA-MODEL §9）。
	Detail map[string]string
}

// AuditRecorder 是 HTTP 侧审计落库出口；由 cmd/kored 注入 store.PutAudit 适配器。
type AuditRecorder interface {
	// Record 记录一条审计事件；实现方负责错误处理（不向请求路径返回错误）。
	Record(AuditEvent)
}

// invokeBurstState 是单方法的突发计数状态（窗口起点 + 次数 + 是否已合并）。
type invokeBurstState struct {
	windowStart time.Time
	count       int
	emitted     bool
}

// ApplyAuditInvokeAll 热更 audit.invoke_all（SIGHUP 白名单）；只影响之后的 invoke。
func (s *Server) ApplyAuditInvokeAll(enabled bool) {
	s.auditInvokeAll.Store(enabled)
}

// recordAudit 走注入的审计出口；未装配时静默跳过（测试/骨架不产生噪音）。
func (s *Server) recordAudit(ev AuditEvent) {
	if s.auditRecorder == nil {
		return
	}
	s.auditRecorder.Record(ev)
}

// recordLoginSuccess 记录一次登录成功：action=login.success、result=ok，
// detail={ip（脱敏）, user_agent（截断）, session_id_prefix}；绝不写口令。
func (s *Server) recordLoginSuccess(r *http.Request, subject, token string) {
	// 登录成功清零连续失败计数（告警「连续 ≥3 次」的口径配套）。
	s.resetLoginStreak()
	s.recordAudit(AuditEvent{
		Subject: subject,
		Action:  auditActionLoginSuccess,
		Result:  auditResultOK,
		Detail: map[string]string{
			"ip":                maskedClientIP(r),
			"user_agent":        truncateUserAgent(r.UserAgent()),
			"session_id_prefix": sessionIDPrefix(token),
		},
	})
}

// recordLoginFailed 记录一次登录失败：action=login.failed、result=denied，
// detail={ip, user_agent, reason}；reason ∈ wrong_password / rate_limited / no_session。
// 请求体（含明文口令）从头到尾不进入本函数。
func (s *Server) recordLoginFailed(r *http.Request, subject, reason string) {
	s.recordAudit(AuditEvent{
		Subject: subject,
		Action:  auditActionLoginFailed,
		Result:  auditResultDenied,
		Detail: map[string]string{
			"ip":         maskedClientIP(r),
			"user_agent": truncateUserAgent(r.UserAgent()),
			"reason":     reason,
		},
	})
	// 告警埋点：连续 ≥3 次合并一条（alerts.go noteLoginFailure；成功登录清零）。
	s.noteLoginFailure()
}

// recordInvokeAudit 记录一次方法调用审计（只写操作 + 可选全量 + 突发合并）。
//
// 审计口径与授权口径一致：auth.needAdmin 为真（该方法按**最终生效能力**需要 admin，
// 即写/管理类）才审计；最终生效能力是只读（方法级 method_capabilities 覆盖或插件级
// 只声明 *:read）时不审计。audit.invoke_all=true 时全量审计（调试用）。
func (s *Server) recordInvokeAudit(plugin, method string, auth invokeAuth, cost time.Duration, invokeErr error) {
	if s.auditRecorder == nil {
		return
	}
	if !s.auditInvokeAll.Load() && !auth.needAdmin {
		return
	}
	subject := auth.subject
	if subject == "" {
		subject = "anonymous"
	}
	result := auditResultOK
	errorCode := ""
	if invokeErr != nil {
		result = auditResultError
		errorCode = invokeErrorCode(invokeErr)
	}
	target := plugin + "/" + method
	burst, count := s.bumpInvokeBurst(invokeBurstKey(plugin, method), s.clock())
	if burst {
		s.recordAudit(AuditEvent{
			Subject: subject, Action: auditActionInvokeBurst, Plugin: plugin, Target: target,
			Result: result,
			Detail: map[string]string{
				"method":    method,
				"count":     strconv.Itoa(count),
				"window_ms": strconv.FormatInt(invokeBurstWindow.Milliseconds(), 10),
			},
		})
		return
	}
	if count == 0 {
		// 已进入突发窗口且合并记录已写出：同窗口后续调用不再逐条落库。
		return
	}
	detail := map[string]string{"duration_ms": strconv.FormatInt(cost.Milliseconds(), 10)}
	if errorCode != "" {
		detail["error_code"] = errorCode
	}
	s.recordAudit(AuditEvent{
		Subject: subject, Action: auditActionInvokePrefix + plugin + "." + method,
		Plugin: plugin, Target: target, Result: result, Detail: detail,
	})
}

// bumpInvokeBurst 推进单方法窗口计数：<=阈值逐条审计；第阈值+1 次写一条
// invoke.burst 并抑制本窗口后续记录；窗口滚动后重新计数。
func (s *Server) bumpInvokeBurst(key string, now time.Time) (burst bool, count int) {
	s.burstMu.Lock()
	defer s.burstMu.Unlock()
	if s.bursts == nil {
		s.bursts = make(map[string]*invokeBurstState)
	}
	if s.burstCalls++; s.burstCalls%invokeBurstSweepEvery == 0 {
		s.sweepInvokeBurstLocked(now)
	}
	state := s.bursts[key]
	if state == nil || now.Before(state.windowStart) || now.Sub(state.windowStart) >= invokeBurstWindow {
		state = &invokeBurstState{windowStart: now}
		s.bursts[key] = state
	}
	state.count++
	if state.count <= invokeBurstThreshold {
		return false, state.count
	}
	if state.emitted {
		return false, 0
	}
	state.emitted = true
	return true, state.count
}

// sweepInvokeBurstLocked 惰性清理过期窗口（调用方必须持锁；零后台 goroutine）。
func (s *Server) sweepInvokeBurstLocked(now time.Time) {
	for key, state := range s.bursts {
		if now.Before(state.windowStart) || now.Sub(state.windowStart) >= invokeBurstWindow {
			delete(s.bursts, key)
		}
	}
}

// invokeBurstKey 用一个不可能出现在插件 id / 方法名中的分隔符拼突发键。
func invokeBurstKey(plugin, method string) string {
	return plugin + "\x00" + method
}

// invokeErrorCode 提取协议错误码；非协议错误按 E_INTERNAL 记（与 writeFailure 同口径）。
func invokeErrorCode(err error) string {
	var protocolErr *pluginapi.Error
	if errors.As(err, &protocolErr) && protocolErr.Code != "" {
		return protocolErr.Code
	}
	return pluginapi.E_INTERNAL
}

// maskedClientIP 返回脱敏后的来源 IP：IPv4 只保留前 3 段（192.168.1.x），
// IPv6 保留前 3 个分组；端口一律丢弃。
func maskedClientIP(r *http.Request) string {
	return maskIP(clientHost(r.RemoteAddr))
}

// clientHost 从 RemoteAddr 取主机部分；无端口时原样返回。
func clientHost(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}

// maskIP 对 IPv4 保留前 3 段、最后一段替换为 x；IPv6 保留前 3 个分组；
// 无法解析的输入原样返回（通常是 UDS 的 "@"，不含可识别地址）。
func maskIP(raw string) string {
	ip := net.ParseIP(raw)
	if ip == nil {
		return raw
	}
	if v4 := ip.To4(); v4 != nil {
		return fmt.Sprintf("%d.%d.%d.x", v4[0], v4[1], v4[2])
	}
	parts := strings.Split(ip.String(), ":")
	if len(parts) > 3 {
		parts = parts[:3]
	}
	return strings.Join(parts, ":") + ":x"
}

// truncateUserAgent 按 rune 截断 User-Agent 到 100 字符，避免超长头撑大审计 detail。
func truncateUserAgent(ua string) string {
	runes := []rune(ua)
	if len(runes) > userAgentMaxLen {
		runes = runes[:userAgentMaxLen]
	}
	return string(runes)
}

// sessionIDPrefix 保留会话 token 前 8 个字符；截断值无法反推完整 token。
func sessionIDPrefix(token string) string {
	if len(token) <= sessionPrefixLen {
		return token
	}
	return token[:sessionPrefixLen]
}

// clock 返回审计突发窗口使用的时间源；测试可替换 s.now 做确定性验证。
func (s *Server) clock() time.Time {
	if s.now == nil {
		return time.Now()
	}
	return s.now()
}
