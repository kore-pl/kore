package main

import (
	"context"
	"log/slog"

	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/core/supervisor"
)

// storeAuditor 把 supervisor 的四类生命周期事件写进 audit bucket（M3-C）。
// 这是装配层唯一把 supervisor 审计事件接到 store 的地方：supervisor 只见
// Auditor 单方法接口，不 import config/store（G-01）。
type storeAuditor struct {
	db *store.Store
}

// Record 实现 supervisor.Auditor：字段一一透传，subject/action/plugin/target/result/detail
// 原样落库；detail 受控校验（DATA-MODEL §9）在 store.PutAudit 内完成，非法即拒收。
func (a *storeAuditor) Record(_ context.Context, ev supervisor.AuditEvent) error {
	return a.db.PutAudit(store.AuditRecord{
		Subject: ev.Subject,
		Action:  ev.Action,
		Plugin:  ev.Plugin,
		Target:  ev.Target,
		Result:  ev.Result,
		Detail:  ev.Detail,
	})
}

// rootActionAuditor 把 privilege 的 root.action 事件写进 audit bucket（ADR-0018）。
//
// 字段映射：actor → subject、action_id → target、decision/argv/unit/deny_reason/
// exit_code/dur_ms → detail；result 由 privilege.Event.Result() 统一成 ok/denied/error。
// 该适配器是 fail-closed 的落点：PutAudit 返回错误时 privilege 拒绝执行动作。
type rootActionAuditor struct {
	db *store.Store
}

// Record 实现 privilege.Auditor。
func (a *rootActionAuditor) Record(_ context.Context, ev privilege.Event) error {
	return a.db.PutAudit(store.AuditRecord{
		Subject: ev.Actor,
		Action:  privilege.AuditAction,
		Plugin:  ev.PluginID,
		Target:  ev.ActionID,
		Result:  ev.Result(),
		Detail:  ev.Detail(),
	})
}

// auditActionCapabilityDenied 是调用校验拒绝的审计动作名（DATA-MODEL §4 审计动作表）。
const auditActionCapabilityDenied = "capability.denied"

// capabilityAuditorFromStore 把 httpapi 的 capability.denied 出口接到 audit bucket。
//
// 这是 invoke 越权审计的落库点：只有拒绝才走本出口，故 result 恒为 denied。
// 字段映射：subject → subject、插件 id → plugin、被拒方法 → target、原因 → detail.reason。
// 写入失败只记 WARN（鉴权已是 fail-closed，不因审计失败放行）。
type capabilityAuditorFromStore struct {
	db *store.Store
}

// Audit 实现 httpapi.CapabilityAuditor。
func (a *capabilityAuditorFromStore) Audit(subject, plugin, target, reason string) {
	if err := a.db.PutAudit(store.AuditRecord{
		Subject: subject,
		Action:  auditActionCapabilityDenied,
		Plugin:  plugin,
		Target:  target,
		Result:  store.AuditResultDenied,
		Detail:  map[string]string{"reason": reason},
	}); err != nil {
		slog.Warn("capability.denied 审计写入失败", "plugin", plugin, "target", target, "err", err)
	}
}
