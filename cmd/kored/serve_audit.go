package main

import (
	"context"

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
