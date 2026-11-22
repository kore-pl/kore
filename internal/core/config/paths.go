package config

import (
	"fmt"
	"path/filepath"
	"strings"
)

// normalizePaths 把 paths.* 全部归一为绝对路径（Abs + Clean）。
//
// 为什么在配置层做：supervisor 拉起插件时会切换 cmd.Dir，配置里的相对路径
// 若留到下游解释，同一个值在不同进程工作目录下会指向不同位置（真机表现为
// `fork/exec .../bin/site: no such file`）。绝对路径是配置解析产物的一部分，
// 不是使用方各自的补丁。
//
// 不做的事：不展开 `~`（Go 标准库无跨平台家目录语义），遇到波浪号直接报错，
// 避免把 `~/kore` 静默解析成 `<cwd>/~/kore`。
func normalizePaths(s *Snapshot) ([]Warning, error) {
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
	} {
		raw := *item.value
		abs, err := absolutePath(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %s %w", s.Source, item.key, err)
		}
		if abs != raw {
			warnings = append(warnings, Warning{
				Source:  s.Source,
				Key:     item.key,
				Message: "已归一化为绝对路径 " + abs,
			})
		}
		*item.value = abs
	}
	return warnings, nil
}

// absolutePath 把单个配置路径归一为绝对路径；空值与 `~` 前缀明确报错。
func absolutePath(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("不能为空")
	}
	if strings.HasPrefix(raw, "~") {
		return "", fmt.Errorf("不支持 %q 的家目录展开，请改写为绝对路径", "~")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("转绝对路径失败: %w", err)
	}
	return filepath.Clean(abs), nil
}
