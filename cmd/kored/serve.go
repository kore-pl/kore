package main

import (
	"io"
	"log/slog"
	"os"
)

// runServe 是 serve 子命令入口：装配内核 → 起 HTTP → 等信号 → 优雅关闭。
//
// 启动顺序固定（CORE §4）：资源锚点 → 配置 → 平台/环境探测 → 状态库 →
// registry 扫描 → supervisor/bus/httpapi → HTTP → signals；任一步失败按码表退出。
func runServe(args []string, stderr io.Writer) int {
	opts, err := parseServeFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	limits := setRuntimeLimits()
	logRuntimeLimits(limits)
	cfg, code := loadConfig(opts, stderr)
	if code != exitOK {
		return code
	}
	// 首启凭据：没有管理员口令时生成一次性初始口令（TTY 下打印一次并写回哈希，
	// 本次启动即可登录；非 TTY 只给 CLI 指引，避免明文进 journald）。已有哈希时无操作。
	firstRunBootstrap(&cfg, stderr)

	app, report, code := bootstrap(cfg)
	if code != exitOK {
		return code
	}
	for _, warning := range report.Warnings {
		slog.Warn("环境降级", "detail", warning)
	}
	state, code := openStore(cfg, stderr)
	if code != exitOK {
		return code
	}
	defer closeStore(state)

	svc, code := buildService(cfg, app, state)
	if code != exitOK {
		return code
	}
	if err := svc.startScheduler(); err != nil {
		slog.Error("定时任务调度器启动失败", "err", err)
		svc.StopAll()
		return exitConfig
	}
	server, code := startHTTP(app, cfg, report, svc)
	if code != exitOK {
		svc.StopAll()
		return code
	}
	slog.Info("kore ready", "pid", os.Getpid(), "version", version,
		"socket", socketPath(app), "addr", cfg.Addr)
	waitForExit(app.Signals, server, &cfg)
	shutdownAll(server, svc)
	return exitOK
}
