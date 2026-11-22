package httpapi

import (
	"context"
	"encoding/json"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// PluginWeb 是 info.json 的 web 段对外 DTO（FRONTEND §4.2）。
//
// 只暴露桥建帧所需的最小字段；G-24：显式类型，不用 any/object。
// 前端 fail-closed 依赖 entry 为字符串：无 web 段时 PluginStatus.Web 为 nil（JSON 省略）。
type PluginWeb struct {
	// Entry iframe 文档加载的 ES module 入口（相对包根、.js 结尾）。
	Entry string `json:"entry"`
	// Styles 由 iframe 文档自行加载的样式文件（相对包根），≤5 项。
	Styles []string `json:"styles,omitempty"`
}

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
	// Web 插件前端清单段（info.json 的 web）；无 web 段时为 nil（JSON 省略，前端 fail-closed）。
	Web *PluginWeb `json:"web,omitempty"`
	// GrantedCapabilities 已授予能力集（来源 manifest capabilities / plugins bucket capabilities）。
	GrantedCapabilities []string `json:"granted_capabilities,omitempty"`
	// RequiresRoot 声明插件是否需要宿主 root 权限（ADR-0018）。
	RequiresRoot bool `json:"requires_root,omitempty"`
	// RootActions 是插件声明的固定 argv 提权动作（启用确认与 UI 展示用）。
	RootActions []pluginapi.RootAction `json:"root_actions,omitempty"`
}

// SupervisorStats 是 /api/v1/system/info 的 supervisor 统计。
type SupervisorStats struct {
	// Resident 当前有进程的 resident 插件数（ready/starting/draining）。
	Resident int `json:"resident"`
	// Restarts 全部插件重启计数之和。
	Restarts int `json:"restarts"`
}

// metricsBody 是 GET /api/v1/system/metrics 的成功响应体。
//
// 字段名即前端契约（web/monitor.js），全部为显式标量（G-24，无 any/object）。
type metricsBody struct {
	// CPUPercent 是自上次采样以来的整机 CPU 占用（0–100）。
	CPUPercent float64 `json:"cpu_pct"`
	// RSSKiB 是主壳常驻内存（KiB）。
	RSSKiB uint64 `json:"rss_kib"`
	// DiskUsedKiB 是状态目录所在文件系统已用容量（KiB）。
	DiskUsedKiB uint64 `json:"disk_used_kib"`
	// DiskTotalKiB 是状态目录所在文件系统总容量（KiB）。
	DiskTotalKiB uint64 `json:"disk_total_kib"`
	// Load1 是 1 分钟系统平均负载。
	Load1 float64 `json:"load1"`
	// Goroutines 是当前活跃 goroutine 数。
	Goroutines int `json:"goroutines"`
	// FDs 是当前打开的文件描述符数。
	FDs int `json:"fds"`
	// UptimeSec 是主壳进程运行秒数。
	UptimeSec uint64 `json:"uptime_sec"`
}

// RootActionLookup 是装配层可选实现的 root_actions 查询（ADR-0018）。
// 未实现时 root-action 端点回 501，不假装成功。
type RootActionLookup interface {
	// RootAction 返回插件清单里指定 id 的动作；未声明时第二返回值为 false。
	RootAction(ctx context.Context, pluginID, actionID string) (pluginapi.RootAction, bool, error)
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

// PathsInfo 是 /api/v1/system/info 暴露的运行期目录视图。
//
// 全部为配置加载阶段归一化后的绝对路径：排查"插件二进制找不到"这类问题时，
// 调用方不必再猜进程当前工作目录。
type PathsInfo struct {
	// StateDir 状态目录。
	StateDir string `json:"state_dir"`
	// RunDir 运行目录（socket 与锁）。
	RunDir string `json:"run_dir"`
	// LogDir 日志目录。
	LogDir string `json:"log_dir"`
	// IndexDir 本地插件索引目录。
	IndexDir string `json:"index_dir"`
	// PluginDir 插件解包目录。
	PluginDir string `json:"plugin_dir"`
}
