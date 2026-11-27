package main

import (
	"context"
	"testing"

	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/store"
)

// TestRootActionAuditNotMerged 验证 root.action 提权审计是独立的 fail-closed 出口：
// 连续 30 次拒绝审计逐条落库（30 条），不经过 deny 突发合并器，不含
// count/window_ms/first_at/last_at 合并元数据——避免把 fail-closed 语义卷入窗口。
func TestRootActionAuditNotMerged(t *testing.T) {
	db, err := store.Open(t.TempDir(), discardLogger())
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	auditor := &rootActionAuditor{db: db}

	const n = 30
	for i := 0; i < n; i++ {
		ev := privilege.Event{
			Actor: "plugin-site", PluginID: "system", ActionID: "restart.test",
			Decision: privilege.DecisionDeny, DenyReason: "测试拒绝",
		}
		if err := auditor.Record(context.Background(), ev); err != nil {
			t.Fatalf("root.action 审计写入失败: %v", err)
		}
	}
	rows, err := db.ListAudit(store.AuditFilter{Action: privilege.AuditAction})
	if err != nil {
		t.Fatalf("读取审计失败: %v", err)
	}
	if len(rows) != n {
		t.Fatalf("root.action 应逐条落库 %d 条（不合并），实际 %d", n, len(rows))
	}
	for _, rec := range rows {
		for _, k := range []string{"count", "window_ms", "first_at", "last_at"} {
			if _, ok := rec.Detail[k]; ok {
				t.Fatalf("root.action 审计不应含合并元数据 %q: %+v", k, rec.Detail)
			}
		}
	}
}
