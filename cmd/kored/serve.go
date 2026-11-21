package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"time"

	"github.com/kore-project/kore/internal/core/envprobe"
	"github.com/kore-project/kore/internal/core/httpapi"
	"github.com/kore-project/kore/internal/platform"
)

// shutdownTimeout 是优雅关闭自限（ARCHITECTURE §6.2：在途 HTTP ≤5s）。
const shutdownTimeout = 5 * time.Second

// runServe 执行 serve：内存上限 → 配置 → 环境探测 → 目录 → HTTP → 等信号 → 优雅关闭。
func runServe(args []string, stderr io.Writer) int {
	setRuntimeLimits()
	opts, err := parseServeFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	cfg := loadConfig(opts, stderr)
	slog.SetDefault(slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	logRuntimeLimits()

	app, report, code := bootstrap(cfg)
	if code != exitOK {
		return code
	}
	for _, warning := range report.Warnings {
		slog.Warn("环境降级", "detail", warning)
	}
	server, code := startHTTP(app, cfg, report)
	if code != exitOK {
		return code
	}
	slog.Info("kore ready", "pid", os.Getpid(), "version", version,
		"socket", filepath.Join(app.Paths.Dir(platform.DirRun), "kore.sock"), "addr", cfg.Addr)
	waitForExit(app.Signals, server)
	return exitOK
}

// maxProcs 是主壳的并行度上限。
//
// 主壳是 I/O 型薄壳（UDS 调用 + 静态资源），8 个 P 足够；而每个 P 的 mcache、g0 栈与
// GC 工作线程会随核数线性推高空载 RSS 与线程数。24 核实测（GOGC=50）：默认 24 P 空载
// 8040 KiB / 13 线程（距 8192 KiB 只剩 152 KiB），8 P 为 7220 KiB / 7 线程；大机器上
// 也保持确定。
const maxProcs = 8

// setRuntimeLimits 钉死主壳的资源锚点（CORE §7）：
//
//   - 堆软上限 6 MiB：GOMEMLIMIT 已由环境设置时尊重环境（消融对照用）；
//   - GC 目标比例 50：GOGC 已设置时尊重环境，未设时取 CORE §7 的兜底值
//     （默认 100 实测空载 7820 KiB、单次请求后 8056 KiB，余量不足 2%；50 为 6408 KiB）；
//   - 并行度上限 8：仅在 CPU 核数超过上限时收敛，小机器不受影响。
func setRuntimeLimits() {
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(6 << 20)
	}
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(50)
	}
	if runtime.NumCPU() > maxProcs {
		runtime.GOMAXPROCS(maxProcs)
	}
}

// logRuntimeLimits 记录实际生效的资源锚点，便于 verifier 核对（environ 里看不到程序内设置）。
func logRuntimeLimits() {
	slog.Info("资源锚点", "gomemlimit_bytes", debug.SetMemoryLimit(-1),
		"gomaxprocs", runtime.GOMAXPROCS(0), "gogc_percent", debug.SetGCPercent(-1))
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
func startHTTP(app *platform.Platform, cfg config, report envprobe.Report) (*httpapi.Server, int) {
	server := httpapi.New(httpapi.Options{
		Version:    version,
		Report:     report,
		SocketPath: filepath.Join(app.Paths.Dir(platform.DirRun), "kore.sock"),
		Addr:       cfg.Addr,
	}, app.Transport)
	if err := server.Start(); err != nil {
		slog.Error("HTTP 监听失败", "err", err)
		return nil, exitListen
	}
	return server, exitOK
}

// waitForExit 阻塞等待停止信号；SIGHUP 只记录（热重载待 M1-03）。
func waitForExit(signals platform.Signals, server *httpapi.Server) {
	for {
		select {
		case <-signals.Shutdown():
			shutdownHTTP(server)
			signals.Stop()
			return
		case <-signals.Reload():
			slog.Warn("收到 SIGHUP：配置热重载待 M1-03 实现，保留当前配置")
		}
	}
}

// shutdownHTTP 在 5s 内优雅关闭 HTTP 服务。
func shutdownHTTP(server *httpapi.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		slog.Warn("HTTP 优雅关闭未在时限内完成", "err", err)
	}
}
