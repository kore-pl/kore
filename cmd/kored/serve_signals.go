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
		}
	}
}
