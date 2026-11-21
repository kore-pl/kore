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

// printServeUsage 打印 serve 参数说明。
func printServeUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored serve [--config <path>] [--state-dir <dir>]")
}
