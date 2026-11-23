package config

import (
	"fmt"
	"path/filepath"
	"strings"
)

// normalizePaths 把 paths.* 与 server.socket 统一归一为绝对路径（Abs + Clean）。
//
// 为什么在配置层做：supervisor 拉起插件时会切换 cmd.Dir，配置里的相对路径
// 若留到下游解释，同一个值在不同进程工作目录下会指向不同位置（真机表现为
// `fork/exec .../bin/site: no such file`）。绝对路径是配置解析产物的一部分，
// 不是使用方各自的补丁。
//
// 相对路径的基准是 baseDir，即**配置文件所在目录**，不是进程 cwd。
// 曾经的实现用 filepath.Abs(raw) 直接取 cwd，后果是同一份配置文件在不同目录
// 启动 `kored` 会算出不同的状态库（第二个 state.db，不报错、结果错）。
// 基准改成配置文件目录后，配置的语义与"谁在哪个目录敲命令"解耦。
//
// 不做的事：不展开 `~`（Go 标准库无跨平台家目录语义），遇到波浪号直接报错，
// 避免把 `~/kore` 静默解析成 `<cwd>/~/kore`。
func normalizePaths(s *Snapshot, baseDir string) ([]Warning, error) {
	var warnings []Warning
	for _, item := range []struct {
		key   string
		value *string
	}{
		{"paths.state_dir", &s.Paths.StateDir},
		{"paths.log_dir", &s.Paths.LogDir},
		{"paths.run_dir", &s.Paths.RunDir},
		{"paths.index_dir", &s.Paths.IndexDir},
		{"paths.plugin_dir", &s.Paths.PluginDir},
		{"server.socket", &s.Server.Socket},
	} {
		raw := *item.value
		abs, err := absolutePath(raw, baseDir)
		if err != nil {
			return nil, fmt.Errorf("%s: %s %w", s.Source, item.key, err)
		}
		if abs != raw {
			warnings = append(warnings, Warning{
				Source: s.Source,
				Key:    item.key,
				Message: fmt.Sprintf("已归一化为绝对路径 %s（相对值 %q 按配置文件目录 %s 解析，与启动目录无关）",
					abs, raw, baseDir),
			})
		}
		*item.value = abs
	}
	return warnings, nil
}

// absolutePath 把单个配置路径归一为绝对路径；空值与 `~` 前缀明确报错。
//
// 已是绝对路径的值原样 Clean；相对路径以 baseDir 为基准（baseDir 为空时退回 cwd，
// 仅用于没有配置文件的极端兜底）。
func absolutePath(raw, baseDir string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("不能为空")
	}
	if strings.HasPrefix(raw, "~") {
		return "", fmt.Errorf("不支持 %q 的家目录展开，请改写为绝对路径", "~")
	}
	if filepath.IsAbs(raw) {
		return filepath.Clean(raw), nil
	}
	if !filepath.IsAbs(baseDir) {
		// 配置文件路径本身是相对的：先按 cwd 把它立住，后续相对值再跟它走。
		if abs, err := filepath.Abs(baseDir); err == nil {
			baseDir = abs
		}
	}
	abs, err := filepath.Abs(filepath.Join(baseDir, raw))
	if err != nil {
		return "", fmt.Errorf("转绝对路径失败: %w", err)
	}
	return filepath.Clean(abs), nil
}

// configBaseDir 返回配置文件所在目录（绝对路径），作为配置内相对路径的解析基准。
//
// 配置文件不存在（使用内置默认值）时仍返回它**期望**所在的目录：默认值本身已是
// 绝对路径，这里的基准只影响用户自己写的相对值。
func configBaseDir(configPath string) string {
	if configPath == "" {
		if cwd, err := filepath.Abs("."); err == nil {
			return filepath.Clean(cwd)
		}
		return "."
	}
	if abs, err := filepath.Abs(configPath); err == nil {
		return filepath.Dir(filepath.Clean(abs))
	}
	return filepath.Dir(filepath.Clean(configPath))
}
