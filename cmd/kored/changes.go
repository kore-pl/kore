package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// changesFileName 是宿主变更账本的文件名（ADR-0023 §3.4/§3.5 豁免 #3）。
const changesFileName = "changes.jsonl"

// purgeOp 是结构化回滚操作——账本里**不存 shell 命令字符串**。
//
// 类型与 kind 白名单的唯一真源在 pkg/pluginapi（协议的一部分），这里只做别名：
// 插件声明与账本写入必须同一套结构，避免"声明一套、写账本另一套"。
type purgeOp = pluginapi.PurgeOp

const (
	// purgeKindFileRemove 删除单个文件。
	purgeKindFileRemove = pluginapi.PurgeKindFileRemove
	// purgeKindFileRestore 用备份覆盖目标文件。
	purgeKindFileRestore = pluginapi.PurgeKindFileRestore
)

// changeEntry 是一条"用户批准的宿主变更"。
type changeEntry struct {
	TS string `json:"ts"`
	// Summary 是人话摘要（root 动作取 action.description），用户视图第一列。
	Summary    string   `json:"summary,omitempty"`
	Plugin     string   `json:"plugin"`
	Action     string   `json:"action"`
	Target     string   `json:"target"`
	Before     string   `json:"before,omitempty"`
	After      string   `json:"after,omitempty"`
	Reversible bool     `json:"reversible"`
	PurgeOp    *purgeOp `json:"purge_op,omitempty"`
}

// rootChangeRecorder 把 root-action 成功后的宿主变更追加进 changes.jsonl。
//
// 这是「软件替用户改了什么」的产品化落点：命令行执行 → 用户可见账本 → 可回滚。
// 不改审计表结构（bbolt 只图追加/按龄清理），账本仍是 append-only + fsync，
// 回滚只按结构化 purge_op 分派，永不执行字符串命令。
type rootChangeRecorder struct {
	path string
}

// newRootChangeRecorder 构造账本出口（路径 = <state>/changes.jsonl）。
func newRootChangeRecorder(stateDir string) *rootChangeRecorder {
	return &rootChangeRecorder{path: changesPath(stateDir)}
}

// RecordHostChange 实现 privilege.ChangeRecorder。
func (r *rootChangeRecorder) RecordHostChange(_ context.Context, change privilege.HostChange) error {
	summary := change.Summary
	if strings.TrimSpace(summary) == "" {
		// 没有 description 时退化为动作 id——宁可不好看，也不能丢条目。
		summary = change.ActionID
	}
	return appendChange(r.path, changeEntry{
		Summary:    summary,
		Plugin:     change.PluginID,
		Action:     change.ActionID,
		Target:     change.Target,
		Reversible: change.PurgeOp != nil,
		PurgeOp:    change.PurgeOp,
	})
}

// changesPath 返回账本路径：<state>/changes.jsonl。
func changesPath(stateDir string) string { return filepath.Join(stateDir, changesFileName) }

// appendChange 追加一条变更记录（0600，append-only，fsync）。
func appendChange(path string, entry changeEntry) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("changes: 路径为空")
	}
	if strings.TrimSpace(entry.Plugin) == "" || strings.TrimSpace(entry.Action) == "" || strings.TrimSpace(entry.Target) == "" {
		return fmt.Errorf("changes: plugin / action / target 必填")
	}
	if entry.Reversible && entry.PurgeOp == nil {
		return fmt.Errorf("changes: reversible=true 必须带结构化 purge_op（不允许 shell 字符串）")
	}
	if entry.TS == "" {
		entry.TS = time.Now().Format(time.RFC3339)
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("changes: 序列化失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("changes: 创建目录失败: %w", err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("changes: 打开账本失败: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("changes: 写入失败: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("changes: fsync 失败: %w", err)
	}
	return nil
}

// readChanges 读取账本；坏行跳过并计数（一行坏不拖垮卸载清单）。
func readChanges(path string) ([]changeEntry, int, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil
		}
		return nil, 0, fmt.Errorf("读取变更账本 %s 失败: %w", path, err)
	}
	defer file.Close()
	var entries []changeEntry
	skipped := 0
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry changeEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil || entry.Target == "" {
			skipped++
			continue
		}
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, skipped, fmt.Errorf("读取变更账本 %s 失败: %w", path, err)
	}
	return entries, skipped, nil
}

// purgeOpString 是给人看的操作描述（不是可执行命令）。
func purgeOpString(op purgeOp) string {
	return op.Kind + " " + strings.Join(op.Args, " ")
}

// executePurgeOp 按 kind 分派结构化回滚操作；未知 kind 一律拒绝（不猜、不兜底）。
func executePurgeOp(op purgeOp) error {
	switch op.Kind {
	case purgeKindFileRemove:
		if len(op.Args) != 1 {
			return fmt.Errorf("file.remove 需要 1 个参数（path）")
		}
		path := op.Args[0]
		if err := validatePurgePath(path); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("file.remove %s 失败: %w", path, err)
		}
		return nil
	case purgeKindFileRestore:
		if len(op.Args) != 2 {
			return fmt.Errorf("file.restore 需要 2 个参数（原文件, 目标）")
		}
		src, dst := op.Args[0], op.Args[1]
		if err := validatePurgePath(src); err != nil {
			return err
		}
		if err := validatePurgePath(dst); err != nil {
			return err
		}
		if err := os.Rename(src, dst); err != nil {
			return fmt.Errorf("file.restore %s → %s 失败: %w", src, dst, err)
		}
		return nil
	default:
		return fmt.Errorf("未知 purge kind %q（仅支持 file.remove / file.restore）", op.Kind)
	}
}

// validatePurgePath 拒绝空路径 / 根目录 / 含 .. 的路径，避免误删。
func validatePurgePath(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("purge 路径为空")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("purge 路径必须是绝对路径: %s", path)
	}
	clean := filepath.Clean(path)
	if clean == "/" || clean == "." {
		return fmt.Errorf("拒绝操作根路径: %s", path)
	}
	// Clean 会折叠 `..`（`/etc/../passwd` → `/passwd`），故比对原串拒绝非规范路径。
	if clean != path {
		return fmt.Errorf("路径必须是规范化绝对路径（不得含 .. 或重复分隔符）: %s", path)
	}
	return nil
}
