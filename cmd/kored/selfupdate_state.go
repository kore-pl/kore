package main

// 本地更新状态文件（ADR-0023 §3.5 豁免 #5 / §11；U3 有限放宽 2026-11-26）。
//
// 全系统只有这一个安装目录外状态文件：<state>/update-state.json（portable 即
// <install>/data/update-state.json）。它只记录更新链的阶段与版本等状态元数据，
// **不写凭据 / token / 口令**（G-30）；不新增 unit / 系统用户 / 常驻任务落盘。
//
// 契约（红队 1d26977 后加固为五条，缺一不可）：
//  1. 创建或覆写前先向 <state>/changes.jsonl 追加一条 purge_op=file.remove 的
//     账本记录（复用 §3.5 豁免 #3 的既有账本，不造第二套）；登记失败即拒绝写盘。
//  2. 状态文件 0600、属主为当前 kored 进程 uid（root 服务即 root、portable 即当前
//     用户，由 CreateTemp 天然继承），写盘走"临时文件 + fsync + rename + fsync 目录"。
//  3. 回滚只走白名单 file.remove：kore uninstall --purge 读账本逐条执行本模块登记
//     的操作；手工回滚 = rm <path> 后从账本删该行（见 RUNBOOK-INSTALL §6.2）。
//  4. 【D-1】读路径 fail-closed：状态文件必须能对应到账本里的 file.remove 条目，
//     账本缺失 / 条目被删 / 解析失败一律拒绝读取，绝不把孤儿状态当真。
//  5. 【D-2/D-3】回滚范围收口 + 路径解析：purge 仅允许 file.remove 且目标必须
//     精确等于本模块的 updateStatePath(stateDir)，越界 fail-closed + WARN；
//     路径经 EvalSymlinks 解析，符号链接重定向（含指向清单外目录）一律拒绝。

import (
	"encoding/json"
	"fmt"
	"log/slog"
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

// forbiddenStateRoots 是 ADR-0023 §3.5 明列的清单外系统路径（字符串层 + 解析后都要挡）。
var forbiddenStateRoots = []string{"/etc", "/var/lib", "/var/log", "/run", "/usr/lib/systemd"}

// validateStateDirBoundary 校验单个路径不在清单外系统目录下（字符串层与解析后共用）。
func validateStateDirBoundary(path string) error {
	for _, forbidden := range forbiddenStateRoots {
		if path == forbidden || strings.HasPrefix(path, forbidden+"/") {
			return fmt.Errorf("更新状态: 拒绝清单外系统路径 %s（ADR-0023 §3.5）", path)
		}
	}
	return nil
}

// evalSymlinksAllowMissing 解析符号链接；目录尚未创建时解析已存在的最近祖先再拼回尾部。
// 这样首次写盘（stateDir 不存在）与已存在目录走同一套解析口径，不给 symlink 留缝。
func evalSymlinksAllowMissing(path string) (string, error) {
	return evalSymlinksDepth(path, 0)
}

// evalSymlinksDepth 是 evalSymlinksAllowMissing 的带深度上限实现（防 symlink 环）。
func evalSymlinksDepth(path string, depth int) (string, error) {
	if depth > 16 {
		return "", fmt.Errorf("更新状态: 符号链接层级过深（>16）: %s", path)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", fmt.Errorf("更新状态: 解析路径 %s 失败: %w", path, err)
	}
	// 悬空 symlink：EvalSymlinks 也返回 IsNotExist，但父目录解析会把链接名
	// 原样拼回，从而漏掉重定向（S5-c）。这里显式 Readlink 取真实目标再校验。
	if info, lerr := os.Lstat(path); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
		target, rerr := os.Readlink(path)
		if rerr != nil {
			return "", fmt.Errorf("更新状态: 读取符号链接 %s 失败: %w", path, rerr)
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		return evalSymlinksDepth(filepath.Clean(target), depth+1)
	}
	// 从目标本身开始向上收集"不存在的后缀分量"，直到某个祖先存在；
	// 解析该祖先后再按原顺序拼回全部后缀（含目标自身的 basename）。
	missing := []string{filepath.Base(path)}
	cur := filepath.Dir(path)
	for {
		resolved, err = filepath.EvalSymlinks(cur)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("更新状态: 解析路径 %s 失败: %w", path, err)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", fmt.Errorf("更新状态: 解析路径 %s 失败: 找不到已存在的祖先目录", path)
		}
		missing = append(missing, filepath.Base(cur))
		cur = parent
	}
}

// updateStatePath 计算状态文件绝对路径并做边界校验。
//
// 拒绝：空 / 相对 / 非规范（含 ..）/ 根路径 / ADR-0023 §3.5 明列的清单外系统目录。
// 【D-3】解析符号链接后复核：解析结果与输入不同（即存在重定向）一律拒绝，
// 既挡 symlink stateDir 穿透（S5-b），也挡 symlink 指向 /etc 等清单外目录（S5-c）。
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
	if err := validateStateDirBoundary(clean); err != nil {
		return "", err
	}
	resolved, err := evalSymlinksAllowMissing(clean)
	if err != nil {
		return "", err
	}
	if err := validateStateDirBoundary(resolved); err != nil {
		return "", err
	}
	if resolved != clean {
		return "", fmt.Errorf("更新状态: 拒绝符号链接 / 路径重定向（%s → %s），防止穿透清单外目录（D-3）", clean, resolved)
	}
	return filepath.Join(resolved, updateStateFileName), nil
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
// 账本 append-only + fsync 由 appendChange 保证（changes.go，未改动）。
// 【D-4】changes.go 的 OpenFile mode 对已存在文件无效，故在本层**写前 + 写后**都
// 显式 Chmod 0600：写前收紧消除 0644 暴露窗口，写后兜底 NEW/EXIST 两种路径。
func recordUpdateStateChange(stateDir, path string) error {
	ledger := changesPath(stateDir)
	// 账本本身若是 symlink，Chmod 会穿透到外部文件——先拒绝（D-3 同源）。
	if info, err := os.Lstat(ledger); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("更新状态: 账本路径是符号链接，拒绝登记: %s", ledger)
		}
		if err := os.Chmod(ledger, 0o600); err != nil {
			return fmt.Errorf("更新状态: 收紧账本权限失败: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("更新状态: 检查账本失败: %w", err)
	}
	if err := appendChange(ledger, changeEntry{
		Summary:    updateStateSummary,
		Plugin:     updateStatePlugin,
		Action:     updateStateAction,
		Target:     path,
		Reversible: true,
		PurgeOp: &purgeOp{
			Kind: purgeKindFileRemove,
			Args: []string{path},
		},
	}); err != nil {
		return err
	}
	if err := os.Chmod(ledger, 0o600); err != nil {
		return fmt.Errorf("更新状态: 写后收紧账本权限失败（fail-closed）: %w", err)
	}
	return nil
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
// 【D-1】读路径复核账本：状态文件存在但账本缺失 / file.remove 条目被删 / 账本解析
// 失败时一律 fail-closed。调用侧（未来的升级链 / M6）必须把本函数的 error 当作
// "不可继续"，不得降级为"无状态"。当前 M5 是唯一读写点，暂无其它生产调用者。
func readUpdateState(stateDir string) (updateState, error) {
	path, err := updateStatePath(stateDir)
	if err != nil {
		return updateState{}, err
	}
	// 状态文件本身是 symlink → 读取会穿透到外部，拒绝（D-3 同源）。
	if info, err := os.Lstat(path); err != nil {
		return updateState{}, fmt.Errorf("更新状态: 检查 %s 失败: %w", path, err)
	} else if info.Mode()&os.ModeSymlink != 0 {
		return updateState{}, fmt.Errorf("更新状态: 状态文件是符号链接，拒绝读取: %s", path)
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
	// 【D-1】孤儿状态 fail-closed：账本探针从"仅门禁使用"提升为读路径必经校验。
	ok, err := updateStateLedgerHasRemove(stateDir)
	if err != nil {
		return updateState{}, fmt.Errorf("更新状态: 账本校验失败，拒绝读取孤儿状态: %w", err)
	}
	if !ok {
		return updateState{}, fmt.Errorf("更新状态: 账本缺少 %s 的 file.remove 条目，拒绝读取孤儿状态（D-1）", path)
	}
	return st, nil
}

// validateM5PurgeOp 是本模块回滚操作的唯一收口（D-2）。
//
// 三条硬约束：
//  1. kind 只允许 file.remove（file.restore 等可被篡改用于覆盖任意文件，M5 不用）；
//  2. 参数恰好 1 个绝对路径，且解析 symlink 后仍规范；
//  3. 目标必须**精确等于** updateStatePath(stateDir) —— 账本被篡改指向 stateDir
//     外任意路径时拒绝执行并 WARN（fail-closed），杜绝把 purge 变成任意删除器。
func validateM5PurgeOp(stateDir string, op purgeOp) error {
	if op.Kind != purgeKindFileRemove {
		slog.Warn("更新状态: 拒绝非白名单 purge kind", "kind", op.Kind, "state_dir", stateDir)
		return fmt.Errorf("更新状态: 拒绝 purge kind %q（M5 仅允许 file.remove，D-2）", op.Kind)
	}
	if len(op.Args) != 1 {
		slog.Warn("更新状态: 拒绝参数个数异常的 purge op", "count", len(op.Args), "state_dir", stateDir)
		return fmt.Errorf("更新状态: file.remove 需要 1 个参数，实际 %d（D-2）", len(op.Args))
	}
	if err := validatePurgePath(op.Args[0]); err != nil {
		slog.Warn("更新状态: 拒绝非法 purge 路径", "target", op.Args[0], "err", err)
		return fmt.Errorf("更新状态: purge 路径非法（D-2）: %w", err)
	}
	expected, err := updateStatePath(stateDir)
	if err != nil {
		return err
	}
	target, err := evalSymlinksAllowMissing(op.Args[0])
	if err != nil {
		return err
	}
	if target != expected {
		slog.Warn("更新状态: 拒绝越界 purge 目标", "target", target, "expected", expected, "state_dir", stateDir)
		return fmt.Errorf("更新状态: purge 目标 %s 不在允许范围（应为 %s，D-2）", target, expected)
	}
	return nil
}

// purgeUpdateState 走收口后的白名单回滚单个状态文件（不执行 shell 字符串）。
// kore uninstall --purge 遍历账本执行本模块登记的操作；这里给手工回滚与门禁提供
// 同一原语，且额外做 D-2 范围校验（老 executePurgeOp 只校验绝对/非根/无 ..）。
func purgeUpdateState(stateDir string) error {
	path, err := updateStatePath(stateDir)
	if err != nil {
		return err
	}
	op := purgeOp{Kind: purgeKindFileRemove, Args: []string{path}}
	if err := validateM5PurgeOp(stateDir, op); err != nil {
		return err
	}
	return executePurgeOp(op)
}

// purgeStateFileFromLedger 是 uninstall --purge 对 M5 条目的收口入口：
// 只处理本模块登记的条目（plugin=kore + action=selfupdate.state.write），逐条先
// 过 validateM5PurgeOp 再执行；其它宿主变更条目不归本模块，原样留给 uninstall。
// 篡改账本（越界路径 / 换成 file.restore）→ 返回错误并 WARN，目标文件不变。
func purgeStateFileFromLedger(stateDir string) error {
	entries, _, err := readChanges(changesPath(stateDir))
	if err != nil {
		return fmt.Errorf("更新状态: 读取账本失败，拒绝 purge: %w", err)
	}
	for _, entry := range entries {
		if entry.Plugin != updateStatePlugin || entry.Action != updateStateAction {
			continue
		}
		if entry.PurgeOp == nil {
			return fmt.Errorf("更新状态: M5 账本条目缺少 purge_op，拒绝 purge（D-2）")
		}
		if err := validateM5PurgeOp(stateDir, *entry.PurgeOp); err != nil {
			return err
		}
		if err := executePurgeOp(*entry.PurgeOp); err != nil {
			return err
		}
	}
	return nil
}

// updateStateLedgerHasRemove 判断账本里是否有指向该状态文件的 file.remove 条目。
// 既供门禁断言"有状态文件 ⟹ 有可回滚账本条目"（ADR-0023 §11 第 2 条），
// 也被 readUpdateState 调用做 D-1 fail-closed 复核。
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
