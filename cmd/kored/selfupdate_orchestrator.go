package main

// ADR-0058 §3.2 选项 B：kored 进程内更新编排服务。
//
// 这是「受控入口 B」：与 M1 的 UDS 专用端点（选项 A）共用同一份 SelfUpdater 编排
// 服务与结果结构。本文件不重复实现校验 / 原子替换 / 重启提交，只是进程内直调该
// 服务（不走 HTTP、不给自己发 UDS 请求、无自连接死锁面与二次鉴权开销）。
//
// 边界（G-01 薄壳）：只做编排规则——fail-closed 审计、phase 状态映射、结果结构与
// M1 对齐；不写插件业务、不 import plugins/**、不碰运行态资产（G-29）。
// 内核升级在进程内只能做到「校验 + 原子替换 + 落 pending + 提交重启」，最终生效
// 由新进程 finalizePendingUpgrade 确认（ADR-0058 §3.2.3）——本文件不假装在进程内
// 替换自己。

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
)

const (
	// inProcessActor 是进程内编排的审计主体：调用身份就是 kored 自己（ADR-0058
	// 「本机静默更新的调用身份」），只写标识，不含口令 / token 等凭据字段（G-30）。
	inProcessActor = "process:kored"

	// orchestrationAuditAction 与 M1 专用端点的审计动作名一致（system.self_update），
	// 保证两条入口写出的审计事件同一口径（ADR-0058 §3.2.2）。
	orchestrationAuditAction = "system.self_update"

	// orchestrationChannel 是审计 detail 的通道标识：进程内直调（区别于 UDS 的 "unix"）。
	orchestrationChannel = "inprocess"

	// 编排 phase 词表取自 ADR-0023 §3.5 修订 / adr-0023-amendment-selfupdate §3.1：
	// downloading / verified / installed / pending / committed / rolled_back。
	// 进程内内核升级链只暴露 verified / pending / committed / rolled_back / failed。
	phaseVerified   = "verified"
	phasePending    = "pending"
	phaseCommitted  = "committed"
	phaseRolledBack = "rolled_back"
	phaseFailed     = "failed"

	// 任务终态字符串（与 M1 selfUpdater 的 job state 同值，不另起第二套）。
	jobStateSuccess = "success"
	jobStateFailed  = "failed"
	// 任务种类字符串（与 M1 launch(actor, kind, ...) 同值）。
	jobKindUpgrade  = "upgrade"
	jobKindRollback = "rollback"
)

// orchestrationErrNoConfirm 是 confirm 缺失的本地哨兵：进程内入口与 M1 一样要求
// 高危更新显式二次确认，缺省拒绝（fail-closed）。
var orchestrationErrNoConfirm = errors.New("进程内更新会替换内核并重启，必须显式确认（confirm=true）")

// OrchestrationResult 是进程内编排的统一结果。
//
// 结果结构直接内嵌 M1 的 httpapi.SelfUpdateJob（对比测试据此证明两条入口的结果
// 结构一致），外层 phase 只补充跨重启提交阶段（ADR-0023 §3.5），不另起第二套结果
// 类型（ADR-0058 §3.2.2「B 不是第二套逻辑」）。
type OrchestrationResult struct {
	// Phase 是本阶段的提交语义：verified / pending / committed / rolled_back / failed。
	Phase string `json:"phase"`
	// Job 与 M1 共用同一结果结构（httpapi.SelfUpdateJob），不复制字段。
	Job httpapi.SelfUpdateJob `json:"job"`
	// ErrorCode 失败时的结构化错误码（与 M1 的 E_UPGRADE_* 同口径）。
	ErrorCode string `json:"error_code,omitempty"`
	// Reason 面向用户的一句话说明（无内部术语）。
	Reason string `json:"reason,omitempty"`
}

// updateOrchestrator 是进程内更新编排服务：注入共享服务与 fail-closed 审计出口。
type updateOrchestrator struct {
	// updater 是 M1 与进程内入口共用的同一份编排服务（httpapi.SelfUpdater）。
	// 唯一直接调 upgrade / installer 原语的实现是 serve_upgrade.go 的 selfUpdater
	// （它调 runUpgradeWith）；这里只委托，不复制其实替换逻辑。
	updater httpapi.SelfUpdater
	// audit 是 fail-closed 审计出口（与 M1 专用端点同一 SelfUpdateAuditRecorder）。
	// nil 时拒绝执行更新，绝不「没审计就替换」。
	audit httpapi.SelfUpdateAuditRecorder
}

// OrchestrateUpgrade 是进程内升级入口：显式确认 → fail-closed 审计 → 委托共享
// 编排服务。返回 phase=verified（预检与 sha 校验已在 updater.StartUpgrade 内同步
// 完成），替换与重启提交异步进行，终态由 OrchestrationStatus 映射成 committed。
//
// 与 M1 UDS 端点的顺序完全对齐（ADR-0058 §3.1.5 / §3.2.2）：审计写不进就不执行。
func (o *updateOrchestrator) OrchestrateUpgrade(ctx context.Context, req httpapi.SelfUpdateRequest) (OrchestrationResult, error) {
	if o.updater == nil {
		return OrchestrationResult{}, errors.New("编排服务未装配")
	}
	if !req.Confirm {
		return OrchestrationResult{}, orchestrationErrNoConfirm
	}
	targetVersion := strings.TrimSpace(req.SHA256)

	// fail-closed 审计：写不进就不开始更新（与 M1 专用端点同一出口与同一事件结构）。
	if err := o.recordStart(targetVersion); err != nil {
		return OrchestrationResult{}, fmt.Errorf("%w：%v", httpapi.ErrUpgradeAudit, err)
	}

	job, err := o.updater.StartUpgrade(ctx, inProcessActor, req)
	if err != nil {
		return OrchestrationResult{
			Phase:     phaseFailed,
			ErrorCode: orchestrationErrorCode(err),
			Reason:    err.Error(),
		}, err
	}
	return OrchestrationResult{
		Phase:  phaseVerified,
		Job:    job,
		Reason: "已校验新二进制并受理替换；重启提交由后台完成",
	}, nil
}

// OrchestrateRollback 是进程内回滚入口，与升级入口共用审计与 fail-closed 语义。
func (o *updateOrchestrator) OrchestrateRollback(ctx context.Context, req httpapi.SelfUpdateRollbackRequest) (OrchestrationResult, error) {
	if o.updater == nil {
		return OrchestrationResult{}, errors.New("编排服务未装配")
	}
	if !req.Confirm {
		return OrchestrationResult{}, orchestrationErrNoConfirm
	}
	targetVersion := strings.TrimSpace(req.SHA256)
	if targetVersion == "" {
		targetVersion = jobKindRollback // 审计总要有一个非空 target
	}
	if err := o.recordStart(targetVersion); err != nil {
		return OrchestrationResult{}, fmt.Errorf("%w：%v", httpapi.ErrUpgradeAudit, err)
	}

	job, err := o.updater.StartRollback(ctx, inProcessActor, req)
	if err != nil {
		return OrchestrationResult{
			Phase:     phaseFailed,
			ErrorCode: orchestrationErrorCode(err),
			Reason:    err.Error(),
		}, err
	}
	return OrchestrationResult{
		Phase:  phaseVerified,
		Job:    job,
		Reason: "已受理回滚；重启提交由后台完成",
	}, nil
}

// OrchestrationStatus 把共享服务的任务快照映射成 phase，供进程内调用方查询。
//
// happy path 的终态是 phase=committed：语义=二进制已替换 + 重启已提交（不等于新
// 版本已生效，生效由新进程 finalizePendingUpgrade 确认，ADR-0058 §3.2.3）。
func (o *updateOrchestrator) OrchestrationStatus(id string) (OrchestrationResult, bool) {
	if o.updater == nil {
		return OrchestrationResult{}, false
	}
	job, ok := o.updater.UpgradeJob(id)
	if !ok {
		return OrchestrationResult{}, false
	}
	res := OrchestrationResult{Job: job}
	switch {
	case job.State == jobStateFailed:
		res.Phase = phaseFailed
		res.ErrorCode = job.ErrorCode
		res.Reason = job.Message
	case job.State == jobStateSuccess:
		if job.Kind == jobKindRollback {
			res.Phase = phaseRolledBack
			res.Reason = "已回滚到上一版本并提交重启；生效由新进程确认"
		} else {
			res.Phase = phaseCommitted
			res.Reason = "已替换内核并提交重启；新版本生效由新进程确认"
		}
	default: // queued / running
		res.Phase = phasePending
		res.Reason = job.Message
	}
	return res, true
}

// recordStart 写一条 system.self_update 发起审计（fail-closed）。
// detail 与 M1 专用端点同构：channel / capability / target_version，不写任何凭据。
func (o *updateOrchestrator) recordStart(targetVersion string) error {
	if o.audit == nil {
		return errors.New("进程内更新审计出口未装配")
	}
	return o.audit.Record(httpapi.AuditEvent{
		Subject: inProcessActor,
		Action:  orchestrationAuditAction,
		Target:  targetVersion,
		Result:  store.AuditResultOK,
		Detail: map[string]string{
			"channel":        orchestrationChannel,
			"capability":     httpapi.LocalUpdateCapability(),
			"target_version": targetVersion,
		},
	})
}

// orchestrationErrorCode 用 errors.Is 复用 M1 的升级错误哨兵，映射成同一套错误码，
// 保证进程内入口与 UDS 入口的失败语义一致（ADR-0058 §3.2.2）。
func orchestrationErrorCode(err error) string {
	switch {
	case errors.Is(err, httpapi.ErrUpgradeSource):
		return "E_UPGRADE_SOURCE"
	case errors.Is(err, httpapi.ErrUpgradeChecksum):
		return "E_UPGRADE_CHECKSUM"
	case errors.Is(err, httpapi.ErrUpgradeNeedRoot):
		return "E_NEED_ROOT"
	case errors.Is(err, httpapi.ErrUpgradeBusy):
		return "E_UPGRADE_BUSY"
	case errors.Is(err, httpapi.ErrUpgradeAudit):
		return "E_UPGRADE_AUDIT"
	case errors.Is(err, httpapi.ErrUpgradeRestart):
		return "E_UPGRADE_RESTART"
	default:
		return "E_INTERNAL"
	}
}
