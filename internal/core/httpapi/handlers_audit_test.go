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
	if got.Records[0].At == "" {
		t.Fatalf("响应应含由键派生的 at 时间字段: %+v", got.Records[0])
	}
}

// TestAuditQueryOrder order=desc 透传给取数层；非法值 400，不静默忽略。
func TestAuditQueryOrder(t *testing.T) {
	lister := &auditTestLister{rows: []AuditRecordView{{Action: "plugins.enable"}}}
	ts, cookie := auditSetup(t, adminResolver, lister)
	status, body := auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z&order=desc")
	if status != http.StatusOK {
		t.Fatalf("order=desc 应 200，实际 %d body=%s", status, body)
	}
	if !lister.last.Desc {
		t.Fatalf("order=desc 未透传到 ListAudit: %+v", lister.last)
	}
	status, body = auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z&order=sideways")
	if status != http.StatusBadRequest || !strings.Contains(string(body), "order") {
		t.Fatalf("非法 order 应 400 且说明 order，实际 %d body=%s", status, body)
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

// TestAuditQueryNewFilterPassthrough 新增只读筛选透传到取数层（subject/plugin/result/target/q/offhours/offset）。
func TestAuditQueryNewFilterPassthrough(t *testing.T) {
	lister := &auditTestLister{rows: []AuditRecordView{
		{Key: "0001-000000", Subject: "admin", Action: "invoke.site.site.create", Plugin: "site", Target: "site/site.create", Result: "error"},
		{Key: "0002-000000", Subject: "system", Action: "plugin.crash", Plugin: "site", Result: "error"},
	}}
	ts, cookie := auditSetup(t, adminResolver, lister)
	query := "?since=2020-01-01T00%3A00%3A00Z&subject=admin&plugin=site&result=failed&target=site%2F&q=create&offhours=1&offset=2"
	status, body := auditRequest(t, ts, cookie, query)
	if status != http.StatusOK {
		t.Fatalf("组合筛选应 200，实际 %d body=%s", status, body)
	}
	got := lister.last
	if got.Subject != "admin" || got.Plugin != "site" || got.Result != "failed" || got.Target != "site/" ||
		got.Keyword != "create" || !got.OffHours || got.Offset != 2 {
		t.Fatalf("新筛选参数未完整透传: %+v", got)
	}
}

// TestAuditQueryPagingAndTotal 响应回显 offset 与筛选后的 total；分页只影响当前页条数。
func TestAuditQueryPagingAndTotal(t *testing.T) {
	lister := &auditTestLister{rows: []AuditRecordView{
		{Key: "0001-000000", Subject: "admin", Action: "a.one", Result: "ok"},
		{Key: "0002-000000", Subject: "admin", Action: "a.two", Result: "ok"},
		{Key: "0003-000000", Subject: "admin", Action: "a.three", Result: "ok"},
	}}
	ts, cookie := auditSetup(t, adminResolver, lister)
	status, body := auditRequest(t, ts, cookie, "?since=2020-01-01T00%3A00%3A00Z&limit=1&offset=1&order=desc")
	if status != http.StatusOK {
		t.Fatalf("分页查询应 200，实际 %d body=%s", status, body)
	}
	var got auditListBody
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v body=%s", err, body)
	}
	if got.Total != 3 || got.Count != 1 || len(got.Records) != 1 || got.Offset != 1 || got.Limit != 1 {
		t.Fatalf("分页回显不符合预期: %+v", got)
	}
	if lister.last.Desc != true || lister.last.Offset != 1 {
		t.Fatalf("分页参数未透传: %+v", lister.last)
	}
}

// TestAuditQueryFilterValidation 非法筛选值 400 且说明改哪里（不静默忽略）。
func TestAuditQueryFilterValidation(t *testing.T) {
	ts, cookie := auditSetup(t, adminResolver, &auditTestLister{})
	base := "?since=2020-01-01T00%3A00%3A00Z"
	long := strings.Repeat("长", auditMaxFilterChars+1)
	cases := []struct {
		query string
		want  string
	}{
		{base + "&result=bogus", "result"},
		{base + "&offset=-1", "offset"},
		{base + "&limit=0", "limit"},
		{base + "&q=" + long, "过长"},
		{base + "&subject=" + long, "过长"},
	}
	for _, c := range cases {
		status, body := auditRequest(t, ts, cookie, c.query)
		if status != http.StatusBadRequest {
			t.Fatalf("查询 %q 应 400，实际 %d body=%s", c.query, status, body)
		}
		if !strings.Contains(string(body), c.want) {
			t.Fatalf("拒绝信息应含 %q，实际 %s", c.want, body)
		}
	}
}
