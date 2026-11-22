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
// 限速（docs/SECURITY §3.5）：先 Allow 后校验口令——锁定期内连正确口令也拒，
// 避免"用正确口令探测是否已解锁"；拒绝回 429 E_RATELIMIT + Retry-After（秒）。
// 计数口径为失败次数，成功登录清零。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.loginLimiter != nil {
		if ok, retryAfter := s.loginLimiter.Allow(loginRateKey); !ok {
			// Retry-After 取整到秒并向上取整：不足 1s 也给 1，避免 0 被读成"立即重试"。
			seconds := int64((retryAfter + time.Second - 1) / time.Second)
			if seconds < 1 {
				seconds = 1
			}
			w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
			// 只记 key 与剩余秒数，绝不记口令；审计事件（auth.login/ratelimit.hit）
			// 尚未实现，此 WARN 是当前唯一取证信号（docs/SECURITY §3.5）。
			slog.Warn("登录限速命中", "key", loginRateKey, "retry_after_s", seconds)
			writeError(w, http.StatusTooManyRequests, pluginapi.E_RATELIMIT,
				"登录失败次数过多，请稍后重试", "")
			return
		}
	}
	var req loginRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体非法", "")
		return
	}
	ok, err := s.auth.Verify(req.Password)
	if err != nil || !ok {
		if s.loginLimiter != nil {
			s.loginLimiter.RecordFailure(loginRateKey)
		}
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "口令错误", "")
		return
	}
	token, session, err := s.auth.Issue()
	if err != nil {
		writeFailure(w, err)
		return
	}
	if s.loginLimiter != nil {
		s.loginLimiter.RecordSuccess(loginRateKey)
	}
	s.auth.SetCookie(w, token)
	// 双提交要求前端能读到与 X-Kore-CSRF 头同名比对的值，故 kore_csrf
	// 非 HttpOnly（裁决40 的 HttpOnly 指主壳内部持有；此处以 withCSRF 的
	// cookie==header 实际校验口径为准）。其余安全属性与会话 cookie 对齐。
	if err := s.setCSRFCookie(w); err != nil {
		writeFailure(w, err)
		return
	}
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
	http.SetCookie(w, &http.Cookie{
		Name: csrfCookieName, Value: token, Path: "/",
		HttpOnly: false, Secure: secure, SameSite: http.SameSiteStrictMode,
		MaxAge: maxAge,
	})
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
	s.auth.ClearCookie(w)
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
