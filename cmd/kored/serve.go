package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/kore-project/kore/internal/core/envprobe"
	"github.com/kore-project/kore/internal/core/httpapi"
	"github.com/kore-project/kore/internal/platform"
)

// shutdownTimeout 是优雅关闭自限（ARCHITECTURE §6.2：在途 HTTP ≤5s）。
const shutdownTimeout = 5 * time.Second

// runServe 执行 serve：配置 → 资源锚点 → 环境探测 → 目录 → HTTP → 等信号 → 优雅关闭。
func runServe(args []string, stderr io.Writer) int {
	opts, err := parseServeFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	cfg := loadConfig(opts, stderr)
	slog.SetDefault(slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	limits := setRuntimeLimits()
	logRuntimeLimits(limits)

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

// 资源锚点默认值（口径见 docs/CORE.md 资源调优一节 +
// docs/DECISIONS/0015-runtime-resource-anchors.md）。
const (
	// defaultGOGC 是默认档 GC 目标比例（未设 GOGC 时生效）。
	defaultGOGC = 50
	// defaultMemLimit 是默认档 Go 堆软上限（未设 GOMEMLIMIT 时生效）。
	defaultMemLimit int64 = 6 << 20
	// maxProcs 是主壳并行度上限（未设 GOMAXPROCS 且 CPU 核数超限时收敛）。
	maxProcs = 8
)

// runtimeLimits 记录本次实际应用到运行时的资源锚点，供启动日志与回归测试使用。
//
// 只记录"自己设置的值"：禁止用副作用式 API 回读运行时配置（G-21）。实测数据见
// `.agents/verify/m1-memory-baseline.md`（三档 × 60 点），此处不写死具体 KiB。
type runtimeLimits struct {
	// GOGC 实际生效的 GC 目标比例；-1 表示 off。
	GOGC int
	// MaxProcs 实际生效的 P 数量上限。
	MaxProcs int
	// MemLimitBytes 实际生效的 Go 堆软上限（字节）。
	MemLimitBytes int64
}

// setRuntimeLimits 应用主壳的资源锚点并返回实际生效值。
//
//   - 堆软上限：GOMEMLIMIT 已由环境设置时尊重环境（消融对照用），否则取默认档；
//   - GC 目标比例：GOGC 已设置时尊重环境（消融对照用），否则取默认档；
//   - 并行度上限：GOMAXPROCS 已设置时尊重环境，否则仅在 CPU 核数超限时收敛。
//
// 三者都是"未显式设置才生效"，因此外部可用 GOGC / GOMEMLIMIT / GOMAXPROCS
// 覆盖做消融实验。
func setRuntimeLimits() runtimeLimits {
	limits := runtimeLimits{GOGC: defaultGOGC, MemLimitBytes: defaultMemLimit}
	if raw := os.Getenv("GOMEMLIMIT"); raw != "" {
		limits.MemLimitBytes = parseMemLimit(raw)
	} else {
		debug.SetMemoryLimit(defaultMemLimit)
	}
	if raw := os.Getenv("GOGC"); raw != "" {
		limits.GOGC = parseGOGC(raw)
	} else {
		debug.SetGCPercent(defaultGOGC)
	}
	if os.Getenv("GOMAXPROCS") == "" && runtime.NumCPU() > maxProcs {
		runtime.GOMAXPROCS(maxProcs)
	}
	limits.MaxProcs = runtime.GOMAXPROCS(0) // GOMAXPROCS(0) 只读，无副作用
	return limits
}

// parseGOGC 解析 GOGC 环境变量；无法解析时按 off(-1) 记录并告警。
func parseGOGC(raw string) int {
	if raw == "off" {
		return -1
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		slog.Warn("GOGC 无法解析，按 off 记录", "raw", raw)
		return -1
	}
	return value
}

// parseMemLimit 解析 GOMEMLIMIT 环境变量（纯字节数或 KiB/MiB/GiB/TiB 后缀）。
func parseMemLimit(raw string) int64 {
	if raw == "off" || raw == "max" {
		return math.MaxInt64
	}
	value, err := parseByteSize(raw)
	if err != nil {
		slog.Warn("GOMEMLIMIT 无法解析，按 -1 记录", "raw", raw)
		return -1
	}
	return value
}

// parseByteSize 解析带二进制单位后缀的字节数。
func parseByteSize(raw string) (int64, error) {
	units := []struct {
		suffix     string
		multiplier int64
	}{
		{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}, {"TiB", 1 << 40},
	}
	for _, unit := range units {
		if strings.HasSuffix(raw, unit.suffix) {
			value, err := strconv.ParseInt(strings.TrimSuffix(raw, unit.suffix), 10, 64)
			if err != nil {
				return 0, err
			}
			return value * unit.multiplier, nil
		}
	}
	return strconv.ParseInt(raw, 10, 64)
}

// logRuntimeLimits 打印实际生效的资源锚点（只读入参，不触碰运行时状态）。
func logRuntimeLimits(limits runtimeLimits) {
	slog.Info("资源锚点", "gogc_percent", limits.GOGC,
		"gomemlimit_bytes", limits.MemLimitBytes, "gomaxprocs", limits.MaxProcs)
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
