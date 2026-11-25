package main

// ADR-0059 / U2=A 批量更新编排器：读已验签索引算待更新项 → 按依赖序逐条调现有
// 单条 store/install（download 分支）→ 复用 reloadOne → 汇总 + 失败分诊。
//
// 边界：不新增对外 API / schema（U2-C 留完整期）、不改 store/install 语义、不下载
// 代码副本、不碰运行态资产（G-29）。每条失败只记分诊结果并继续后续项，绝不整批
// 回滚（local-update-plan.md §4 第 5 步口径）。结果结构直接内嵌 M2 的
// OrchestrationResult，复用 M2 的 phase 词表、审计出口与错误码，不另起第二套。

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// batchAuditTarget 与 M2 共用一个审计动作（system.self_update），target 标记批量。
	batchAuditTarget = "batch:plugins"
	// jobKindPluginInstall 是批量项在共用 SelfUpdateJob 结构里的种类标识。
	jobKindPluginInstall = "plugin_install"
	// batchExitFailed 沿用 SelfUpdateJob 的 exit_code 语义：非 0 表示未成功。
	batchExitFailed = 2
)

// batchSingleInstaller 是单条 store/install 的 download 分支（market.Service 已实现）。
// 批量入口只委托，不复制下载 / 摘要校验 / 落盘逻辑。
type batchSingleInstaller interface {
	InstallDownload(ctx context.Context, id, version string) (*market.InstallJob, error)
}

// batchPendingSource 是只读索引计算层（market.Service.PendingUpdates 已实现）。
type batchPendingSource interface {
	PendingUpdates(installed map[string]string) ([]market.PendingUpdate, error)
}

// BatchItemResult 是单条插件更新的结果：内嵌 M2 结果结构，附加 reload 分类。
// 不复制 Job / Phase / ErrorCode 字段（G-24：显式字段，禁 any）。
type BatchItemResult struct {
	// 直接内嵌 M2 的 OrchestrationResult：Phase / Job / ErrorCode / Reason 字段
	// 与 M2 完全共用（对比测试据此断言同一结果结构，不复制字段、不另起第二套）。
	OrchestrationResult
	// PluginID 是目标插件 id。
	PluginID string `json:"plugin_id"`
	// Version 是索引目标版本。
	Version string `json:"version"`
	// Reload 是 reloadOne 的分类（reloaded / restarted / failed）。
	Reload string `json:"reload,omitempty"`
}

// BatchFailure 是一条失败分诊记录，供上层决定单条重试（不整批回滚）。
type BatchFailure struct {
	// ID 失败的插件 id（规划阶段失败时为空）。
	ID string `json:"id,omitempty"`
	// ErrorCode 结构化错误码（market 的 E_* 或 M2 的 E_UPGRADE_*）。
	ErrorCode string `json:"error_code"`
	// Reason 面向用户的一句话说明（无内部术语、无凭据）。
	Reason string `json:"reason"`
	// Retryable 是否可单条重试（上游/校验类瞬时失败可重试，索引结构错误不可）。
	Retryable bool `json:"retryable"`
}

// BatchSummary 是批量结果汇总（显式计数，禁 any）。
type BatchSummary struct {
	Total     int `json:"total"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

// BatchUpdateResult 是整批编排的汇总结果，复用 M2 的结果语义。
type BatchUpdateResult struct {
	// Phase 整批阶段：规划失败 / 审计失败为 failed，全部完成为 committed。
	Phase string `json:"phase"`
	// Items 按依赖序逐条执行的结果。
	Items []BatchItemResult `json:"items"`
	// Failures 失败分诊清单（单条可重试，不整批回滚）。
	Failures []BatchFailure `json:"failures,omitempty"`
	// Summary 计数。
	Summary BatchSummary `json:"summary"`
	// Reason 面向用户的一句话总结。
	Reason string `json:"reason,omitempty"`
}

// batchUpdateOrchestrator 批量编排器：共用 M2 的审计出口与结果语义。
type batchUpdateOrchestrator struct {
	// orch 是 M2 的进程内编排器；批量入口复用它的 fail-closed 审计出口，不新建审计面。
	orch *updateOrchestrator
	// pendingSource 提供待更新项计算（market.Service）。
	pendingSource batchPendingSource
	// installer 是单条 store/install 的 download 分支（market.Service）。
	installer batchSingleInstaller
	// installed 从装配层读已装版本快照；只读投影，不改状态库。
	installed func() (map[string]string, error)
	// reloadOne 与 store/install / store/update 共用同一重载入口（serve_runtime.go:262）。
	reloadOne func(string) (string, error)
}

// newBatchUpdateOrchestrator 由装配层注入（本任务不新增对外端点，装配在 M4 触发链使用）。
func newBatchUpdateOrchestrator(
	orch *updateOrchestrator,
	marketSvc *market.Service,
	installed func() (map[string]string, error),
	reloadOne func(string) (string, error),
) *batchUpdateOrchestrator {
	return &batchUpdateOrchestrator{
		orch: orch, pendingSource: marketSvc, installer: marketSvc,
		installed: installed, reloadOne: reloadOne,
	}
}

// Run 执行一次批量更新：审计门 → 读索引算待更新项 → 按依赖序逐条 install + reload → 汇总。
// 单条失败不整批回滚，也不阻断其余项；返回 error 只用于「整批根本没开始」的失败。
func (b *batchUpdateOrchestrator) Run(ctx context.Context) (BatchUpdateResult, error) {
	if b.pendingSource == nil || b.installer == nil || b.installed == nil || b.reloadOne == nil {
		return BatchUpdateResult{}, errors.New("批量更新编排器未装配")
	}
	// fail-closed：与 M2 同一审计出口，写不进就不开始（不静默放行更新）。
	if err := b.orch.recordStart(batchAuditTarget); err != nil {
		return BatchUpdateResult{Phase: phaseFailed}, fmt.Errorf("%w：%v", httpapi.ErrUpgradeAudit, err)
	}

	versions, err := b.installed()
	if err != nil {
		return BatchUpdateResult{Phase: phaseFailed}, fmt.Errorf("读取已装版本失败：%w", err)
	}
	pending, err := b.pendingSource.PendingUpdates(versions)
	if err != nil {
		return BatchUpdateResult{Phase: phaseFailed}, err
	}

	result := BatchUpdateResult{Phase: phaseCommitted, Items: []BatchItemResult{}}
	result.Summary.Total = len(pending)
	for _, item := range pending {
		result.Items = append(result.Items, b.runOne(ctx, item, &result))
	}
	result.Reason = fmt.Sprintf("批量更新完成：成功 %d / 失败 %d（失败项可单条重试）",
		result.Summary.Succeeded, result.Summary.Failed)
	return result, nil
}

// runOne 执行单条 install + reload，并把结果（成功或失败）并入汇总；绝不整批回滚。
func (b *batchUpdateOrchestrator) runOne(ctx context.Context, item market.PendingUpdate, batch *BatchUpdateResult) BatchItemResult {
	started := time.Now().UTC().Format(time.RFC3339)
	base := OrchestrationResult{Job: httpapi.SelfUpdateJob{
		ID: item.ID + "-" + item.Version, Kind: jobKindPluginInstall,
		State: jobStateFailed, ExitCode: batchExitFailed, StartedAt: started,
	}}
	res := BatchItemResult{
		OrchestrationResult: base,
		PluginID:            item.ID, Version: item.Version,
	}
	job, err := b.installer.InstallDownload(ctx, item.ID, item.Version)
	if err != nil {
		return b.markFailed(res, item, err, batch)
	}
	if job != nil {
		res.Job.ID = job.ID
		res.Job.Message = job.Message
	}
	reload, err := b.reloadOne(item.ID)
	if err != nil {
		return b.markFailed(res, item, err, batch)
	}
	res.Reload = reload
	res.Phase = phaseCommitted
	res.Reason = "已安装并完成热重载，无需重启内核"
	res.Job.State = jobStateSuccess
	res.Job.ExitCode = exitOK
	res.Job.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	batch.Summary.Succeeded++
	return res
}

// markFailed 记录单条失败（phase=Failed + 错误码分诊），不回滚已成功的项。
func (b *batchUpdateOrchestrator) markFailed(
	res BatchItemResult, item market.PendingUpdate, err error, batch *BatchUpdateResult,
) BatchItemResult {
	code := batchErrorCode(err)
	res.Phase = phaseFailed
	res.ErrorCode = code
	res.Reason = err.Error()
	res.Job.ErrorCode = code
	res.Job.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	batch.Summary.Failed++
	batch.Failures = append(batch.Failures, BatchFailure{
		ID: item.ID, ErrorCode: code, Reason: err.Error(), Retryable: batchRetryable(code),
	})
	return res
}

// batchErrorCode 优先用 market/pluginapi 的结构化错误码，其余回落到 M2 的哨兵映射。
func batchErrorCode(err error) string {
	var pe *pluginapi.Error
	if errors.As(err, &pe) && pe.Code != "" {
		return pe.Code
	}
	return orchestrationErrorCode(err)
}

// batchRetryable 标记可单条重试的失败（上游/校验类）；索引结构错误重试同样失败。
func batchRetryable(code string) bool {
	switch code {
	case pluginapi.E_UPSTREAM, pluginapi.E_CONFLICT, pluginapi.E_INVALID,
		"E_UPGRADE_SOURCE", "E_UPGRADE_CHECKSUM", "E_UPGRADE_BUSY":
		return true
	default:
		return false
	}
}
