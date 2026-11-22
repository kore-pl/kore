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
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/web"
)

// 主壳静态资源在 web.Dist 中的精确路径（embed 编译期保证存在）。
const (
	staticIndexPath = "dist/index.html"
	staticAppJSPath = "dist/app.js"
	staticCSSPath   = "dist/style.css"
)

// Options 是 httpapi 的启动参数，由 cmd/kored 装配。
type Options struct {
	// Version 是 kore 版本，随 /api/v1/system/info 返回。
	Version string
	// Report 是启动期环境探测结果，原样返回。
	Report envprobe.Report
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
	// InstallRefresh 在 POST /store/install 成功后回调，增量刷新 registry 使新装
	// 插件立即可 enable/invoke（缺口2）。由 cmd/kored 装配层注入（ReloadOne：
	// 读 store 已装记录 → 装载清单 → 登记 catalog）；nil 时不刷新（测试/未装配）。
	InstallRefresh func(id string) error
}

// CapabilityResolver 由请求解析出调用方 subject 与已授予能力集。
// subject 为空表示无凭证；granted 为 6 特权能力或 <plugin-id>:<action> 语法。
type CapabilityResolver func(*http.Request) (string, []string)

// CapabilityAuditor 记录一次 capability.denied（subject/插件 id/原因）。
type CapabilityAuditor func(subject, plugin, reason string)

// 单管理员语义下的 6 个宿主特权能力（与 registry/validate.go 同源，不重复名词表）。
var adminCapabilities = []string{
	"system:admin", "system:read", "net:read", "net:write", "proc:read", "proc:write",
}

// defaultCapabilityResolver 从 session cookie 推导 admin 全权；无有效 cookie 返回空 subject。
func defaultCapabilityResolver(r *http.Request) (string, []string) {
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

// isManagementPath 判断是否为插件管理端点（enable/disable）。
func isManagementPath(path string) bool {
	return strings.HasSuffix(path, "/enable") || strings.HasSuffix(path, "/disable")
}

// managementPluginID 从 /api/v1/plugins/{id}/enable|disable 取插件 id。
func managementPluginID(path string) string {
	rest, ok := strings.CutPrefix(path, "/api/v1/plugins/")
	if !ok {
		return ""
	}
	id, _, _ := strings.Cut(rest, "/")
	return id
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
	auditLister    AuditLister
	installRefresh func(id string) error
	mu             sync.Mutex
	listeners      []net.Listener
}

// New 构造 Server 并注册路由；此时尚未绑定任何监听地址。
func New(opts Options, transport platform.Transport) *Server {
	server := &Server{
		opts: opts, transport: transport, mux: http.NewServeMux(),
		auth: opts.Auth, loginLimiter: opts.LoginLimiter, market: opts.Market,
		capResolver: opts.CapabilityResolver, capAuditor: opts.CapabilityAuditor,
		auditLister: opts.AuditLister, installRefresh: opts.InstallRefresh,
	}
	if server.capResolver == nil {
		server.capResolver = defaultCapabilityResolver
	}
	server.routes()
	// 主壳静态三件套：精确路径注册，优先于 routes() 里的 "/" 404 兜底。
	// 面板壳无敏感数据，走鉴权白名单（middleware.isPublicPath）；API 仍全量鉴权。
	server.staticRoutes()
	// 中间件链（外层先执行）：req_id → CSRF → auth → handler。
	// CSRF 在 auth 之前：非法写请求一律先按 CSRF 失败收敛，不泄露会话状态。
	// 仅装配鉴权时挂 CSRF/auth；M0 探活骨架（auth==nil）保持裸路由。
	handler := http.Handler(server.mux)
	if server.auth != nil {
		handler = server.withAuth(handler)
		handler = server.withCSRF(handler)
	}
	server.httpServer = &http.Server{
		Handler:           server.withRequestID(handler),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
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
		return nil
	}
	tcp, err := net.Listen("tcp", s.opts.Addr)
	if err != nil {
		_ = s.httpServer.Close()
		return fmt.Errorf("监听 TCP %s: %w", s.opts.Addr, err)
	}
	s.track(tcp)
	go s.serve(tcp)
	return nil
}

// Shutdown 在 ctx 内优雅关闭；ctx 由调用方给 5s 超时。
func (s *Server) Shutdown(ctx context.Context) error {
	err := s.httpServer.Shutdown(ctx)
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

// staticRoutes 注册主壳静态三件套。三条精确路由优先于 "/" 兜底：
// 根路径用 "GET /{$}"（{$} 锚定精确根，Go 1.22+ ServeMux 语义），
// 若写成 "GET /" 会与 "/api/v1/store/" 等子路径模式冲突并 panic（实测）；
// 其它路径仍由 routes() 的 "/" 兜底 → 404。
func (s *Server) staticRoutes() {
	s.mux.HandleFunc("GET /{$}", s.handleIndex)
	s.mux.HandleFunc("GET /app.js", s.handleAppJS)
	s.mux.HandleFunc("GET /style.css", s.handleStyleCSS)
}

// staticFile 从 embed.FS 读取精确路径并写出；embed 编译期已保证存在，
// 读取失败只可能是运行期数据损坏 → 500，绝不回落到其它文件（无 SPA 兜底）。
func staticFile(w http.ResponseWriter, path, contentType string) {
	data, err := web.Dist.ReadFile(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "E_INTERNAL", "静态资源读取失败", path)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleIndex 提供主壳 HTML 壳（浏览器面板入口）。
func (s *Server) handleIndex(w http.ResponseWriter, _ *http.Request) {
	staticFile(w, staticIndexPath, "text/html; charset=utf-8")
}

// handleAppJS 提供主壳脚本。
func (s *Server) handleAppJS(w http.ResponseWriter, _ *http.Request) {
	staticFile(w, staticAppJSPath, "application/javascript; charset=utf-8")
}

// handleStyleCSS 提供主壳样式。
func (s *Server) handleStyleCSS(w http.ResponseWriter, _ *http.Request) {
	staticFile(w, staticCSSPath, "text/css; charset=utf-8")
}
