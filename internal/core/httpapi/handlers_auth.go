package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// loginRateKey 是登录限速的 key。单管理员体系下只有一个账号，用固定 key
// 构成全局桶（与 docs/SECURITY §3.5「UDS 下退化为全局桶」口径一致）。
const loginRateKey = "admin"

// loginRequest / sessionBody 是登录与会话查询的显式请求/响应结构。
type loginRequest struct {
	// Password 是管理员明文口令（仅内存，不写日志）。
	Password string `json:"password"`
	// OTP 是可选的两步验证码（6 位动态码或恢复码）；2FA 未开启时忽略。
	OTP string `json:"otp"`
}

// sessionBody 是 GET /api/v1/auth/session 的响应体。
type sessionBody struct {
	// Authenticated 表示当前会话是否有效。
	Authenticated bool `json:"authenticated"`
	// ExpiresAt 是会话过期时刻（RFC3339；未登录为空）。
	ExpiresAt string `json:"expires_at"`
}

// handleLogin 校验口令，成功签发会话并下发 cookie。
//
// 限速（docs/SECURITY §3.5，P1 DoS 修复）：**先校验口令、再对错误口令施加递增
// 延迟**，不存在"锁定期"——因此任意本地进程无法用错口令把管理员永久锁死，正确
// 口令在任何时候都短路放行。错误口令连续失败达到阈值后按 1s→2s→4s→…→30s
// 递增延迟，把串行爆破压到 1/30s；并行爆破另由 BeginVerify 单飞限制猜测吞吐。
// 计数口径为连续失败次数，成功登录清零、静默超过 security.login_rate_limit.lock
// 后清零。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		// 请求体非法 = 未形成有效凭据尝试，reason 统一记 no_session（不记录请求体）。
		s.recordLoginFailed(r, loginRateKey, "no_session")
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体非法", "")
		return
	}
	// 登录来源 IP 白名单（用户主动开启才生效；fail-closed：读配置失败按拒绝处理）。
	// 先于口令校验：不在允许列表的请求连口令都不试，不泄露"口令是否正确"。
	if s.auth != nil && s.auth.Security() != nil {
		allowed, err := s.auth.Security().IPAllowed(auth.ClientIP(r))
		if err != nil {
			slog.Warn("读取登录白名单失败，按拒绝处理", "err", err)
			writeLoginDenied(w)
			return
		}
		if !allowed {
			s.recordLoginFailed(r, loginRateKey, "ip_denied")
			writeLoginDenied(w)
			return
		}
	}
	// 口令校验：单飞串行化 PBKDF2，避免修掉硬锁后并行连接把猜测吞吐放大 N 倍。
	var (
		verified  bool
		verifyErr error
	)
	if s.loginLimiter != nil {
		release, acquired := s.loginLimiter.BeginVerify(r.Context())
		if !acquired {
			// ctx 已取消（客户端断开）：仍回 429 让调用方按 Retry-After 退避。
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, pluginapi.E_RATELIMIT, "登录校验繁忙，请稍后重试", "")
			return
		}
		verified, verifyErr = s.auth.Verify(req.Password)
		release()
	} else {
		verified, verifyErr = s.auth.Verify(req.Password)
	}
	if verifyErr != nil || !verified {
		var penalty, next time.Duration
		if s.loginLimiter != nil {
			penalty = s.loginLimiter.RecordFailure(loginRateKey)
			if penalty > 0 {
				next = s.loginLimiter.NextPenalty(loginRateKey)
			}
		}
		reason := "wrong_password"
		if penalty > 0 {
			reason = "rate_limited"
		}
		// 先落审计再等待：等待期间进程若被杀，暴力破解仍可追溯。
		s.recordLoginFailed(r, loginRateKey, reason)
		if penalty > 0 {
			// Retry-After 给"下一次错误尝试将被延迟的秒数"（向上取整、最小 1）。
			seconds := int64((next + time.Second - 1) / time.Second)
			if seconds < 1 {
				seconds = 1
			}
			w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
			slog.Warn("登录错误口令惩罚延迟", "key", loginRateKey, "delay_ms", penalty.Milliseconds(),
				"retry_after_s", seconds)
			if !s.loginLimiter.Wait(r.Context(), penalty) {
				return
			}
			writeError(w, http.StatusTooManyRequests, pluginapi.E_RATELIMIT,
				"登录失败次数过多，请稍后重试", "")
			return
		}
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "口令错误", "")
		return
	}
	// 两步验证：口令正确后仍须 OTP 才能签发会话；未开启 2FA 时原流程完全不变。
	if s.auth.Security() != nil {
		totpEnabled, err := s.auth.Security().TOTPEnabled()
		if err != nil {
			slog.Warn("读取两步验证状态失败，按拒绝处理", "err", err)
			writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL,
				"安全设置读取失败，请稍后重试", "")
			return
		}
		if totpEnabled {
			if strings.TrimSpace(req.OTP) == "" {
				write2FARequired(w)
				return
			}
			valid, err := s.auth.Security().VerifyTOTP(req.OTP)
			if err != nil {
				slog.Warn("校验两步验证码失败，按拒绝处理", "err", err)
				write2FAInvalid(w)
				return
			}
			if !valid {
				s.recordLoginFailed(r, loginRateKey, "wrong_otp")
				write2FAInvalid(w)
				return
			}
		}
	}
	token, session, err := s.auth.IssueWithMeta(auth.SessionMeta{
		IP: auth.ClientIP(r), UserAgent: r.UserAgent(),
	})
	if err != nil {
		s.recordLoginFailed(r, loginRateKey, "no_session")
		writeFailure(w, err)
		return
	}
	if s.loginLimiter != nil {
		s.loginLimiter.RecordSuccess(loginRateKey)
	}
	s.auth.SetCookie(w, r, token)
	// 双提交要求前端能读到与 X-Kore-CSRF 头同名比对的值，故 kore_csrf
	// 非 HttpOnly（裁决40 的 HttpOnly 指主壳内部持有；此处以 withCSRF 的
	// cookie==header 实际校验口径为准）。其余安全属性与会话 cookie 对齐。
	if err := s.setCSRFCookie(w); err != nil {
		writeFailure(w, err)
		return
	}
	// 会话与 CSRF cookie 都已下发，按成功落审计（口令与完整 token 均不落库）。
	s.recordLoginSuccess(r, loginRateKey, token)
	writeJSON(w, http.StatusOK, sessionBody{Authenticated: true, ExpiresAt: formatExpiry(session.ExpiresAt)})
}

// ApplyLoginPolicy 热更登录限速口径（SIGHUP 白名单 security.login_rate_limit.*）。
// 未装配 limiter 时静默忽略：骨架/测试不因缺限速而 panic。
func (s *Server) ApplyLoginPolicy(maxFailures int, window, lockout time.Duration) {
	if s.loginLimiter == nil {
		return
	}
	s.loginLimiter.SetPolicy(maxFailures, window, lockout)
}

// setCSRFCookie 下发 kore_csrf：非 HttpOnly（双提交要求前端可读），
// 其余属性（Path=/、SameSite=Strict、Secure、MaxAge）与刚写出的会话 cookie 对齐。
// Secure 与 MaxAge 从响应里已有的会话 Set-Cookie 解析，避免在本包重复持有
// auth.Manager 的 secure/ttl 配置（保持单一事实源）。
func (s *Server) setCSRFCookie(w http.ResponseWriter) error {
	token, err := newCSRFToken()
	if err != nil {
		return err
	}
	secure, maxAge := sessionCookieAttrs(w)
	writeCSRFCookie(w, token, secure, maxAge)
	return nil
}

// sessionCookieAttrs 从响应中已写出的 kore_session Set-Cookie 解析 Secure 与
// Max-Age；解析不到时退回安全侧（secure=false, maxAge=0 = 会话 cookie）。
func sessionCookieAttrs(w http.ResponseWriter) (secure bool, maxAge int) {
	for _, raw := range w.Header().Values("Set-Cookie") {
		if !strings.HasPrefix(raw, auth.CookieName+"=") {
			continue
		}
		parts := strings.Split(raw, ";")
		for _, part := range parts[1:] {
			part = strings.TrimSpace(part)
			switch {
			case part == "Secure":
				secure = true
			case strings.HasPrefix(part, "Max-Age="):
				maxAge, _ = strconv.Atoi(strings.TrimPrefix(part, "Max-Age="))
			}
		}
	}
	return secure, maxAge
}

// handleLogout 吊销会话并清 cookie；无有效 cookie 也幂等返回 200。
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(auth.CookieName); err == nil {
		if revokeErr := s.auth.Revoke(cookie.Value); revokeErr != nil {
			writeFailure(w, revokeErr)
			return
		}
	}
	s.auth.ClearCookie(w, r)
	writeJSON(w, http.StatusOK, sessionBody{Authenticated: false})
}

// handleSession 返回当前会话状态； middleware 已保证到达此处的请求有有效会话。
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	session, err := s.sessionFrom(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "会话无效", "")
		return
	}
	writeJSON(w, http.StatusOK, sessionBody{Authenticated: true, ExpiresAt: formatExpiry(session.ExpiresAt)})
}

// formatExpiry 把过期时刻格式化为 RFC3339（UTC）；零值返回空串。
func formatExpiry(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
