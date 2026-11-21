package main

import (
	"errors"
	"log/slog"
	"path/filepath"

	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/platform"
)

// socketPath 返回主壳 UDS 路径（平台运行目录下的 kore.sock）。
func socketPath(app *platform.Platform) string {
	return filepath.Join(app.Paths.Dir(platform.DirRun), "kore.sock")
}

// bootstrap 绑定平台实现、探测环境并创建运行期目录，返回退出码。
func bootstrap(cfg config) (*platform.Platform, envprobe.Report, int) {
	app, err := platform.New(platform.Config{
		ConfigDir: cfg.ConfigDir,
		StateDir:  cfg.StateDir,
		RunDir:    cfg.RunDir,
		LogDir:    cfg.LogDir,
	})
	if err != nil {
		slog.Error("平台初始化失败", "err", err)
		if errors.Is(err, platform.ErrUnsupported) {
			return nil, envprobe.Report{}, exitEnv
		}
		return nil, envprobe.Report{}, exitConfig
	}
	facts, err := envprobe.Collect(app)
	if err != nil {
		slog.Error("环境探测失败（按硬要求不满足处理）", "err", err)
		return nil, envprobe.Report{}, exitEnv
	}
	report, err := envprobe.Probe(facts)
	if err != nil {
		slog.Error("环境不满足硬要求", "err", err)
		return nil, envprobe.Report{}, exitEnv
	}
	slog.Info("环境探测完成", "summary", report.String())
	if err := app.Paths.Ensure(); err != nil {
		code := exitState
		if errors.Is(err, platform.ErrUnsupportedFS) {
			code = exitEnv
		}
		slog.Error("运行期目录不可用", "err", err)
		return nil, envprobe.Report{}, code
	}
	return app, report, exitOK
}

// startHTTP 装配并启动 httpapi，返回退出码（绑定失败 = 5）。
func startHTTP(app *platform.Platform, cfg config, report envprobe.Report, svc *service) (*httpapi.Server, int) {
	server := httpapi.New(httpapi.Options{
		Version:    version,
		Report:     report,
		SocketPath: socketPath(app),
		Addr:       cfg.Addr,
		Backend:    svc.backend,
		Auth:       svc.auth,
	}, app.Transport)
	if err := server.Start(); err != nil {
		slog.Error("HTTP 监听失败", "err", err)
		return nil, exitListen
	}
	return server, exitOK
}

// closeStore 关闭状态库；关闭失败只 WARN，不影响退出码。
func closeStore(state storeCloser) {
	if err := state.Close(); err != nil {
		slog.Warn("状态库关闭失败", "err", err)
	}
}

// storeCloser 是 closeStore 的最小依赖（*store.Store 实现）。
type storeCloser interface {
	// Close 关闭状态库，重复调用幂等。
	Close() error
}
