package main

import (
	"testing"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
)

// TestHTTPAuditRecorderWritesStore 验证 HTTP 审计适配器真实落 bbolt：
// action / subject / result / detail 原样透传，可被 ListAudit 读回。
func TestHTTPAuditRecorderWritesStore(t *testing.T) {
	db, err := store.Open(t.TempDir(), discardLogger())
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	recorder := &httpAuditRecorderFromStore{db: db}
	recorder.Record(httpapi.AuditEvent{
		Subject: "admin",
		Action:  "login.success",
		Result:  "ok",
		Detail:  map[string]string{"ip": "192.168.1.x", "session_id_prefix": "abcdefgh"},
	})
	recorder.Record(httpapi.AuditEvent{
		Subject: "admin", Action: "invoke.db-mysql.db-mysql.dropDatabase",
		Plugin: "db-mysql", Target: "db-mysql/db-mysql.dropDatabase",
		Result: "error", Detail: map[string]string{"duration_ms": "3", "error_code": "E_NOTFOUND"},
	})

	rows, err := db.ListAudit(store.AuditFilter{})
	if err != nil {
		t.Fatalf("读取审计失败: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("应写入 2 条审计，实际 %d", len(rows))
	}
	if rows[0].Action != "login.success" || rows[0].Detail["ip"] != "192.168.1.x" {
		t.Errorf("login 审计字段不符: %+v", rows[0])
	}
	if rows[1].Action != "invoke.db-mysql.db-mysql.dropDatabase" ||
		rows[1].Plugin != "db-mysql" || rows[1].Result != store.AuditResultError ||
		rows[1].Detail["error_code"] != "E_NOTFOUND" {
		t.Errorf("invoke 审计字段不符: %+v", rows[1])
	}
}
