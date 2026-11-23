package main

import (
	"context"
	"log/slog"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// Uninstall 实现 httpapi.PluginUninstaller（DELETE /api/v1/plugins/{id}）。
//
// 薄壳边界：本层只做装配（把 manager.Stop / store.PutAudit 注入 installer），
// 卸载顺序与回滚口径在 installer.Uninstall 一处收口，不在 HTTP 层或 daemon 里
// 重复实现"停进程 / 删目录 / 删记录 / 写审计"的业务步骤。
func (d *daemon) Uninstall(ctx context.Context, id string) (httpapi.UninstallOutcome, error) {
	if d.uninstaller == nil {
		return httpapi.UninstallOutcome{}, &pluginapi.Error{
			Code: pluginapi.E_UNSUPPORTED, Message: "当前装配未启用插件卸载",
		}
	}
	return d.uninstaller(ctx, id)
}

// uninstallPlugin 装配一次卸载：停进程复用 supervisor.Stop，审计直接落 audit bucket。
func (s *service) uninstallPlugin(ctx context.Context, cfg config, id string) (httpapi.UninstallOutcome, error) {
	if s.db == nil || s.manager == nil || s.catalog == nil {
		return httpapi.UninstallOutcome{}, &pluginapi.Error{
			Code: pluginapi.E_INTERNAL, Message: "内核组件未装配，无法卸载",
		}
	}
	inst, err := installer.New(installer.Options{
		StateDir:    cfg.StateDir,
		PluginDir:   s.pluginRootDir,
		KoreVersion: version,
		Logger:      slog.Default(),
		Store:       s.db,
		// 运行中卸载先优雅停止：失败时 installer 直接返回，不删任何东西。
		Stop: func(stopCtx context.Context, pluginID string) error {
			return s.manager.Stop(stopCtx, pluginID)
		},
		// fail-closed：PutAudit 报错时 installer 整体还原并返回 ErrAudit。
		Audit: func(_ context.Context, rec store.AuditRecord) error {
			return s.db.PutAudit(rec)
		},
	})
	if err != nil {
		return httpapi.UninstallOutcome{}, err
	}
	result, err := inst.Uninstall(ctx, id)
	if err != nil {
		return httpapi.UninstallOutcome{}, err
	}
	if !result.AlreadyAbsent {
		// 注册表与 supervisor 实例表同步摘除，避免 /plugins 继续列出已删目录。
		s.catalog.Remove(id)
		s.manager.Forget(id)
	}
	return httpapi.UninstallOutcome{
		ID:            result.ID,
		Deleted:       !result.AlreadyAbsent,
		AlreadyAbsent: result.AlreadyAbsent,
		Stopped:       result.Stopped,
	}, nil
}
