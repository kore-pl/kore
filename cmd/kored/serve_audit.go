package main

import (
	"context"
	"log/slog"

	"github.com/pengtang1024/kore/internal/core/credential"
	"github.com/pengtang1024/kore/internal/core/httpapi"
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

// httpAuditRecorderFromStore 把 httpapi 的 HTTP 侧审计事件接到 audit bucket。
//
// 这是 login.success / login.failed / invoke.* / invoke.burst 的落库点：
// 字段一一透传，result 由 httpapi 按 ok/denied/error 归一；detail 受控校验
// （DATA-MODEL §9）在 store.PutAudit 内完成，非法即拒收。
// 写入失败只记 WARN：登录/调用本身已经完成，审计失败不改变业务结果，
// 但必须在进程日志留痕（审计库不可用时仍可取证）。
type httpAuditRecorderFromStore struct {
	db *store.Store
}

// Record 实现 httpapi.AuditRecorder。
func (a *httpAuditRecorderFromStore) Record(ev httpapi.AuditEvent) {
	if err := a.db.PutAudit(store.AuditRecord{
		Subject: ev.Subject,
		Action:  ev.Action,
		Plugin:  ev.Plugin,
		Target:  ev.Target,
		Result:  ev.Result,
		Detail:  ev.Detail,
	}); err != nil {
		slog.Warn("HTTP 审计写入失败", "action", ev.Action, "plugin", ev.Plugin, "err", err)
	}
}

// credentialAuditor 把 credential.grant / credential.revoke 写进 audit bucket（ADR-0026）。
//
// fail-closed 落点：credential.Service 在修改索引前调用本适配器，PutAudit 返回错误时
// 授权/撤销整体失败（E_AUDIT），不允许"审计没写进去但授权生效"。
type credentialAuditor struct {
	db *store.Store
}

// Record 实现 credential.Auditor；detail 只含 owner/grantee/credentialId，不含 secret。
func (a *credentialAuditor) Record(_ context.Context, ev credential.AuditEvent) error {
	return a.db.PutAudit(store.AuditRecord{
		Subject: ev.Actor,
		Action:  ev.Action,
		Plugin:  ev.Owner,
		Target:  ev.CredentialID,
		Result:  store.AuditResultOK,
		Detail:  map[string]string{"grantee": ev.Grantee, "decision": ev.Decision},
	})
}
