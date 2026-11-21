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
