package main

import (
	"context"

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
