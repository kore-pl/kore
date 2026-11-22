package main

import (
	"context"
	"fmt"
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
	catalog       *registry.Catalog
	manager       *supervisor.Manager
	bus           *bus.Bus
	states        *stateRepo
	backend       *daemon
	auth          *auth.Manager
	db            *store.Store
	pluginRootDir string // 插件落盘根目录，供 reloadOne 增量登记复用
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
		Auditor: &storeAuditor{db: db},
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
		pluginRootDir: root,
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

// reloadOne 增量登记单个新装插件到内存 catalog（缺口2：运行时安装立即可见）。
//
// 只处理指定 id：从 store 的 plugins bucket 读该 id 的已装记录（真源），
// 装载其 info.json 后登记。已登记则幂等跳过，不触碰其余插件、不重启进程。
// 失败返回原始错误，由 HTTP 层映射；落盘由 installer 负责，本方法只读 store。
func (s *service) reloadOne(id string) error {
	if id == "" {
		return fmt.Errorf("插件 id 为空，无法刷新登记")
	}
	if _, ok := s.catalog.Manifest(id); ok {
		return nil // 已登记，幂等
	}
	refs, err := s.states.installed()
	if err != nil {
		return fmt.Errorf("读取已装插件记录失败: %w", err)
	}
	for _, ref := range refs {
		if ref.ID != id {
			continue
		}
		manifest, loadErr := registry.Load(registry.PluginDir(s.pluginRootDir, id, ref.Version))
		if loadErr != nil {
			return fmt.Errorf("装载插件 %s 清单失败: %w", id, loadErr)
		}
		if addErr := s.catalog.Add(manifest); addErr != nil {
			return fmt.Errorf("登记插件 %s 失败: %w", id, addErr)
		}
		return nil
	}
	return fmt.Errorf("插件 %s 未在状态库中登记", id)
}

// StopAll 停止全部有运行态的插件；进程退出由 supervisor 的 Wait 驱动，不轮询。
// 已 stopped 的实例直接跳过：停机不是 disable 动作，避免污染 plugin.disable 审计（M3-C）。
func (s *service) StopAll() {
	for _, view := range s.catalog.List() {
		inst, ok := s.manager.Snapshot(view.ID)
		if !ok || inst.State == supervisor.StateStopped {
			continue
		}
		if err := s.manager.Stop(context.Background(), view.ID); err != nil {
			slog.Warn("停止插件失败", "plugin_id", view.ID, "err", err)
		}
	}
}
