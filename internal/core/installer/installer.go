// Package installer 负责插件包的安全校验、解包与原子落位。
//
// 薄壳边界：只做包完整性/安全校验与文件落位；出站只收敛在 InstallFromURL 一处
// （把索引声明的 download_url 拉到 <state_dir>/tmp，摘要校验通过后交回 Install）；
// 不做依赖拓扑安装（M2）、不验签（M4）、不拉起插件进程（supervisor）。
package installer

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/pengtang1024/kore/internal/core/store"
)

// Persister 是落库所需的最小能力；*store.Store 直接满足。
type Persister interface {
	// View 执行只读事务。
	View(func(*store.Tx) error) error
	// Update 执行写事务。
	Update(func(*store.Tx) error) error
}

// Options 是构造 Installer 的参数。
type Options struct {
	// StateDir 是状态目录（KORE_STATE_DIR / paths.state_dir）。
	StateDir string
	// PluginDir 是插件根目录；空表示 <StateDir>/plugins。
	PluginDir string
	// KoreVersion 是当前内核版本，用于 requires_kore 区间比对。
	KoreVersion string
	// ExpectedSHA256 是调用方给出的包 sha256；空表示只信包旁 .sha256（若有）。
	ExpectedSHA256 string
	// Limits 是包与解包上限；零值字段取协议默认值。
	Limits Limits
	// Logger 是诊断日志目标；nil 用 slog.Default()。
	Logger *slog.Logger
	// Store 是状态库句柄；安装成功后据此写 plugins / plugin_state。
	Store Persister
	// Force 为 true 时允许覆盖已存在的同 id 同版本目录（修复/重装）：
	// 先把旧目录原子备份，安装失败回滚，成功才删除备份。
	Force bool
	// Progress 是安装阶段进度回调；nil 表示不上报（CLI 与测试）。
	// 阶段固定为 download / verify / extract / register，percent 是 0–100 的总体进度；
	// reload 阶段在装配层（安装返回后重载 registry/supervisor）上报。
	Progress ProgressFunc
	// HTTPClient 覆盖 InstallFromURL 的下载客户端；nil 用内置客户端。
	// 内置客户端固定 60 s 总超时并禁用 keep-alive（G-19：安装后不残留空闲连接）。
	// 注入面只给"自定义代理 / 私有 CA 信任 / 测试 TLS 服务器"，超时仍受 ctx 60 s 约束。
	HTTPClient *http.Client
}

// Installer 是单包安装器；同一 id 的并发安装由调用方串行化。
type Installer struct {
	stateDir    string
	pluginRoot  string
	koreVersion string
	expectedSHA string
	limits      Limits
	logger      *slog.Logger
	store       Persister
	client      *http.Client
	force       bool
	progress    ProgressFunc
}

// ProgressFunc 上报一次安装进度；id/version 是任务标识，message 面向用户。
type ProgressFunc func(id, version, phase string, percent int, message string)

// Result 是一次成功安装的结果。
type Result struct {
	// ID 是插件 id（与包名、info.json 三者一致）。
	ID string
	// Version 是插件版本。
	Version string
	// Dir 是落位后的版本目录。
	Dir string
	// SHA256 是安装时自算的包 sha256（不采信包内声明）。
	SHA256 string
}

// ensureRoot 确保插件根目录存在且为 0755（可穿越、可列举）。
//
// 根目录若沿用 MkdirAll 的 0700，root 安装后非 root 启动的 kored 连插件目录都
// 进不去（清单"读不到 → 未安装"）。插件包内容公开，根目录 0755 不构成泄密。
func (in *Installer) ensureRoot() error {
	if err := os.MkdirAll(in.pluginRoot, 0o755); err != nil {
		return wrap(ErrStateDir, "建立插件根目录失败：%v", err)
	}
	if err := os.Chmod(in.pluginRoot, 0o755); err != nil {
		return wrap(ErrStateDir, "设置插件根目录权限失败：%v", err)
	}
	return nil
}

// New 构造安装器；只做参数检查，不触碰文件系统。
func New(opts Options) (*Installer, error) {
	if opts.StateDir == "" {
		return nil, wrap(ErrStateDir, "state_dir 为空")
	}
	if opts.KoreVersion == "" {
		return nil, wrap(ErrInvalid, "Kore 版本为空，无法校验 requires_kore")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	root := opts.PluginDir
	if root == "" {
		root = filepath.Join(opts.StateDir, "plugins")
	}
	client := opts.HTTPClient
	if client == nil {
		client = defaultDownloadClient
	}
	return &Installer{
		stateDir:    opts.StateDir,
		pluginRoot:  root,
		koreVersion: opts.KoreVersion,
		expectedSHA: opts.ExpectedSHA256,
		limits:      opts.Limits.withDefaults(),
		logger:      logger,
		store:       opts.Store,
		client:      client,
		force:       opts.Force,
		progress:    opts.Progress,
	}, nil
}

// Install 按固定顺序校验并原子安装：
// 包名/存在性/大小 → 包级 sha256 → 安全解包 → 包内 SHA256SUMS →
// info.json 必填字段 → requires_kore → id 与 entry 一致性 → 原子 rename → 落库。
// 任一步失败都会清理 staging，不留半装态。
func (in *Installer) Install(path string) (*Result, error) {
	if _, err := statPackage(path, in.limits); err != nil {
		return nil, err
	}
	ref, err := parsePackageName(path)
	if err != nil {
		return nil, err
	}
	in.report(ref, "verify", 40, "正在校验包摘要…")
	sum, err := fileSHA256(path)
	if err != nil {
		return nil, wrap(ErrInvalid, "计算包 sha256 失败：%v", err)
	}
	if err := checkExpectedSHA256(path, sum, in.expectedSHA); err != nil {
		return nil, err
	}
	in.report(ref, "verify", 45, "包摘要校验通过")
	if err := in.ensureRoot(); err != nil {
		return nil, err
	}
	staging, err := in.newStaging(ref)
	if err != nil {
		return nil, err
	}
	defer func() {
		if cleanupErr := os.RemoveAll(staging); cleanupErr != nil {
			in.logger.Warn("清理安装临时目录失败", "dir", staging, "err", cleanupErr)
		}
	}()
	in.report(ref, "extract", 60, "正在安全解包…")
	if err := extractTarGz(path, staging, in.limits); err != nil {
		return nil, err
	}
	in.report(ref, "extract", 72, "正在校验包内文件清单…")
	if err := verifySHA256SUMS(staging); err != nil {
		return nil, err
	}
	in.report(ref, "extract", 78, "文件清单校验通过")
	manifest, err := loadManifest(staging)
	if err != nil {
		return nil, err
	}
	if err := in.checkManifest(ref, manifest); err != nil {
		return nil, err
	}
	in.report(ref, "register", 82, "正在登记插件…")
	result, err := in.commit(staging, manifest, sum)
	if err != nil {
		return nil, err
	}
	in.report(ref, "register", 95, "插件已落盘")
	return result, nil
}

// report 上报一次阶段进度；Progress 未装配时是空操作。
func (in *Installer) report(ref pkgRef, phase string, percent int, message string) {
	if in.progress == nil {
		return
	}
	in.progress(ref.ID, ref.Version, phase, percent, message)
}
