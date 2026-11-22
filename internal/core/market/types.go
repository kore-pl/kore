// Package market 提供软件商店的本地索引读取、验签与安装触发。
//
// 薄壳边界：只做索引读取/验签/安装调度，不下载包、不审核、不账号化（G-10/G-13）。
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
