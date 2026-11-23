package supervisor

import (
	"context"
	"log/slog"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/platform"
)

// Manifests 是 supervisor 对 registry 的最小依赖：只读清单与 enabled 状态。
type Manifests interface {
	// Manifest 返回已登记清单；未安装时第二返回值为 false。
	Manifest(id string) (*registry.Manifest, bool)
	// Enabled 报告插件是否已 enable。
	Enabled(id string) bool
}

// Credentials 是凭据注入的最小依赖（credential.Service 实现）。
type Credentials interface {
	// EnvFor 返回 KEY=value 形式的环境变量；调用方不得记录其内容（G-30）。
	EnvFor(ctx context.Context, pluginID string) ([]string, error)
}

// Options 是 Manager 的构造参数，全部由装配层（cmd/kored）注入。
type Options struct {
	// Transport 是平台层 UDS 传输（Listen / Dial / PeerCred）。
	Transport platform.Transport
	// Manifests 是清单来源（registry.Catalog 实现）。
	Manifests Manifests
	// RunDir 是插件 socket 父目录（/run/kore/plugins）；测试用 t.TempDir()。
	RunDir string
	// LogDir 是插件 stdout/stderr 目录；空串表示丢弃输出（前台调试/单测）。
	LogDir string
	// Version 是内核版本，写进 hello 响应。
	Version string
	// KernelSocket 是**独立通道 socket** 路径（ADR-0018 方案①）；非空时注入插件
	// KORE_KERNEL_SOCK，供插件经 root-action 通道请求内核代理提权。空串表示通道
	// 不可用（非 root / 未启用），插件据此显式返回 E_NEED_ROOT，而不是去连管理面。
	KernelSocket string
	// PluginDataRoot 是插件数据根的父目录（portable 下 <install>/data/plugin-data）；
	// 非空时启动前创建 <root>/<id>（0700，属主 kore-<id>）并注入 KORE_PLUGIN_DATA。
	// 与 plugin_dir 安装树**必须分离**：数据根可写，安装树不可写（防篡改自身包）。
	PluginDataRoot string
	// InstallDir 是安装根（<install>）；非空时注入 KORE_INSTALL_DIR，供插件定位
	// 自身只读资源（模板/默认配置），不得用于写。
	InstallDir string
	// ChannelGroup 是通道 socket 的共享属组（Linux，默认 kore）：插件用户会在
	// 降权时被加入该组，并随 Credential 获得该 gid，从而能 connect 0660 的通道
	// socket；socket 本身由 httpapi 以 root:<group> 0660 创建。
	ChannelGroup string
	// HelloTimeout 是 exec→hello 完成的硬超时，默认 2s。
	HelloTimeout time.Duration
	// ShutdownGrace 是 kore.shutdown 后等进程退出的宽限，默认 5s。
	ShutdownGrace time.Duration
	// QueueLimit 是同一插件冷启动的并发队列上限（含正在启动者），默认 32。
	QueueLimit int
	// MaxSlots 是同时常驻槽位上限（resident + 活跃 lazy），默认 3（G-03 / 提案 §4）。
	MaxSlots int
	// ResidentMax 是 resident 插件独占配额上限，默认 2（lazy 至少保留 1 槽）。
	// 必须 ≤ MaxSlots；等于 MaxSlots 表示放弃槽位保护（仅排障用，会 WARN）。
	ResidentMax int
	// IdleTimeout 是 lazy 空闲退出时长，默认 60s；清单 idle_timeout_s 优先。
	IdleTimeout time.Duration
	// Auditor 是审计出口（M3-C）；nil 表示不审计。由装配层注入 store 实现，
	// supervisor 只依赖该单方法接口，不 import config/store（G-01）。
	Auditor Auditor
	// Credentials 在启插件时返回该插件可见的凭据 env（ADR-0026）；nil 不注入。
	// 只返回 owner 或显式 grantee 的条目，未授权不注入、不降级。
	Credentials Credentials
	// Identity 是插件低权身份的解析/创建/应用（ADR-0018）；nil 用宿主实现。
	// 平台专有 API 全部收在 internal/platform（G-16）。
	Identity platform.Identity
	// Access 是降权所需的属主与可穿越权限；nil 用宿主实现。
	Access platform.Access
	// Logger 可空，默认 slog.Default()。
	Logger *slog.Logger
}

// withDefaults 只填空值，不覆盖调用方显式配置。
func (o *Options) withDefaults() {
	if o.HelloTimeout <= 0 {
		o.HelloTimeout = defaultHelloTimeout
	}
	if o.ShutdownGrace <= 0 {
		o.ShutdownGrace = defaultShutdownGrace
	}
	if o.QueueLimit <= 0 {
		o.QueueLimit = defaultQueueLimit
	}
	if o.MaxSlots <= 0 {
		o.MaxSlots = defaultMaxSlots
	}
	if o.ResidentMax <= 0 {
		o.ResidentMax = defaultResidentMaxSlots
	}
	if o.ResidentMax > o.MaxSlots {
		// 配置层已拒绝越界值；这里兜底防止直接调 New 时绕过保护。
		o.ResidentMax = o.MaxSlots
	}
	if o.IdleTimeout <= 0 {
		o.IdleTimeout = defaultIdleTimeout
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.ChannelGroup == "" {
		o.ChannelGroup = "kore"
	}
	if o.Identity == nil {
		o.Identity = platform.SystemIdentity()
	}
	if o.Access == nil {
		o.Access = platform.SystemAccess()
	}
}
