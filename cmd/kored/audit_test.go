package main

import (
	"bytes"
	"encoding/csv"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
)

// auditSeed 在 stateDir 写入两条可识别审计记录。
func auditSeed(t *testing.T, stateDir string) {
	t.Helper()
	db, err := store.Open(stateDir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	records := []store.AuditRecord{
		{Subject: "admin", Action: "plugins.enable", Plugin: "site", Target: "site", Result: store.AuditResultOK,
			Detail: map[string]string{"version": "0.1.0"}},
		{Subject: "admin", Action: "plugins.disable", Plugin: "echo", Target: "echo", Result: store.AuditResultOK},
	}
	for _, rec := range records {
		if err := db.PutAudit(rec); err != nil {
			t.Fatalf("写审计失败: %v", err)
		}
	}
}

// TestAuditCSVHeader --csv 导出带表头，且含目标事件行。
func TestAuditCSVHeader(t *testing.T) {
	dir := t.TempDir()
	auditSeed(t, dir)
	t.Setenv("KORE_STATE_DIR", dir)
	var out, errBuf bytes.Buffer
	code := runAudit([]string{"--since", "2000-01-01T00:00:00Z", "--action", "plugins.enable", "--csv"}, &out, &errBuf)
	if code != exitOK {
		t.Fatalf("audit --csv 应退 0，实际 %d stderr=%s", code, errBuf.String())
	}
	reader := csv.NewReader(strings.NewReader(out.String()))
	rows, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("CSV 解析失败: %v out=%s", err, out.String())
	}
	want := []string{"time", "subject", "action", "plugin", "target", "result", "detail"}
	if len(rows) == 0 || !equalStrings(rows[0], want) {
		t.Fatalf("CSV 表头不符: got=%v want=%v", rows[0], want)
	}
	found := false
	for _, row := range rows[1:] {
		if len(row) >= 6 && row[2] == "plugins.enable" && row[3] == "site" {
			found = true
		}
	}
	if !found {
		t.Fatalf("CSV 未含目标事件行: %s", out.String())
	}
}

// TestAuditRequiresSince 无 --since 必须被拒（全量导出禁止，S-03 AUDIT-OPEN）。
func TestAuditRequiresSince(t *testing.T) {
	dir := t.TempDir()
	auditSeed(t, dir)
	t.Setenv("KORE_STATE_DIR", dir)
	for _, args := range [][]string{
		{},
		{"--csv"},
		{"--action", "plugins.enable"},
	} {
		var out, errBuf bytes.Buffer
		code := runAudit(args, &out, &errBuf)
		if code == exitOK {
			t.Fatalf("args=%v 无 --since 应被拒，实际退 0", args)
		}
		msg := errBuf.String()
		if !strings.Contains(msg, "since") || !strings.Contains(msg, "上限") {
			t.Fatalf("拒绝信息应含 since 与上限，实际 %q", msg)
		}
	}
}

// TestAuditTextOutput 无 --csv 时输出人类可读文本，含目标事件。
func TestAuditTextOutput(t *testing.T) {
	dir := t.TempDir()
	auditSeed(t, dir)
	t.Setenv("KORE_STATE_DIR", dir)
	var out, errBuf bytes.Buffer
	code := runAudit([]string{"--since", "2000-01-01T00:00:00Z"}, &out, &errBuf)
	if code != exitOK {
		t.Fatalf("audit 应退 0，实际 %d stderr=%s", code, errBuf.String())
	}
	if !strings.Contains(out.String(), "plugins.enable") || !strings.Contains(out.String(), "plugins.disable") {
		t.Fatalf("文本输出未含目标事件: %s", out.String())
	}
}

// TestAuditLimitCap --limit 超上限被拒。
func TestAuditLimitCap(t *testing.T) {
	dir := t.TempDir()
	auditSeed(t, dir)
	t.Setenv("KORE_STATE_DIR", dir)
	var out, errBuf bytes.Buffer
	code := runAudit([]string{"--since", "2000-01-01T00:00:00Z", "--limit", "1001"}, &out, &errBuf)
	if code == exitOK {
		t.Fatalf("--limit 1001 应被拒，实际退 0")
	}
	if !strings.Contains(errBuf.String(), "1000") {
		t.Fatalf("拒绝信息应含上限 1000，实际 %q", errBuf.String())
	}
}

// TestAuditSinceFiltersOld since 设为未来时不过滤出任何记录。
func TestAuditSinceFiltersOld(t *testing.T) {
	dir := t.TempDir()
	auditSeed(t, dir)
	t.Setenv("KORE_STATE_DIR", dir)
	var out, errBuf bytes.Buffer
	future := time.Now().Add(time.Hour).Format(time.RFC3339)
	code := runAudit([]string{"--since", future, "--csv"}, &out, &errBuf)
	if code != exitOK {
		t.Fatalf("audit 应退 0，实际 %d stderr=%s", code, errBuf.String())
	}
	// 只有表头，没有数据行。
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Fatalf("未来 since 应只有表头无数据，实际 %s", out.String())
	}
}

// TestAuditMainDispatch 验证 main 的 audit 子命令分派存在（未知子命令仍退 2）。
func TestAuditMainDispatch(t *testing.T) {
	dir := t.TempDir()
	auditSeed(t, dir)
	t.Setenv("KORE_STATE_DIR", dir)
	var out, errBuf bytes.Buffer
	code := run([]string{"audit", "--since", "2000-01-01T00:00:00Z", "--csv"}, &out, &errBuf)
	if code != exitOK {
		t.Fatalf("run audit 应退 0，实际 %d stderr=%s", code, errBuf.String())
	}
	if !strings.Contains(out.String(), "subject,action") {
		t.Fatalf("run audit 应输出 CSV 表头，实际 %s", out.String())
	}
}

// equalStrings 比较两个字符串切片（顺序敏感）。
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestAuditListerOrder 装配层：asc 保持键序，desc 最新优先，limit 在排序后截断。
func TestAuditListerOrder(t *testing.T) {
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, action := range []string{"audit.one", "audit.two", "audit.three"} {
		if err := db.PutAudit(store.AuditRecord{Subject: "admin", Action: action, Result: store.AuditResultOK}); err != nil {
			t.Fatalf("写审计失败: %v", err)
		}
	}
	l := &auditListerFromStore{db: db}
	asc, err := l.ListAudit(httpapi.AuditQuery{Since: time.Unix(0, 0), Limit: 2})
	if err != nil || len(asc.Records) != 2 || asc.Records[0].Action != "audit.one" || asc.Records[1].Action != "audit.two" {
		t.Fatalf("升序前 2 条不符合预期: %+v err=%v", asc, err)
	}
	if asc.Total != 3 {
		t.Fatalf("分页前 total 应为 3，实际 %d", asc.Total)
	}
	desc, err := l.ListAudit(httpapi.AuditQuery{Since: time.Unix(0, 0), Desc: true, Limit: 2})
	if err != nil || len(desc.Records) != 2 || desc.Records[0].Action != "audit.three" || desc.Records[1].Action != "audit.two" {
		t.Fatalf("降序前 2 条不符合预期: %+v err=%v", desc, err)
	}
}

// TestAuditListerFiltersAndTotal 装配层只读筛选 + 分页 total（真实 store 记录）。
func TestAuditListerFiltersAndTotal(t *testing.T) {
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	records := []store.AuditRecord{
		{Subject: "admin", Action: "invoke.site.site.create", Plugin: "site", Target: "site/site.create",
			Result: store.AuditResultOK, Detail: map[string]string{"duration_ms": "12"}},
		{Subject: "admin", Action: "invoke.site.site.create", Plugin: "site", Target: "site/site.create",
			Result: store.AuditResultError, Detail: map[string]string{"duration_ms": "31", "error_code": "E_INTERNAL"}},
		{Subject: "system", Action: "plugin.crash", Plugin: "site", Result: store.AuditResultError},
		{Subject: "admin", Action: "login.failed", Result: store.AuditResultDenied,
			Detail: map[string]string{"ip": "10.0.0.x", "reason": "wrong_password"}},
	}
	for _, rec := range records {
		if err := db.PutAudit(rec); err != nil {
			t.Fatalf("写审计失败: %v", err)
		}
	}
	l := &auditListerFromStore{db: db}
	epoch := time.Unix(0, 0)
	cases := []struct {
		name string
		q    httpapi.AuditQuery
		want int
	}{
		{"全部", httpapi.AuditQuery{Since: epoch, Limit: 100}, 4},
		{"按操作者", httpapi.AuditQuery{Since: epoch, Subject: "admin", Limit: 100}, 3},
		{"按插件", httpapi.AuditQuery{Since: epoch, Plugin: "site", Limit: 100}, 3},
		{"失败含被拒", httpapi.AuditQuery{Since: epoch, Result: "failed", Limit: 100}, 3},
		{"只要被拒", httpapi.AuditQuery{Since: epoch, Result: "denied", Limit: 100}, 1},
		{"目标子串", httpapi.AuditQuery{Since: epoch, Target: "site.create", Limit: 100}, 2},
		{"关键字匹配 detail", httpapi.AuditQuery{Since: epoch, Keyword: "wrong_password", Limit: 100}, 1},
		{"关键字匹配 IP", httpapi.AuditQuery{Since: epoch, Keyword: "10.0.0", Limit: 100}, 1},
		{"关键字不区分大小写", httpapi.AuditQuery{Since: epoch, Keyword: "e_internal", Limit: 100}, 1},
		{"组合筛选", httpapi.AuditQuery{Since: epoch, Subject: "admin", Result: "error", Limit: 100}, 1},
	}
	for _, c := range cases {
		page, err := l.ListAudit(c.q)
		if err != nil {
			t.Fatalf("%s 查询失败: %v", c.name, err)
		}
		if page.Total != c.want || len(page.Records) != c.want {
			t.Fatalf("%s 应命中 %d 条，实际 total=%d len=%d", c.name, c.want, page.Total, len(page.Records))
		}
	}
	page, err := l.ListAudit(httpapi.AuditQuery{Since: epoch, Limit: 2, Offset: 1})
	if err != nil || page.Total != 4 || len(page.Records) != 2 {
		t.Fatalf("分页应 total=4 len=2，实际 total=%d len=%d err=%v", page.Total, len(page.Records), err)
	}
	page, err = l.ListAudit(httpapi.AuditQuery{Since: epoch, Limit: 2, Offset: 4})
	if err != nil || page.Total != 4 || len(page.Records) != 0 {
		t.Fatalf("越界 offset 应空页但保留 total=4，实际 total=%d len=%d err=%v", page.Total, len(page.Records), err)
	}
}

// TestAuditOffHoursAt 非工作时间判据（本地时间）：工作日 09:00–18:00 之外、或周末。
func TestAuditOffHoursAt(t *testing.T) {
	cases := []struct {
		name string
		at   time.Time
		want bool
	}{
		{"周一上午", time.Date(2024, 1, 1, 10, 0, 0, 0, time.Local), false},
		{"周一凌晨", time.Date(2024, 1, 1, 8, 59, 0, 0, time.Local), true},
		{"周一午夜前", time.Date(2024, 1, 1, 23, 0, 0, 0, time.Local), true},
		{"周一刚下班", time.Date(2024, 1, 1, 18, 0, 0, 0, time.Local), true},
		{"周六中午", time.Date(2024, 1, 6, 12, 0, 0, 0, time.Local), true},
		{"周日中午", time.Date(2024, 1, 7, 12, 0, 0, 0, time.Local), true},
	}
	for _, c := range cases {
		if got := auditOffHoursAt(c.at); got != c.want {
			t.Fatalf("%s（%s）应 %v，实际 %v", c.name, c.at.Format("2006-01-02 15:04"), c.want, got)
		}
	}
}
