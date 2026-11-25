package httpapi

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 审计查询硬上限（R3/S-03：防无界导出与全量拉取 DoS）。
const (
	// auditDefaultLimit 是未指定 limit 时的默认条数。
	auditDefaultLimit = 100
	// auditMaxLimit 是 limit 的硬上限，超过即 400 拒绝，不静默截断。
	auditMaxLimit = 1000
	// auditMaxOffset 是分页偏移的硬上限：只为翻页提供，不允许拿超大 offset 拖全量扫描。
	auditMaxOffset = 1_000_000
	// auditMaxFilterChars 是文本类筛选参数（操作者 / 插件 / 目标 / 关键字）的最大字符数。
	auditMaxFilterChars = 128
)

// auditDetailEntry 是 detail 的一个键值项（显式结构，非 map，G-24）。
type auditDetailEntry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// auditRecordDTO 是单条审计记录的对外视图（全为显式字段，遵守 G-24 无动态类型逃逸）。
// At 由存储键（unix 纳秒前缀）派生，只是响应字段，不落库（DATA-MODEL §9）。
type auditRecordDTO struct {
	At      string             `json:"at"`
	Subject string             `json:"subject"`
	Action  string             `json:"action"`
	Plugin  string             `json:"plugin"`
	Target  string             `json:"target"`
	Result  string             `json:"result"`
	Detail  []auditDetailEntry `json:"detail"`
}

// auditListBody 是 GET /api/v1/audit 的成功响应体。
type auditListBody struct {
	Records []auditRecordDTO `json:"records"`
	// Count 是本页返回条数（既有语义不变）。
	Count int `json:"count"`
	// Total 是筛选后、分页前的总条数（前端「共 N 条」与翻页用）。
	Total int `json:"total"`
	Limit int `json:"limit"`
	// Offset 是本次跳过的条数（回显请求值，便于前端核对分页位置）。
	Offset int `json:"offset"`
}

// AuditQuery 是 audit 查询入参（显式字段，G-24）。
type AuditQuery struct {
	// Since 起始时间（RFC3339），必填；零值视为未提供。
	Since time.Time
	// Action 动作精确过滤（可选；空表示不限）。
	Action string
	// Subject 操作者精确过滤（可选）。
	Subject string
	// Plugin 插件 id 精确过滤（可选）。
	Plugin string
	// Result 结果过滤：ok / denied / error / failed（failed = 非成功，即 denied+error）。
	Result string
	// Target 目标资源关键字（不区分大小写的子串匹配；可选）。
	Target string
	// Keyword 全字段关键字（动作 / 目标 / 操作者 / 插件 / detail 键值，子串匹配；可选）。
	Keyword string
	// OffHours 为 true 时只保留非工作时间（主机本地时间：18:00–次日 09:00 或周末）。
	OffHours bool
	// Desc 为 true 时按时间倒序返回（前端「最新优先」；默认升序保持 CLI 口径）。
	Desc bool
	// Limit 最大返回条数，默认 auditDefaultLimit，上限 auditMaxLimit。
	Limit int
	// Offset 跳过的条数（分页；0 表示第一页）。
	Offset int
}

// AuditRecordView 是 httpapi 侧审计记录视图（显式字段）。由装配层把 store.AuditRecord
// 转成此类型，httpapi 不 import store（G-01 薄壳边界）。Key 供 since 下界过滤。
type AuditRecordView struct {
	Key     string
	Subject string
	Action  string
	Plugin  string
	Target  string
	Result  string
	Detail  map[string]string
}

// AuditPage 是一次审计查询的结果：Records 为当前页，Total 为筛选后未分页的总数。
type AuditPage struct {
	Records []AuditRecordView
	Total   int
}

// AuditLister 由装配层注入，把 ListAudit 的必要子集暴露给 httpapi。
// 返回 AuditPage（当前页 + 分页前总数）：offset/total 是只读查询增强的一部分。
type AuditLister interface {
	ListAudit(q AuditQuery) (AuditPage, error)
}

// parseAuditQuery 解析并校验参数：since 必填 + RFC3339、limit ≤1000、order=asc|desc，
// 以及本轮新增的只读筛选（subject / plugin / result / target / q / offhours / offset）。
// 所有新增参数都可缺省（缺省 = 不限 / 第一页），既有 since/action/order/limit 语义不变。
func parseAuditQuery(r *http.Request) (AuditQuery, string) {
	values := r.URL.Query()
	sinceStr := values.Get("since")
	if sinceStr == "" {
		return AuditQuery{}, "缺少必填参数 since（RFC3339；全量导出已禁止）"
	}
	since, err := time.Parse(time.RFC3339, sinceStr)
	if err != nil {
		return AuditQuery{}, "since 不是合法 RFC3339: " + sinceStr
	}
	desc := false
	switch values.Get("order") {
	case "", "asc":
	case "desc":
		desc = true
	default:
		return AuditQuery{}, "order 只接受 asc 或 desc"
	}
	limit := auditDefaultLimit
	if values.Has("limit") {
		parsed, err := strconv.Atoi(values.Get("limit"))
		if err != nil || parsed <= 0 {
			return AuditQuery{}, "limit 必须是正整数"
		}
		if parsed > auditMaxLimit {
			return AuditQuery{}, "limit 超过上限 " + strconv.Itoa(auditMaxLimit)
		}
		limit = parsed
	}
	offset := 0
	if values.Has("offset") {
		parsed, err := strconv.Atoi(values.Get("offset"))
		if err != nil || parsed < 0 {
			return AuditQuery{}, "offset 应为非负整数（0 表示第一页）"
		}
		if parsed > auditMaxOffset {
			return AuditQuery{}, "offset 超过上限 " + strconv.Itoa(auditMaxOffset) + "，请缩小时间范围后再翻页"
		}
		offset = parsed
	}
	result, problem := parseAuditResultFilter(values.Get("result"))
	if problem != "" {
		return AuditQuery{}, problem
	}
	subject, problem := auditFilterText(values.Get("subject"), "subject（操作者）")
	if problem != "" {
		return AuditQuery{}, problem
	}
	plugin, problem := auditFilterText(values.Get("plugin"), "plugin（插件）")
	if problem != "" {
		return AuditQuery{}, problem
	}
	target, problem := auditFilterText(values.Get("target"), "target（目标）")
	if problem != "" {
		return AuditQuery{}, problem
	}
	keyword, problem := auditFilterText(values.Get("q"), "q（关键字）")
	if problem != "" {
		return AuditQuery{}, problem
	}
	q := AuditQuery{
		Since: since, Action: strings.TrimSpace(values.Get("action")), Subject: subject,
		Plugin: plugin, Result: result, Target: target, Keyword: keyword,
		OffHours: auditOffHoursFilter(values.Get("offhours")), Desc: desc, Limit: limit, Offset: offset,
	}
	return q, ""
}

// parseAuditResultFilter 校验结果筛选值；failed 是「非成功」的便捷写法（denied+error）。
func parseAuditResultFilter(raw string) (string, string) {
	switch raw = strings.TrimSpace(raw); raw {
	case "", "ok", "denied", "error", "failed":
		return raw, ""
	default:
		return "", "result 只接受 ok、denied、error 或 failed（failed = 被拒 + 失败），例如 result=failed"
	}
}

// auditFilterText 统一处理文本筛选：去空白 + 长度上限（按字符计）。
func auditFilterText(raw, name string) (string, string) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", ""
	}
	if len([]rune(text)) > auditMaxFilterChars {
		return "", name + " 过长，请缩到 " + strconv.Itoa(auditMaxFilterChars) + " 字符内"
	}
	return text, ""
}

// auditOffHoursFilter 只接受 1 / true / yes 开启；其余值按关闭处理（筛选开关不是查询条件，
// 不必为拼错的布尔值整体报错）。
func auditOffHoursFilter(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// handleAudit 处理 GET /api/v1/audit：先过目标操作鉴权（system:read），
// 再校验 since 必填与 limit 上限，最后调注入的 auditLister 取数。
func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAuditRead(w, r) {
		return
	}
	q, problem := parseAuditQuery(r)
	if problem != "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, problem, "")
		return
	}
	if s.auditLister == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "审计查询后端未装配", "")
		return
	}
	page, err := s.auditLister.ListAudit(q)
	if err != nil {
		writeFailure(w, err)
		return
	}
	rows, total := page.Records, page.Total
	records := make([]auditRecordDTO, 0, len(rows))
	for _, row := range rows {
		records = append(records, toAuditDTO(row))
	}
	writeJSON(w, http.StatusOK, auditListBody{
		Records: records, Count: len(records), Total: total, Limit: q.Limit, Offset: q.Offset,
	})
}

// auditAt 从审计键 `%020d-%06d` 的纳秒段派生 RFC3339Nano；键非法返回空串，不猜时间。
func auditAt(key string) string {
	dash := strings.IndexByte(key, '-')
	if dash <= 0 {
		return ""
	}
	ns, err := strconv.ParseInt(key[:dash], 10, 64)
	if err != nil || ns <= 0 {
		return ""
	}
	return time.Unix(0, ns).UTC().Format(time.RFC3339Nano)
}

// toAuditDTO 把视图转成 DTO；Detail 的 map 转有序列并按 key 排序，输出稳定（G-24）。
func toAuditDTO(row AuditRecordView) auditRecordDTO {
	detail := make([]auditDetailEntry, 0, len(row.Detail))
	for k, v := range row.Detail {
		detail = append(detail, auditDetailEntry{Key: k, Value: v})
	}
	sort.Slice(detail, func(i, j int) bool { return detail[i].Key < detail[j].Key })
	return auditRecordDTO{
		At: auditAt(row.Key), Subject: row.Subject, Action: row.Action, Plugin: row.Plugin,
		Target: row.Target, Result: row.Result, Detail: detail,
	}
}
