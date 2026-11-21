// Package installer 负责插件包的安全校验、解包与原子落位。
//
// 薄壳边界：只做包完整性/安全校验与文件落位；不下载包（market 层）、
// 不做依赖拓扑安装（M2）、不验签（M4）、不拉起插件进程（supervisor）。
package installer

import (
	"log/slog"
	"os"
	"path/filepath"

	"github.com/kore-project/kore/internal/core/store"
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
}

// Installer 是单包安装器；同一 id 的并发安装由调用方串行化。
type Installer struct {
	pluginRoot  string
	koreVersion string
	expectedSHA string
	limits      Limits
	logger      *slog.Logger
	store       Persister
}

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

// New 构造安装器；只做参数检查，不触碰文件系统。
func New(opts Options) (*Installer, error) {
	if opts.StateDir == "" {
		return nil, wrap(ErrStateDir, "state_dir 为空")
	}
	if opts.KoreVersion == "" {
		return nil, wrap(ErrInvalid, "kore 版本为空，无法校验 requires_kore")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	root := opts.PluginDir
	if root == "" {
		root = filepath.Join(opts.StateDir, "plugins")
	}
	return &Installer{
		pluginRoot:  root,
		koreVersion: opts.KoreVersion,
		expectedSHA: opts.ExpectedSHA256,
		limits:      opts.Limits.withDefaults(),
		logger:      logger,
		store:       opts.Store,
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
	sum, err := fileSHA256(path)
	if err != nil {
		return nil, wrap(ErrInvalid, "计算包 sha256 失败：%v", err)
	}
	if err := checkExpectedSHA256(path, sum, in.expectedSHA); err != nil {
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
	if err := extractTarGz(path, staging, in.limits); err != nil {
		return nil, err
	}
	if err := verifySHA256SUMS(staging); err != nil {
		return nil, err
	}
	manifest, err := loadManifest(staging)
	if err != nil {
		return nil, err
	}
	if err := in.checkManifest(ref, manifest); err != nil {
		return nil, err
	}
	return in.commit(staging, manifest, sum)
}
