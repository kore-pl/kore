package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"

	coreconfig "github.com/kore-project/kore/internal/core/config"
	"github.com/kore-project/kore/internal/core/store"
)

// config 是 serve 的运行期配置（由只读配置快照映射而来）。
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
	// snapshot 是当前配置快照，热重载后整体替换。
	snapshot *coreconfig.Snapshot
	// opts 保留原始参数，供 SIGHUP 重新解析。
	opts serveOptions
}

// loadConfig 加载配置快照；任何配置错误都映射退出码 2（CORE §2.1）。
func loadConfig(opts serveOptions, stderr io.Writer) (config, int) {
	snap, _, err := coreconfig.Load(coreconfig.Options{
		FlagPath: opts.config,
		StateDir: opts.stateDir,
		Logger:   slog.Default(),
	})
	if err != nil {
		fmt.Fprintf(stderr, "配置错误: %v\n", err)
		return config{}, exitConfig
	}
	return buildConfig(snap, opts), exitOK
}

// buildConfig 把配置快照映射为运行期配置。
func buildConfig(snap *coreconfig.Snapshot, opts serveOptions) config {
	return config{
		ConfigDir: snap.ConfigDir(),
		StateDir:  snap.Paths.StateDir,
		RunDir:    snap.Paths.RunDir,
		LogDir:    snap.Paths.LogDir,
		Addr:      snap.Server.Addr,
		snapshot:  snap,
		opts:      opts,
	}
}

// reload 按白名单重载配置；失败只记 ERROR 并保留旧快照，不退出进程。
func (c *config) reload() {
	next, _, err := c.snapshot.Reload(coreconfig.Options{
		FlagPath: c.opts.config,
		StateDir: c.opts.stateDir,
		Logger:   slog.Default(),
	})
	if err != nil {
		slog.Error("配置重载失败，保留旧快照", "err", err)
		return
	}
	c.snapshot = next
	// 不可热更字段由 Reload 保留旧值，这里同步映射不会改变它们。
	c.ConfigDir = next.ConfigDir()
	c.StateDir = next.Paths.StateDir
	c.RunDir = next.Paths.RunDir
	c.LogDir = next.Paths.LogDir
	c.Addr = next.Server.Addr
}

// openStore 打开状态库：锁 / 状态目录 → 3，损坏 / schema → 4。
func openStore(cfg config, stderr io.Writer) (*store.Store, int) {
	st, err := store.Open(cfg.StateDir, slog.Default())
	if err == nil {
		return st, exitOK
	}
	fmt.Fprintf(stderr, "状态存储打开失败: %v\n", err)
	if errors.Is(err, store.ErrLocked) || errors.Is(err, store.ErrStateDir) {
		return nil, exitState
	}
	return nil, exitStore
}
