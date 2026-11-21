package config

import (
	"path/filepath"
	"time"
)

// Server 是 HTTP / UDS 入口配置。
type Server struct {
	// Addr 是可选 TCP 监听地址；空表示只监听 UDS。
	Addr string
	// Socket 是主壳 UDS 路径。
	Socket string
	// TLS 是 TLS 开关；MVP 固定 false。
	TLS bool
}

// Auth 是单管理员鉴权配置。
type Auth struct {
	// AdminPasswordHash 是 PBKDF2 存储串；空表示首启 bootstrap。
	AdminPasswordHash string
	// SessionTTL 是会话滑动过期时长。
	SessionTTL time.Duration
	// CookieSecure 取 auto / true / false。
	CookieSecure string
	// Initialized 表示是否已完成首启口令生成。
	Initialized bool
}

// Paths 是四类运行期目录。
type Paths struct {
	// StateDir 是状态目录（单文件 bbolt 落点）。
	StateDir string
	// LogDir 是日志目录。
	LogDir string
	// RunDir 是运行目录（socket 与锁）。
	RunDir string
	// PluginDir 是插件解包目录；空表示由 state_dir 派生为 <state_dir>/plugins。
	PluginDir string
}

// Rotate 是日志轮转阈值。
type Rotate struct {
	// MaxSizeMB 是单文件轮转阈值（MiB）。
	MaxSizeMB int
	// MaxBackups 是保留份数。
	MaxBackups int
}

// Log 是日志配置。
type Log struct {
	// Level 取 debug / info / warn / error。
	Level string
	// Rotate 是轮转阈值。
	Rotate Rotate
}

// Defaults 是插件未声明资源时的兜底值。
type Defaults struct {
	// MemoryMB 是内存上限（MiB）。
	MemoryMB int
	// CPUQuota 是单核百分比配额串，如 "50%"。
	CPUQuota string
	// PidsMax 是进程数上限。
	PidsMax int
}

// Resources 是资源限额配置。
type Resources struct {
	// Defaults 是插件缺省资源。
	Defaults Defaults
	// Enforce 为 false 时只监控不写限额。
	Enforce bool
}

// Plugins 是插件安装与启动配置。
type Plugins struct {
	// AllowUnsigned 表示是否允许无签名包。
	AllowUnsigned bool
	// Autostart 是启动时按序拉起的插件 id。
	Autostart []string
}

// RateLimit 是登录限速参数。
type RateLimit struct {
	// Attempts 是窗口内失败次数上限。
	Attempts int
	// Window 是计数窗口。
	Window time.Duration
	// Lock 是触发后的锁定时长。
	Lock time.Duration
}

// Security 是安全相关配置。
type Security struct {
	// LoginRateLimit 是登录限速。
	LoginRateLimit RateLimit
}

// CertRenew 是唯一允许的常驻定时器配置。
type CertRenew struct {
	// Enabled 为 false 时内核不创建任何 ticker。
	Enabled bool
	// Interval 是检查周期（仅 Enabled 时生效）。
	Interval time.Duration
}

// Snapshot 是一次解析产物；加载完成后调用方只读，不做原地修改。
type Snapshot struct {
	// Source 是本次解析使用的配置文件路径（文件不存在时仍记录期望路径）。
	Source string
	// Server 是入口配置。
	Server Server
	// Auth 是鉴权配置。
	Auth Auth
	// Paths 是运行期目录。
	Paths Paths
	// Log 是日志配置。
	Log Log
	// Resources 是资源限额。
	Resources Resources
	// Plugins 是插件配置。
	Plugins Plugins
	// Security 是安全配置。
	Security Security
	// CertRenew 是证书续期检查配置。
	CertRenew CertRenew
}

// Default 返回内置默认快照（不含任何文件与环境覆盖）。
func Default() *Snapshot {
	return &Snapshot{
		Server: Server{Socket: "/run/kore/kore.sock"},
		Auth: Auth{
			SessionTTL:   12 * time.Hour,
			CookieSecure: "auto",
		},
		Paths: Paths{
			StateDir: "/var/lib/kore",
			LogDir:   "/var/log/kore",
			RunDir:   "/run/kore",
		},
		Log:       Log{Level: "info", Rotate: Rotate{MaxSizeMB: 10, MaxBackups: 5}},
		Resources: Resources{Defaults: Defaults{MemoryMB: 12, CPUQuota: "50%", PidsMax: 128}, Enforce: true},
		Plugins:   Plugins{AllowUnsigned: true, Autostart: []string{}},
		Security:  Security{LoginRateLimit: RateLimit{Attempts: 5, Window: 60 * time.Second, Lock: 300 * time.Second}},
		CertRenew: CertRenew{Enabled: false, Interval: 6 * time.Hour},
	}
}

// ConfigDir 返回配置文件所在目录（供平台层创建目录使用）。
func (s *Snapshot) ConfigDir() string {
	dir := filepath.Dir(s.Source)
	if dir == "." || dir == "" {
		return "/etc/kore"
	}
	return dir
}
