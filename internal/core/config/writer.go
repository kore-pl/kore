package config

// ADR-0056 T4：配置写入端点的冷字段判据。
// 唯一真源是 reload.go 的 coldChanged（含 paths.index_dir），本文件只做导出与显式写入，
// 不复制判据、不改 reload.go（credential 卡写域）。

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ConfigUpdates 是面板允许写入的显式配置项（G-24：不用 any/map 逃逸）。
// 每个字段的零值表示"不改"；字符串字段用指针区分"不改"与"清空"（路径不允许清空）。
type ConfigUpdates struct {
	IndexDir  *string `json:"index_dir,omitempty"`
	PluginDir *string `json:"plugin_dir,omitempty"`
	LogLevel  *string `json:"log_level,omitempty"`
	Addr      *string `json:"addr,omitempty"`
	InvokeAll *bool   `json:"invoke_all,omitempty"`
}

// ColdFieldsChanged 返回应用 updates 后需要重启的字段列表（复用 reload.go 的 coldChanged）。
func ColdFieldsChanged(old *Snapshot, updates ConfigUpdates) []string {
	if old == nil {
		return nil
	}
	next := *old
	applyUpdates(&next, updates)
	return coldChanged(old, &next)
}

// applyUpdates 把显式字段写入快照副本（只用于判据，不修改运行态快照）。
func applyUpdates(s *Snapshot, u ConfigUpdates) {
	if u.IndexDir != nil {
		s.Paths.IndexDir = *u.IndexDir
	}
	if u.PluginDir != nil {
		s.Paths.PluginDir = *u.PluginDir
	}
	if u.LogLevel != nil {
		s.Log.Level = *u.LogLevel
	}
	if u.Addr != nil {
		s.Server.Addr = *u.Addr
	}
	if u.InvokeAll != nil {
		s.Audit.InvokeAll = *u.InvokeAll
	}
}

// WriteConfigUpdates 把显式更新原子写回配置文件（行级就地改写，保留注释与键顺序）。
// 返回更新后的快照与冷字段列表；写盘失败不修改任何状态。
func WriteConfigUpdates(path string, old *Snapshot, updates ConfigUpdates) (*Snapshot, []string, error) {
	if old == nil {
		return nil, nil, errors.New("当前配置快照为空")
	}
	if strings.TrimSpace(path) == "" {
		return nil, nil, errors.New("配置文件路径为空")
	}
	cold := ColdFieldsChanged(old, updates)
	raw, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, fmt.Errorf("读取配置文件失败: %w", err)
	}
	doc := string(raw)
	if u := updates.IndexDir; u != nil {
		doc = upsertNestedKey(doc, "paths", "index_dir", quoteYAML(*u))
	}
	if u := updates.PluginDir; u != nil {
		doc = upsertNestedKey(doc, "paths", "plugin_dir", quoteYAML(*u))
	}
	if u := updates.LogLevel; u != nil {
		doc = upsertNestedKey(doc, "log", "level", quoteYAML(*u))
	}
	if u := updates.Addr; u != nil {
		doc = upsertNestedKey(doc, "server", "addr", quoteYAML(*u))
	}
	if u := updates.InvokeAll; u != nil {
		doc = upsertNestedKey(doc, "audit", "invoke_all", strconv.FormatBool(*u))
	}
	if err := atomicWriteConfig(path, doc); err != nil {
		return nil, nil, err
	}
	next := *old
	applyUpdates(&next, updates)
	next.Source = path
	return &next, cold, nil
}

// quoteYAML 给字符串加双引号（值只来自显式字段，不接受任意 YAML 片段）。
func quoteYAML(value string) string {
	return strconv.Quote(value)
}

// upsertNestedKey 在 YAML 文本的 section 段内就地设置 key: value；
// section 不存在时追加。走行级改写，保留用户注释与键顺序。
func upsertNestedKey(doc, section, key, value string) string {
	lines := strings.Split(doc, "\n")
	sectionLine := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == section+":" {
			sectionLine = i
			break
		}
	}
	if sectionLine < 0 {
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
			lines = lines[:len(lines)-1]
		}
		lines = append(lines, section+":", "  "+key+": "+value, "")
		return strings.Join(lines, "\n")
	}
	end := len(lines)
	for j := sectionLine + 1; j < len(lines); j++ {
		trimmed := strings.TrimSpace(lines[j])
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if !strings.HasPrefix(lines[j], " ") && !strings.HasPrefix(lines[j], "\t") {
			end = j
			break
		}
	}
	for j := sectionLine + 1; j < end; j++ {
		if strings.HasPrefix(strings.TrimSpace(lines[j]), key+":") {
			lines[j] = "  " + key + ": " + value
			return strings.Join(lines, "\n")
		}
	}
	lines = append(lines[:end], append([]string{"  " + key + ": " + value}, lines[end:]...)...)
	return strings.Join(lines, "\n")
}

// atomicWriteConfig 临时文件 + fsync + rename（半写配置比没有配置更危险）。
func atomicWriteConfig(path, content string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".kore-config-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
