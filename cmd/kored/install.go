package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"

	coreconfig "github.com/kore-project/kore/internal/core/config"
	"github.com/kore-project/kore/internal/core/installer"
	"github.com/kore-project/kore/internal/core/store"
	"github.com/kore-project/kore/pkg/pluginapi"
)

// installOptions 是 install 子命令解析后的参数。
type installOptions struct {
	// config 是配置文件路径（--config，缺省取 KORE_CONFIG）。
	config string
	// stateDir 是状态目录（--state-dir，缺省取 KORE_STATE_DIR）。
	stateDir string
	// packagePath 是本地包路径（--package）。
	packagePath string
	// scenario 是场景预设 id（--scenario，M2 实现）。
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
	fs.StringVar(&opts.scenario, "scenario", "", "场景预设 id（M2 实现）")
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
		fmt.Fprintln(stderr, "install: 必须指定 --package 或 --scenario")
		printInstallUsage(stderr)
		return exitConfig
	default:
		return runPackageInstall(opts, stdout, stderr)
	}
}

// runScenarioInstall 明确回 E_UNSUPPORTED 语义：场景预设归 M2，不假装成功。
func runScenarioInstall(id string, stderr io.Writer) int {
	fmt.Fprintf(stderr, "%s: 安装场景预设 %q 未实现（M2 支持场景预设）\n", pluginapi.E_UNSUPPORTED, id)
	return exitConfig
}

// runPackageInstall 先做无副作用的包前置校验，再打开状态库并原子安装单个包。
//
// 顺序刻意把「包不存在/包名非法」挡在状态目录之前：只读或错误路径不该先撞权限。
func runPackageInstall(opts installOptions, stdout, stderr io.Writer) int {
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
		fmt.Fprintf(stderr, "安装失败: %v\n", err)
		return installExitCode(err)
	}
	result, err := inst.Install(opts.packagePath)
	if err != nil {
		fmt.Fprintf(stderr, "安装失败: %v\n", err)
		return installExitCode(err)
	}
	fmt.Fprintf(stdout, "installed %s %s\n", result.ID, result.Version)
	return exitOK
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
	fmt.Fprintln(w, "用法: kored install --package <tar.gz> | --scenario <id>")
	fmt.Fprintln(w, "  --package  安装本地插件包 <id>-<version>.tar.gz")
	fmt.Fprintln(w, "  --scenario 安装场景预设（M2 支持）")
	fmt.Fprintln(w, "退出码: 0 正常 / 2 校验失败 / 3 状态目录或锁 / 4 存储")
}
