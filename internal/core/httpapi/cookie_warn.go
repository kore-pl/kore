package httpapi

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
)

// withCookieTransportWarning 对"经明文 HTTP 暴露在非回环地址"的请求打一次 WARN。
//
// 背景（P1）：kore 默认只监听 UDS，server.addr 也只接受 127.0.0.1，且
// server.tls 被配置层拒绝——面板对外只能由同机反向代理暴露。反代终结 TLS 时
// 会话 cookie 会按 auth.cookie_secure=auto 加上 Secure（读 X-Forwarded-Proto）；
// 但反代**没终结 TLS**（用户直接 http://域名 访问）时，auto 必须不加 Secure，
// 否则浏览器会丢弃 cookie、用户直接登不上。这个场景不能静默：cookie 里的
// 7 天根权限令牌会在"浏览器 ↔ 反代"这一段明文中被同网段嗅探。
//
// 判据刻意保守，避免测试与纯本机访问刷日志：
//   - Host 必须是**非回环**（localhost / 127.0.0.1 / ::1 之外）；
//   - 已解析出不带 Secure（即 TLS 与 X-Forwarded-Proto: https 都没命中）；
//   - 且确实是"对外暴露"形态：配置了 TCP 监听（opts.Addr 非空）或请求带了
//     反代转发头。UDS-only 且无反代头的纯本机请求不告警。
//
// 只告警、不改变请求处理：把 cookie 强制加上 Secure 会让纯 HTTP 用户登不上，
// 那是另一种可用性事故。修复责任在入口（反代开 TLS / 透传 X-Forwarded-Proto）。
func (s *Server) withCookieTransportWarning(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.auth != nil && s.needsCookieSecureWarning(r) {
			host := hostOnly(r.Host)
			s.cookieWarnOnce.Do(func() {
				slog.Warn("会话 cookie 无 Secure 保护：面板正以明文 HTTP 暴露在非回环地址",
					"host", host, "remote", r.RemoteAddr,
					"hint", "在反向代理终结 TLS 并透传 X-Forwarded-Proto: https（cookie_secure=auto 会据此加 Secure）；否则同网段可嗅探 7 天会话令牌")
			})
		}
		next.ServeHTTP(w, r)
	})
}

// needsCookieSecureWarning 汇总上面的三条判据。
func (s *Server) needsCookieSecureWarning(r *http.Request) bool {
	host := hostOnly(r.Host)
	if host == "" || isLoopbackHost(host) {
		return false
	}
	if s.auth.CookieSecure(r) {
		return false
	}
	return s.opts.Addr != "" || hasForwardedHeader(r)
}

// hasForwardedHeader 判断请求是否经过反代（任一常见转发头存在即视为经过）。
func hasForwardedHeader(r *http.Request) bool {
	for _, key := range []string{"X-Forwarded-Proto", "X-Forwarded-For", "X-Real-Ip"} {
		if r.Header.Get(key) != "" {
			return true
		}
	}
	return false
}

// hostOnly 去掉 Host 里的端口；解析失败时按原值处理（可能是裸主机名）。
func hostOnly(hostport string) string {
	if hostport == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		return host
	}
	return strings.Trim(hostport, "[]")
}

// isLoopbackHost 判定 Host 是否本机访问（浏览器安全上下文）。
func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
