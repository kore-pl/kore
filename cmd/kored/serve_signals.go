package main

import (
	"log/slog"

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
			// audit.invoke_all 同样在白名单里：重载后同步到运行中的审计开关。
			applyAuditPolicy(server, cfg)
			// ADR-0055 §5：CLI 重置口令后 SIGHUP 即生效，不重启。
			// 只有哈希或 must_change 真的变了才同步并吊销全部旧会话，
			// 否则每次热更都会把管理员踢下线（ApplyCredentialSnapshot 返回是否变化）。
			applyAuthCredential(server, cfg)
		}
	}
}

// applyAuthCredential 把配置快照里的新哈希与 must_change 标志同步给运行中的 auth.Manager。
// 变化即吊销全部会话：CLI 重置后旧会话立即失效，需重新登录并（按需）改密。
func applyAuthCredential(server *httpapi.Server, cfg *config) {
	if cfg == nil || cfg.snapshot == nil {
		return
	}
	mgr := server.AuthManager()
	if mgr == nil {
		return
	}
	authSnap := cfg.snapshot.Auth
	if !mgr.ApplyCredentialSnapshot(authSnap.AdminPasswordHash, authSnap.MustChangePassword) {
		return
	}
	if n, err := mgr.RevokeAll(); err != nil {
		slog.Error("SIGHUP 口令变更吊销旧会话失败", "err", err)
	} else {
		slog.Info("SIGHUP 已同步新管理员口令并吊销旧会话", "revoked", n)
	}
}

// applyAuditPolicy 把当前快照里的 audit.invoke_all 应用到运行中的审计开关。
// 快照缺失时不动运行值（保持启动时装配的口径）。
func applyAuditPolicy(server *httpapi.Server, cfg *config) {
	if cfg.snapshot == nil {
		return
	}
	server.ApplyAuditInvokeAll(cfg.snapshot.Audit.InvokeAll)
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
