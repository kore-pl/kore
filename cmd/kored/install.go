package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// installOptions 是 install 子命令解析后的参数。
type installOptions struct {
	// config 是配置文件路径（--config，缺省取 KORE_CONFIG）。
	config string
	// stateDir 是状态目录（--state-dir，缺省取 KORE_STATE_DIR）。
	stateDir string
	// packagePath 是本地包路径（--package）。
	packagePath string
	// scenario 是场景预设 id（--scenario）：批量预设安装归 M2，当前明确返回 E_UNSUPPORTED。
	scenario string
}

// parseInstallFlags 解析 install 参数；flag 自身错误由调用方映射退出码 2。
func parseInstallFlags(args []string, stderr io.Writer) (installOptions, error) {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var opts installOptions
	fs.StringVar(&opts.config, "config", "", "配置文件路径（默认取 KORE_CONFIG）")
	fs.StringVar(&opts.stateDir, "state-dir", "", "状态目录（默认取 KORE_STATE_DIR / 配置文件）")
	fs.StringVar(&opts.packagePath, "package", "", "插件包路径 <id>-<version>.tar.gz")
	fs.StringVar(&opts.scenario, "scenario", "", "场景预设 id（未实现，M2；请用 --package 或面板商店逐插件安装）")
	fs.Usage = func() { printInstallUsage(stderr) }
	if err := fs.Parse(args); err != nil {
		return installOptions{}, err
	}
	return opts, nil
}

// runInstall 是 install 子命令入口：--package 走单包装载，--scenario 明确未实现。
func runInstall(args []string, stdout, stderr io.Writer) int {
	opts, err := parseInstallFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	switch {
	case opts.scenario != "":
		return runScenarioInstall(opts.scenario, stderr)
	case opts.packagePath == "":
		fmt.Fprintln(stderr, "install: 必须指定 --package（单包）；--scenario 未实现（M2）")
		printInstallUsage(stderr)
		return exitConfig
	default:
		return runPackageInstall(opts, stdout, stderr)
	}
}

// runScenarioInstall 明确回 E_UNSUPPORTED：批量预设安装归 M2，不假装成功。
//
// 错误文本必须给出**当前真实可用**的替代路径：单包 CLI 安装 + 面板商店逐插件安装。
// 刻意不写「面板一键装预设」——商店预设卡片的「一键安装」当前是禁用态（M2 才落地），
// 指向不存在的批量路径就是另一种「点了才发现不行」（G-06）。
func runScenarioInstall(id string, stderr io.Writer) int {
	fmt.Fprintf(stderr, "%s: 安装场景预设 %q 未实现（M2 支持批量预设安装）\n", pluginapi.E_UNSUPPORTED, id)
	fmt.Fprintln(stderr, "替代路径（当前可用）：")
	fmt.Fprintln(stderr, "  1) 单包安装：kored install --package <id>-<version>.tar.gz")
	fmt.Fprintln(stderr, "  2) 面板商店：商店页逐个插件点「安装」（POST /api/v1/store/install）；预设卡片「一键安装」当前为禁用态")
	fmt.Fprintln(stderr, "  3) 查看可用预设：GET /api/v1/store/presets（只读元数据，需 KORE_PRESETS_DIR）")
	return exitConfig
}

// runPackageInstall 先做无副作用的包前置校验，再打开状态库并原子安装单个包。
//
// 顺序刻意把「包不存在/包名非法」挡在状态目录之前：只读或错误路径不该先撞权限。
// 统一前置：先解析并对齐「配置文件 + 状态目录」并打印，配置文件缺失且没给 --config 时 fail-closed。
func runPackageInstall(opts installOptions, stdout, stderr io.Writer) int {
	targets, err := resolveCLITargets(opts.config, opts.stateDir, false)
	if err != nil {
		fmt.Fprintf(stderr, "安装失败: %v\n", err)
		return exitConfig
	}
	printCLITargets(stdout, targets)
	if err := installer.ValidatePackage(opts.packagePath); err != nil {
		fmt.Fprintf(stderr, "安装失败: %v\n", err)
		return exitConfig
	}
	snapshot, _, err := coreconfig.Load(coreconfig.Options{
		FlagPath: opts.config, StateDir: opts.stateDir, Logger: slog.Default(),
	})
	if err != nil {
		fmt.Fprintf(stderr, "配置错误: %v\n", err)
		return exitConfig
	}
	state, err := store.Open(snapshot.Paths.StateDir, slog.Default())
	if err != nil {
		fmt.Fprintf(stderr, "状态存储打开失败: %v\n", err)
		if errors.Is(err, store.ErrLocked) {
			printStoreLockedHint(stderr)
		}
		return storeExitCode(err)
	}
	defer func() {
		if closeErr := state.Close(); closeErr != nil {
			fmt.Fprintf(stderr, "状态存储关闭失败: %v\n", closeErr)
		}
	}()
	inst, err := installer.New(installer.Options{
		StateDir:    snapshot.Paths.StateDir,
		PluginDir:   snapshot.Paths.PluginDir,
		KoreVersion: version,
		Logger:      slog.Default(),
		Store:       state,
	})
	if err != nil {
		reportInstallError(stderr, err)
		return installExitCode(err)
	}
	result, err := inst.Install(opts.packagePath)
	if err != nil {
		reportInstallError(stderr, err)
		return installExitCode(err)
	}
	fmt.Fprintf(stdout, "installed %s %s\n", result.ID, result.Version)
	return exitOK
}

// reportInstallError 打印安装错误；状态库被占用时追加可操作的下一步提示。
//
// 原始错误始终原样打印（含持有者 pid），提示只做追加，不替换证据。
func reportInstallError(w io.Writer, err error) {
	fmt.Fprintf(w, "安装失败: %v\n", err)
	if errors.Is(err, store.ErrLocked) {
		printStoreLockedHint(w)
	}
}

// printStoreLockedHint 给出"状态库被占用"时的下一步：先停服务，装完再启动。
func printStoreLockedHint(w io.Writer) {
	fmt.Fprintln(w, "提示: Kore 服务正在运行并独占 state.db，安装插件前请先停止服务：")
	fmt.Fprintln(w, "  systemctl --user stop kored-local       # 用户级实例（portable，bin/kored serve）")
	fmt.Fprintln(w, "  sudo systemctl stop kore                # 系统级实例（fhs，/etc/systemd/system/kore.service）")
	fmt.Fprintln(w, "安装完成后再启动：systemctl --user start kored-local / sudo systemctl start kore")
	fmt.Fprintln(w, "若你用的是商店页面安装（POST /api/v1/store/install），服务无需停止，可直接安装。")
}

// installExitCode 把安装错误映射为退出码：校验 2 / 状态目录或锁 3 / 存储 4。
func installExitCode(err error) int {
	switch {
	case errors.Is(err, installer.ErrStateDir), errors.Is(err, store.ErrLocked), errors.Is(err, store.ErrStateDir):
		return exitState
	case errors.Is(err, installer.ErrStore), errors.Is(err, store.ErrCorrupt),
		errors.Is(err, store.ErrSchemaTooNew), errors.Is(err, store.ErrValueTooLarge), errors.Is(err, store.ErrBucket):
		return exitStore
	default:
		return exitConfig
	}
}

// storeExitCode 把状态库打开失败映射为：锁/目录 3，其余（损坏/schema）4。
func storeExitCode(err error) int {
	if errors.Is(err, store.ErrLocked) || errors.Is(err, store.ErrStateDir) {
		return exitState
	}
	return exitStore
}

// printInstallUsage 打印 install 参数说明。
func printInstallUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored install --package <tar.gz>   （--scenario 未实现，M2）")
	fmt.Fprintln(w, "  --package  安装本地插件包 <id>-<version>.tar.gz（当前唯一可用的安装方式）")
	fmt.Fprintln(w, "  --scenario 场景预设批量安装：未实现（M2），会返回 E_UNSUPPORTED 并列出替代路径")
	fmt.Fprintln(w, "  --config    配置文件路径（缺省按 profile 解析）")
	fmt.Fprintln(w, "  --state-dir 状态目录（覆盖配置）")
	fmt.Fprintln(w, "注意: install 与 serve 独占同一 state.db，serve 运行时请用 POST /api/v1/store/install 安装；CLI install 仅离线使用（在线运行会撞锁 exit 3）")
	fmt.Fprintln(w, "退出码: 0 正常 / 2 校验失败 / 3 状态目录或锁 / 4 存储")
}
