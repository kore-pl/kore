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

// Paths 是运行期目录。
type Paths struct {
	// StateDir 是状态目录（单文件 bbolt 落点）。
	StateDir string
	// LogDir 是日志目录。
	LogDir string
	// RunDir 是运行目录（socket 与锁）。
	RunDir string
	// PluginDir 是插件解包目录；空表示由 state_dir 派生为 <state_dir>/plugins。
	PluginDir string
	// IndexDir 是本地插件索引目录（plugins.json + plugins.json.sig）。
	IndexDir string
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
	// ResidentMax 是 resident 插件独占配额上限（默认 2，范围 1–3）。
	// 等于 max_slots（3）表示放弃槽位保护，仅排障时使用。
	ResidentMax int
}

// Plugins 是插件安装与启动配置。
type Plugins struct {
	// AllowUnsigned 表示是否允许无签名包（插件包签名，M4）。
	AllowUnsigned bool
	// Autostart 是启动时按序拉起的插件 id。
	Autostart []string
}

// Store 是软件商店（market）配置。
//
// 与 Plugins.AllowUnsigned 语义不同：本字段管索引级 ed25519 签名（M2），
// 默认零值 false；禁止在 Default() 中显式放行，须显式配置并写 WARN 审计。
type Store struct {
	// AllowUnsigned 为 true 时允许未签名/验签失败的索引（仅显式配置）。
	AllowUnsigned bool
}

// Audit 是审计写入面与保留策略配置。
type Audit struct {
	// InvokeAll 为 true 时审计全部 invoke（含只读方法），用于调试；
	// 默认 false 只审计需要 admin 能力的写/管理类方法，避免日志爆炸。
	InvokeAll bool
	// Retention 是审计记录保留期（audit.retention，默认 90 天）；
	// 由 scheduler 内置任务 builtin-audit-clean 按龄删除（DATA-MODEL §11）。
	Retention time.Duration
	// CleanEnabled 为 false 时不注册按龄清理内置任务（audit.clean_enabled）。
	CleanEnabled bool
	// CleanInterval 是清理周期（audit.clean_interval，默认 6h）。
	CleanInterval time.Duration
	// CleanBatch 是单次清理删除上限（audit.clean_batch，默认 1000）。
	CleanBatch int
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
	// Profile 是零侵入安装形态（portable / fhs，ADR-0023）。
	Profile string
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
	// Store 是软件商店配置。
	Store Store
	// Security 是安全配置。
	Security Security
	// Audit 是审计写入面配置。
	Audit Audit
	// CertRenew 是证书续期检查配置。
	CertRenew CertRenew
}

// Default 返回内置默认快照（profile 由 KORE_PROFILE 与可执行文件位置决定，ADR-0023）。
func Default() *Snapshot { return defaultsFor(resolveProfile()) }

// defaultsFor 返回指定 profile 的默认快照：portable 全部落安装目录，fhs 用系统路径。
func defaultsFor(profile string) *Snapshot {
	paths, socket := defaultLayout(profile)
	return &Snapshot{
		Profile: profile,
		Server:  Server{Socket: socket},
		Auth: Auth{
			SessionTTL:   7 * 24 * time.Hour, // ADR-0041：面板默认 7 天；显式配置优先
			CookieSecure: "auto",
		},
		Paths:     paths,
		Log:       Log{Level: "info", Rotate: Rotate{MaxSizeMB: 10, MaxBackups: 5}},
		Resources: Resources{Defaults: Defaults{MemoryMB: 12, CPUQuota: "50%", PidsMax: 128}, Enforce: true, ResidentMax: 2},
		Plugins:   Plugins{AllowUnsigned: true, Autostart: []string{}},
		Security:  Security{LoginRateLimit: RateLimit{Attempts: 5, Window: 60 * time.Second, Lock: 300 * time.Second}},
		Audit: Audit{
			InvokeAll: false,
			// 审计无限增长是真实运维问题：默认保留 90 天，清理走 scheduler
			// 内置任务（单 ticker、单次 ≤1000 条），见 DATA-MODEL §11。
			Retention:     90 * 24 * time.Hour,
			CleanEnabled:  true,
			CleanInterval: 6 * time.Hour,
			CleanBatch:    1000,
		},
		CertRenew: CertRenew{Enabled: false, Interval: 6 * time.Hour},
	}
}

// ConfigDir 返回配置文件所在目录（供平台层创建目录使用）。
func (s *Snapshot) ConfigDir() string {
	if s.Source != "" {
		if dir := filepath.Dir(s.Source); dir != "." && dir != "" {
			return dir
		}
	}
	if s.Profile == ProfileFHS {
		return "/etc/kore"
	}
	return filepath.Join(InstallRoot(), "config")
}
