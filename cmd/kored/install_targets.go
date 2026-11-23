package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
)

// cliTargets 是一次 CLI 执行将对齐的「配置文件 + 状态目录」绝对路径。
//
// 存在的意义：CLI 与 serve 各自解析路径时，只要有一处回落到默认值，就会静默读写
// 第二个 state.db（2026-11-23 实测事故）。因此所有会改状态的 CLI 都必须先解析、先打印。
type cliTargets struct {
	// ConfigPath 是本次生效配置文件的绝对路径（不保证存在）。
	ConfigPath string
	// StateDir 是本次生效的状态目录绝对路径。
	StateDir string
	// Profile 是本次生效的零侵入 profile（portable / fhs）。
	Profile string
	// ConfigExists 表示配置文件是否真实存在。
	ConfigExists bool
	// ExplicitConfig 表示用户是否显式指定了配置（--config 或 KORE_CONFIG）。
	ExplicitConfig bool
}

// resolveCLITargets 解析 CLI 的配置/状态路径，并在 allowMissing=false 时对"配置文件不存在
// 且用户没显式给 --config"做 fail-closed（绝不按默认值另建 state.db）。
func resolveCLITargets(flagConfig, flagStateDir string, allowMissing bool) (cliTargets, error) {
	explicit := strings.TrimSpace(flagConfig) != "" || strings.TrimSpace(os.Getenv(coreconfig.EnvConfigPath)) != ""
	configPath := coreconfig.ResolvePath(flagConfig)
	absConfig, err := filepath.Abs(configPath)
	if err != nil {
		return cliTargets{}, fmt.Errorf("解析配置文件路径失败: %w", err)
	}
	targets := cliTargets{ConfigPath: absConfig, ExplicitConfig: explicit}
	if _, err := os.Stat(absConfig); err == nil {
		targets.ConfigExists = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		return targets, fmt.Errorf("探测配置文件 %s 失败: %w", absConfig, err)
	}
	snap, _, err := coreconfig.Load(coreconfig.Options{
		FlagPath: flagConfig,
		StateDir: flagStateDir,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		return targets, err
	}
	targets.StateDir = snap.Paths.StateDir
	if abs, absErr := filepath.Abs(snap.Paths.StateDir); absErr == nil {
		targets.StateDir = abs
	}
	targets.Profile = snap.Profile
	if !targets.ConfigExists && !allowMissing {
		if targets.ExplicitConfig {
			return targets, fmt.Errorf("配置文件 %s 不存在（该路径由 --config / %s 显式指定）："+
				"CLI 不会按默认值另建一个状态库；请修正路径，或用 `kored status` 查看运行中的配置路径",
				absConfig, coreconfig.EnvConfigPath)
		}
		return targets, fmt.Errorf("未找到配置文件 %s：CLI 不能按内置默认值另建一个状态库。"+
			"若 Kore 正以某个 --config 运行，请用同一个 --config 执行本命令；"+
			"可用 `kored status` 查看运行中的配置路径", absConfig)
	}
	return targets, nil
}

// printCLITargets 打印本次执行对齐的路径（每次 CLI 输出都有这一行，不一致一眼可见）。
func printCLITargets(w io.Writer, t cliTargets) {
	state := "存在"
	if !t.ConfigExists {
		state = "不存在"
	}
	fmt.Fprintf(w, "配置: %s（%s）｜状态目录: %s\n", t.ConfigPath, state, t.StateDir)
}

// fileExists 判断路径是否存在（只用于打印"存在/不存在"，不改变行为）。
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// readStatePID 读取状态库锁持有者 pid（store 的 state.lock 记录）；读不到返回 0。
func readStatePID(stateDir string) int {
	data, err := os.ReadFile(filepath.Join(stateDir, "state.lock"))
	if err != nil {
		return 0
	}
	pid := 0
	if _, err := fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &pid); err != nil || pid <= 0 {
		return 0
	}
	return pid
}
