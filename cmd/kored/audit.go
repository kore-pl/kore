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

// ListAudit 按 since 下界（Key 前缀为 unix 纳秒）与只读筛选条件过滤，按需倒序，
// 再按 offset/limit 分页；Total 是分页前的命中总数（前端「共 N 条」与翻页用）。
// store.ListAudit 按 key 升序列出；audit key 为 %020d-%06d（纳秒+序号）。
// 本轮只加查询侧筛选，不碰写入路径与存储结构（G-29 之外也不动历史数据）。
func (l *auditListerFromStore) ListAudit(q httpapi.AuditQuery) (httpapi.AuditPage, error) {
	rows, err := l.db.ListAudit(store.AuditFilter{Action: q.Action})
	if err != nil {
		return httpapi.AuditPage{}, err
	}
	lower := fmt.Sprintf("%020d", q.Since.UnixNano())
	keyword := strings.ToLower(q.Keyword)
	target := strings.ToLower(q.Target)
	out := make([]httpapi.AuditRecordView, 0, len(rows))
	for _, rec := range rows {
		if rec.Key != "" && rec.Key[:min(len(rec.Key), 20)] < lower {
			continue
		}
		if q.Subject != "" && rec.Subject != q.Subject {
			continue
		}
		if q.Plugin != "" && rec.Plugin != q.Plugin {
			continue
		}
		if !auditResultMatch(q.Result, rec.Result) {
			continue
		}
		if target != "" && !strings.Contains(strings.ToLower(rec.Target), target) {
			continue
		}
		if keyword != "" && !auditKeywordMatch(rec, keyword) {
			continue
		}
		if q.OffHours && !auditOffHoursKey(rec.Key) {
			continue
		}
		out = append(out, httpapi.AuditRecordView{
			Key: rec.Key, Subject: rec.Subject, Action: rec.Action, Plugin: rec.Plugin,
			Target: rec.Target, Result: rec.Result, Detail: rec.Detail,
		})
	}
	total := len(out)
	if q.Desc {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	if q.Offset > 0 {
		if q.Offset >= len(out) {
			out = out[:0]
		} else {
			out = out[q.Offset:]
		}
	}
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return httpapi.AuditPage{Records: out, Total: total}, nil
}

// auditResultMatch 判定结果筛选：空表示不限；failed 表示「非成功」（denied + error）。
func auditResultMatch(filter, result string) bool {
	switch filter {
	case "":
		return true
	case "failed":
		return result != store.AuditResultOK
	default:
		return result == filter
	}
}

// auditKeywordMatch 关键字检索：动作 / 目标 / 操作者 / 插件 / detail 键与值，全部小写子串匹配。
// 只读派生，不新建索引（审计量受保留策略约束，保持零迁移）。
func auditKeywordMatch(rec store.AuditRecord, keyword string) bool {
	if strings.Contains(strings.ToLower(rec.Action), keyword) ||
		strings.Contains(strings.ToLower(rec.Target), keyword) ||
		strings.Contains(strings.ToLower(rec.Subject), keyword) ||
		strings.Contains(strings.ToLower(rec.Plugin), keyword) {
		return true
	}
	for k, v := range rec.Detail {
		if strings.Contains(strings.ToLower(k), keyword) || strings.Contains(strings.ToLower(v), keyword) {
			return true
		}
	}
	return false
}

// auditOffHoursKey 判断记录是否落在非工作时间：主机本地时间 18:00–次日 09:00 或周六日。
// 键里没有可解析时间戳时按「不是非工作时间」处理（不猜年龄）。
func auditOffHoursKey(key string) bool {
	ts, ok := parseKeyTS(key)
	if !ok {
		return false
	}
	return auditOffHoursAt(time.Unix(0, ts))
}

// auditOffHoursAt 是「非工作时间」的唯一判据（本地时区）：工作日 09:00–18:00 之外、或周末。
func auditOffHoursAt(at time.Time) bool {
	local := at.Local()
	if local.Weekday() == time.Saturday || local.Weekday() == time.Sunday {
		return true
	}
	hour := local.Hour()
	return hour < 9 || hour >= 18
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
	page, err := lister.ListAudit(httpapi.AuditQuery{Since: since, Action: opts.action, Limit: opts.limit})
	if err != nil {
		fmt.Fprintf(stderr, "audit: 查询失败: %v\n", err)
		return exitStore
	}
	if opts.csv {
		writeAuditCSV(stdout, page.Records)
	} else {
		writeAuditText(stdout, page.Records)
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
