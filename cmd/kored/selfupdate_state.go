package main

// 本地更新状态文件（ADR-0023 §3.5 豁免 #5 / §11；U3 有限放宽 2026-11-26）。
//
// 全系统只有这一个安装目录外状态文件：<state>/update-state.json（portable 即
// <install>/data/update-state.json）。它只记录更新链的阶段与版本等状态元数据，
// **不写凭据 / token / 口令**（G-30）；不新增 unit / 系统用户 / 常驻任务落盘。
//
// 契约（三条，缺一不可）：
//  1. 创建或覆写前先向 <state>/changes.jsonl 追加一条 purge_op=file.remove 的
//     账本记录（复用 §3.5 豁免 #3 的既有账本，不造第二套）；登记失败即拒绝写盘。
//  2. 状态文件 0600、属主为当前 kored 进程 uid（root 服务即 root、portable 即当前
//     用户，由 CreateTemp 天然继承），写盘走"临时文件 + fsync + rename + fsync 目录"。
//  3. 回滚只走白名单 file.remove：kore uninstall --purge 读账本逐条执行本模块登记
//     的操作；手工回滚 = rm <path> 后从账本删该行（见 RUNBOOK-INSTALL §6.2）。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// updateStateFileName 是豁免 #5 唯一允许的状态文件名；不得扩展为目录树。
const updateStateFileName = "update-state.json"

// 更新阶段白名单（提案 §3.1 的 phase 枚举；未知阶段一律拒绝，避免半写状态被当真）。
const (
	updatePhaseDownloading = "downloading"
	updatePhaseVerified    = "verified"
	updatePhaseInstalled   = "installed"
	updatePhasePending     = "pending"
	updatePhaseCommitted   = "committed"
	updatePhaseRolledBack  = "rolled_back"
)

// updateState 是状态文件的显式 schema——所有字段都是 string，禁止 object / any
// 逃逸（G-24）。字段集合即凭据边界：这里没有也不允许有 password / secret / token。
type updateState struct {
	Phase           string `json:"phase"`
	TargetVersion   string `json:"target_version"`
	PreviousVersion string `json:"previous_version"`
	AssetSHA256     string `json:"asset_sha256"`
	Unit            string `json:"unit"`
	CommitResult    string `json:"commit_result"`
	StartedAt       string `json:"started_at"`
	FinishedAt      string `json:"finished_at"`
}

// updateStateSummary 是账本里的人话摘要（ADR-0023 §3.5 #5 指定文案）。
const updateStateSummary = "更新状态记录"

// updateStateAction 是账本 action id（内核自身写入，plugin 字段用 "kore" 标识内核）。
const (
	updateStatePlugin = "kore"
	updateStateAction = "selfupdate.state.write"
)

// updateStatePath 计算状态文件绝对路径并做边界校验。
//
// 拒绝：空 / 相对 / 非规范（含 ..）/ 根路径 / ADR-0023 §3.5 明列的清单外系统目录。
// 本模块**不提供安装目录外路径注入**：用户显式配置的外置单文件路径属另一个决策，
// 不在 U3 有限放宽范围内，避免借配置项把"一个文件"变成"任意路径"。
func updateStatePath(stateDir string) (string, error) {
	if strings.TrimSpace(stateDir) == "" {
		return "", fmt.Errorf("更新状态: 状态目录为空")
	}
	if !filepath.IsAbs(stateDir) {
		return "", fmt.Errorf("更新状态: 状态目录必须是绝对路径: %s", stateDir)
	}
	clean := filepath.Clean(stateDir)
	if clean != stateDir {
		return "", fmt.Errorf("更新状态: 状态目录必须规范化（不得含 .. 或重复分隔符）: %s", stateDir)
	}
	if clean == "/" {
		return "", fmt.Errorf("更新状态: 拒绝根状态目录")
	}
	for _, forbidden := range []string{
		"/etc", "/var/lib", "/var/log", "/run", "/usr/lib/systemd",
	} {
		if clean == forbidden || strings.HasPrefix(clean, forbidden+"/") {
			return "", fmt.Errorf("更新状态: 拒绝清单外系统路径 %s（ADR-0023 §3.5）", clean)
		}
	}
	return filepath.Join(clean, updateStateFileName), nil
}

// validateUpdateState 校验显式 schema：阶段白名单 + 版本必填。
// 未知阶段 fail-closed——"写了个看不懂的状态"比"没有状态"更危险。
func validateUpdateState(st updateState) error {
	switch st.Phase {
	case updatePhaseDownloading, updatePhaseVerified, updatePhaseInstalled,
		updatePhasePending, updatePhaseCommitted, updatePhaseRolledBack:
	default:
		return fmt.Errorf("更新状态: 未知 phase %q", st.Phase)
	}
	if strings.TrimSpace(st.TargetVersion) == "" {
		return fmt.Errorf("更新状态: target_version 必填")
	}
	return nil
}

// recordUpdateStateChange 在写盘**之前**落账。登记失败即 fail-closed（ADR-0023 §11）。
// 账本 append-only + 0600 + fsync 由 appendChange 保证（changes.go，未改动）。
func recordUpdateStateChange(stateDir, path string) error {
	return appendChange(changesPath(stateDir), changeEntry{
		Summary:    updateStateSummary,
		Plugin:     updateStatePlugin,
		Action:     updateStateAction,
		Target:     path,
		Reversible: true,
		PurgeOp: &purgeOp{
			Kind: purgeKindFileRemove,
			Args: []string{path},
		},
	})
}

// writeUpdateState 创建 / 覆写状态文件：先落账，再原子写盘。
//
// 顺序不可颠倒：账本写失败时目标文件一个字节都不动（与 upgrade.go 的
// "校验先于替换"同口径）。账本成功但写盘失败会留一条指向不存在文件的
// file.remove 条目——该操作幂等，不会误删他人文件。
func writeUpdateState(stateDir string, st updateState) (string, error) {
	path, err := updateStatePath(stateDir)
	if err != nil {
		return "", err
	}
	if err := validateUpdateState(st); err != nil {
		return "", err
	}
	if err := recordUpdateStateChange(stateDir, path); err != nil {
		return "", fmt.Errorf("更新状态: 账本登记失败，拒绝写状态文件: %w", err)
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("更新状态: 创建目录失败: %w", err)
	}
	data, err := json.Marshal(st)
	if err != nil {
		return "", fmt.Errorf("更新状态: 序列化失败: %w", err)
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(dir, ".update-state-*")
	if err != nil {
		return "", fmt.Errorf("更新状态: 创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpName)
		}
	}()

	// CreateTemp 是 0600，显式 Chmod 固化为契约（umask 不影响 0600）。
	if err := tmp.Chmod(0o600); err != nil {
		return "", fmt.Errorf("更新状态: 设置 0600 失败: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return "", fmt.Errorf("更新状态: 写临时文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return "", fmt.Errorf("更新状态: fsync 临时文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("更新状态: 关闭临时文件失败: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return "", fmt.Errorf("更新状态: 原子替换失败: %w", err)
	}
	committed = true

	// rename 本身也要落盘（与 upgrade.go 的原子替换口径一致）。
	if dh, err := os.Open(dir); err == nil {
		_ = dh.Sync()
		_ = dh.Close()
	}
	return path, nil
}

// readUpdateState 严格读取状态文件：未知字段一律拒绝，防止有人往文件里塞凭据字段。
func readUpdateState(stateDir string) (updateState, error) {
	path, err := updateStatePath(stateDir)
	if err != nil {
		return updateState{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return updateState{}, fmt.Errorf("更新状态: 打开 %s 失败: %w", path, err)
	}
	defer file.Close()
	dec := json.NewDecoder(file)
	dec.DisallowUnknownFields()
	var st updateState
	if err := dec.Decode(&st); err != nil {
		return updateState{}, fmt.Errorf("更新状态: 解析 %s 失败: %w", path, err)
	}
	if err := validateUpdateState(st); err != nil {
		return updateState{}, err
	}
	return st, nil
}

// purgeUpdateState 走既有白名单 file.remove 回滚单个状态文件（不执行 shell 字符串）。
// kore uninstall --purge 会遍历账本执行同一操作，这里给手工回滚与门禁提供同一原语。
func purgeUpdateState(stateDir string) error {
	path, err := updateStatePath(stateDir)
	if err != nil {
		return err
	}
	return executePurgeOp(purgeOp{Kind: purgeKindFileRemove, Args: []string{path}})
}

// updateStateLedgerHasRemove 判断账本里是否有指向该状态文件的 file.remove 条目。
// 门禁用它断言"有状态文件 ⟹ 有可回滚账本条目"（ADR-0023 §11 第 2 条）。
func updateStateLedgerHasRemove(stateDir string) (bool, error) {
	path, err := updateStatePath(stateDir)
	if err != nil {
		return false, err
	}
	entries, _, err := readChanges(changesPath(stateDir))
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.Target != path || entry.PurgeOp == nil {
			continue
		}
		if entry.PurgeOp.Kind == purgeKindFileRemove &&
			len(entry.PurgeOp.Args) == 1 && entry.PurgeOp.Args[0] == path {
			return true, nil
		}
	}
	return false, nil
}
