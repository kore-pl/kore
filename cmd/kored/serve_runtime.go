package main

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/bus"
	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
)

// restoreTimeout 是启动期恢复已启用插件的单插件上限（覆盖 hello 2s + 进程创建）。
const restoreTimeout = 5 * time.Second

// service 是 serve 进程持有的内核运行件；关闭顺序由 shutdownAll 控制。
type service struct {
	catalog *registry.Catalog
	manager *supervisor.Manager
	bus     *bus.Bus
	states  *stateRepo
	backend *daemon
	auth    *auth.Manager
	db      *store.Store
}

// buildService 装配 registry/supervisor/bus/httpapi 后端。
//
// 返回码：插件根目录不可用 = 3；状态库读取失败 = 4；其它装配错误 = 2。
func buildService(cfg config, app *platform.Platform, db *store.Store) (*service, int) {
	if cfg.snapshot == nil {
		slog.Error("配置快照缺失，无法装配插件目录")
		return nil, exitConfig
	}
	root := cfg.snapshot.Paths.PluginDir
	if root == "" {
		root = filepath.Join(cfg.StateDir, "plugins")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		slog.Error("插件根目录不可用", "dir", root, "err", err)
		return nil, exitState
	}
	runPlugins := filepath.Join(cfg.RunDir, "plugins")
	if err := os.MkdirAll(runPlugins, 0o700); err != nil {
		slog.Error("插件 socket 目录不可用", "dir", runPlugins, "err", err)
		return nil, exitState
	}
	states := newStateRepo(db)
	catalog := registry.NewCatalog()
	if err := loadCatalog(catalog, states, root); err != nil {
		slog.Error("插件登记扫描失败", "err", err)
		return nil, exitStore
	}
	manager, err := supervisor.New(supervisor.Options{
		Transport: app.Transport, Manifests: catalog, RunDir: runPlugins,
		LogDir: filepath.Join(cfg.LogDir, "plugins"), Version: version,
	})
	if err != nil {
		slog.Error("supervisor 装配失败", "err", err)
		return nil, exitConfig
	}
	frameBus, err := bus.New(manager, bus.Options{})
	if err != nil {
		slog.Error("bus 装配失败", "err", err)
		return nil, exitConfig
	}
	svc := &service{
		catalog: catalog, manager: manager, bus: frameBus, states: states,
		db: db, backend: newDaemon(catalog, manager, frameBus, states),
		auth: auth.NewManager(db, cfg.snapshot.Auth.AdminPasswordHash, cfg.snapshot.Auth.SessionTTL,
			cfg.snapshot.Auth.CookieSecure == "true"),
	}
	svc.restoreEnabled()
	return svc, exitOK
}

// restoreEnabled 按 plugin_state.desired 恢复上次已启用的插件；单个失败只 WARN。
func (s *service) restoreEnabled() {
	for _, view := range s.catalog.List() {
		state, found, err := s.states.load(view.ID)
		if err != nil {
			slog.Warn("读取插件期望状态失败", "plugin_id", view.ID, "err", err)
			continue
		}
		if !found || state.Desired != desiredEnabled {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
		err = s.backend.Enable(ctx, view.ID)
		cancel()
		if err != nil {
			slog.Warn("恢复已启用插件失败", "plugin_id", view.ID, "err", err)
		}
	}
}

// StopAll 停止全部有运行态的插件；进程退出由 supervisor 的 Wait 驱动，不轮询。
func (s *service) StopAll() {
	for _, view := range s.catalog.List() {
		if _, ok := s.manager.Snapshot(view.ID); !ok {
			continue
		}
		if err := s.manager.Stop(context.Background(), view.ID); err != nil {
			slog.Warn("停止插件失败", "plugin_id", view.ID, "err", err)
		}
	}
}
