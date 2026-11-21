package httpapi

import (
	"context"
	"encoding/json"
)

// PluginStatus 是插件列表/启停响应的单插件视图。
//
// state 是运行期实际状态（ready/starting/stopped/failed），desired 是持久化的
// 期望状态（enabled/disabled）；两者分开表达，避免前端把"想开"误读成"已就绪"。
type PluginStatus struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Name 展示名。
	Name string `json:"name"`
	// Version 已安装版本。
	Version string `json:"version"`
	// Lifecycle 生命周期（resident/lazy/oneshot）。
	Lifecycle string `json:"lifecycle"`
	// DepthLevel 深度等级（production/basic）。
	DepthLevel string `json:"depth_level"`
	// State 运行期实际状态。
	State string `json:"state"`
	// Desired 持久化期望状态。
	Desired string `json:"desired"`
	// Restarts 重启计数。
	Restarts int `json:"restarts"`
	// PID 插件进程号；未运行时为 0。
	PID int `json:"pid"`
	// Enabled 是否已在 registry 置为 enabled。
	Enabled bool `json:"enabled"`
}

// SupervisorStats 是 /api/v1/system/info 的 supervisor 统计。
type SupervisorStats struct {
	// Resident 当前有进程的 resident 插件数（ready/starting/draining）。
	Resident int `json:"resident"`
	// Restarts 全部插件重启计数之和。
	Restarts int `json:"restarts"`
}

// Backend 是 httpapi 对装配层（cmd/kored）的最小依赖。
//
// 薄壳边界：httpapi 不直接读 bbolt、不直接 exec 进程，只通过本接口驱动
// registry/supervisor/bus；错误一律以 *pluginapi.Error 透传，由 HTTP 层映射状态码。
type Backend interface {
	// Plugins 返回全部已登记插件的视图（按 id 升序）。
	Plugins(ctx context.Context) ([]PluginStatus, error)
	// Plugin 返回单个插件视图；未安装时第二返回值为 false。
	Plugin(ctx context.Context, id string) (PluginStatus, bool, error)
	// Enable 启用插件并拉起进程（幂等）。
	Enable(ctx context.Context, id string) error
	// Disable 停止进程并退回 installed（幂等）。
	Disable(ctx context.Context, id string) error
	// Invoke 经 bus 转发一次方法调用；params 为插件方法参数原始 JSON。
	Invoke(ctx context.Context, plugin, method string, params json.RawMessage, reqID string) (json.RawMessage, error)
	// Stats 返回 supervisor 统计。
	Stats(ctx context.Context) (SupervisorStats, error)
}
