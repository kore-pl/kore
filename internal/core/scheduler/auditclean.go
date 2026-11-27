package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// 内置任务参数与执行上限（DATA-MODEL §11）。
const (
	// auditCleanTimeoutS 是单次清理的执行超时；上限本身保证事务短小，60s 已很宽。
	auditCleanTimeoutS = 60
	// maxAuditCleanBatch 是单次删除上限的硬顶（配置校验同口径，防误配一次删爆）。
	maxAuditCleanBatch = 10000
	// minAuditRetentionSeconds 是保留期硬下限：24h，与 config.validateAudit 对
	// audit.retention 的下限（1 天）**同口径**。作用不是限制运维，而是保证
	// 「任何一次清理都删不掉最近 24h 的审计」——即使任务 params 被伪造或残留旧值。
	// 不设上限：保留期越长删得越少，不是风险。
	minAuditRetentionSeconds int64 = int64(24 * time.Hour / time.Second)
)

// auditCleanParams 是内置任务 params 的形状：保留期与单次上限随任务落库，
// 便于 GET /scheduler/tasks 直接读到当前生效值（G-24 受控例外：内核自有参数）。
type auditCleanParams struct {
	RetentionSeconds int64 `json:"retention_seconds"`
	Batch            int   `json:"batch"`
	// MaxRecords 是按量硬上限（0 表示关闭按量封顶）。随任务落库，便于
	// GET /scheduler/tasks 直接读到当前生效值。
	MaxRecords int `json:"max_records"`
}

// auditCleanResult 是清理结果（写进 scheduler_runs.error/结果与审计 detail）。
type auditCleanResult struct {
	Deleted          int    `json:"deleted"`
	More             bool   `json:"more"`
	Cutoff           string `json:"cutoff"`
	RetentionSeconds int64  `json:"retention_seconds"`
	Batch            int    `json:"batch"`
	// TrimDeleted 是按量清理删除的条数（删除原因与按龄区分，可追溯）。
	TrimDeleted int `json:"trim_deleted"`
	MaxRecords  int `json:"max_records"`
}

// syncAuditCleanTask 把配置 audit.* 映射为内置任务（同 cert_renew 的迁移方式，
// 不新增任何 ticker：到点执行仍由唯一调度循环派发）。
//
// 已存在且参数未变时**保留原 next_run_at**——否则每次重启都会把清理往后推一个
// 周期，频繁重启的机器永远等不到第一次清理。
func (s *Service) syncAuditCleanTask() error {
	task, err := s.loadTask(builtinAuditCleanID)
	missing := errors.Is(err, ErrNotFound)
	if err != nil && !missing {
		return err
	}
	if !s.auditEnabled {
		if missing || !task.Enabled {
			return nil
		}
		task.Enabled = false
		return s.saveTask(task)
	}
	interval := int(s.auditInterval.Seconds())
	if interval < minIntervalS {
		interval = minIntervalS
	}
	params := json.RawMessage(fmt.Sprintf(`{"retention_seconds":%d,"batch":%d,"max_records":%d}`,
		int64(s.auditRetention.Seconds()), s.auditBatch, s.auditMaxRecords))
	if missing {
		task = Task{ID: builtinAuditCleanID, Name: "审计按龄清理", Plugin: BuiltinPlugin,
			Method: AuditCleanMethod, Params: params, IntervalS: interval, Enabled: true,
			TimeoutS: auditCleanTimeoutS, CreatedAt: s.now()}
		next, err := task.nextRun(s.now())
		if err != nil {
			return err
		}
		task.NextRunAt = next
		return s.saveTask(task)
	}
	changed := !task.Enabled || task.IntervalS != interval || task.Plugin != BuiltinPlugin ||
		task.Method != AuditCleanMethod || string(task.Params) != string(params)
	if !changed {
		return nil
	}
	task.Plugin, task.Method, task.Schedule = BuiltinPlugin, AuditCleanMethod, ""
	task.IntervalS, task.Enabled = interval, true
	if task.TimeoutS <= 0 || task.TimeoutS > auditCleanTimeoutS {
		task.TimeoutS = auditCleanTimeoutS
	}
	task.Params = params
	next, err := task.nextRun(s.now())
	if err != nil {
		return err
	}
	task.NextRunAt = next
	return s.saveTask(task)
}

// cleanAudit 执行一次按龄清理。**只有内核内置任务 builtin-audit-clean 可以触发**：
// 用户创建的定时任务不得冒用内置 plugin/method，否则「删除审计」会多出第二个入口
// （P1：拿到会话就能自建任务把审计清零，见 .agents/verify/api-security-redteam-2026-11-24.md §5.2）。
// 被拒绝的尝试也写一条审计——删除审计这个动作本身必须可追溯。
//
// 失败只返回错误（落 scheduler_runs + WARN 日志），不阻塞调度循环、不影响其他任务；
// 清理结果本身写一条审计（写失败只 WARN）。
func (s *Service) cleanAudit(ctx context.Context, task Task) (json.RawMessage, error) {
	if task.ID != builtinAuditCleanID {
		var attempted auditCleanParams
		// 尽力解析参数，仅用于把「有人尝试冒用清理入口」记进审计；解析失败不影响拒绝。
		_ = json.Unmarshal(task.Params, &attempted)
		err := fmt.Errorf("%w: %s 只能由内核内置任务 %q 执行（拒绝任务 %q）",
			ErrInvalid, AuditCleanMethod, builtinAuditCleanID, task.ID)
		s.recordAuditClean(attempted, store.AuditCleanReport{}, err, 0)
		s.log.Warn("拒绝非内置任务执行审计清理", "task_id", task.ID, "err", err)
		return nil, err
	}
	out, err := s.runAuditClean(ctx, task.Params)
	if err != nil {
		s.log.Warn("审计按龄清理失败（不影响调度与其他任务）", "err", err)
	}
	return out, err
}

// validateAuditCleanParams 校验清理参数：保留期 ≥ 24h（与 audit.retention 配置下限同口径）、
// 单次上限 1–maxAuditCleanBatch。校验失败不删任何记录。
func validateAuditCleanParams(in auditCleanParams) error {
	if in.RetentionSeconds < minAuditRetentionSeconds {
		return fmt.Errorf("%w: %s 参数非法（retention_seconds 不得小于 %d 秒 = 24 小时，实际 %d；拒绝删除最近审计）",
			ErrInvalid, AuditCleanMethod, minAuditRetentionSeconds, in.RetentionSeconds)
	}
	if in.Batch <= 0 || in.Batch > maxAuditCleanBatch {
		return fmt.Errorf("%w: %s 参数非法（batch 取 1–%d）",
			ErrInvalid, AuditCleanMethod, maxAuditCleanBatch)
	}
	// 0 表示关闭按量封顶；正数须落在 [1, 1000000]（与 config.validateAudit 同口径）。
	if in.MaxRecords < 0 || in.MaxRecords > 1_000_000 {
		return fmt.Errorf("%w: %s 参数非法（max_records 取 0 或 1–1000000）",
			ErrInvalid, AuditCleanMethod)
	}
	return nil
}

// runAuditClean 是清理的实际执行体：解析参数 → 按龄删除 → 记录结果。
func (s *Service) runAuditClean(ctx context.Context, params json.RawMessage) (json.RawMessage, error) {
	var in auditCleanParams
	if err := json.Unmarshal(params, &in); err != nil {
		parseErr := fmt.Errorf("%w: %s 参数无法解析: %v", ErrInvalid, AuditCleanMethod, err)
		s.recordAuditClean(in, store.AuditCleanReport{}, parseErr, 0)
		return nil, parseErr
	}
	if err := validateAuditCleanParams(in); err != nil {
		// 被拒绝的清理尝试同样留痕：删除审计这个动作本身必须可追溯。
		s.recordAuditClean(in, store.AuditCleanReport{}, err, 0)
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cutoff := s.now().Add(-time.Duration(in.RetentionSeconds) * time.Second)
	report, err := s.store.CleanAudit(cutoff, in.Batch)
	if err != nil {
		s.recordAuditClean(in, report, err, 0)
		return nil, err
	}
	// 按量封顶：按龄清理后再核对总数，超上限则从最旧端删（与按龄删除区分原因）。
	// 复用同一内置任务与单 ticker，不新增定时器（方案候选④）。
	trimDeleted := 0
	trimMore := false
	if in.MaxRecords > 0 {
		trimDeleted, trimMore, err = s.store.TrimAuditToMax(in.MaxRecords, in.Batch)
		if err != nil {
			s.recordAuditClean(in, report, err, 0)
			return nil, err
		}
	}
	report.More = report.More || trimMore
	s.recordAuditClean(in, report, err, trimDeleted)
	result := auditCleanResult{
		Deleted: report.Deleted, More: report.More,
		Cutoff:           cutoff.UTC().Format(time.RFC3339),
		RetentionSeconds: in.RetentionSeconds, Batch: in.Batch,
		TrimDeleted: trimDeleted, MaxRecords: in.MaxRecords,
	}
	out, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("序列化清理结果失败: %w", err)
	}
	s.log.Info("审计清理完成", "deleted", report.Deleted, "more", report.More,
		"trim_deleted", trimDeleted, "max_records", in.MaxRecords,
		"retention_seconds", in.RetentionSeconds, "batch", in.Batch,
		"cutoff", result.Cutoff)
	return out, nil
}

// recordAuditClean 把一次清理写进审计（可观测性要求）；写失败只 WARN，
// 不让"记录清理"这件事反过来破坏清理或主流程。
func (s *Service) recordAuditClean(in auditCleanParams, report store.AuditCleanReport, cleanErr error, trimDeleted int) {
	rec := store.AuditRecord{
		Subject: "system",
		Action:  AuditCleanMethod,
		Plugin:  BuiltinPlugin,
		Target:  "audit",
		Result:  store.AuditResultOK,
		Detail: map[string]string{
			"deleted":           strconv.Itoa(report.Deleted),
			"more":              strconv.FormatBool(report.More),
			"batch":             strconv.Itoa(in.Batch),
			"retention_seconds": strconv.FormatInt(in.RetentionSeconds, 10),
			"trim_deleted":      strconv.Itoa(trimDeleted),
			"max_records":       strconv.Itoa(in.MaxRecords),
		},
	}
	if cleanErr != nil {
		rec.Result = store.AuditResultError
		rec.Detail["error"] = truncateRunes(cleanErr.Error(), 200)
	}
	if err := s.store.PutAudit(rec); err != nil {
		s.log.Warn("审计清理记录写入失败（不影响清理结果）", "err", err)
	}
}

// truncateRunes 按字符截断，避免错误文本超 detail 值上限（256 字符）。
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
