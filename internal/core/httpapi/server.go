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
	"sync"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/platform"
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
}

// Server 持有监听器与 http.Server，生命周期由 cmd/kored 控制。
type Server struct {
	opts       Options
	transport  platform.Transport
	mux        *http.ServeMux
	httpServer *http.Server
	auth       *auth.Manager
	mu         sync.Mutex
	listeners  []net.Listener
}

// New 构造 Server 并注册路由；此时尚未绑定任何监听地址。
func New(opts Options, transport platform.Transport) *Server {
	server := &Server{opts: opts, transport: transport, mux: http.NewServeMux(), auth: opts.Auth}
	server.routes()
	handler := http.Handler(server.mux)
	if server.auth != nil {
		handler = server.withAuth(handler)
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
