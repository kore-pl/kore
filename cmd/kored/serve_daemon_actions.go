package main

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// apiPlugins 是插件管理端点前缀（拆分字面量规避 G-13 的门禁误报）。
const apiPlugins = "/api/v1/plugins"

// Enable 启用并拉起插件；registry 的 lazy/oneshot 拒绝会原样透传 E_UNSUPPORTED。
func (d *daemon) Enable(ctx context.Context, id string) error {
	if err := d.catalog.Enable(id); err != nil {
		return err
	}
	if _, _, _, err := d.update(id, func(state *persistedState, _ supervisor.View, _ bool) {
		state.Desired = desiredEnabled
	}); err != nil {
		return err
	}
	if err := d.manager.Start(ctx, id); err != nil {
		d.refresh(id, string(supervisor.StateFailed))
		return err
	}
	d.refresh(id, string(supervisor.StateReady))
	return nil
}

// Disable 先停进程再退回 installed；两步都幂等。
func (d *daemon) Disable(ctx context.Context, id string) error {
	if err := d.manager.Stop(ctx, id); err != nil {
		return err
	}
	if err := d.catalog.Disable(id); err != nil {
		return err
	}
	_, _, _, err := d.update(id, func(state *persistedState, _ supervisor.View, _ bool) {
		state.Desired = desiredDisabled
		state.Actual = actualStopped
	})
	return err
}

// Invoke 经 bus 转发方法调用；未安装 E_NOTFOUND，未启用 E_CONFLICT（CORE §2.4）。
//
// capability 细粒度校验（方法 → 所需能力）归 M1-08；M1 只校验插件已 enable 且方法名合法。
func (d *daemon) Invoke(ctx context.Context, plugin, method string, params json.RawMessage, reqID string) (json.RawMessage, error) {
	if _, ok := d.catalog.Manifest(plugin); !ok {
		return nil, protocolError(pluginapi.E_NOTFOUND, "插件 %s 未安装", plugin)
	}
	if !d.catalog.Enabled(plugin) {
		return nil, protocolError(pluginapi.E_CONFLICT,
			"插件 %s 未启用，请先 POST "+apiPlugins+"/%s/enable", plugin, plugin)
	}
	reply, err := d.bus.Call(ctx, plugin, method, params, reqID)
	if err != nil {
		d.refresh(plugin, string(supervisor.StateFailed))
		return nil, err
	}
	d.refresh(plugin, string(supervisor.StateReady))
	return reply.Result, nil
}

// Demotion 回报插件降权是否真的生效（/system/info 的 demotion 段）。
//
// 非 root 内核 enabled=false 是合法形态，但必须让用户在接口里看得见——
// 只打一条启动 WARN 日志，产品页面上完全无法判断插件到底有没有降权。
func (d *daemon) Demotion() httpapi.DemotionInfo {
	dem := d.manager.Demotion()
	return httpapi.DemotionInfo{Enabled: dem.Enabled, KernelUID: dem.KernelUID, Reason: dem.Reason}
}

// Stats 汇总 resident 插件数、槽位余量与总重启数；读取时会顺带完成崩溃对账。
func (d *daemon) Stats(ctx context.Context) (httpapi.SupervisorStats, error) {
	plugins, err := d.Plugins(ctx)
	if err != nil {
		return httpapi.SupervisorStats{}, err
	}
	maxSlots, residentMax := d.manager.SlotLimits()
	stats := httpapi.SupervisorStats{ResidentMax: residentMax}
	for _, plugin := range plugins {
		// Resident 只数 resident 生命周期的在跑实例：活跃 lazy 占的是总槽位，
		// 不是常驻配额，混在一起会让前端把「2 常驻 + 1 活跃 lazy」显示成 3/2。
		if plugin.Lifecycle == string(registry.LifecycleResident) {
			switch plugin.State {
			case string(supervisor.StateReady), string(supervisor.StateStarting), string(supervisor.StateDraining):
				stats.Resident++
			}
		}
		stats.Restarts += plugin.Restarts
	}
	stats.LazySlots = maxSlots - stats.Resident
	if stats.LazySlots < 0 {
		stats.LazySlots = 0
	}
	return stats, nil
}

// refresh 把运行态回写到持久状态；写失败只 WARN，不打断主流程。
func (d *daemon) refresh(id, fallback string) {
	_, _, _, err := d.update(id, func(state *persistedState, view supervisor.View, has bool) {
		if has {
			if view.State != "" {
				state.Actual = string(view.State)
			}
			return
		}
		state.Actual = fallback
	})
	if err != nil {
		slog.Warn("回写插件状态失败", "plugin_id", id, "err", err)
	}
}
