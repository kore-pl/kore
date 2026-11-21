package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/platform"
)

// discardLogger 返回丢弃输出的 logger，避免测试刷屏。
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// installSpecs 在 stateDir 下连续安装多个测试插件包。
func installSpecs(t *testing.T, stateDir string, logger *slog.Logger, specs []pluginSpec) {
	t.Helper()
	st, err := store.Open(stateDir, logger)
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	defer func() {
		if err := st.Close(); err != nil {
			t.Fatalf("关闭安装期状态库失败: %v", err)
		}
	}()
	for _, spec := range specs {
		inst, err := installer.New(installer.Options{
			StateDir: stateDir, PluginDir: stateDir + "/plugins",
			KoreVersion: testVersion, Logger: logger, Store: st,
		})
		if err != nil {
			t.Fatalf("构造安装器失败: %v", err)
		}
		if _, err := inst.Install(buildPackage(t, spec)); err != nil {
			t.Fatalf("安装插件 %s 失败: %v", spec.ID, err)
		}
	}
}

// newPlatform 构造临时目录下的平台实现并创建运行期目录。
func newPlatform(t *testing.T, cfg config) *platform.Platform {
	t.Helper()
	app, err := platform.New(platform.Config{
		ConfigDir: cfg.ConfigDir, StateDir: cfg.StateDir, RunDir: cfg.RunDir, LogDir: cfg.LogDir,
	})
	if err != nil {
		t.Fatalf("平台初始化失败: %v", err)
	}
	if err := app.Paths.Ensure(); err != nil {
		t.Fatalf("创建运行期目录失败: %v", err)
	}
	return app
}

// openState 打开测试状态库。
func openState(t *testing.T, stateDir string, logger *slog.Logger) *store.Store {
	t.Helper()
	db, err := store.Open(stateDir, logger)
	if err != nil {
		t.Fatalf("重新打开状态库失败: %v", err)
	}
	return db
}

// newSocket 在短临时目录下给出 UDS 路径（避免路径长度上限）。
func newSocket(t *testing.T) (string, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "kore-sock-")
	if err != nil {
		t.Fatalf("创建 socket 目录失败: %v", err)
	}
	return dir, dir + "/kore.sock"
}

// startServer 启动带测试后端的 HTTP 服务。
func startServer(t *testing.T, sock string, svc *service, app *platform.Platform) *httpapi.Server {
	t.Helper()
	server := httpapi.New(httpapi.Options{
		Version: testVersion, Report: envprobe.Report{OS: "linux", Arch: "amd64"},
		SocketPath: sock, Backend: svc.backend,
	}, app.Transport)
	if err := server.Start(); err != nil {
		t.Fatalf("启动 HTTP 失败: %v", err)
	}
	return server
}

// newClient 返回经 UDS 访问测试服务的 HTTP 客户端。
func newClient(sock string) *http.Client {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, "unix", sock)
	}}
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}

// removeSocket 清理随机 socket 目录。
func removeSocket(dir string) { _ = os.RemoveAll(dir) }
