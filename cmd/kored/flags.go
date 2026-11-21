package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

// serveOptions 是 serve 子命令解析后的参数。
type serveOptions struct {
	// config 是配置文件路径（--config，缺省取 KORE_CONFIG）。
	config string
	// stateDir 是状态目录（--state-dir，缺省取 KORE_STATE_DIR）。
	stateDir string
}

// parseServeFlags 解析 serve 参数；flag 自身错误直接交给调用方映射退出码 2。
func parseServeFlags(args []string, stderr io.Writer) (serveOptions, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", os.Getenv("KORE_CONFIG"), "配置文件路径（默认取 KORE_CONFIG）")
	stateDir := fs.String("state-dir", os.Getenv("KORE_STATE_DIR"), "状态目录（默认取 KORE_STATE_DIR）")
	fs.Usage = func() { printServeUsage(stderr) }
	if err := fs.Parse(args); err != nil {
		return serveOptions{}, err
	}
	return serveOptions{config: *configPath, stateDir: *stateDir}, nil
}

// runInstall 只解析 --package / --scenario 并明确回"未实现（M2）"，不写任何安装逻辑。
func runInstall(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(stderr)
	packagePath := fs.String("package", "", "插件包路径（M2 实现）")
	scenario := fs.String("scenario", "", "场景预设 id（M2 实现）")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}
	if *packagePath == "" && *scenario == "" {
		fmt.Fprintln(stderr, "install: 必须指定 --package 或 --scenario")
		printInstallUsage(stderr)
		return exitConfig
	}
	fmt.Fprintf(stdout, "install: 未实现（M2）——参数已解析 package=%q scenario=%q\n", *packagePath, *scenario)
	return exitOK
}

// printServeUsage 打印 serve 参数说明。
func printServeUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored serve [--config <path>] [--state-dir <dir>]")
}

// printInstallUsage 打印 install 参数说明。
func printInstallUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored install --package <tar.gz> | --scenario <id>")
}
