package main

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/pengtang1024/kore/internal/core/bus"
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// crashPrefix 是 supervisor reaper 对"就绪后意外退出"写入的 lastError 前缀。
const crashPrefix = "插件进程意外退出"

// daemon 是 httpapi.Backend 的实现：把 HTTP 动作翻译成 registry/supervisor/bus 调用。
//
// 持久化边界：本类型是装配层唯一把运行期状态写回 plugin_state 的地方。
// plugin_state.restarts 仍走"请求驱动对账"（状态字段由本层回写，见 countCrashLocked）；
// 四类生命周期事件（enable/disable/crash/restart）的审计已改为事件发生时直接落
// audit bucket（M3-C：supervisor 经注入的 Auditor → store.PutAudit，见 serve_audit.go），
// 不依赖本层对账，本层不再承担审计职责。
type daemon struct {
	catalog *registry.Catalog
	manager *supervisor.Manager
	bus     *bus.Bus
	states  *stateRepo

	mu      sync.Mutex
	crashes map[string]time.Time

	// uninstaller 是插件卸载实现（装配层注入，见 serve_plugin_uninstall.go）；
	// nil 表示未装配，DELETE /plugins/{id} 回 E_UNSUPPORTED 而不是假装成功。
	uninstaller func(ctx context.Context, id string) (httpapi.UninstallOutcome, error)

	// selfUpdate 是内核自升级实现（装配层注入，见 serve_upgrade.go）；
	// nil 表示未装配，self-upgrade 端点回 E_UNSUPPORTED 而不是假装成功。
	selfUpdate *selfUpdater
}

// newDaemon 构造后端。
func newDaemon(catalog *registry.Catalog, manager *supervisor.Manager, frameBus *bus.Bus, states *stateRepo) *daemon {
	return &daemon{
		catalog: catalog, manager: manager, bus: frameBus, states: states,
		crashes: make(map[string]time.Time),
	}
}

// Plugins 返回全部已登记插件视图。
func (d *daemon) Plugins(context.Context) ([]httpapi.PluginStatus, error) {
	views := d.catalog.List()
	// 授予记录一次事务批量读出：列表路径不为每个插件各开一次读事务。
	grants, err := d.states.grants()
	if err != nil {
		return nil, err
	}
	plugins := make([]httpapi.PluginStatus, 0, len(views))
	for _, view := range views {
		grant, found := grants[view.ID]
		if !found {
			status, statusErr := d.status(view, nil)
			if statusErr != nil {
				return nil, statusErr
			}
			plugins = append(plugins, status)
			continue
		}
		status, statusErr := d.status(view, &grant)
		if statusErr != nil {
			return nil, statusErr
		}
		plugins = append(plugins, status)
	}
	return plugins, nil
}

// Plugin 返回单个插件视图；未安装时第二返回值为 false。
func (d *daemon) Plugin(_ context.Context, id string) (httpapi.PluginStatus, bool, error) {
	manifest, ok := d.catalog.Manifest(id)
	if !ok {
		return httpapi.PluginStatus{}, false, nil
	}
	state, _ := d.catalog.State(id)
	grant, found, err := d.states.grant(id)
	if err != nil {
		return httpapi.PluginStatus{}, false, err
	}
	var grantRef *installer.Grant
	if found {
		grantRef = &grant
	}
	status, err := d.status(registry.View{
		ID: manifest.ID, Name: manifest.Name, Version: manifest.Version,
		Lifecycle: manifest.Lifecycle, State: state,
	}, grantRef)
	if err != nil {
		return httpapi.PluginStatus{}, false, err
	}
	return status, true, nil
}

// status 组装单插件视图，并在运行态变化时回写 plugin_state。
//
// grant 为 nil 表示授予记录缺失（存量库尚未回填）：此时回退到清单声明，
// 前端桥与调用校验行为不变（默认放行）；一旦安装/启用/启动回填写入记录，
// 视图展示的就是真实授予记录。
func (d *daemon) status(view registry.View, grant *installer.Grant) (httpapi.PluginStatus, error) {
	state, runtimeView, hasRuntime, err := d.update(view.ID, nil)
	if err != nil {
		return httpapi.PluginStatus{}, err
	}
	manifest, _ := d.catalog.Manifest(view.ID)
	status := httpapi.PluginStatus{
		ID: view.ID, Name: view.Name, Version: view.Version,
		Lifecycle: string(view.Lifecycle), DepthLevel: manifest.DepthLevel,
		State: state.Actual, Desired: state.Desired, Restarts: state.Restarts,
		PID: runtimePID(runtimeView, hasRuntime), Enabled: view.State == registry.StateEnabled,
		// Web / GrantedCapabilities 供前端桥按 FRONTEND §4 建帧与限权。
		// 已授予能力优先取 plugins bucket 的 granted_capabilities 记录（谁授的/何时/哪些）；
		// 记录缺失时回退清单声明，保证存量库与单管理员路径行为不变。
		GrantedCapabilities: grantedCapabilities(manifest.Capabilities, grant),
		MethodCapabilities:  maps.Clone(manifest.MethodCapabilities),
		RequiresRoot:        manifest.RequiresRoot,
		RootActions:         append([]pluginapi.RootAction(nil), manifest.RootActions...),
	}
	if manifest.Web != nil {
		status.Web = &httpapi.PluginWeb{
			Entry:  manifest.Web.Entry,
			Styles: append([]string(nil), manifest.Web.Styles...),
		}
	}
	if grant != nil {
		status.GrantedBy = grant.GrantedBy
		status.GrantedAt = grant.GrantedAt
		status.PendingCapabilities = append([]string(nil), grant.AddedCapabilities...)
	}
	return status, nil
}

// grantedCapabilities 返回视图展示的已授予能力集：有记录用记录，无记录回退声明。
func grantedCapabilities(declared []string, grant *installer.Grant) []string {
	if grant != nil {
		return append([]string(nil), grant.Capabilities...)
	}
	return append([]string(nil), declared...)
}

// ConfirmCapabilities 实现 httpapi.CapabilityGrantConfirmer：显式启用即确认授予。
//
// 只写授予记录（补齐缺失 / 清空升级新增的待确认项）并落审计，不改运行态；
// 是否已安装由 catalog 判定，未安装返回 E_NOTFOUND。
func (d *daemon) ConfirmCapabilities(_ context.Context, id, subject string) error {
	if _, ok := d.catalog.Manifest(id); !ok {
		return protocolError(pluginapi.E_NOTFOUND, "插件 %s 未安装", id)
	}
	if _, _, err := d.states.confirmGrant(id, subject); err != nil {
		return protocolError(pluginapi.E_INTERNAL, "确认插件 %s 授予记录失败：%v", id, err)
	}
	return nil
}

// PluginCapabilities 实现 httpapi.PluginCapabilityLookup：只读内存清单的 capabilities。
//
// 这是 invoke 调用校验的首选数据源：直接返回 info.json 的声明（Manifest.Capabilities），
// 不读 bbolt、不组装 PluginStatus、不产生状态回写副作用；能力语义由 httpapi 判定（G-01）。
func (d *daemon) PluginCapabilities(_ context.Context, id string) ([]string, bool, error) {
	manifest, ok := d.catalog.Manifest(id)
	if !ok {
		return nil, false, nil
	}
	return append([]string(nil), manifest.Capabilities...), true, nil
}

// PluginMethodCapabilities 实现 httpapi.PluginMethodCapabilityLookup：只读内存清单的
// method_capabilities（完整方法名 → 6 项特权能力之一），不解释语义（G-01）。
//
// 与 PluginCapabilities 同一数据源（Manifest），返回副本避免调用方改到登记表；
// 方法级优先级与回退逻辑由 httpapi 判定，装配层只交原始声明。
func (d *daemon) PluginMethodCapabilities(_ context.Context, id string) (map[string]string, bool, error) {
	manifest, ok := d.catalog.Manifest(id)
	if !ok {
		return nil, false, nil
	}
	return maps.Clone(manifest.MethodCapabilities), true, nil
}

// RootAction 实现 httpapi.RootActionLookup：按 id 从已登记清单查 root 动作。
//
// 只查内存清单，不执行、不判断业务含义（G-01）；动作不存在返回 found=false，
// 由 HTTP 层映射成 404 E_NOTFOUND。
func (d *daemon) RootAction(_ context.Context, pluginID, actionID string) (pluginapi.RootAction, bool, error) {
	manifest, ok := d.catalog.Manifest(pluginID)
	if !ok {
		return pluginapi.RootAction{}, false, nil
	}
	for _, action := range manifest.RootActions {
		if action.ID == actionID {
			return action, true, nil
		}
	}
	return pluginapi.RootAction{}, false, nil
}

// update 在锁内完成"读状态 → 合并运行态 → 崩溃对账 → 按需回写"。
//
// 串行化是必要的：并发请求若各自 load 再 save，会把已累计的 restarts 覆盖回旧值。
func (d *daemon) update(id string, apply func(*persistedState, supervisor.View, bool)) (persistedState, supervisor.View, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	state, found, err := d.states.load(id)
	if err != nil {
		return persistedState{}, supervisor.View{}, false, protocolError(pluginapi.E_INTERNAL,
			"读取插件 %s 状态失败：%v", id, err)
	}
	if !found {
		state = defaultState()
	}
	before := state
	runtimeView, hasRuntime := d.manager.Snapshot(id)
	if hasRuntime {
		if runtimeView.Restarts > state.Restarts {
			state.Restarts = runtimeView.Restarts
		}
		d.countCrashLocked(id, runtimeView, &state)
		if runtimeView.State != "" {
			state.Actual = string(runtimeView.State)
		}
	}
	if apply != nil {
		apply(&state, runtimeView, hasRuntime)
	}
	if state != before && (found || apply != nil) {
		if saveErr := d.states.save(id, state); saveErr != nil {
			slog.Warn("回写插件状态失败", "plugin_id", id, "err", saveErr)
		}
	}
	return state, runtimeView, hasRuntime, nil
}

// countCrashLocked 对就绪后意外退出的同一进程只计一次重启；调用方须持有 d.mu。
func (d *daemon) countCrashLocked(id string, view supervisor.View, state *persistedState) {
	if view.State != supervisor.StateFailed || !strings.HasPrefix(view.LastError, crashPrefix) {
		return
	}
	if last, ok := d.crashes[id]; ok && last.Equal(view.StartedAt) {
		return
	}
	d.crashes[id] = view.StartedAt
	state.Restarts++
	state.Actual = string(supervisor.StateFailed)
}

// protocolError 构造带协议错误码的统一错误体。
func protocolError(code, format string, args ...any) *pluginapi.Error {
	return &pluginapi.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// runtimePID 取运行态 PID；无运行态时为 0。
func runtimePID(view supervisor.View, ok bool) int {
	if !ok {
		return 0
	}
	return view.PID
}
