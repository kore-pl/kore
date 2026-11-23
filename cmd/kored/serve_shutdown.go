package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
)

// shutdownTimeout 是优雅关闭自限（ARCHITECTURE §6.2：在途 HTTP ≤5s）。
const shutdownTimeout = 5 * time.Second

// shutdownAll 按固定顺序关闭：先停调度器（不再派发新任务）→ 停 HTTP（在途 ≤5s）
// → 再停全部插件 → 由 defer 关状态库。
//
// 顺序不可调换：先停调度器与 HTTP 保证不再产生新调用，再停插件才能让
// kore.shutdown 的 5s 宽限期覆盖真实在途请求。
func shutdownAll(server *httpapi.Server, svc *service) {
	svc.stopScheduler()
	shutdownHTTP(server)
	svc.StopAll()
}

// shutdownHTTP 在 5s 内优雅关闭 HTTP 服务（ARCHITECTURE §6.2：在途 HTTP ≤5s）。
func shutdownHTTP(server *httpapi.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		slog.Warn("HTTP 优雅关闭未在时限内完成", "err", err)
	}
}
