package httpapi

import (
	"net/http"
)

// 本机免密通道（ADR-0041）的 CSRF 引导。
//
// 断链背景：withAuth 对 UDS / loopback 免密放行后不再经过登录，而 kore_csrf
// 原先只在登录成功时下发（handlers_auth.setCSRFCookie）。于是本机浏览器
// document.cookie 里没有 kore_csrf，面板所有数据视图的 POST /api/v1/invoke/*
// 都被 withCSRF 以 401 拦下——免密只解决了"有没有会话"，没解决"写请求的
// 双提交令牌从哪来"。
//
// 口径（不削弱 CSRF，跨站伪造 POST 仍然被拒）：
//   - 只对**幂等方法**（GET/HEAD/OPTIONS）+ **本机通道**（UDS / loopback TCP）
//   - **尚未携带 kore_csrf** 的请求下发。跨站页面既读不到该 cookie 的值，
//     也不能给简单表单/跨源 fetch 加上 X-Kore-CSRF 头，拿不到可用的双提交对。
//   - 令牌进程内稳定（首次生成后复用）：首屏并发 GET 各自 Set-Cookie 会互相
//     覆盖，后发的 POST 头与 cookie 可能不同步；稳定令牌让这个竞态无害。
//   - 远程（非本机）请求一律不下发：远程仍必须登录换会话，令牌只随登录下发。
//   - cookie 属性与登录下发的一致：非 HttpOnly（双提交要求前端可读）、Path=/、
//     SameSite=Strict；Secure 跟随本请求是否 TLS（本机 HTTP 场景为 false）。
func (s *Server) withLocalCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isSafeMethod(r.Method) && !hasCSRFCookie(r) {
			if local, blocked := s.resolveLocal(r); !blocked && local.isLocal() {
				if token, err := s.localCSRFToken(); err == nil {
					writeCSRFCookie(w, token, r.TLS != nil, 0)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// hasCSRFCookie 判断请求是否已携带非空的 kore_csrf。
func hasCSRFCookie(r *http.Request) bool {
	cookie, err := r.Cookie(csrfCookieName)
	return err == nil && cookie.Value != ""
}

// localCSRFToken 返回本机通道使用的进程级 CSRF token（首次调用时生成）。
// 加锁避免首屏并发 GET 生成多个 token 互相覆盖 cookie。
func (s *Server) localCSRFToken() (string, error) {
	s.localCSRFMu.Lock()
	defer s.localCSRFMu.Unlock()
	if s.localCSRFTokenValue != "" {
		return s.localCSRFTokenValue, nil
	}
	token, err := newCSRFToken()
	if err != nil {
		return "", err
	}
	s.localCSRFTokenValue = token
	return token, nil
}

// writeCSRFCookie 是 kore_csrf cookie 的唯一写入点：登录下发与本机引导共用，
// 避免两处属性漂移（非 HttpOnly 是双提交的硬要求）。
func writeCSRFCookie(w http.ResponseWriter, token string, secure bool, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: csrfCookieName, Value: token, Path: "/",
		HttpOnly: false, Secure: secure, SameSite: http.SameSiteStrictMode,
		MaxAge: maxAge,
	})
}
