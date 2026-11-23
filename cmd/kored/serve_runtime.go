package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/bus"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// restoreTimeout 是启动期恢复已启用插件的单插件上限（覆盖 hello 2s + 进程创建）。
const restoreTimeout = 5 * time.Second

// reloadStopTimeout 是热重载前等待旧进程退出的上限（Stop 内 5s 宽限 + 2s SIGKILL 兜底）。
const reloadStopTimeout = 5 * time.Second

// reloadOne 的结果分类，随 POST /store/install 的 reload 字段返回。
const (
	reloadFailed     = "failed"
	reloadRegistered = "reloaded"
	reloadRestarted  = "restarted"
)

// service 是 serve 进程持有的内核运行件；关闭顺序由 shutdownAll 控制。
type service struct {
	catalog       *registry.Catalog
	manager       *supervisor.Manager
	bus           *bus.Bus
	states        *stateRepo
	backend       *daemon
	auth          *auth.Manager
	db            *store.Store
	privilege     *privilege.Service // ADR-0018 提权通道执行器
	pluginRootDir string             // 插件落盘根目录，供 reloadOne 重载登记复用
	// reloadMu 串行化同一进程内的安装后重载：Stop→Forget→Replace→Start 不能交错，
	// 否则两次并发安装会互相覆盖 catalog/instance，最终跑错版本。
	reloadMu sync.Mutex
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
		KernelSocket: socketPath(app),
		ResidentMax:  cfg.snapshot.Resources.ResidentMax,
		Auditor:      &storeAuditor{db: db},
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
		privilege:     privilege.New(privilege.Options{Auditor: &rootActionAuditor{db: db}}),
		pluginRootDir: root,
		auth: auth.NewManager(db, cfg.snapshot.Auth.AdminPasswordHash, cfg.snapshot.Auth.SessionTTL,
			cfg.snapshot.Auth.CookieSecure == "true"),
	}
	svc.restoreEnabled()
	return svc, exitOK
}

// pluginTokenAuth 是 httpapi.PluginAuth 的实现：按进程 token 反查插件与已授予能力。
//
// token 是 spawn 时注入插件的 KORE_PLUGIN_TOKEN，只在进程存活期有效；比较用
// 常量时间，避免时序侧信道。插件身份只能走 root-action 通道，不映射成管理会话。
func (s *service) pluginTokenAuth(token string) (string, []string, bool) {
	if token == "" {
		return "", nil, false
	}
	for _, view := range s.catalog.List() {
		got, ok := s.manager.PluginToken(view.ID)
		if !ok {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			continue
		}
		manifest, found := s.catalog.Manifest(view.ID)
		if !found {
			return "", nil, false
		}
		return view.ID, append([]string(nil), manifest.Capabilities...), true
	}
	return "", nil, false
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
			var perr *pluginapi.Error
			if errors.As(err, &perr) && perr.Code == pluginapi.E_RATELIMIT {
				// 槽位保护拒绝第 3 个 resident：只 WARN，不阻止整个启动
				// （RESOURCE-MODEL §2.6 候选 A 的启动路径口径）。
				slog.Warn("槽位保护拒绝恢复常驻插件（继续启动其余插件，不阻止内核）",
					"plugin_id", view.ID, "err", err)
				continue
			}
			slog.Warn("恢复已启用插件失败", "plugin_id", view.ID, "err", err)
		}
	}
}

// reloadOne 真正重载单个插件（运行时安装/升级/强制重装后调用）。
//
// 旧实现对已登记 id 直接幂等返回，只覆盖「首次增量登记」；同 id 装新版本时
// id 早已登记，于是新版本只落盘、catalog 与 supervisor 仍停在旧版本——表现为
// /store/install 返回 succeeded，但 /plugins 报旧版本、新方法 404（P0 根因）。
//
// 固定顺序（缺一不可）：
//  1. 运行中的旧版本先 Stop 并等待退出（≤5s），避免新旧进程共用 socket；
//  2. Forget 旧 instance（它绑定旧 manifest/旧版本目录，复用会 exec 旧二进制）；
//  3. 从状态库（已装真源）取该 id 的**新版本**，从磁盘重新装载 info.json；
//  4. Add（首次）或 Replace（已有同 id）登记，替换旧版本视图；
//  5. 按持久化 desired_state 决定是否重新拉起，返回 reloaded / restarted；
//     任一步失败返回 failed + 原始错误（HTTP 层显式 500，不假装成功）。
//
// 该函数是 store/install 的唯一重载入口；其他调用方（未来的 upgrade/repair）
// 走同一实现，不存在「只有安装端点生效」的第二条路径。
func (s *service) reloadOne(id string) (string, error) {
	if strings.TrimSpace(id) == "" {
		return reloadFailed, fmt.Errorf("插件 id 为空，无法重载登记")
	}
	s.reloadMu.Lock()
	defer s.reloadMu.Unlock()

	// 1) 旧版本进程先退出：Stop 幂等，已 stopped/failed 的实例不重复发 shutdown。
	if view, ok := s.manager.Snapshot(id); ok &&
		view.State != supervisor.StateStopped && view.State != supervisor.StateFailed {
		ctx, cancel := context.WithTimeout(context.Background(), reloadStopTimeout)
		stopErr := s.manager.Stop(ctx, id)
		cancel()
		if stopErr != nil {
			return reloadFailed, fmt.Errorf("停止旧版本插件 %s 失败: %w", id, stopErr)
		}
	}
	// 2) 丢弃旧运行态：instance.manifest 指向旧版本目录，必须由新清单重建。
	s.manager.Forget(id)

	// 3) 状态库是「已装版本」真源；磁盘目录是清单真源，两处都以新版本为准。
	refs, err := s.states.installed()
	if err != nil {
		return reloadFailed, fmt.Errorf("读取已装插件记录失败: %w", err)
	}
	var ref *pluginRef
	for i := range refs {
		if refs[i].ID == id {
			ref = &refs[i]
			break
		}
	}
	if ref == nil {
		return reloadFailed, fmt.Errorf("插件 %s 未在状态库中登记", id)
	}
	manifest, err := registry.Load(registry.PluginDir(s.pluginRootDir, id, ref.Version))
	if err != nil {
		return reloadFailed, fmt.Errorf("装载插件 %s@%s 清单失败: %w", id, ref.Version, err)
	}

	// 4) 首次安装走 Add，同 id 升级/重装走 Replace（覆盖旧 manifest）。
	if _, exists := s.catalog.Manifest(id); exists {
		err = s.catalog.Replace(manifest)
	} else {
		err = s.catalog.Add(manifest)
	}
	if err != nil {
		return reloadFailed, fmt.Errorf("登记插件 %s@%s 失败: %w", id, ref.Version, err)
	}

	// 5) desired_state 决定是否拉起；重装/升级不再无条件把插件打回 disabled。
	state, found, err := s.states.load(id)
	if err != nil {
		return reloadFailed, fmt.Errorf("读取插件 %s 期望状态失败: %w", id, err)
	}
	if !found || state.Desired != desiredEnabled {
		if disableErr := s.catalog.Disable(id); disableErr != nil {
			return reloadFailed, disableErr
		}
		slog.Info("插件重载完成", "plugin_id", id, "version", ref.Version, "result", reloadRegistered)
		return reloadRegistered, nil
	}
	if err := s.catalog.Enable(id); err != nil {
		return reloadFailed, fmt.Errorf("重载后启用插件 %s 失败: %w", id, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	if err := s.backend.Enable(ctx, id); err != nil {
		return reloadFailed, fmt.Errorf("重载后按 desired=enabled 启动 %s 失败: %w", id, err)
	}
	slog.Info("插件重载完成", "plugin_id", id, "version", ref.Version, "result", reloadRestarted)
	return reloadRestarted, nil
}

// disableForInstall 在强制重装前停用插件，返回安装前是否为 enabled。
//
// 未安装（首次带 force 安装）时不做任何事；已安装则停进程并把 desired 置为
// disabled，保证旧版本二进制与 socket 在目录被替换前退出。
func (s *service) disableForInstall(id string) (bool, error) {
	if _, ok := s.catalog.Manifest(id); !ok {
		return false, nil
	}
	state, _, err := s.states.load(id)
	if err != nil {
		return false, fmt.Errorf("读取插件 %s 期望状态失败: %w", id, err)
	}
	wasEnabled := state.Desired == desiredEnabled
	if err := s.backend.Disable(context.Background(), id); err != nil {
		return wasEnabled, fmt.Errorf("强制重装前停用插件 %s 失败: %w", id, err)
	}
	return wasEnabled, nil
}

// restoreForInstall 恢复强制重装前的期望态。
//
// 安装成功时只写 desired（enabled 由随后的 reloadOne 统一拉起，避免旧二进制
// 先起一次再被杀）；安装失败时 reenable=true，把 installer 已回滚的旧版本拉回来。
func (s *service) restoreForInstall(id string, wasEnabled, reenable bool) {
	desired := desiredDisabled
	if wasEnabled {
		desired = desiredEnabled
	}
	if err := s.setDesired(id, desired); err != nil {
		slog.Warn("恢复插件期望状态失败", "plugin_id", id, "desired", desired, "err", err)
	}
	if !reenable || !wasEnabled {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	if err := s.backend.Enable(ctx, id); err != nil {
		slog.Warn("强制重装失败后恢复旧插件失败", "plugin_id", id, "err", err)
	}
}

// setDesired 只写 plugin_state.desired，不触发进程动作。
func (s *service) setDesired(id, desired string) error {
	_, _, _, err := s.backend.update(id, func(state *persistedState, _ supervisor.View, _ bool) {
		state.Desired = desired
	})
	return err
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
