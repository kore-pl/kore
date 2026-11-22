package main

import (
	"encoding/csv"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
)

// auditListerFromStore 把 store.ListAudit 适配成 httpapi.AuditLister。
// 装配层做类型转换，httpapi 不 import store（G-01）。
type auditListerFromStore struct {
	db *store.Store
}

// ListAudit 按 since 下界（Key 前缀为 unix 纳秒）过滤，按需倒序，再按 limit 截断。
// store.ListAudit 按 key 升序列出；audit key 为 %020d-%06d（纳秒+序号）。
func (l *auditListerFromStore) ListAudit(q httpapi.AuditQuery) ([]httpapi.AuditRecordView, error) {
	rows, err := l.db.ListAudit(store.AuditFilter{Action: q.Action})
	if err != nil {
		return nil, err
	}
	lower := fmt.Sprintf("%020d", q.Since.UnixNano())
	out := make([]httpapi.AuditRecordView, 0, len(rows))
	for _, rec := range rows {
		if rec.Key != "" && rec.Key[:min(len(rec.Key), 20)] < lower {
			continue
		}
		out = append(out, httpapi.AuditRecordView{
			Key: rec.Key, Subject: rec.Subject, Action: rec.Action, Plugin: rec.Plugin,
			Target: rec.Target, Result: rec.Result, Detail: rec.Detail,
		})
	}
	if q.Desc {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, nil
}

// auditStateDir 取状态目录：优先 KORE_STATE_DIR 环境变量（与 serve 同源）。
func auditStateDir() string {
	return os.Getenv("KORE_STATE_DIR")
}

// discardAuditLogger 返回丢弃输出的 logger，避免 CLI 刷系统日志。
func discardAuditLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// auditOptions 是 audit 子命令解析后的参数。
type auditOptions struct {
	since  string
	action string
	csv    bool
	limit  int
}

// parseAuditFlags 解析 audit 参数；flag 自身错误返回 error。
func parseAuditFlags(args []string, stderr io.Writer) (auditOptions, error) {
	fs := flag.NewFlagSet("audit", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var o auditOptions
	fs.StringVar(&o.since, "since", "", "起始时间（RFC3339，必填；全量导出禁止）")
	fs.StringVar(&o.action, "action", "", "动作过滤（可选，如 plugins.enable）")
	fs.BoolVar(&o.csv, "csv", false, "以 CSV 格式导出（带表头）")
	fs.IntVar(&o.limit, "limit", 100, "最大返回条数（默认 100，上限 1000）")
	fs.Usage = func() { printAuditUsage(stderr) }
	if err := fs.Parse(args); err != nil {
		return auditOptions{}, err
	}
	return o, nil
}

// printAuditUsage 打印 audit 参数说明。
func printAuditUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: kored audit --since <RFC3339> [--action <action>] [--csv] [--limit N]")
}

// runAudit 是 audit 子命令入口：读 store 的 audit bucket 并输出。
func runAudit(args []string, stdout, stderr io.Writer) int {
	opts, err := parseAuditFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	if opts.since == "" {
		fmt.Fprintln(stderr, "audit: --since 必填（RFC3339；全量导出已禁止，上限 1000）")
		return exitConfig
	}
	since, err := time.Parse(time.RFC3339, opts.since)
	if err != nil {
		fmt.Fprintf(stderr, "audit: --since 不是合法 RFC3339: %s\n", opts.since)
		return exitConfig
	}
	if opts.limit <= 0 || opts.limit > 1000 {
		fmt.Fprintln(stderr, "audit: --limit 必须是 1..1000")
		return exitConfig
	}
	stateDir := auditStateDir()
	db, err := store.Open(stateDir, discardAuditLogger())
	if err != nil {
		fmt.Fprintf(stderr, "audit: 状态库打开失败（state-dir=%s）: %v\n", stateDir, err)
		return exitStore
	}
	defer func() { _ = db.Close() }()
	lister := &auditListerFromStore{db: db}
	rows, err := lister.ListAudit(httpapi.AuditQuery{Since: since, Action: opts.action, Limit: opts.limit})
	if err != nil {
		fmt.Fprintf(stderr, "audit: 查询失败: %v\n", err)
		return exitStore
	}
	if opts.csv {
		writeAuditCSV(stdout, rows)
	} else {
		writeAuditText(stdout, rows)
	}
	return exitOK
}

// writeAuditCSV 导出带表头的 CSV（表头固定 7 列）。
func writeAuditCSV(w io.Writer, rows []httpapi.AuditRecordView) {
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"time", "subject", "action", "plugin", "target", "result", "detail"})
	for _, row := range rows {
		ts := ""
		if tsNum, ok := parseKeyTS(row.Key); ok {
			ts = time.Unix(0, tsNum).UTC().Format(time.RFC3339Nano)
		}
		_ = cw.Write([]string{ts, row.Subject, row.Action, row.Plugin, row.Target, row.Result, flattenDetail(row.Detail)})
	}
	cw.Flush()
}

// writeAuditText 以对齐列输出审计记录（人类可读）。
func writeAuditText(w io.Writer, rows []httpapi.AuditRecordView) {
	for _, row := range rows {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			row.Key, row.Subject, row.Action, row.Plugin, row.Target, row.Result, flattenDetail(row.Detail))
	}
}

// flattenDetail 把 detail map 稳定序列化为 k=v,k=v（按 key 排序）。
func flattenDetail(detail map[string]string) string {
	if len(detail) == 0 {
		return ""
	}
	keys := make([]string, 0, len(detail))
	for k := range detail {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+detail[k])
	}
	return strings.Join(parts, ",")
}

// parseKeyTS 从 %020d-%06d 的 key 取 unix 纳秒。
func parseKeyTS(key string) (int64, bool) {
	dash := strings.IndexByte(key, '-')
	if dash <= 0 {
		return 0, false
	}
	ts, err := strconv.ParseInt(key[:dash], 10, 64)
	return ts, err == nil
}
