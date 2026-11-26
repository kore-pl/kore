package market

// 旧版本自动清理（ADR-0059 §3.5 / U6）。
//
// 边界：只处理 <install> 内插件目录下的 MAJOR.MINOR.PATCH 版本目录；
// .prev / .bak-<ts> / .staging 等回滚材料与临时目录一律不删（G-31）。
// 本文件只提供圈闭的清理原语，由装配层在新版本生效确认后调用，
// 不在 market 内部起任何 goroutine / ticker（G-19）。

import (
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// CleanupAction 是清理审计的事件名（DATA-MODEL §9 的 action 字段）。
const CleanupAction = "market.backup.clean"

// versionDirPattern 只认严格三段数字目录名；.prev / .bak-<ts> / .staging
// 这类回滚材料与临时目录不会命中，天然免于清理。
var versionDirPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// CleanupOptions 是一次清理的输入。所有字段显式类型（G-24，无 any/object）。
type CleanupOptions struct {
	// Root 是版本目录的父目录（通常为 <plugin_dir>/<id>）；不能为空。
	Root string
	// PluginID 只进审计，用于定位；不参与路径拼接。
	PluginID string
	// CurrentVersion 是当前已生效的版本目录名；该目录永不删除。
	// 为空时按最大版本号视为当前版本。
	CurrentVersion string
	// KeepCount 是版本目录保留份数上限；低于 2 时强制抬到 2
	// （当前版本 + 至少 1 份可回滚版本，ADR-0059 §3.5 保底规则）。
	KeepCount int
	// MaxDiskBytes 是版本目录合计字节上限；<=0 表示不按磁盘清理。
	// 即使超限也绝不删除受保护的可回滚版本，只返回 OverBudget=true。
	MaxDiskBytes int64
	// Confirmed 表示新版本已完成生效确认（reload / finalize 成功）。
	// false 时整次清理短路并返回 Skipped=true + WARN，不动任何文件。
	Confirmed bool
	// Actor 是审计主体（如 "kored" / "system" / 管理员标识）。
	Actor string
	// Auditor 是审计写入口；nil 表示只写 slog WARN，不落库。
	Auditor CleanupAuditor
	// Logger 是 WARN 输出；nil 用 slog.Default()。
	Logger *slog.Logger
}

// CleanupAuditor 把一次清理结果写入审计通道；由装配层适配 store.PutAudit。
type CleanupAuditor func(CleanupAuditEvent) error

// CleanupAuditEvent 是一条清理审计事件（字段显式，便于映射到 store.AuditRecord）。
type CleanupAuditEvent struct {
	Actor        string
	PluginID     string
	Root         string
	Reason       string // count / disk / count+disk
	KeepCount    int
	MaxDiskBytes int64
	Kept         []string
	Deleted      []string
	FreedBytes   int64
	OverBudget   bool
	Result       string // ok / error
	Message      string
}

// AuditDetail 映射为 store 的受控 detail（≤16 键、键 ≤32 字符、值 ≤256 字符）。
// 删除清单按逗号拼接；超长时保留前缀并标记截断，避免审计写入被拒（DATA-MODEL §9）。
func (e CleanupAuditEvent) AuditDetail() map[string]string {
	detail := map[string]string{
		"actor":          trimAudit(e.Actor, 32),
		"path":           trimAudit(e.Root, 256),
		"keep_count":     strconv.Itoa(e.KeepCount),
		"max_disk_bytes": strconv.FormatInt(e.MaxDiskBytes, 10),
		"kept":           trimAudit(strings.Join(e.Kept, ","), 256),
		"deleted":        trimAudit(strings.Join(e.Deleted, ","), 256),
		"deleted_count":  strconv.Itoa(len(e.Deleted)),
		"freed_bytes":    strconv.FormatInt(e.FreedBytes, 10),
		"reason":         trimAudit(e.Reason, 64),
		"over_budget":    strconv.FormatBool(e.OverBudget),
	}
	if e.Message != "" {
		detail["message"] = trimAudit(e.Message, 256)
	}
	return detail
}

// trimAudit 截断审计值并加省略标记（值按 rune 计，避免切坏 UTF-8）。
func trimAudit(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	if limit <= 3 {
		return string(runes[:limit])
	}
	return string(runes[:limit-3]) + "..."
}

// CleanupResult 是一次清理的可观测结果。
type CleanupResult struct {
	// Kept / Deleted 是版本目录名（字典序）；Deleted 只含真正删除成功的。
	Kept    []string
	Deleted []string
	// FreedBytes 是成功删除的目录字节数合计。
	FreedBytes int64
	// Skipped 为 true 表示因未确认生效而未触碰任何文件。
	Skipped    bool
	SkipReason string
	// OverBudget 为 true 表示受保护版本仍在磁盘上限之外（不删回滚材料）。
	OverBudget bool
	// Reason 记录触发原因（count / disk / count+disk）。
	Reason string
}

// CleanupStaleVersions 在新版本生效确认后清理超限的旧版本目录。
//
// 顺序：先按份数、再按磁盘上限，从最旧的非保护版本开始删；
// 当前版本与最新一份回滚版本始终保留；任何情况下不删非版本目录。
// 审计写入失败只 WARN 并作为 error 返回，不回滚已完成的删除。
func CleanupStaleVersions(opts CleanupOptions) (CleanupResult, error) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	if strings.TrimSpace(opts.Root) == "" {
		return CleanupResult{}, fmt.Errorf("cleanup: Root 不能为空")
	}

	// 生效确认是清理的前置门：未确认时短路，绝不触碰版本目录。
	if !opts.Confirmed {
		logger.Warn("审计：新版本未确认生效，跳过旧版本清理",
			"plugin_id", opts.PluginID, "root", opts.Root)
		return CleanupResult{Skipped: true, SkipReason: "new_version_unconfirmed", Kept: []string{}}, nil
	}

	versions, err := scanVersionDirs(opts.Root)
	if err != nil {
		return CleanupResult{}, err
	}
	if len(versions) == 0 {
		return writeCleanupAudit(opts, logger, CleanupResult{Kept: []string{}}, nil)
	}

	// 受保护集合：当前版本 + 最新一份可回滚版本。
	keepNames := protectedVersions(versions, opts.CurrentVersion)
	effectiveKeep := opts.KeepCount
	if effectiveKeep < 2 && len(versions) >= 2 {
		effectiveKeep = 2 // 保底：当前 + 1 份可回滚（ADR-0059 §3.5）
	}
	if effectiveKeep < 1 {
		effectiveKeep = 1
	}

	// versions 已按版本升序排列：最旧在前，优先删除。
	deletedSet := make(map[string]bool)
	result := CleanupResult{Reason: ""}
	remaining := len(versions)
	for _, v := range versions {
		if remaining <= effectiveKeep {
			break
		}
		if keepNames[v.name] {
			continue
		}
		if err := os.RemoveAll(v.path); err != nil {
			logger.Warn("旧版本目录删除失败", "plugin_id", opts.PluginID,
				"dir", v.name, "path", v.path, "err", err)
			continue
		}
		deletedSet[v.name] = true
		result.Deleted = append(result.Deleted, v.name)
		result.FreedBytes += v.size
		remaining--
	}
	if len(result.Deleted) > 0 {
		result.Reason = "count"
	}

	// 磁盘上限：只删非保护版本；即使仍超限也保留回滚材料，标记 OverBudget。
	if opts.MaxDiskBytes > 0 {
		var total int64
		for _, v := range versions {
			if !deletedSet[v.name] {
				total += v.size
			}
		}
		if total > opts.MaxDiskBytes {
			if result.Reason != "" {
				result.Reason = "count+disk"
			} else {
				result.Reason = "disk"
			}
			for _, v := range versions {
				if total <= opts.MaxDiskBytes {
					break
				}
				if deletedSet[v.name] || keepNames[v.name] {
					continue
				}
				if err := os.RemoveAll(v.path); err != nil {
					logger.Warn("旧版本目录删除失败（磁盘上限）", "plugin_id", opts.PluginID,
						"dir", v.name, "path", v.path, "err", err)
					continue
				}
				deletedSet[v.name] = true
				result.Deleted = append(result.Deleted, v.name)
				result.FreedBytes += v.size
				total -= v.size
			}
			if total > opts.MaxDiskBytes {
				result.OverBudget = true
				logger.Warn("旧版本磁盘仍超上限，已保留可回滚版本不再删除",
					"plugin_id", opts.PluginID, "root", opts.Root,
					"total_bytes", total, "max_bytes", opts.MaxDiskBytes)
			}
		}
	}

	// 保留清单按版本升序返回，便于调用方与前端提示对齐。
	for _, v := range versions {
		if !deletedSet[v.name] {
			result.Kept = append(result.Kept, v.name)
		}
	}
	sort.Strings(result.Kept)
	sort.Strings(result.Deleted)
	return writeCleanupAudit(opts, logger, result, nil)
}

// CleanupAfterInstall 是 Service 上的清理入口，供装配层在"新版本生效确认后"调用
// （插件 reload 成功 / 内核 finalize 成功，ADR-0059 §3.5 第 3 条）。
//
// market 不 import config（G-01/G-02）：backup.keep_count / backup.max_disk_bytes
// 由装配层从 config.Snapshot.Backup 读取后填入 opts；审计写入口由装配层适配 store.PutAudit。
// 本方法只补默认 logger，不持有策略状态、不起任何后台任务（G-19）。
func (s *Service) CleanupAfterInstall(opts CleanupOptions) (CleanupResult, error) {
	if opts.Logger == nil && s != nil {
		opts.Logger = s.logger
	}
	return CleanupStaleVersions(opts)
}

// versionDir 是扫描到的一个版本目录及其磁盘占用。
type versionDir struct {
	name  string
	path  string
	major int
	minor int
	patch int
	size  int64
}

// scanVersionDirs 只读取 Root 的直接子目录；严格版本名 + 非符号链接；
// 目录大小按普通文件累加，WalkDir 出错时跳过该目录（不删未知内容）。
func scanVersionDirs(root string) ([]versionDir, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("cleanup: 读取版本目录失败 %s: %w", root, err)
	}
	var versions []versionDir
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if !versionDirPattern.MatchString(name) {
			continue
		}
		major, minor, patch, ok := parseVersion(name)
		if !ok {
			continue
		}
		size, err := dirSize(filepath.Join(root, name))
		if err != nil {
			continue // 读不完整的目录不纳入清理候选
		}
		versions = append(versions, versionDir{
			name: name, path: filepath.Join(root, name),
			major: major, minor: minor, patch: patch, size: size,
		})
	}
	sort.Slice(versions, func(i, j int) bool {
		a, b := versions[i], versions[j]
		if a.major != b.major {
			return a.major < b.major
		}
		if a.minor != b.minor {
			return a.minor < b.minor
		}
		return a.patch < b.patch
	})
	return versions, nil
}

// parseVersion 把三段版本号解析为整数；任一段非法返回 false。
func parseVersion(name string) (int, int, int, bool) {
	parts := strings.Split(name, ".")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	values := [3]int{}
	for i, part := range parts {
		v, err := strconv.Atoi(part)
		if err != nil || v < 0 {
			return 0, 0, 0, false
		}
		values[i] = v
	}
	return values[0], values[1], values[2], true
}

// dirSize 累加目录下普通文件字节数；符号链接不跟随（避免删前读到目录外数据）。
func dirSize(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	return total, err
}

// protectedVersions 选出当前版本与最新一份回滚版本；两者都不参与删除。
// versions 按版本升序传入；当前版本缺失时取最大版本作为当前。
func protectedVersions(versions []versionDir, current string) map[string]bool {
	protected := make(map[string]bool, 2)
	if current != "" {
		for _, v := range versions {
			if v.name == current {
				protected[v.name] = true
			}
		}
	}
	if len(protected) == 0 && len(versions) > 0 {
		protected[versions[len(versions)-1].name] = true
	}
	// 最新一份非当前版本是回滚材料，绝不能删。
	for i := len(versions) - 1; i >= 0; i-- {
		if !protected[versions[i].name] {
			protected[versions[i].name] = true
			break
		}
	}
	return protected
}

// writeCleanupAudit 写出一条清理审计：无论是否发生删除都留痕（含删除清单）。
func writeCleanupAudit(opts CleanupOptions, logger *slog.Logger, result CleanupResult, cleanErr error) (CleanupResult, error) {
	event := CleanupAuditEvent{
		Actor:        opts.Actor,
		PluginID:     opts.PluginID,
		Root:         opts.Root,
		Reason:       result.Reason,
		KeepCount:    opts.KeepCount,
		MaxDiskBytes: opts.MaxDiskBytes,
		Kept:         result.Kept,
		Deleted:      result.Deleted,
		FreedBytes:   result.FreedBytes,
		OverBudget:   result.OverBudget,
		Result:       "ok",
	}
	if cleanErr != nil {
		event.Result = "error"
		event.Message = cleanErr.Error()
	}
	if result.Skipped {
		event.Message = result.SkipReason
	}
	if opts.Auditor != nil {
		if err := opts.Auditor(event); err != nil {
			logger.Warn("审计：旧版本清理审计写入失败",
				"action", CleanupAction, "plugin_id", opts.PluginID, "err", err)
			if cleanErr == nil {
				cleanErr = fmt.Errorf("cleanup: 审计写入失败: %w", err)
			}
		}
	}
	logger.Info("旧版本清理完成", "action", CleanupAction, "plugin_id", opts.PluginID,
		"kept", strings.Join(result.Kept, ","), "deleted", strings.Join(result.Deleted, ","),
		"freed_bytes", result.FreedBytes, "reason", result.Reason)
	return result, cleanErr
}
