package supervisor

import (
	"log/slog"
	"time"

	"github.com/kore-project/kore/internal/core/registry"
	"github.com/kore-project/kore/internal/platform"
)

// Manifests 是 supervisor 对 registry 的最小依赖：只读清单与 enabled 状态。
type Manifests interface {
	// Manifest 返回已登记清单；未安装时第二返回值为 false。
	Manifest(id string) (*registry.Manifest, bool)
	// Enabled 报告插件是否已 enable。
	Enabled(id string) bool
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
	// HelloTimeout 是 exec→hello 完成的硬超时，默认 2s。
	HelloTimeout time.Duration
	// ShutdownGrace 是 kore.shutdown 后等进程退出的宽限，默认 5s。
	ShutdownGrace time.Duration
	// QueueLimit 是同一插件冷启动的并发队列上限（含正在启动者），默认 32。
	QueueLimit int
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
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
}
