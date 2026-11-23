// Package httpapi 提供 kore 的最小 HTTP 入口：UDS 监听、健康检查、系统信息与插件启停/调用。
//
// M1 端点：GET /-/healthz、GET /api/v1/system/info、GET /api/v1/plugins、
// POST 插件管理端点（enable/disable）与 POST /api/v1/invoke/{plugin}/{method}；
// 路由用标准库 net/http + ServeMux，不引入任何 Web 框架；关闭走 context + Server.Shutdown。
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/credential"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/scheduler"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
	"github.com/pengtang1024/kore/web"
)

// 主壳静态资源在 web.Dist 中的根与入口路径（embed 编译期保证存在）。
// 除根 HTML 外，其余资源统一走 /assets/{file} 前缀，由后缀白名单判定 Content-Type，
// 内核不认识任何具体前端文件名——新增视图模块无需改本包（G-01：内核不维护业务域词表）。
const (
	staticDistRoot  = "dist/"
	staticIndexPath = "dist/index.html"

	// 静态资源 URL 前缀与允许的后缀（后缀即 Content-Type 的唯一判定依据）。
	staticURLPrefix = "/assets/"
	contentTypeHTML = "text/html; charset=utf-8"
	contentTypeJS   = "application/javascript; charset=utf-8"
	contentTypeCSS  = "text/css; charset=utf-8"
)

// assetContentType 按后缀返回 Content-Type；不在白名单内的后缀一律拒绝（空串表示不支持）。
// 用后缀而不是文件名判定：后端只承诺"是什么类型"，不对前端文件清单做业务枚举。
func assetContentType(name string) string {
	switch {
	case strings.HasSuffix(name, ".js"):
		return contentTypeJS
	case strings.HasSuffix(name, ".css"):
		return contentTypeCSS
	case strings.HasSuffix(name, ".html"):
		return contentTypeHTML
	default:
		return ""
	}
}

// Options 是 httpapi 的启动参数，由 cmd/kored 装配。
type Options struct {
	// Version 是 kore 版本，随 /api/v1/system/info 返回。
	Version string
	// Report 是启动期环境探测结果，原样返回。
	Report envprobe.Report
	// Paths 是配置加载后归一化的绝对路径，随 /api/v1/system/info 返回。
	Paths PathsInfo
	// SocketPath 是 UDS 监听路径（/run/kore/kore.sock）。
	SocketPath string
	// Addr 是可选的 TCP 监听地址（默认空 = 不监听 TCP）。
	Addr string
	// Backend 是插件管理后端；nil 表示未装配（仅健康检查与系统信息可用）。
	Backend Backend
	// Auth 是鉴权管理器；nil 表示不启用鉴权（测试与 M0 探活骨架用）。
	Auth *auth.Manager
	// LoginLimiter 是登录失败限速器；nil 时跳过限速（测试与骨架兼容）。
	// 生产必装配：cmd/kored 按 security.login_rate_limit 注入，缺装配等于
	// 文档承诺的 429/Retry-After 不存在（见 docs/SECURITY §3.5）。
	LoginLimiter *auth.LoginLimiter
	// Market 是软件商店后端；nil 表示 store/* 端点回 501 E_UNSUPPORTED。
	Market *market.Service
	// CapabilityResolver 解析请求的 subject 与其 granted capabilities；
	// nil 时按单管理员全权语义：有效 session 的 subject=admin，持 6 特权能力。
	// 插件身份走 UDS 的 KORE_PLUGIN_TOKEN/hello，不经 HTTP session（G-01）。
	CapabilityResolver CapabilityResolver
	// CapabilityAuditor 是 capability.denied 的审计出口；nil 时只记 slog WARN。
	// 挂点：cmd/kored 注入 store.PutAudit（Result=denied），本包不 import store。
	CapabilityAuditor CapabilityAuditor
	// AuditLister 是 GET /api/v1/audit 的查询后端；nil 时该端点回 501。
	// 由 cmd/kored 注入（内部转换 store.AuditRecord），本包不 import store（G-01）。
	AuditLister AuditLister
	// AuditRecorder 是 HTTP 侧审计出口（login.success / login.failed / invoke.*）；
	// nil 时静默跳过。由 cmd/kored 注入 store.PutAudit 适配器（本包不 import store）。
	AuditRecorder AuditRecorder
	// AuditInvokeAll 为 true 时审计全部 invoke（含只读方法，调试用）；默认 false
	// 只审计需要 admin 能力的写/管理类方法，避免日志爆炸。
	AuditInvokeAll bool
	// InstallRefresh 在 POST /store/install 成功后回调，真正重载 registry/supervisor
	// 使新装或升级的插件立即可 enable/invoke（缺口2 与热升级 P0）。由 cmd/kored
	// 装配层注入（reloadOne：停旧进程 → 读新清单 → Replace → 按 desired 拉起）。
	// 返回 reloaded / restarted；nil 时不刷新（测试/未装配）。
	InstallRefresh func(id string) (string, error)
	// Metrics 是系统资源采样器；nil 时 GET /api/v1/system/metrics 回 501。
	// 由 cmd/kored 注入（状态目录来自平台层），本包不持有目录解析逻辑。
	Metrics MetricsCollector
	// Privilege 是 ADR-0018 提权执行器；nil 时 root-action 端点回 501。
	Privilege RootActionExecutor
	// PluginAuth 校验插件 bearer token（root-action 通道）：返回插件 id 与已授予能力。
	// nil 表示不接受插件身份（只有管理会话可调提权端点）。
	PluginAuth PluginTokenAuth
	// TaskEvents 是安装/升级任务进度的进程内扇出中心（GET /api/v1/events 的 SSE 源）。
	// nil 时端点仍可连接但不产生事件；进度只存内存，不落库、不跨重启。
	TaskEvents *TaskEvents
	// Scheduler 是内核定时任务调度器（ADR-0019）；nil 时 scheduler/* 端点回 501。
	// 由 cmd/kored 注入（本包不 import store、不持有任务持久化逻辑）。
	Scheduler *scheduler.Service
	// Credentials 是 ADR-0026 凭据库；nil 时 credentials/* 端点回 501。
	Credentials *credential.Service
	// Alerts 是告警中心持久层（alerts bucket）；nil 时 alerts/* 端点回 501、
	// 各检查点埋点静默跳过。由 cmd/kored 注入（本包不 import store，G-01）。
	Alerts AlertSink
	// ChannelSocket 是插件 → 内核 root-action 的**独立通道** UDS（ADR-0018 方案①）；
	// 空串表示不启用。通道只接受插件 bearer + SO_PEERCRED(uid,pid) 双校验过的
	// root-action 请求，不放宽主 socket /run/kore/kore.sock（仍 0600 root）。
	ChannelSocket string
	// ChannelGroup 是通道 socket 的属组（Linux）：socket 以 root:<group> 0660 创建，
	// 插件用户降权时被加入该组；空串时用 kore。
	ChannelGroup string
	// PluginPeer 返回插件当前进程的低权 uid 与 pid（supervisor.PluginPeer 注入），
	// 供通道 SO_PEERCRED 双校验；nil 表示通道装配不完整（Start 拒绝启用通道）。
	PluginPeer func(pluginID string) (uid, pid int, ok bool)
}

// RootActionExecutor 是 httpapi 对提权服务的最小依赖（privilege.Service 实现）。
type RootActionExecutor interface {
	// Execute 执行一次提权动作（含 schema 复核、审计 fail-closed、confirm 核销）。
	Execute(ctx context.Context, req privilege.Request) (privilege.Result, error)
	// Confirm 返回一次性确认令牌表（confirm-token 端点签发）。
	Confirm() *privilege.ConfirmStore
}

// PluginTokenAuth 由 token 解析插件身份与已授予能力；token 无效时 ok=false。
type PluginTokenAuth func(token string) (pluginID string, granted []string, ok bool)

// CapabilityResolver 由请求解析出调用方 subject 与已授予能力集。
// subject 为空表示无凭证；granted 为 6 特权能力或 <plugin-id>:<action> 语法。
type CapabilityResolver func(*http.Request) (string, []string)

// CapabilityAuditor 记录一次 capability.denied（subject / 插件 id / 目标动作 / 原因）。
// 目标动作：invoke 传方法名，管理端点传 enable|disable，提权端点传 action_id。
type CapabilityAuditor func(subject, plugin, target, reason string)

// 单管理员语义下的 6 个宿主特权能力（与 registry/validate.go 同源，不重复名词表）。
var adminCapabilities = []string{
	"system:admin", "system:read", "net:read", "net:write", "proc:read", "proc:write",
}

// defaultCapabilityResolver 从 session cookie 推导 admin 全权；无有效 cookie 返回空 subject。
//
// 当前 auth.Session 未携带 capability 字段（单管理员模式），故有效会话一律按 6 项
// 全权处理；authorizeInvoke 会在首次检查时打一次 WARN 说明降级。多用户接入时
// 由装配层注入 CapabilityResolver 覆盖本函数即可生效。
func defaultCapabilityResolver(r *http.Request) (string, []string) {
	// 只认会话 cookie：本机通道不是免登录身份（ADR-0043），不再提供
	// "UDS/loopback 即 admin 全权"的第二条提权路径。
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil || cookie.Value == "" {
		return "", nil
	}
	return "admin", adminCapabilities
}

// hasCapability 判断能力集是否含 need（精确匹配 6 特权或 <plugin>:<action>）。
func hasCapability(granted []string, need string) bool {
	for _, c := range granted {
		if c == need {
			return true
		}
	}
	return false
}

// isManagementPath 判断是否为插件管理端点（enable/disable/uninstall）。
//
// 卸载（DELETE /api/v1/plugins/{id}）与 enable/disable 同级：都改变插件运行态，
// 一律要求 system:admin（卸载更不可逆，不能降级为普通会话可调用）。
func isManagementPath(path string) bool {
	return strings.HasSuffix(path, "/enable") || strings.HasSuffix(path, "/disable") || isPluginUninstallPath(path)
}

// isPluginUninstallPath 判断是否是 /api/v1/plugins/<id>（恰好一段、非空）。
func isPluginUninstallPath(path string) bool {
	rest, ok := strings.CutPrefix(path, pluginsPath+"/")
	if !ok || rest == "" {
		return false
	}
	return !strings.Contains(rest, "/")
}

// pluginIDFromPath 从 /api/v1/plugins/{id}/... 取插件 id。
func pluginIDFromPath(path string) string {
	rest, ok := strings.CutPrefix(path, pluginsPath+"/")
	if !ok {
		return ""
	}
	id, _, _ := strings.Cut(rest, "/")
	return id
}

// managementPluginID 从 /api/v1/plugins/{id}/enable|disable 取插件 id。
func managementPluginID(path string) string { return pluginIDFromPath(path) }

// managementAction 从 /api/v1/plugins/{id}/enable|disable 取动作名（审计 target 用）。
func managementAction(path string) string {
	// 卸载路径没有动作后缀（DELETE 方法本身即动作），单独识别。
	if isPluginUninstallPath(path) {
		return "uninstall"
	}
	for _, action := range [...]string{"enable", "disable"} {
		if strings.HasSuffix(path, "/"+action) {
			return action
		}
	}
	return ""
}

// authorizeRootAction 校验提权端点的调用方：管理会话（system:admin）或目标插件自身
// 的 bearer 身份（且该插件已获 system:admin）。失败时直接写 401 并返回 ok=false。
func (s *Server) authorizeRootAction(w http.ResponseWriter, r *http.Request, target string) (string, bool) {
	if actor, ok := r.Context().Value(pluginActorKey{}).(*pluginActor); ok {
		if actor.id != target {
			writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "插件只能调用自己的 root-action", "")
			return "", false
		}
		if !hasCapability(actor.grants, "system:admin") {
			s.auditDenied(actor.id, target, "", "插件未获 system:admin 能力")
			writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "越权：插件需要 system:admin 能力", "system:admin")
			return "", false
		}
		return actor.id, true
	}
	if s.auth == nil {
		return "admin", true // 探活骨架（测试）未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if subject == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
		return "", false
	}
	if !hasCapability(granted, "system:admin") {
		s.auditDenied(subject, target, "", "缺少 system:admin 特权能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "越权：管理端点需要 system:admin 能力", "system:admin")
		return "", false
	}
	return subject, true
}

// isPluginActor 报告请求是否已按插件 bearer 身份认证。
func isPluginActor(r *http.Request) bool {
	_, ok := r.Context().Value(pluginActorKey{}).(*pluginActor)
	return ok
}

// Server 持有监听器与 http.Server，生命周期由 cmd/kored 控制。
type Server struct {
	opts           Options
	transport      platform.Transport
	mux            *http.ServeMux
	httpServer     *http.Server
	auth           *auth.Manager
	loginLimiter   *auth.LoginLimiter
	market         *market.Service
	capResolver    CapabilityResolver
	capAuditor     CapabilityAuditor
	capDegradeOnce sync.Once
	auditLister    AuditLister
	auditRecorder  AuditRecorder
	// auditInvokeAll 用 atomic 承载，SIGHUP 热更与请求路径并发读写不产生数据竞争。
	auditInvokeAll atomic.Bool
	// burstMu / bursts / burstCalls 是 invoke 突发合并状态（纯内存，零后台 goroutine）。
	burstMu    sync.Mutex
	bursts     map[string]*invokeBurstState
	burstCalls uint64
	// now 是突发窗口时间源；nil 时用 time.Now（测试可替换）。
	now            func() time.Time
	installRefresh func(id string) (string, error)
	metrics        MetricsCollector
	privilege      RootActionExecutor
	pluginAuth     PluginTokenAuth
	taskEvents     *TaskEvents
	scheduler      *scheduler.Service
	// alerts 是告警中心持久层；nil 时端点 501、埋点跳过。
	alerts AlertSink
	// channelServer 是独立通道 socket 的服务端；nil 表示未启用通道。
	channelServer *http.Server
	// loginFailStreak 是登录连续失败计数（noteLoginFailure 用；互斥见 loginStreakMu）。
	loginStreakMu   sync.Mutex
	loginFailStreak int
	// localCSRFMu / localCSRFTokenValue 是本机免密通道的进程级 CSRF token
	//（幂等请求首次下发后稳定复用，避免并发下发互相覆盖 cookie 的竞态）。
	localCSRFMu         sync.Mutex
	localCSRFTokenValue string
	mu                  sync.Mutex
	listeners           []net.Listener
}

// New 构造 Server 并注册路由；此时尚未绑定任何监听地址。
func New(opts Options, transport platform.Transport) *Server {
	server := &Server{
		opts: opts, transport: transport, mux: http.NewServeMux(),
		auth: opts.Auth, loginLimiter: opts.LoginLimiter, market: opts.Market,
		capResolver: opts.CapabilityResolver, capAuditor: opts.CapabilityAuditor,
		auditLister: opts.AuditLister, installRefresh: opts.InstallRefresh,
		auditRecorder: opts.AuditRecorder, now: time.Now,
		metrics: opts.Metrics, privilege: opts.Privilege, pluginAuth: opts.PluginAuth,
		taskEvents: opts.TaskEvents, scheduler: opts.Scheduler, alerts: opts.Alerts,
	}
	server.auditInvokeAll.Store(opts.AuditInvokeAll)
	if server.capResolver == nil {
		server.capResolver = defaultCapabilityResolver
	}
	server.routes()
	// 主壳静态三件套：精确路径注册，优先于 routes() 里的 "/" 404 兜底。
	// 面板壳无敏感数据，走鉴权白名单（middleware.isPublicPath）；API 仍全量鉴权。
	server.staticRoutes()
	// 中间件链（外层先执行）：req_id → local CSRF 引导 → CSRF → auth → handler。
	// CSRF 在 auth 之前：非法写请求一律先按 CSRF 失败收敛，不泄露会话状态。
	// 仅装配鉴权时挂 CSRF/auth；M0 探活骨架（auth==nil）保持裸路由。
	handler := http.Handler(server.mux)
	if server.auth != nil {
		handler = server.withAuth(handler)
		handler = server.withCSRF(handler)
		// 本机免密不经过登录，kore_csrf 需在幂等请求上补发（详见 csrf_local.go）；
		// 仅本机通道，远程仍必须登录换会话后才拿到令牌。
		handler = server.withLocalCSRF(handler)
	}
	server.httpServer = &http.Server{
		Handler:           server.withRequestID(handler),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
		// 把 net.Conn 带进请求上下文：UDS 免密要拿它做 SO_PEERCRED 校验，
		// 同时按连接记住"是否已记过 local.access"（只记首次连接 + 写操作）。
		ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
			return context.WithValue(ctx, connKey{}, &connInfo{conn: conn})
		},
	}
	// 独立通道：单独一个 http.Server，处理器只认插件 root-action（channel.go）。
	// ConnContext 把 net.Conn 带进请求上下文，供 SO_PEERCRED 双校验使用。
	if opts.ChannelSocket != "" {
		server.channelServer = &http.Server{
			Handler: server.channelHandler(),
			ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
				return context.WithValue(ctx, channelConnKey{}, conn)
			},
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
	}
	return server
}

// Handler 返回带 request id 中间件的路由处理器，供测试与后续内嵌复用。
func (s *Server) Handler() http.Handler { return s.httpServer.Handler }

// Start 先绑定 UDS（按需追加 TCP），再开始服务；绑定失败原样返回（cmd 映射 exit 5）。
func (s *Server) Start() error {
	uds, err := s.transport.Listen(s.opts.SocketPath)
	if err != nil {
		return err
	}
	s.track(uds)
	go s.serve(uds)
	if s.opts.Addr == "" {
		return s.startChannel()
	}
	tcp, err := net.Listen("tcp", s.opts.Addr)
	if err != nil {
		_ = s.httpServer.Close()
		return fmt.Errorf("监听 TCP %s: %w", s.opts.Addr, err)
	}
	s.track(tcp)
	go s.serve(tcp)
	return s.startChannel()
}

// startChannel 绑定独立通道 socket（插件 root-action 专用）。
//
// 失败即返回错误让 kored 拒绝启动：通道是"插件低权"模型的安全边界之一，
// 起不来时不能假装成功（否则插件会一直 E_NEED_ROOT 且无人知晓原因）。
func (s *Server) startChannel() error {
	if s.opts.ChannelSocket == "" {
		return nil
	}
	if s.pluginAuth == nil || s.opts.PluginPeer == nil || s.channelServer == nil {
		_ = s.httpServer.Close()
		return fmt.Errorf("通道装配不完整：ChannelSocket 需要 PluginAuth + PluginPeer")
	}
	listener, err := s.transport.Listen(s.opts.ChannelSocket)
	if err != nil {
		_ = s.httpServer.Close()
		return fmt.Errorf("监听通道 socket %s: %w", s.opts.ChannelSocket, err)
	}
	group := s.opts.ChannelGroup
	if group == "" {
		group = "kore"
	}
	if err := platform.OwnGroup(s.opts.ChannelSocket, group, 0o660); err != nil {
		_ = listener.Close()
		_ = s.httpServer.Close()
		return fmt.Errorf("设置通道 socket 属组 %s: %w", group, err)
	}
	s.track(listener)
	go s.serveChannel(listener)
	return nil
}

// serveChannel 运行通道监听器（独立 http.Server，独立处理器）。
func (s *Server) serveChannel(listener net.Listener) {
	if err := s.channelServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("通道服务异常退出", "socket", listener.Addr().String(), "err", err)
	}
}

// Shutdown 在 ctx 内优雅关闭；ctx 由调用方给 5s 超时。
func (s *Server) Shutdown(ctx context.Context) error {
	err := s.httpServer.Shutdown(ctx)
	if s.channelServer != nil {
		if channelErr := s.channelServer.Shutdown(ctx); err == nil {
			err = channelErr
		}
	}
	s.mu.Lock()
	for _, listener := range s.listeners {
		_ = listener.Close()
	}
	s.listeners = nil
	s.mu.Unlock()
	return err
}

// track 记录监听器，关闭时统一回收。
func (s *Server) track(listener net.Listener) {
	s.mu.Lock()
	s.listeners = append(s.listeners, listener)
	s.mu.Unlock()
}

// serve 运行单个监听器；只把非正常关闭记为错误（正常关闭不刷日志）。
func (s *Server) serve(listener net.Listener) {
	if err := s.httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("HTTP 服务异常退出", "addr", listener.Addr().String(), "err", err)
	}
}

// staticRoutes 注册主壳静态资源。精确路由优先于 "/" 兜底：
// 根路径用 "GET /{$}"（{$} 锚定精确根，Go 1.22+ ServeMux 语义），
// 若写成 "GET /" 会与 "/api/v1/store/" 等子路径模式冲突并 panic（实测）；
// 其它路径仍由 routes() 的 "/" 兜底 → 404。
//
// 资源统一走 "/assets/" 前缀（Go 1.22 的尾斜杠子树模式），由 handleAsset 做
// "文件名净度 + 后缀白名单" 双重校验，再按精确路径读 embed。不逐文件注册，
// 故新增前端文件不需要改本包——内核不认识任何具体视图名（G-01）。
func (s *Server) staticRoutes() {
	s.mux.HandleFunc("GET /{$}", s.handleIndex)
	s.mux.HandleFunc("GET "+staticURLPrefix, s.handleAsset)
}

// handleAsset 托管 /assets/{file}：只认单段文件名（不含 / 与 ..）、只认白名单后缀。
// 拒绝即 404，与未知路由同口径——不泄露"文件存在但类型不支持"这类区分。
func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, staticURLPrefix)
	if name == "" || strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		s.handleNotFound(w, r)
		return
	}
	contentType := assetContentType(name)
	if contentType == "" {
		s.handleNotFound(w, r)
		return
	}
	staticFile(w, staticDistRoot+name, contentType)
}

// staticFile 从 embed.FS 读取精确路径并写出；embed 编译期已保证首屏静态资源存在。
// 运行期读取失败按"资源不存在"处理并回 404 E_NOTFOUND（不是 500）：
// 视图模块缺失属于部署不完整，语义上就是该 URL 不存在，不该伪装成服务端故障。
func staticFile(w http.ResponseWriter, path, contentType string) {
	data, err := web.Dist.ReadFile(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "E_NOTFOUND", "静态资源不存在", path)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleIndex 提供主壳 HTML 壳（浏览器面板入口）。
func (s *Server) handleIndex(w http.ResponseWriter, _ *http.Request) {
	staticFile(w, staticIndexPath, contentTypeHTML)
}
