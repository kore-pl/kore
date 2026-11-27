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

// withAuth 对 /api/v1/* 强制会话校验；/-/healthz、登录端点与主壳壳资源放行。
// 登录成功后所有已鉴权端点一视同仁放行：首次登录改密提示只作为可选建议，
// 通过响应头 X-Kore-Password-Hint 告知前端，不作为访问闸门（用户口径 2026-11-25）。
// 无有效 cookie → 401 E_UNAUTHORIZED（不泄露是"无 cookie"还是"已过期"）。
//
// 本机（UDS / loopback）**不是免登录通道**（ADR-0043 更正 ADR-0041 的误读）：
// 「操作免密」指登录一次后所有动作（含 root 特权动作，走 ADR-0042 的内核 root
// 服务）不再要口令，**不是"不登录就能操作管理 API"**。因此 UDS 与 loopback 与
// 远程同口径：没有有效会话一律 401；浏览器未登录时 /api/v1/system/info 也是 401，
// 前端据此渲染登录页。
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
			// API token（用户主动生成，与会话鉴权并存）：只读 token 只能调 GET/HEAD；
			// 管理 token 走与会话一致的能力集。token 无效时不回退会话，fail-closed。
			if strings.HasPrefix(r.Header.Get(authorizationHeader), bearerPrefix) &&
				!isRootActionPath(r.URL.Path) {
				if s.authenticateAPIToken(w, r) {
					next.ServeHTTP(w, r)
					return
				}
				return
			}
			if isRootActionPath(r.URL.Path) && r.Header.Get(authorizationHeader) != "" {
				actor, ok := s.pluginIdentity(r)
				if !ok {
					writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "插件凭证无效", "")
					return
				}
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), pluginActorKey{}, actor)))
				return
			}
			if _, err := s.authenticate(w, r); err != nil {
				writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
				return
			}
			// ADR-0055 首登改密为**可选建议**，不是访问闸门：must_change_password
			// 只作前端提示标记（X-Kore-Password-Hint），不再拦截任何业务端点。
			// 用户可直接使用控制台全部功能（用户口径 2026-11-25："不能是必选项"）。
			s.notePasswordHint(w)
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

// apiTokenKey 是 API token 身份在请求上下文中的私有键；content type 字段显式。
type apiTokenKey struct{}

// authenticateAPIToken 校验 Authorization: Bearer <API token>，成功后写入上下文身份。
// 写请求要求 admin scope；失败一律 401，不回退会话 cookie（防止无效 bearer 绕过 CSRF）。
func (s *Server) authenticateAPIToken(w http.ResponseWriter, r *http.Request) bool {
	if s.auth == nil || s.auth.Security() == nil {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "API 令牌不可用", "")
		return false
	}
	plain := strings.TrimSpace(strings.TrimPrefix(r.Header.Get(authorizationHeader), bearerPrefix))
	rec, valid, err := s.auth.Security().ValidateToken(plain)
	if err != nil || !valid {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "API 令牌无效或已过期", "")
		return false
	}
	// 来源绑定门：验签之后、scope/能力判定之前。陌生网络发起的任何请求（含只读）
	// 统一 401，不给攻击者用 403 探测 scope；绑定门没有能力判定来源，capability
	// 传空串（DATA-MODEL §9 禁止编造能力名），reason 固定 token_ip_denied。
	if !s.tokenPeerAllowed(r, rec) {
		s.auditDenied("token:"+rec.ID, "", "", "", "token_ip_denied")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "API 令牌不允许从此网络地址使用", "")
		return false
	}
	if rec.Scope == "read" && !isSafeMethod(r.Method) {
		writeError(w, http.StatusForbidden, pluginapi.E_UNAUTHORIZED,
			"这个令牌只有读取权限，不能执行修改操作；请在设置页生成 admin 令牌", "")
		return false
	}
	ctx := context.WithValue(r.Context(), apiTokenKey{}, &apiTokenActor{id: rec.ID, scope: rec.Scope})
	*r = *r.WithContext(ctx)
	return true
}

// apiTokenActor 是 API token 身份的请求上下文值。
type apiTokenActor struct {
	id    string
	scope string
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
	return path == "/-/healthz" || path == "/-/onboarding" || path == "/api/v1/auth/login" ||
		path == "/api/v1/auth/captcha" || // ADR-0057 T4：登录前可拉取验证码（GET 安全方法，不放宽 CSRF）
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
// 关于"三方比对"（header == cookie == sessions.csrf）：那**不是待办事项**，而是
// ADR-0040 §2.4 所述未来方案的一部分——与独立 origin iframe + postMessage 桥、
// kore_csrf 改 HttpOnly 同属一条未实现的链路，v1.0 前不补。
// 现状（事实口径）：auth.Session 至今无 csrf 字段，服务端只做两方比对；残余风险
// （纯双提交不防"同源 XSS 读 cookie 后伪造"，会话绑定可防）见 SECURITY.md §4。
func (s *Server) withCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isCSRFExempt(r.URL.Path) || isSafeMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		// UDS 请求豁免 CSRF：浏览器没有 unix socket 通道，跨站请求打不到这里。
		// 本豁免**只免 CSRF**，不免认证——认证仍由 withAuth 的会话承担（ADR-0043），
		// 文件系统权限（0600 socket）只决定可达性、不构成认证。loopback TCP
		// **不豁免**——浏览器就在本机，SameSite 挡不住同站跨源，双提交必须照做。
		if local, _ := s.resolveLocal(r); local.channel == localChannelUnix {
			next.ServeHTTP(w, r)
			return
		}
		// 插件 bearer / API token 身份不走 cookie，天然无 CSRF 面（withAuth 会校验 token）。
		if strings.HasPrefix(r.Header.Get(authorizationHeader), bearerPrefix) {
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
		s.auditDenied(subject, plugin, managementAction(r.URL.Path), "", "缺少 system:admin 特权能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "越权：管理端点需要 system:admin 能力", "system:admin")
		return false
	}
	return true
}

// auditDenied 走注入的审计出口；未注入时只记 WARN（挂点见 server.go）。
// target 是被拒的目标动作：invoke 传方法名，enable/disable 传动作名，空串表示不细分。
// capability 是触发拒绝的真实能力名，仅 invoke 路径有值；其余出口传空串（不得编造）。
//
// 本出口是唯一 deny 汇聚点：一次 Submit 同时产出审计与告警的落库计划，保证
// 同源同窗、count 守恒（方案 DESIGN-AUDIT-DENY-OPT §2.1 / §4 I3）。
// root.action 提权审计是独立 fail-closed 出口，不经过这里，天然不并入合并。
func (s *Server) auditDenied(subject, plugin, target, capability, reason string) {
	key := DenyBurstKey{Subject: subject, Plugin: plugin, Target: target,
		Capability: capability, Reason: reason}
	alertDetail := denyAlertDetail(subject, plugin, target, reason)
	outcome := s.denyBurst.Submit(key, alertDetail, s.clock())

	for _, rec := range outcome.Audits {
		s.emitCapabilityAudit(rec)
	}
	if len(outcome.Audits) == 0 && s.capAuditor == nil && s.capAuditorDetail == nil {
		slog.Warn("capability.denied", "subject", subject, "plugin", plugin,
			"target", target, "capability", capability, "reason", reason)
	}
	for _, alert := range outcome.Alerts {
		s.emitDeniedAlert(alert.N, alertDetail)
	}
}

// emitCapabilityAudit 把一条 deny 审计记录交给注入出口。
// detail 携带合并元数据时走扩展接口；未装配扩展的注入方按原 5 参签名回退，
// 合并记录仍以原 reason 落库（detail 元数据仅由 store 适配器保留，G-01）。
func (s *Server) emitCapabilityAudit(rec DenyAuditRecord) {
	if s.capAuditorDetail != nil {
		s.capAuditorDetail.AuditWithDetail(rec.Subject, rec.Plugin, rec.Target, rec.Capability, rec.Detail)
		return
	}
	if s.capAuditor != nil {
		s.capAuditor(rec.Subject, rec.Plugin, rec.Target, rec.Capability, rec.Detail["reason"])
	}
}

// denyAlertDetail 构造 deny 告警明细（受控标量拼接，值长度受 store 校验）。
func denyAlertDetail(subject, plugin, target, reason string) string {
	detail := "subject=" + alertDash(subject)
	if plugin != "" {
		detail += "；plugin=" + plugin
	}
	if target != "" {
		detail += "；target=" + target
	}
	return detail + "；原因：" + reason
}

// sessionFrom 从 cookie 取 token 并校验，返回会话视图（不续期）。
func (s *Server) sessionFrom(r *http.Request) (auth.Session, error) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		return auth.Session{}, auth.ErrNoSession
	}
	return s.auth.Validate(cookie.Value)
}

// authenticate 校验会话并做滑动续期（ADR-0041）：剩余 < min(24h, TTL/2) 时写回
// 过期时刻并重发 Set-Cookie，面板连续使用就不会被 12h/7d 的固定过期踢下线；
// 阈值与 TTL 挂钩（12h 实例 6h、1h 实例 30m），不会每次鉴权都写盘。
// 续期失败只记 WARN、不拒绝请求——鉴权已通过，不能因写库抖动把用户挡在外面。
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (auth.Session, error) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		return auth.Session{}, auth.ErrNoSession
	}
	sess, err := s.auth.Validate(cookie.Value)
	if err != nil {
		return auth.Session{}, err
	}
	// 记录"最后活跃 / 来源 IP / UA 摘要"，供账户与安全中心的会话管理表使用。
	// 写库由 auth.Touch 内部按 5 分钟节流；失败只记 WARN，不拒绝请求。
	if touched, _, touchErr := s.auth.Touch(sess, auth.ClientIP(r), r.UserAgent()); touchErr != nil {
		slog.Warn("更新会话活跃时间失败", "err", touchErr)
	} else {
		sess = touched
	}
	next, renewed, slideErr := s.auth.Slide(sess)
	if slideErr != nil {
		slog.Warn("会话滑动续期失败", "err", slideErr)
		return sess, nil
	}
	if renewed {
		s.auth.SetCookie(w, r, cookie.Value)
		return next, nil
	}
	return sess, nil
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
	case "E_NO_SELF_RESTART":
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
