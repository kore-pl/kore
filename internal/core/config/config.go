// Package config 负责 kore 配置的加载、校验与只读快照。
//
// 处理顺序固定为：内置默认值 → 配置文件覆盖 → 环境变量覆盖 → 字段校验。
// 键名与默认值的唯一真源是 docs/DATA-MODEL.md §3；本包只落地行为，不复写字段表。
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// 配置路径与覆盖来源。
const (
	// DefaultPath 是未指定 --config 且未设置 KORE_CONFIG 时的配置文件路径。
	DefaultPath = "/etc/kore/config.yaml"
	// EnvConfigPath 是指定配置文件路径的环境变量名。
	EnvConfigPath = "KORE_CONFIG"
	// EnvStateDir 是覆盖 paths.state_dir 的环境变量名。
	EnvStateDir = "KORE_STATE_DIR"
	// EnvPluginDir 是覆盖 paths.plugin_dir 的环境变量名。
	EnvPluginDir = "KORE_PLUGIN_DIR"
)

// Options 是加载参数。
type Options struct {
	// FlagPath 是 --config 的原始值（KORE_CONFIG 优先于它）。
	FlagPath string
	// StateDir 是 --state-dir 的原始值（KORE_STATE_DIR 优先于它）。
	StateDir string
	// Logger 是告警输出目标；nil 用 slog.Default()。
	Logger *slog.Logger
}

// Warning 是一条不阻断启动的配置告警。
type Warning struct {
	// Source 是配置文件路径。
	Source string
	// Line 是行号；0 表示与具体行无关。
	Line int
	// Key 是字段路径。
	Key string
	// Message 是告警说明。
	Message string
	// Suggestion 是最接近的合法键名；空表示无建议。
	Suggestion string
}

// String 返回可直接写入启动日志的一行文本。
func (w Warning) String() string {
	where := w.Source
	if w.Line > 0 {
		where = fmt.Sprintf("%s:%d", w.Source, w.Line)
	}
	if w.Suggestion != "" {
		return fmt.Sprintf("%s: %s %s（是否想写 %s？）", where, w.Key, w.Message, w.Suggestion)
	}
	return fmt.Sprintf("%s: %s %s", where, w.Key, w.Message)
}

// ResolvePath 按 KORE_CONFIG > --config > profile 默认路径 解析配置路径。
func ResolvePath(flagPath string) string {
	if v := os.Getenv(EnvConfigPath); v != "" {
		return v
	}
	if flagPath != "" {
		return flagPath
	}
	return DefaultConfigPath()
}

// DefaultConfigPath 返回当前 profile 下的默认配置路径：
//   - portable：<install>/config/config.yaml（零侵入，ADR-0023）；
//   - fhs：/etc/kore/config.yaml（发行版打包）。
func DefaultConfigPath() string {
	if resolveProfile() == ProfileFHS {
		return DefaultPath
	}
	return filepath.Join(InstallRoot(), "config", "config.yaml")
}

// Load 解析配置并返回不可变快照；不阻断的告警通过返回值与日志同时给出。
func Load(opts Options) (*Snapshot, []Warning, error) {
	snap, warnings, err := load(opts)
	if err == nil {
		logWarnings(opts.Logger, warnings)
	}
	return snap, warnings, err
}

// load 是 Load 的无日志内核，供 Reload 复用以免重复打印告警。
func load(opts Options) (*Snapshot, []Warning, error) {
	path := ResolvePath(opts.FlagPath)
	data, err := os.ReadFile(path)
	var snap *Snapshot
	var warnings []Warning
	usedDefaultConfig := false
	switch {
	case err == nil:
		snap, warnings, err = parse(path, data)
		if err != nil {
			return nil, warnings, err
		}
	case errors.Is(err, os.ErrNotExist):
		usedDefaultConfig = true
		snap = Default()
		snap.Source = path
		warnings = append(warnings, Warning{
			Source:  path,
			Key:     "config",
			Message: "配置文件不存在，使用内置默认值",
		})
	default:
		return nil, nil, fmt.Errorf("%s: 读取配置失败: %w", path, err)
	}
	warnings = append(warnings, applyOverrides(snap, opts.StateDir)...)
	// 覆盖来源（含环境变量 / 命令行）也可能带相对路径，归一化必须放在最后一步。
	pathWarnings, err := normalizePaths(snap)
	if err != nil {
		return nil, warnings, err
	}
	warnings = append(warnings, pathWarnings...)
	// 零侵入告警（fhs 提示 + 旧路径迁移提示）放在最后：此时路径已就绪。
	warnings = append(warnings, profileWarnings(snap, opts, usedDefaultConfig)...)
	return snap, warnings, nil
}

// applyOverrides 应用命令行/环境变量覆盖，并派生未显式设置的 plugin_dir。
//
// 优先级：KORE_PLUGIN_DIR > paths.plugin_dir（配置文件）> <state_dir>/plugins；
// state_dir 优先级：KORE_STATE_DIR > --state-dir > paths.state_dir > 内置默认。
func applyOverrides(snap *Snapshot, flagStateDir string) []Warning {
	var warnings []Warning
	if flagStateDir != "" {
		snap.Paths.StateDir = flagStateDir
	}
	if v := os.Getenv(EnvStateDir); v != "" {
		snap.Paths.StateDir = v
		warnings = append(warnings, Warning{
			Source:  snap.Source,
			Key:     "paths.state_dir",
			Message: "被环境变量 " + EnvStateDir + " 覆盖为 " + v,
		})
	}
	if v := os.Getenv(EnvPluginDir); v != "" {
		snap.Paths.PluginDir = v
		warnings = append(warnings, Warning{
			Source:  snap.Source,
			Key:     "paths.plugin_dir",
			Message: "被环境变量 " + EnvPluginDir + " 覆盖为 " + v,
		})
	} else if snap.Paths.PluginDir == "" {
		snap.Paths.PluginDir = filepath.Join(snap.Paths.StateDir, "plugins")
	}
	return warnings
}

// logWarnings 把告警逐条写成 WARN；未知字段只告警、不阻断启动。
func logWarnings(logger *slog.Logger, warnings []Warning) {
	if logger == nil {
		logger = slog.Default()
	}
	for _, w := range warnings {
		logger.Warn("配置告警", "detail", w.String())
	}
}
