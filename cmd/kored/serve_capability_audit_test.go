package main

import (
	"context"
	"reflect"
	"testing"

	"github.com/pengtang1024/kore/internal/core/store"
)

// TestDaemonPluginCapabilitiesFromManifest 验证 invoke 调用校验的首选数据源：
// daemon 直接返回 info.json 的 capabilities（Manifest.Capabilities），未安装返回 known=false。
func TestDaemonPluginCapabilitiesFromManifest(t *testing.T) {
	h := newHarness(t, pluginSpec{ID: "echo", Lifecycle: "resident"})

	caps, ok, err := h.svc.backend.PluginCapabilities(context.Background(), "echo")
	if err != nil {
		t.Fatalf("读取能力声明失败: %v", err)
	}
	if !ok {
		t.Fatal("已安装插件应 known=true")
	}
	if !reflect.DeepEqual(caps, []string{"system:read"}) {
		t.Fatalf("capabilities = %v，期望 [system:read]", caps)
	}

	_, ok, err = h.svc.backend.PluginCapabilities(context.Background(), "not-installed")
	if err != nil {
		t.Fatalf("未安装插件不应报错: %v", err)
	}
	if ok {
		t.Fatal("未安装插件应 known=false")
	}
}

// TestCapabilityAuditWritesDenied 验证 invoke 越权审计真实落 bbolt：
// action=capability.denied、result=denied、target=被拒方法、detail 带原因。
func TestCapabilityAuditWritesDenied(t *testing.T) {
	db, err := store.Open(t.TempDir(), discardLogger())
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	auditor := &capabilityAuditorFromStore{db: db}
	auditor.Audit("plugin-site", "db-mysql", "db-mysql.dropDatabase", "调用该插件需要 system:admin 能力")

	rows, err := db.ListAudit(store.AuditFilter{})
	if err != nil {
		t.Fatalf("读取审计失败: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("应写入 1 条审计，实际 %d", len(rows))
	}
	rec := rows[0]
	if rec.Action != auditActionCapabilityDenied {
		t.Errorf("action = %q，期望 %q", rec.Action, auditActionCapabilityDenied)
	}
	if rec.Result != store.AuditResultDenied {
		t.Errorf("result = %q，期望 denied", rec.Result)
	}
	if rec.Subject != "plugin-site" || rec.Plugin != "db-mysql" || rec.Target != "db-mysql.dropDatabase" {
		t.Errorf("字段映射不符: %+v", rec)
	}
	if rec.Detail["reason"] != "调用该插件需要 system:admin 能力" {
		t.Errorf("detail.reason = %q", rec.Detail["reason"])
	}
}
