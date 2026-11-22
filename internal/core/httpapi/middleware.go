package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// withAuth 对 /api/v1/* 强制会话校验；/-/healthz 与登录端点放行。
// 无有效 cookie → 401 E_UNAUTHORIZED（不泄露是"无 cookie"还是"已过期"）。
//
// root-action 端点额外接受**插件 bearer 身份**（ADR-0018 提权通道）：插件用
// KORE_PLUGIN_TOKEN 调内核代理自己声明的动作；带 Authorization 时不做会话回退，
// 避免"无效 bearer + 有效 cookie"绕过 CSRF 语义。
func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isPublicPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if len(r.URL.Path) >= 7 && r.URL.Path[:7] == "/api/v1" {
			if isRootActionPath(r.URL.Path) && r.Header.Get(authorizationHeader) != "" {
				actor, ok := s.pluginIdentity(r)
				if !ok {
					writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "插件凭证无效", "")
					return
				}
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), pluginActorKey{}, actor)))
				return
			}
			if _, err := s.sessionFrom(r); err != nil {
				writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// authorizationHeader / bearerPrefix 是插件 bearer 身份的载体。
const (
	authorizationHeader = "Authorization"
	bearerPrefix        = "Bearer "
)

// pluginActor 是插件身份的请求上下文值。
type pluginActor struct {
	id     string
	grants []string
}

// pluginActorKey 是插件身份在 context 中的私有键。
type pluginActorKey struct{}

// pluginIdentity 解析插件 bearer token；仅对 root-action 路径生效。
func (s *Server) pluginIdentity(r *http.Request) (*pluginActor, bool) {
	if s.pluginAuth == nil || !isRootActionPath(r.URL.Path) {
		return nil, false
	}
	header := r.Header.Get(authorizationHeader)
	if !strings.HasPrefix(header, bearerPrefix) {
		return nil, false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, bearerPrefix))
	if token == "" {
		return nil, false
	}
	id, grants, ok := s.pluginAuth(token)
	if !ok || id == "" {
		return nil, false
	}
	return &pluginActor{id: id, grants: grants}, true
}

// isRootActionPath 判断是否为提权端点（POST root-action / GET confirm-token）。
func isRootActionPath(path string) bool {
	return strings.HasPrefix(path, pluginsPath+"/") && strings.Contains(path, "/root-action")
}

// isPublicPath 返回无需鉴权的路径（健康检查、登录与主壳静态壳资源）。
//
// 主壳面板壳只含静态 UI 骨架与前端代码、无任何敏感数据，放行以便浏览器未登录时
// 也能加载登录界面；静态资源统一走 /assets/ 前缀，白名单只认这一条前缀，不枚举
// 具体文件名（内核不认识前端视图名，G-01）。所有 /api/v1/* 端点仍强制会话校验，
// 鉴权逻辑不下放；插件资产（/plugin-assets/*）不在白名单内。视图模块自身的数据
// 请求走 /api/v1/*，未登录仍 401——放行只覆盖静态文件本体。
func isPublicPath(path string) bool {
	return path == "/-/healthz" || path == "/api/v1/auth/login" ||
		path == "/" || strings.HasPrefix(path, staticURLPrefix)
}

// CSRF 双提交 token 的载体：非 HttpOnly cookie + 同名请求头（SECURITY.md §4）。
const (
	csrfCookieName = "kore_csrf"
	csrfHeaderName = "X-Kore-CSRF"
	// csrfTokenBytes 是 CSRF token 的随机字节数（32 B → base64url 43 字符）。
	csrfTokenBytes = 32
)

// newCSRFToken 生成 32 B 随机 token（base64url，无 padding），供登录时下发
// kore_csrf cookie。auth 模块不持有 CSRF 逻辑（写域边界），生成与校验同在
// 本包，口径一致：登录下发的值就是后续双提交比对的值。
func newCSRFToken() (string, error) {
	buf := make([]byte, csrfTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成 CSRF token 失败: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// isCSRFExempt 返回免于 CSRF 校验的路径：探针与认证入口本身。
// login/setup 尚未持有会话，无法要求 CSRF token；logout 是幂等的会话终止，
// 与 login 对称，CSRF 强制登出只造成一次重新登录、无越权面。管理端点不在豁免内。
func isCSRFExempt(path string) bool {
	return path == "/-/healthz" || path == "/api/v1/auth/login" ||
		path == "/api/v1/auth/setup" || path == "/api/v1/auth/logout"
}

// withCSRF 对所有非幂等方法做双提交校验：header == cookie 且均非空。
//
// 只写不读（无 cookie 或 header → 401 E_UNAUTHORIZED），不泄露"缺哪一个"。
// 用常量时间比较避免时序侧信道。仅在启用鉴权时由 New 挂载：auth==nil 的
// M0 探活骨架没有会话/cookie 体系，不引入 CSRF 门禁。
//
// TODO(M4, 裁决40): 服务端应把 header/cookie 与 sessions.csrf 三方比对，
// 并把 kore_csrf 改为 HttpOnly（客户端 UI 改走独立 origin iframe + postMessage 桥）。
// 本阶段 auth.Session 无 csrf 字段且写域禁止改 auth 模块，故先做双提交两方比对。
func (s *Server) withCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isCSRFExempt(r.URL.Path) || isSafeMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		// 插件 bearer 身份不走 cookie，天然无 CSRF 面（withAuth 会校验 token）。
		if isRootActionPath(r.URL.Path) && r.Header.Get(authorizationHeader) != "" {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(csrfCookieName)
		if err != nil || cookie.Value == "" {
			writeCSRFDenied(w)
			return
		}
		header := r.Header.Get(csrfHeaderName)
		if header == "" || subtle.ConstantTimeCompare([]byte(header), []byte(cookie.Value)) != 1 {
			writeCSRFDenied(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isSafeMethod 判断是否幂等（无需 CSRF）的请求方法。
func isSafeMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// writeCSRFDenied 统一返回 401，不区分"缺 cookie / 缺 header / 不匹配"。
func writeCSRFDenied(w http.ResponseWriter) {
	writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "CSRF 校验失败", "")
}

// authorizeTargetAction 按目标操作做 capability 校验（裁决40/42，M4 落地）。
// 管理端点（enable/disable）要求 system:admin；invoke 保持"方法合法"现状。
// 无有效 session → 401；能力不足 → 401 E_UNAUTHORIZED + 审计 capability.denied。
// subject 与 granted 由注入的 CapabilityResolver 提供，默认按单管理员全权语义。
func (s *Server) authorizeTargetAction(w http.ResponseWriter, r *http.Request) bool {
	if s.auth == nil {
		return true // M0 探活骨架未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if subject == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
		return false
	}
	if isManagementPath(r.URL.Path) && !hasCapability(granted, "system:admin") {
		plugin := managementPluginID(r.URL.Path)
		s.auditDenied(subject, plugin, "缺少 system:admin 特权能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "越权：管理端点需要 system:admin 能力", "system:admin")
		return false
	}
	return true
}

// auditDenied 走注入的审计出口；未注入时只记 WARN（挂点见 server.go）。
func (s *Server) auditDenied(subject, plugin, reason string) {
	if s.capAuditor != nil {
		s.capAuditor(subject, plugin, reason)
		return
	}
	slog.Warn("capability.denied", "subject", subject, "plugin", plugin, "reason", reason)
}

// sessionFrom 从 cookie 取 token 并校验，返回会话视图。
func (s *Server) sessionFrom(r *http.Request) (auth.Session, error) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		return auth.Session{}, auth.ErrNoSession
	}
	return s.auth.Validate(cookie.Value)
}

// reqIDKey 是请求 id 在 context 中的私有键。
type reqIDKey struct{}

// reqIDPattern 限制外部传入的 X-Request-ID 形态；不合法时内核重新生成。
var reqIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// withRequestID 读取或生成 request id，写入响应头与 context，供 invoke 透传给 bus。
//
// 中间件链完整版（recover/access_log/body_limit/auth/csrf/rate_limit）归 M1-14；
// M1 只落地 req_id —— 没有它，跨进程日志无法串起来。
func (s *Server) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !reqIDPattern.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), reqIDKey{}, id)))
	})
}

// newRequestID 生成 r-<16 hex> 的请求 id。
func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "r-0000000000000000"
	}
	return "r-" + hex.EncodeToString(buf)
}

// requestIDFrom 取 context 中的请求 id；缺失时返回空串（bus 会自行生成）。
func requestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(reqIDKey{}).(string)
	return id
}

// statusFor 把协议错误码映射为 HTTP 状态码（PLUGIN-PROTOCOL §9）。
func statusFor(code string) int {
	switch code {
	case pluginapi.E_INVALID:
		return http.StatusBadRequest
	case pluginapi.E_UNAUTHORIZED:
		return http.StatusUnauthorized
	case pluginapi.E_NOTFOUND:
		return http.StatusNotFound
	case pluginapi.E_CONFLICT:
		return http.StatusConflict
	case pluginapi.E_UPSTREAM:
		return http.StatusBadGateway
	case pluginapi.E_UNSUPPORTED:
		return http.StatusNotImplemented
	case pluginapi.E_RATELIMIT:
		return http.StatusTooManyRequests
	case pluginapi.E_NEED_ROOT:
		return http.StatusForbidden
	case pluginapi.E_NO_SYSTEMD:
		return http.StatusNotImplemented
	default:
		return http.StatusInternalServerError
	}
}

// writeFailure 把内核错误统一写成 {code,message,detail}；非协议错误按 E_INTERNAL 处理。
// 协议错误 detail 里的 requires_restart / hint 会提升为响应顶层字段，
// 分别供前端显示重启提示条与"下一步怎么做"的可操作提示。
func writeFailure(w http.ResponseWriter, err error) {
	var protocolErr *pluginapi.Error
	if !errors.As(err, &protocolErr) {
		slog.Error("HTTP handler 内部错误", "err", err)
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "内核内部错误", err.Error())
		return
	}
	writeJSON(w, statusFor(protocolErr.Code), errorBody{
		Code: protocolErr.Code, Message: protocolErr.Message,
		Detail: string(protocolErr.Detail), RequiresRestart: restartRequired(protocolErr),
		Hint: errorHint(protocolErr),
	})
}

// optionHint 是协议错误 detail 中允许携带的可操作提示。
type optionHint struct {
	// Hint 面向用户，给出可执行的下一步。
	Hint string `json:"hint"`
}

// errorHint 读取 detail 中的 hint；detail 为空或非 JSON 视为空。
func errorHint(err *pluginapi.Error) string {
	if len(err.Detail) == 0 {
		return ""
	}
	var hint optionHint
	if json.Unmarshal(err.Detail, &hint) != nil {
		return ""
	}
	return hint.Hint
}

// requiresRestartHint 是协议错误 detail 中允许携带的可选提示（与 market 同形）。
type requiresRestartHint struct {
	// RequiresRestart 为 true 表示需要重启内核才能恢复。
	RequiresRestart bool `json:"requires_restart"`
}

// restartRequired 读取 detail 中的 requires_restart；detail 为空或非 JSON 视为 false。
func restartRequired(err *pluginapi.Error) bool {
	if len(err.Detail) == 0 {
		return false
	}
	var hint requiresRestartHint
	return json.Unmarshal(err.Detail, &hint) == nil && hint.RequiresRestart
}
