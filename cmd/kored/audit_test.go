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
	if err != nil || len(asc) != 2 || asc[0].Action != "audit.one" || asc[1].Action != "audit.two" {
		t.Fatalf("升序前 2 条不符合预期: %+v err=%v", asc, err)
	}
	desc, err := l.ListAudit(httpapi.AuditQuery{Since: time.Unix(0, 0), Desc: true, Limit: 2})
	if err != nil || len(desc) != 2 || desc[0].Action != "audit.three" || desc[1].Action != "audit.two" {
		t.Fatalf("降序前 2 条不符合预期: %+v err=%v", desc, err)
	}
}
