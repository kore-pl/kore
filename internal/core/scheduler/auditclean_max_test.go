package scheduler

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// TestAuditCleanMaxRecordsTrim 按量上限经内置清理任务生效：
// 未到期但超上限的记录按最旧端删除，清理审计 detail 记 trim_deleted 区分原因。
func TestAuditCleanMaxRecordsTrim(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	// 8 条未过期记录（1h 前），按量上限 5 → 应删 3 条最旧。
	for i := 0; i < 8; i++ {
		putAuditAt(t, service, clock.Now().Add(-time.Hour), i, "capability.denied")
	}
	params := json.RawMessage(`{"retention_seconds":7776000,"batch":100,"max_records":5}`)
	out, err := service.cleanAudit(context.Background(), Task{ID: builtinAuditCleanID, Params: params})
	if err != nil {
		t.Fatalf("按量清理失败: %v", err)
	}
	var result auditCleanResult
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("解析结果失败: %v", err)
	}
	if result.TrimDeleted != 3 || result.MaxRecords != 5 {
		t.Fatalf("按量清理应删 3 条，实际 %+v", result)
	}
	if got := countAudit(t, service, "capability.denied"); got != 5 {
		t.Fatalf("按量清理后应剩 5 条，实际 %d", got)
	}
	// 清理审计 detail 记录删除原因与条数（可追溯）。
	cleanRecords, _ := service.store.ListAudit(store.AuditFilter{Action: AuditCleanMethod})
	if len(cleanRecords) != 1 || cleanRecords[0].Detail["trim_deleted"] != "3" {
		t.Fatalf("清理审计应记 trim_deleted=3，实际 %+v", cleanRecords)
	}
}

// TestAuditCleanParamsRejectBadMaxRecords 越界 max_records 被参数校验拒绝，不删任何记录。
func TestAuditCleanParamsRejectBadMaxRecords(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	putAuditAt(t, service, clock.Now().Add(-time.Hour), 0, "capability.denied")
	params := json.RawMessage(`{"retention_seconds":7776000,"batch":100,"max_records":2000000}`)
	_, err := service.cleanAudit(context.Background(), Task{ID: builtinAuditCleanID, Params: params})
	if err == nil {
		t.Fatal("max_records 越界应被拒绝")
	}
	if got := countAudit(t, service, "capability.denied"); got != 1 {
		t.Fatalf("拒绝清理时不得删记录，实际剩 %d", got)
	}
}
