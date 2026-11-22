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
	Count   int              `json:"count"`
	Limit   int              `json:"limit"`
}

// AuditQuery 是 audit 查询入参（显式字段，G-24）。
type AuditQuery struct {
	// Since 起始时间（RFC3339），必填；零值视为未提供。
	Since time.Time
	// Action 动作过滤（可选；空表示不限）。
	Action string
	// Desc 为 true 时按时间倒序返回（前端「最新优先」；默认升序保持 CLI 口径）。
	Desc bool
	// Limit 最大返回条数，默认 auditDefaultLimit，上限 auditMaxLimit。
	Limit int
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

// AuditLister 由装配层注入，把 ListAudit 的必要子集暴露给 httpapi。
type AuditLister interface {
	ListAudit(q AuditQuery) ([]AuditRecordView, error)
}

// parseAuditQuery 解析并校验参数：since 必填 + RFC3339、limit ≤1000、action 可选、order=asc|desc。
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
	return AuditQuery{Since: since, Action: values.Get("action"), Desc: desc, Limit: limit}, ""
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
	rows, err := s.auditLister.ListAudit(q)
	if err != nil {
		writeFailure(w, err)
		return
	}
	records := make([]auditRecordDTO, 0, len(rows))
	for _, row := range rows {
		records = append(records, toAuditDTO(row))
	}
	writeJSON(w, http.StatusOK, auditListBody{Records: records, Count: len(records), Limit: q.Limit})
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
