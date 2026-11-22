package main

import (
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/platform"
)

// waitForExit 阻塞等待停止信号；SIGHUP 按白名单热重载配置。
func waitForExit(signals platform.Signals, server *httpapi.Server, cfg *config) {
	defer signals.Stop()
	for {
		select {
		case <-signals.Shutdown():
			return
		case <-signals.Reload():
			cfg.reload()
			// 限速口径在热更白名单里（CORE §6）：重载后同步到运行中的 limiter，
			// 否则配置改了不生效——那又是"文档声明 > 实现"。
			applyLoginPolicy(server, cfg)
		}
	}
}

// applyLoginPolicy 把当前快照里的 security.login_rate_limit 应用到运行中的限速器。
// 快照缺失时不动运行值（保持启动时装配的口径）。
func applyLoginPolicy(server *httpapi.Server, cfg *config) {
	if cfg.snapshot == nil {
		return
	}
	r := cfg.snapshot.Security.LoginRateLimit
	server.ApplyLoginPolicy(r.Attempts, r.Window, r.Lock)
}
