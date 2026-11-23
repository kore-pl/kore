package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// changesFileName 是宿主变更账本的文件名（ADR-0023 §3.4/§3.5 豁免 #3）。
const changesFileName = "changes.jsonl"

// purgeOp 是结构化回滚操作——账本里**不存 shell 命令字符串**。
//
// 为什么：以 root 执行账本里的任意字符串等于把 RCE 面写进文件；结构化 op 只允许
// 白名单 kind + 参数，由 executePurgeOp 分派，未知 kind 直接拒绝。
type purgeOp struct {
	// Kind 是白名单操作类型：file.remove / file.restore。
	Kind string `json:"kind"`
	// Args 是操作参数（file.remove: [path]；file.restore: [原文件, 目标]）。
	Args []string `json:"args"`
}

const (
	// purgeKindFileRemove 删除单个文件。
	purgeKindFileRemove = "file.remove"
	// purgeKindFileRestore 用备份覆盖目标文件。
	purgeKindFileRestore = "file.restore"
)

// changeEntry 是一条"用户批准的宿主变更"。
type changeEntry struct {
	TS         string   `json:"ts"`
	Plugin     string   `json:"plugin"`
	Action     string   `json:"action"`
	Target     string   `json:"target"`
	Before     string   `json:"before,omitempty"`
	After      string   `json:"after,omitempty"`
	Reversible bool     `json:"reversible"`
	PurgeOp    *purgeOp `json:"purge_op,omitempty"`
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
	return nil
}
