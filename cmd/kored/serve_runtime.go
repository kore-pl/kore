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
	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/credential"
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/scheduler"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// restoreTimeout 是启动期恢复已启用插件的单插件上限（覆盖 hello 2s + 进程创建）。
const restoreTimeout = 5 * time.Second

// reloadStopTimeout 是热重载前等待旧进程退出的上限（Stop 内 5s 宽限 + 2s SIGKILL 兜底）。
const reloadStopTimeout = 5 * time.Second

// postUpgradeTimeout 是升级后置动作的执行上限：动作可能读写宿主文件（如 crontab），
// 给足 15s 但不无限等待；超时按失败处理并告警，不阻断安装结果。
const postUpgradeTimeout = 15 * time.Second

// reloadOne 的结果分类，随 POST /store/install 的 reload 字段返回。
const (
	reloadFailed     = "failed"
	reloadRegistered = "reloaded"
	reloadRestarted  = "restarted"
)

// service 是 serve 进程持有的内核运行件；关闭顺序由 shutdownAll 控制。
type service struct {
	catalog    *registry.Catalog
	manager    *supervisor.Manager
	bus        *bus.Bus
	states     *stateRepo
	backend    *daemon
	auth       *auth.Manager
	db         *store.Store
	privilege  *privilege.Service  // ADR-0018 提权通道执行器
	credential *credential.Service // ADR-0026 凭据库（owner/grantee env 注入 + 4 端点）
	// channelSocket 是插件 → 内核 root-action 的独立通道 UDS（空表示未启用）。
	channelSocket string
	sched         *scheduler.Service // ADR-0019 定时任务调度器（单 ticker）
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
	warnCookieTransport(cfg.snapshot)
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
	// 插件 root-action 通道：root 内核下建独立 socket（ADR-0018 方案①）。
	// 非 root 不建通道，KernelSocket 留空 → 插件显式 E_NEED_ROOT，不去连管理面。
	channelSocket, channelGroup := "", "kore"
	if current, err := platform.SystemIdentity().Current(); err == nil && current.UID == 0 {
		if err := platform.EnsureGroup(channelGroup); err != nil {
			slog.Error("创建插件通道共享组失败（root-action 通道不可用）", "group", channelGroup, "err", err)
			return nil, exitEnv
		}
		channelSocket = filepath.Join(app.Paths.Dir(platform.DirRun), "kore-channel.sock")
	}
	// ADR-0026：凭据库是运行态资产，落在 <install>/data/credentials（0700）。
	// 审计适配器是 fail-closed 落点：未装配或 PutAudit 失败时 Grant/Revoke 一律拒绝。
	credentialSvc, err := credential.New(credential.Options{
		Dir:     filepath.Join(cfg.StateDir, "credentials"),
		Auditor: &credentialAuditor{db: db},
	})
	if err != nil {
		slog.Error("凭据库装配失败", "err", err)
		return nil, exitState
	}
	manager, err := supervisor.New(supervisor.Options{
		Transport: app.Transport, Manifests: catalog, RunDir: runPlugins,
		LogDir: filepath.Join(cfg.LogDir, "plugins"), Version: version,
		KernelSocket: channelSocket, ChannelGroup: channelGroup,
		PluginDataRoot: filepath.Join(cfg.StateDir, "plugin-data"),
		InstallDir:     coreconfig.InstallRoot(),
		ResidentMax:    cfg.snapshot.Resources.ResidentMax,
		Auditor:        &storeAuditor{db: db},
		Credentials:    credentialSvc,
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
		privilege: privilege.New(privilege.Options{
			Auditor:        &rootActionAuditor{db: db},
			ChangeRecorder: newRootChangeRecorder(cfg.StateDir),
			FileWrite:      newFileWriteOptions(cfg.StateDir),
			FileDelete:     newFileDeleteOptions(cfg.StateDir),
		}),
		credential:    credentialSvc,
		pluginRootDir: root,
		channelSocket: channelSocket,
		// cookie_secure 三值语义（auto 逐请求判定）由 auth.Manager 持有：
		// 旧实现把 auto 折成 false（== "true"），TLS 场景也不带 Secure（P1）。
		auth: auth.NewManagerWithPolicy(db, cfg.snapshot.Auth.AdminPasswordHash,
			cfg.snapshot.Auth.SessionTTL, cfg.snapshot.Auth.CookieSecure),
	}
	// 改口令 → 全局吊销（ADR-0041）：`kored admin-password set` 只改配置哈希，
	// 旧会话仍在 bbolt 里；这里按口令指纹比对，变化即删除全部会话。
	if revoked, err := svc.auth.ReconcilePasswordFingerprint(); err != nil {
		slog.Error("口令指纹比对失败，旧会话未被吊销", "err", err)
	} else if revoked {
		slog.Info("管理员口令已变更，全部旧会话已吊销")
	}
	// 卸载能力：刻意用可选接口注入，Backend 接口本身不扩方法（不涟漪测试替身）。
	svc.backend.uninstaller = func(ctx context.Context, id string) (httpapi.UninstallOutcome, error) {
		return svc.uninstallPlugin(ctx, cfg, id)
	}
	// 升级后置动作补跑入口：禁用态升级的标记在 Enable 成功后由 consumePostUpgrade 消费。
	svc.backend.postUpgrade = svc.runPostUpgrade
	// 自升级能力：同样走可选接口（httpapi.SelfUpdater），复用 cmd/kored/upgrade.go
	// 的校验/原子替换/回滚/finalize 语义，只多一层 HTTP 暴露与 fail-closed 审计。
	svc.backend.selfUpdate = newSelfUpdater(db, app, cfg)
	// 调度器必须在 backend 之后装配：Invoker 就是 daemon.Invoke（oneshot 调用面）。
	sched, err := scheduler.New(scheduler.Options{
		Store: db, Invoker: svc.backend, Logger: slog.Default(), Builtin: svc.builtinTask,
		CertRenewEnabled:   cfg.snapshot.CertRenew.Enabled,
		CertRenewInterval:  cfg.snapshot.CertRenew.Interval,
		AuditRetention:     cfg.snapshot.Audit.Retention,
		AuditCleanEnabled:  cfg.snapshot.Audit.CleanEnabled,
		AuditCleanInterval: cfg.snapshot.Audit.CleanInterval,
		AuditCleanBatch:    cfg.snapshot.Audit.CleanBatch,
	})
	if err != nil {
		slog.Error("调度器装配失败", "err", err)
		return nil, exitConfig
	}
	svc.sched = sched
	svc.restoreEnabled()
	// ADR-0056 T4：新进程补跑上次重启前未消费的 post_upgrade_pending（离线升级收尾闭环）。
	svc.resumePendingPostUpgrade()
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
//     禁用态升级不拉起、不执行后置动作，只落「待补跑」标记（版本号），
//     由下一次 Enable 成功后补跑（daemon.consumePostUpgrade）——两个诉求同时满足：
//     不违背禁用意图，且启用后不会带着未迁移的旧外部引用上线；
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
	// 先快照旧版本：Replace 之后 catalog 只剩新版本，「本次是否升级」就无从判断。
	previousVersion := ""
	if previous, exists := s.catalog.Manifest(id); exists {
		previousVersion = previous.Version
	}
	if _, exists := s.catalog.Manifest(id); exists {
		err = s.catalog.Replace(manifest)
	} else {
		err = s.catalog.Add(manifest)
	}
	if err != nil {
		return reloadFailed, fmt.Errorf("登记插件 %s@%s 失败: %w", id, ref.Version, err)
	}
	// 升级新增能力的授予扩展：installer 侧只有 WARN 日志，装配层补一条审计，
	// 让「谁/何时/新增了哪些」在 audit bucket 可追溯（不阻断重载）。
	s.noteGrantExtension(id)

	// 5) desired_state 决定是否拉起；重装/升级不再无条件把插件打回 disabled。
	state, found, err := s.states.load(id)
	if err != nil {
		return reloadFailed, fmt.Errorf("读取插件 %s 期望状态失败: %w", id, err)
	}
	if !found || state.Desired != desiredEnabled {
		if disableErr := s.catalog.Disable(id); disableErr != nil {
			return reloadFailed, disableErr
		}
		// 禁用态升级的两难：升级当下拉起插件（bus.Call 会冷启）违背用户禁用意图，
		// 但不迁移就让插件启用后继续引用旧二进制（cron 的 crontab 条目是真实案例）。
		// 折中：现在不拉起、不执行，只把「哪个版本待补跑」落库，由下一次 Enable 消费。
		// 只有「版本确实变化」才记标记——首次安装/同版本重装不是升级，不误跑。
		if previousVersion != "" && previousVersion != ref.Version {
			s.deferPostUpgrade(id, ref.Version)
		}
		slog.Info("插件重载完成", "plugin_id", id, "version", ref.Version, "result", reloadRegistered)
		return reloadRegistered, nil
	}
	if err := s.catalog.Enable(id); err != nil {
		return reloadFailed, fmt.Errorf("重载后启用插件 %s 失败: %w", id, err)
	}
	// 本条路径会直接执行后置动作，先清掉可能残留的待补跑标记，
	// 避免 backend.Enable 内的消费逻辑重复执行一次迁移。
	s.clearPostUpgradePending(id)
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	if err := s.backend.Enable(ctx, id); err != nil {
		return reloadFailed, fmt.Errorf("重载后按 desired=enabled 启动 %s 失败: %w", id, err)
	}
	// 6) 升级后置动作：按清单声明执行一次（PLUGIN-PROTOCOL §3.1）。
	// 顺序在 Enable 之后：先确保新版本已登记/可拉起，再让插件处理自己的存量迁移。
	s.runPostUpgrade(id, manifest.PostUpgrade)
	slog.Info("插件重载完成", "plugin_id", id, "version", ref.Version, "result", reloadRestarted)
	return reloadRestarted, nil
}

// deferPostUpgrade 记录「禁用态升级」的待补跑标记（值 = 升级到的版本）。
//
// 升级当下绝不拉起插件（用户禁用即不想它运行；拉起会占槽位并写 plugin.enable 审计），
// 所以只落标记；真正执行由下一次 Enable 成功后的 daemon.consumePostUpgrade 完成。
func (s *service) deferPostUpgrade(id, version string) {
	if _, _, _, err := s.backend.update(id, func(state *persistedState, _ supervisor.View, _ bool) {
		state.PostUpgradePending = version
	}); err != nil {
		slog.Warn("记录升级后置动作待补跑标记失败（升级已生效，动作需在启用后人工重放）",
			"plugin_id", id, "version", version, "err", err)
		return
	}
	slog.Info("插件在禁用态升级：升级后置动作推迟到启用时执行",
		"plugin_id", id, "version", version)
}

// clearPostUpgradePending 清除待补跑标记；写失败只 WARN，不阻断重载。
func (s *service) clearPostUpgradePending(id string) {
	if _, _, _, err := s.backend.update(id, func(state *persistedState, _ supervisor.View, _ bool) {
		state.PostUpgradePending = ""
	}); err != nil {
		slog.Warn("清除升级后置动作待补跑标记失败", "plugin_id", id, "err", err)
	}
}

// runPostUpgrade 执行清单声明的升级后置动作。
//
// G-01 边界：方法名完全来自插件清单，内核只做「读取声明 → bus 调用」——不认识
// cron、不认识迁移语义，也不维护任何业务动词表。lazy 插件会因此被冷启一次
// （bus.Ensure 的既有语义），动作完成后由 idle 计时器正常回收，不改变常驻配额。
//
// 失败不阻断安装（新版本已落位、其余功能可用），但必须可见：WARN 日志 + 告警中心
// 一条记录，避免「动作没执行」再次变成静默失效。
func (s *service) runPostUpgrade(id, method string) {
	if method == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), postUpgradeTimeout)
	defer cancel()
	if _, err := s.bus.Call(ctx, id, method, nil, "r-post-upgrade"); err != nil {
		slog.Warn("升级后置动作未完成（新版本已安装，动作需重试或人工处理）",
			"plugin_id", id, "method", method, "err", err)
		s.alertPostUpgradeFailure(id, method, err)
		return
	}
	slog.Info("升级后置动作完成", "plugin_id", id, "method", method)
}

// alertPostUpgradeFailure 把后置动作失败落进告警中心（用户不打开插件页也能看到）。
func (s *service) alertPostUpgradeFailure(id, method string, cause error) {
	if s.db == nil {
		return
	}
	if _, err := s.db.PutAlert("warning", "plugin",
		"插件 "+id+" 升级后置动作未完成", method+"："+cause.Error()); err != nil {
		slog.Warn("写升级后置动作告警失败", "plugin_id", id, "err", err)
	}
}

// noteGrantExtension 把升级新增能力的授予扩展写进审计（installer 无审计通道）。
//
// 只在存在待确认新增项时写一条 capability.grant_extended；审计失败只 WARN，
// 不阻断安装/重载（授予记录本身已与 plugins 记录同事务落库）。
func (s *service) noteGrantExtension(id string) {
	grant, found, err := s.states.grant(id)
	if err != nil || !found || len(grant.AddedCapabilities) == 0 {
		return
	}
	added := strings.Join(grant.AddedCapabilities, ",")
	if value := []rune(added); len(value) > 200 {
		added = string(value[:200]) // DATA-MODEL §9：detail 值 ≤256 字符
	}
	record := store.AuditRecord{
		Subject: "system", Action: "capability.grant_extended", Plugin: id,
		Target: "capabilities", Result: store.AuditResultOK,
		Detail: map[string]string{
			"granted_by": grant.GrantedBy,
			"version":    grant.Version,
			"added":      added,
		},
	}
	if err := s.db.PutAudit(record); err != nil {
		slog.Warn("授予扩展审计写入失败", "plugin_id", id, "err", err)
	}
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

// warnCookieTransport 在启动时把 cookie_secure 的实际取舍讲清楚。
//
// 为什么需要（P1 的可用性侧）：cookie_secure=true 在纯 HTTP 下会让浏览器丢弃
// 会话 cookie，表现为"口令正确但立刻掉线"；auto 在反代没终结 TLS 时只能不加
// Secure（加了就登不上），残余风险是同网段可嗅探会话令牌。两种情况都必须让
// 运维在日志里看到，而不是上线后自己猜。
func warnCookieTransport(snap *coreconfig.Snapshot) {
	if snap == nil {
		return
	}
	policy := snap.Auth.CookieSecure
	if policy == auth.CookiePolicyTrue {
		slog.Info("cookie_secure=true：会话 cookie 恒带 Secure；经纯 HTTP 访问会被浏览器丢弃（登不上），请确认入口已终结 TLS")
		return
	}
	if snap.Server.Addr == "" {
		// UDS-only：本机 Unix socket 无网络传输面，auto 下没有可告警的暴露路径。
		return
	}
	if snap.Server.TLS {
		return // 配置层当前拒绝，保留分支便于将来内核自终结 TLS。
	}
	switch policy {
	case auth.CookiePolicyFalse:
		slog.Warn("cookie_secure=false：即使经 HTTPS 反向代理访问，会话 cookie 也不带 Secure；仅建议纯本机调试使用",
			"addr", snap.Server.Addr)
	default:
		slog.Warn("已开启 TCP 监听但内核不终结 TLS：纯 HTTP 请求的会话 cookie 不带 Secure（浏览器才不会丢 cookie）",
			"addr", snap.Server.Addr,
			"hint", "在反向代理终结 TLS 并透传 X-Forwarded-Proto: https，auto 会据此加 Secure；直接暴露到网络请勿使用明文 HTTP")
	}
}
