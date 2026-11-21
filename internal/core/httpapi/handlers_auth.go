package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

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
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体非法", "")
		return
	}
	ok, err := s.auth.Verify(req.Password)
	if err != nil || !ok {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "口令错误", "")
		return
	}
	token, session, err := s.auth.Issue()
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.auth.SetCookie(w, token)
	writeJSON(w, http.StatusOK, sessionBody{Authenticated: true, ExpiresAt: formatExpiry(session.ExpiresAt)})
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
