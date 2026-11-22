package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/envprobe"
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/internal/core/metrics"
	"github.com/pengtang1024/kore/internal/platform"
)

// socketPath 返回主壳 UDS 路径（平台运行目录下的 kore.sock）。
func socketPath(app *platform.Platform) string {
	return filepath.Join(app.Paths.Dir(platform.DirRun), "kore.sock")
}

// bootstrap 绑定平台实现、探测环境并创建运行期目录，返回退出码。
func bootstrap(cfg config) (*platform.Platform, envprobe.Report, int) {
	app, err := platform.New(platform.Config{
		ConfigDir: cfg.ConfigDir,
		StateDir:  cfg.StateDir,
		RunDir:    cfg.RunDir,
		LogDir:    cfg.LogDir,
	})
	if err != nil {
		slog.Error("平台初始化失败", "err", err)
		if errors.Is(err, platform.ErrUnsupported) {
			return nil, envprobe.Report{}, exitEnv
		}
		return nil, envprobe.Report{}, exitConfig
	}
	facts, err := envprobe.Collect(app)
	if err != nil {
		slog.Error("环境探测失败（按硬要求不满足处理）", "err", err)
		return nil, envprobe.Report{}, exitEnv
	}
	report, err := envprobe.Probe(facts)
	if err != nil {
		slog.Error("环境不满足硬要求", "err", err)
		return nil, envprobe.Report{}, exitEnv
	}
	slog.Info("环境探测完成", "summary", report.String())
	if err := app.Paths.Ensure(); err != nil {
		code := exitState
		if errors.Is(err, platform.ErrUnsupportedFS) {
			code = exitEnv
		}
		slog.Error("运行期目录不可用", "err", err)
		return nil, envprobe.Report{}, code
	}
	return app, report, exitOK
}

// startHTTP 装配并启动 httpapi，返回退出码（绑定失败 = 5）。
func startHTTP(app *platform.Platform, cfg config, report envprobe.Report, svc *service) (*httpapi.Server, int) {
	server := httpapi.New(httpapi.Options{
		Version:        version,
		Report:         report,
		Paths:          pathsInfo(cfg),
		SocketPath:     socketPath(app),
		Addr:           cfg.Addr,
		Backend:        svc.backend,
		Auth:           svc.auth,
		LoginLimiter:   loginLimiter(cfg),
		Market:         buildMarket(cfg, svc),
		AuditLister:    &auditListerFromStore{db: svc.db},
		InstallRefresh: svc.reloadOne,
		Metrics:        metrics.New(app.Paths.Dir(platform.DirState)),
		Privilege:      svc.privilege,
		PluginAuth:     svc.pluginTokenAuth,
	}, app.Transport)
	if err := server.Start(); err != nil {
		slog.Error("HTTP 监听失败", "err", err)
		return nil, exitListen
	}
	return server, exitOK
}

// buildMarket 装配商店：本地索引目录 + 内置公钥验签 + 安装触发器（走现有 installer）。
//
// 信任边界：AllowUnsigned 仅来自显式配置（coreconfig 零值 false），不在默认配置放行。
func buildMarket(cfg config, svc *service) *market.Service {
	if cfg.snapshot == nil {
		return nil
	}
	dir := cfg.snapshot.Paths.IndexDir
	if dir == "" {
		dir = "/var/lib/kore/index"
	}
	opts := market.Options{
		IndexDir:      dir,
		PresetsDir:    os.Getenv("KORE_PRESETS_DIR"), // 预设目录（可选；空则 presets 返回空列表），不写进默认配置
		AllowUnsigned: cfg.snapshot.Store.AllowUnsigned,
		Installer:     installerAdapter(cfg, svc),
	}
	return market.New(opts)
}

// installerAdapter 把现有 installer 包装成 market.Installer：
// 每次安装按索引声明的 expectedSHA 新建 installer（ExpectedSHA256 是构造参数）。
func installerAdapter(cfg config, svc *service) marketInstaller {
	return marketInstaller{cfg: cfg, svc: svc}
}

type marketInstaller struct {
	cfg config
	svc *service
}

func (m marketInstaller) Install(path, expectedSHA string) error {
	inst, err := m.newInstaller(expectedSHA, false)
	if err != nil {
		return err
	}
	_, err = inst.Install(path)
	return err
}

// InstallForce 实现 market.ForceInstaller：先停用 → 备份旧目录 → 安装 → 恢复期望态。
// 安装失败时 installer 已回滚目录，本方法再把旧版本拉回来，避免重装失败把插件打停。
func (m marketInstaller) InstallForce(id, path, expectedSHA string) error {
	return m.withForce(id, expectedSHA, func(inst *installer.Installer) error {
		_, err := inst.Install(path)
		return err
	})
}

// InstallFromURL 让 marketInstaller 同时满足 market.URLInstaller（下载安装）。
//
// 与本地包安装共用同一个 installer：下载只多一段"拉到 <state_dir>/tmp"，
// 摘要比对、解包、落位、落库仍是同一份逻辑，内核不存在第二条安装链路。
func (m marketInstaller) InstallFromURL(ctx context.Context, id, version, url, wantSHA256 string) error {
	inst, err := m.newInstaller(wantSHA256, false)
	if err != nil {
		return err
	}
	return inst.InstallFromURL(ctx, id, version, url, wantSHA256)
}

// InstallFromURLForce 实现 market.ForceURLInstaller（下载路径的强制重装）。
func (m marketInstaller) InstallFromURLForce(ctx context.Context, id, version, url, wantSHA256 string) error {
	return m.withForce(id, wantSHA256, func(inst *installer.Installer) error {
		return inst.InstallFromURL(ctx, id, version, url, wantSHA256)
	})
}

// withForce 串起强制重装的三个装配层动作：停用 → 强制安装 → 恢复期望态。
//
// 停用保证旧进程在目录被替换前退出；恢复只写 desired，enabled 的插件由随后的
// reloadOne 用新清单统一拉起（避免旧二进制先起一次再被杀）。安装失败时把旧插件
// 重新拉起（installer 已回滚旧目录）。
func (m marketInstaller) withForce(id, expectedSHA string, run func(*installer.Installer) error) error {
	if m.svc == nil {
		return fmt.Errorf("service 未装配，无法强制重装")
	}
	wasEnabled, err := m.svc.disableForInstall(id)
	if err != nil {
		return err
	}
	inst, err := m.newInstaller(expectedSHA, true)
	if err != nil {
		m.svc.restoreForInstall(id, wasEnabled, true)
		return err
	}
	installErr := run(inst)
	m.svc.restoreForInstall(id, wasEnabled, installErr != nil)
	return installErr
}

// PreviousVersion 实现 market.PreviousVersionLookup：读已装记录里的版本。
func (m marketInstaller) PreviousVersion(id string) (string, error) {
	if m.svc == nil || m.svc.db == nil {
		return "", nil
	}
	return installer.PreviousVersion(m.svc.db, id)
}

// StaleVersions 实现 market.StaleVersionLister：列出 <plugin_dir>/<id>/ 下
// 除"当前已装版本"与临时目录之外的版本目录，供前端提示清理（内核不自动删除）。
func (m marketInstaller) StaleVersions(id string) ([]string, error) {
	root := m.pluginRoot()
	entries, err := os.ReadDir(filepath.Join(root, id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	current, err := m.PreviousVersion(id)
	if err != nil {
		return nil, err
	}
	stale := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || name == current || !isVersionDirName(name) {
			continue
		}
		stale = append(stale, name)
	}
	sort.Strings(stale)
	return stale, nil
}

// pluginRoot 返回插件落盘根目录（与 installer 的派生规则一致）。
func (m marketInstaller) pluginRoot() string {
	if m.cfg.snapshot != nil {
		if dir := m.cfg.snapshot.Paths.PluginDir; dir != "" {
			return dir
		}
	}
	return filepath.Join(m.cfg.StateDir, "plugins")
}

// isVersionDirName 只认 MAJOR.MINOR.PATCH 三段数字目录，避免把 .staging /
// <ver>.bak-<ts> 这类临时目录当成可清理版本。
func isVersionDirName(name string) bool {
	parts := strings.Split(name, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

// newInstaller 构造一个绑定当前状态目录与状态库的安装器。
func (m marketInstaller) newInstaller(expectedSHA string, force bool) (*installer.Installer, error) {
	if m.svc == nil || m.svc.db == nil {
		return nil, fmt.Errorf("状态库未装配，无法安装")
	}
	return installer.New(installer.Options{
		StateDir:       m.cfg.StateDir,
		PluginDir:      m.cfg.snapshot.Paths.PluginDir,
		KoreVersion:    version,
		ExpectedSHA256: expectedSHA,
		Force:          force,
		Logger:         slog.Default(),
		Store:          m.svc.db,
	})
}

// closeStore 关闭状态库；关闭失败只 WARN，不影响退出码。
func closeStore(state storeCloser) {
	if err := state.Close(); err != nil {
		slog.Warn("状态库关闭失败", "err", err)
	}
}

// storeCloser 是 closeStore 的最小依赖（*store.Store 实现）。
type storeCloser interface {
	// Close 关闭状态库，重复调用幂等。
	Close() error
}

// loginLimiter 按配置装配登录失败限速器（docs/SECURITY §3.5 / CORE §2.3）。
//
// 口径来自 security.login_rate_limit（默认 5 次 / 60s 窗口 / 锁 300s）；
// 配置快照缺失时退回 auth 包默认值，绝不因为配置缺位而跳过限速。
// 状态是纯内存，重启清零（不假装持久化）。
func loginLimiter(cfg config) *auth.LoginLimiter {
	if cfg.snapshot == nil {
		return auth.NewLoginLimiter(auth.DefaultMaxFailures, auth.DefaultWindow, auth.DefaultLockout)
	}
	r := cfg.snapshot.Security.LoginRateLimit
	return auth.NewLoginLimiter(r.Attempts, r.Window, r.Lock)
}
