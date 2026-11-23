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
)

// auditCleanParams 是内置任务 params 的形状：保留期与单次上限随任务落库，
// 便于 GET /scheduler/tasks 直接读到当前生效值（G-24 受控例外：内核自有参数）。
type auditCleanParams struct {
	RetentionSeconds int64 `json:"retention_seconds"`
	Batch            int   `json:"batch"`
}

// auditCleanResult 是清理结果（写进 scheduler_runs.error/结果与审计 detail）。
type auditCleanResult struct {
	Deleted          int    `json:"deleted"`
	More             bool   `json:"more"`
	Cutoff           string `json:"cutoff"`
	RetentionSeconds int64  `json:"retention_seconds"`
	Batch            int    `json:"batch"`
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
	params := json.RawMessage(fmt.Sprintf(`{"retention_seconds":%d,"batch":%d}`,
		int64(s.auditRetention.Seconds()), s.auditBatch))
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

// cleanAudit 执行一次按龄清理。失败只返回错误（落 scheduler_runs + WARN 日志），
// 不阻塞调度循环、不影响其他任务；清理结果本身写一条审计（写失败只 WARN）。
func (s *Service) cleanAudit(ctx context.Context, params json.RawMessage) (json.RawMessage, error) {
	out, err := s.runAuditClean(ctx, params)
	if err != nil {
		s.log.Warn("审计按龄清理失败（不影响调度与其他任务）", "err", err)
	}
	return out, err
}

// runAuditClean 是清理的实际执行体：解析参数 → 按龄删除 → 记录结果。
func (s *Service) runAuditClean(ctx context.Context, params json.RawMessage) (json.RawMessage, error) {
	var in auditCleanParams
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, fmt.Errorf("%w: %s 参数无法解析: %v", ErrInvalid, AuditCleanMethod, err)
	}
	if in.RetentionSeconds <= 0 || in.Batch <= 0 || in.Batch > maxAuditCleanBatch {
		return nil, fmt.Errorf("%w: %s 参数非法（retention_seconds 必须为正，batch 取 1–%d）",
			ErrInvalid, AuditCleanMethod, maxAuditCleanBatch)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cutoff := s.now().Add(-time.Duration(in.RetentionSeconds) * time.Second)
	report, err := s.store.CleanAudit(cutoff, in.Batch)
	s.recordAuditClean(in, report, err)
	if err != nil {
		return nil, err
	}
	result := auditCleanResult{
		Deleted: report.Deleted, More: report.More,
		Cutoff:           cutoff.UTC().Format(time.RFC3339),
		RetentionSeconds: in.RetentionSeconds, Batch: in.Batch,
	}
	out, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("序列化清理结果失败: %w", err)
	}
	s.log.Info("审计按龄清理完成", "deleted", report.Deleted, "more", report.More,
		"retention_seconds", in.RetentionSeconds, "batch", in.Batch,
		"cutoff", result.Cutoff)
	return out, nil
}

// recordAuditClean 把一次清理写进审计（可观测性要求）；写失败只 WARN，
// 不让"记录清理"这件事反过来破坏清理或主流程。
func (s *Service) recordAuditClean(in auditCleanParams, report store.AuditCleanReport, cleanErr error) {
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
