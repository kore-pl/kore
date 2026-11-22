// Package market 提供软件商店的本地索引读取、验签与安装触发。
//
// 薄壳边界：只做索引读取/验签/安装调度；下载与摘要校验交给 installer，market 只负责
// "从已验签索引取 download_url 与 sha256"，不审核、不账号化（G-10/G-13）。
// 信任根是内置公钥与本地验签结果，索引本身只是发现渠道。
package market

// Index 是 index/plugins.json 的顶层结构（schema_version=1）。
type Index struct {
	// SchemaVersion 必须是 1；其他版本拒绝加载。
	SchemaVersion int `json:"schema_version"`
	// Plugins 是索引条目，按 id 升序由加载层保证。
	Plugins []Plugin `json:"plugins"`
}

// Plugin 是索引中的单条插件记录（对外 schema 显式列字段，禁 any/object，G-24）。
type Plugin struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Name 展示名。
	Name string `json:"name"`
	// Version 可安装版本。
	Version string `json:"version"`
	// DepthLevel 深度等级（production/basic）。
	DepthLevel string `json:"depth_level"`
	// Lifecycle 生命周期（resident/lazy/oneshot）。
	Lifecycle string `json:"lifecycle"`
	// SizeBytes 包字节数。
	SizeBytes int64 `json:"size_bytes"`
	// SHA256 包摘要（64 位小写 hex），安装时由 kore 自算比对。
	SHA256 string `json:"sha256"`
	// DownloadURL 发布物地址（M2 仅展示，不下载）。
	DownloadURL string `json:"download_url"`
	// RequiresKore 兼容的内核版本区间。
	RequiresKore string `json:"requires_kore"`
	// DependsOn 依赖的插件 id 列表。
	DependsOn []string `json:"depends_on"`
	// Conflicts 冲突的插件 id 列表。
	Conflicts []string `json:"conflicts"`
	// ScenarioTags 场景标签。
	ScenarioTags []string `json:"scenario_tags"`
}

// Preset 是 kore-plugins/presets 下的预设元数据（对外 schema 显式列字段，禁 any/object，G-24）。
// 本模块只列元数据，不解析安装计划（安装计划属 installer 职责，G-13 边界）。
type Preset struct {
	// ID 预设 id。
	ID string `json:"id"`
	// Name 展示名。
	Name string `json:"name"`
	// Description 场景说明。
	Description string `json:"description"`
	// OutOfBox 是否开箱可用（basic 深度插件不得标 true，由 presets-check 守护）。
	OutOfBox bool `json:"out_of_box"`
	// Plugins 预设引用的插件条目。
	Plugins []PresetPlugin `json:"plugins"`
}

// PresetPlugin 是预设中的单条插件引用。
type PresetPlugin struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Version 目标版本（精确版本，区间校验属 presets-check）。
	Version string `json:"version"`
	// Desired 期望状态（enabled/disabled）。
	Desired string `json:"desired"`
}

// RefreshResult 是 POST /store/refresh 的结果视图。
type RefreshResult struct {
	// Refreshed 是否成功刷新。
	Refreshed bool `json:"refreshed"`
	// PluginCount 已验签索引的插件条数。
	PluginCount int `json:"plugin_count"`
	// Message 可读说明。
	Message string `json:"message"`
}

// UpdateResult 是 POST /store/update 的结果视图。
type UpdateResult struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Version 目标版本。
	Version string `json:"version"`
	// State 结果状态（succeeded）。
	State string `json:"state"`
	// Message 可读说明。
	Message string `json:"message"`
}

// InstallJob 是安装任务的进度视图（M2 固定状态，异步队列留 M3）。
type InstallJob struct {
	// ID 任务 id。
	ID string `json:"id"`
	// PluginID 目标插件 id。
	PluginID string `json:"plugin_id"`
	// Version 目标版本。
	Version string `json:"version"`
	// State 任务状态（queued/succeeded/failed）。
	State string `json:"state"`
	// Message 可读说明。
	Message string `json:"message"`
}
