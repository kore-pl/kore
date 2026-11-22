package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

// TestAuditQueryNormal 带 since 的管理员查询返回记录（200 + count）。
func TestAuditQueryNormal(t *testing.T) {
	lister := &auditTestLister{rows: []AuditRecordView{
		{Key: "0001-000000", Subject: "admin", Action: "plugins.enable", Plugin: "site", Result: "ok"},
	}}
	ts, cookie := auditSetup(t, adminResolver, lister)
	status, body := auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z")
	if status != http.StatusOK {
		t.Fatalf("正常查询应 200，实际 %d body=%s", status, body)
	}
	var got auditListBody
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v body=%s", err, body)
	}
	if got.Count != 1 || len(got.Records) != 1 || got.Records[0].Action != "plugins.enable" {
		t.Fatalf("查询记录不符合预期: %+v", got)
	}
}

// TestAuditQueryUnauthorized 低权 site:read 访问审计端点 → 401（S-03 越权反例）。
func TestAuditQueryUnauthorized(t *testing.T) {
	ts, cookie := auditSetup(t, siteOnlyResolver, &auditTestLister{})
	status, body := auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z")
	if status != http.StatusUnauthorized {
		t.Fatalf("低权 site:read 应 401，实际 %d body=%s", status, body)
	}
	if !strings.Contains(string(body), "system:read") {
		t.Fatalf("越权错误体应说明需要 system:read，实际 %s", body)
	}
}

// TestAuditQueryNoCookie 无有效 session → 401（withAuth 中间件拦截）。
func TestAuditQueryNoCookie(t *testing.T) {
	ts, _ := auditSetup(t, adminResolver, &auditTestLister{})
	status, body := auditRequest(t, ts, "", "?since=2020-01-01T00%3A00%3A00Z")
	if status != http.StatusUnauthorized {
		t.Fatalf("无 session 应 401，实际 %d body=%s", status, body)
	}
}

// TestAuditQueryRequiresSince 未带 since 的全量导出必须拒绝（S-03 AUDIT-OPEN）。
func TestAuditQueryRequiresSince(t *testing.T) {
	ts, cookie := auditSetup(t, adminResolver, &auditTestLister{})
	for _, q := range []string{"", "?action=plugins.enable", "?limit=10"} {
		status, body := auditRequest(t, ts, cookie, q)
		if status != http.StatusBadRequest {
			t.Fatalf("查询 %q 无 since 应 400，实际 %d body=%s", q, status, body)
		}
		if !strings.Contains(string(body), "since") {
			t.Fatalf("拒绝信息应含 since，实际 %s", body)
		}
	}
}

// TestAuditQueryLimitCap limit 超过上限 1000 → 400（防 DoS）；<=1000 正常。
func TestAuditQueryLimitCap(t *testing.T) {
	ts, cookie := auditSetup(t, adminResolver, &auditTestLister{})
	status, body := auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z&limit=1001")
	if status != http.StatusBadRequest {
		t.Fatalf("limit=1001 应 400，实际 %d body=%s", status, body)
	}
	status, body = auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z&limit=1000")
	if status != http.StatusOK {
		t.Fatalf("limit=1000 应 200，实际 %d body=%s", status, body)
	}
	var got auditListBody
	if err := json.Unmarshal(body, &got); err != nil || got.Limit != 1000 {
		t.Fatalf("limit=1000 响应应含 limit=1000，实际 %+v err=%v", got, err)
	}
}

// TestAuditQueryActionFilter action 过滤生效。
func TestAuditQueryActionFilter(t *testing.T) {
	lister := &auditTestLister{rows: []AuditRecordView{
		{Action: "plugins.enable", Subject: "admin"},
		{Action: "plugins.disable", Subject: "admin"},
	}}
	ts, cookie := auditSetup(t, adminResolver, lister)
	status, body := auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z&action=plugins.enable")
	if status != http.StatusOK {
		t.Fatalf("action 过滤查询应 200，实际 %d body=%s", status, body)
	}
	var got auditListBody
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("非法 JSON: %v", err)
	}
	if got.Count != 1 || got.Records[0].Action != "plugins.enable" {
		t.Fatalf("action 过滤未生效: %+v", got)
	}
}

// TestAuditQueryNoTicker audit 路径不得出现周期定时器（G-19）。
func TestAuditQueryNoTicker(t *testing.T) {
	body, err := os.ReadFile("handlers_audit.go")
	if err != nil {
		t.Fatalf("读取 handler 失败: %v", err)
	}
	for _, forbidden := range []string{"NewTicker", "AfterFunc", "time.Tick("} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("audit 路径出现周期定时器 %q（破 G-19）", forbidden)
		}
	}
}
