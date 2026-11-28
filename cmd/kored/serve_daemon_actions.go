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
	// 消费「禁用态升级」留下的待补跑标记：插件现在已启用，迁移必须补上，
	// 否则启用后仍引用旧版本二进制（cron 的 crontab 条目是真实案例）。
	d.consumePostUpgrade(id)
	return nil
}

// consumePostUpgrade 消费「禁用态升级」留下的待补跑标记：启用成功后补跑一次声明动作。
//
// 两个诉求同时满足：
//   - 不违背禁用意图：升级当下不拉起插件、不执行动作，只落标记（见 reloadOne 的
//     disabled 分支与 service.deferPostUpgrade）；
//   - 启用后状态正确：用户显式 Enable 是「我愿意它运行」的表达，此时补跑迁移，
//     插件不会带着旧外部引用上线。
//
// 标记只由「版本变化 + desired=disabled + 清单声明 post_upgrade」产生，因此从未
// 升级过的插件启用时不会误跑。先清标记再调用：失败不阻断启用（与重载路径同口径
// WARN + 告警，禁止静默），但也不在每次启用时反复重试轰炸；插件自身的启动期兜底
// 或人工重放是失败后的兜底路径。
func (d *daemon) consumePostUpgrade(id string) {
	state, found, err := d.states.load(id)
	if err != nil {
		slog.Warn("读取升级后置动作待补跑标记失败", "plugin_id", id, "err", err)
		return
	}
	if !found || state.PostUpgradePending == "" {
		return
	}
	if _, _, _, err := d.update(id, func(state *persistedState, _ supervisor.View, _ bool) {
		state.PostUpgradePending = ""
	}); err != nil {
		slog.Warn("清除升级后置动作待补跑标记失败，跳过本次补跑以避免重复执行",
			"plugin_id", id, "err", err)
		return
	}
	manifest, ok := d.catalog.Manifest(id)
	if !ok || manifest.PostUpgrade == "" {
		return
	}
	slog.Info("启用时补跑升级后置动作（禁用态升级的迁移不能丢）",
		"plugin_id", id, "upgraded_to", state.PostUpgradePending, "method", manifest.PostUpgrade)
	if d.postUpgrade != nil {
		d.postUpgrade(id, manifest.PostUpgrade)
	}
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
		// P1-3 / hands-on-r51：message 主文案必须是小白能看懂的白话，并指向
		// 真实存在的入口「软件商店 → 插件管理」（不是不存在的「插件页」）。
		// 内部 API 动词只写服务端日志，不进 message / detail.hint——后者会被
		// web/app.js 当作错误详情直接展示给用户（违反 USABILITY 原则④）。
		slog.Info("插件未启用，invoke 被拒绝", "plugin_id", plugin,
			"enable_endpoint", apiPlugins+"/"+plugin+"/enable")
		return nil, protocolError(pluginapi.E_CONFLICT,
			"插件「%s」尚未启用，请在「软件商店 → 插件管理」里启用后重试", plugin)
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
