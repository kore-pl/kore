package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/pengtang1024/kore/internal/core/bus"
	"github.com/pengtang1024/kore/internal/core/httpapi"
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
	plugins := make([]httpapi.PluginStatus, 0, len(views))
	for _, view := range views {
		status, err := d.status(view)
		if err != nil {
			return nil, err
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
	status, err := d.status(registry.View{
		ID: manifest.ID, Name: manifest.Name, Version: manifest.Version,
		Lifecycle: manifest.Lifecycle, State: state,
	})
	if err != nil {
		return httpapi.PluginStatus{}, false, err
	}
	return status, true, nil
}

// status 组装单插件视图，并在运行态变化时回写 plugin_state。
func (d *daemon) status(view registry.View) (httpapi.PluginStatus, error) {
	state, runtimeView, hasRuntime, err := d.update(view.ID, nil)
	if err != nil {
		return httpapi.PluginStatus{}, err
	}
	manifest, _ := d.catalog.Manifest(view.ID)
	return httpapi.PluginStatus{
		ID: view.ID, Name: view.Name, Version: view.Version,
		Lifecycle: string(view.Lifecycle), DepthLevel: manifest.DepthLevel,
		State: state.Actual, Desired: state.Desired, Restarts: state.Restarts,
		PID: runtimePID(runtimeView, hasRuntime), Enabled: view.State == registry.StateEnabled,
	}, nil
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
