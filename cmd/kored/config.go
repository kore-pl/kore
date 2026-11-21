package main

import (
	"fmt"
	"io"
	"os"
)

// config 是 serve 的运行期配置。
//
// M1 只有内置默认值 + --state-dir / KORE_STATE_DIR 覆盖；YAML 解析、未知键 WARN、
// 字段校验与 SIGHUP 热重载白名单由 M1-03（internal/core/config）补齐——补齐前
// 不解析任何 YAML 文件，server.addr 也固定为空（只监听 UDS，符合 M1 默认不监听 TCP）。
type config struct {
	// ConfigDir 配置目录。
	ConfigDir string
	// StateDir 状态目录。
	StateDir string
	// RunDir 运行目录（UDS 与锁文件落点）。
	RunDir string
	// LogDir 日志目录。
	LogDir string
	// Addr 可选 TCP 监听地址；空表示只监听 UDS。
	Addr string
}

// loadConfig 返回内置默认值并应用命令行 / 环境变量覆盖。
func loadConfig(opts serveOptions, stderr io.Writer) config {
	cfg := config{
		ConfigDir: "/etc/kore",
		StateDir:  "/var/lib/kore",
		RunDir:    "/run/kore",
		LogDir:    "/var/log/kore",
	}
	if opts.config != "" {
		if _, err := os.Stat(opts.config); err != nil {
			// CORE §2.1：文件不存在用内置默认值 + WARN，不拒绝启动。
			fmt.Fprintf(stderr, "[WARN] 配置文件 %s 不可读（%v），使用内置默认值\n", opts.config, err)
		}
	}
	if opts.stateDir != "" {
		cfg.StateDir = opts.stateDir
	}
	return cfg
}
