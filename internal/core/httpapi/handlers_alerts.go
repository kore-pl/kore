package httpapi

import (
	"net/http"
	"strconv"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 告警中心端点（docs/CORE.md §2.4）：照 scheduler 端点风格。
//   - GET  /api/v1/alerts?limit=&severity=   列表（最新在前）——system:read
//   - POST /api/v1/alerts                    写入（内核检查点亦经 AlertSink 落库）——system:admin
//   - POST /api/v1/alerts/{id}/seen          标记已读——system:admin
//
// 未装配 AlertSink 时一律 501 E_UNSUPPORTED（零服务路径不受影响）。

const (
	// alertsPath 是告警中心端点前缀。
	alertsPath = "/api/v1/alerts"
	// alertsDefaultLimit 是未指定 limit 时的默认条数。
	alertsDefaultLimit = 100
	// alertsMaxLimit 是 limit 硬上限（= store 保留上限 500，不静默截断）。
	alertsMaxLimit = 500
	// alertsTitleMaxRunes / alertsDetailMaxRunes 与持久层校验同口径（快路径 400）。
	alertsTitleMaxRunes  = 200
	alertsDetailMaxRunes = 512
)

// alertsListBody 是 GET /api/v1/alerts 的响应体。
type alertsListBody struct {
	// Alerts 按时间倒序（最新在前）。
	Alerts []AlertView `json:"alerts"`
	// Count 是本次返回条数。
	Count int `json:"count"`
	// Unread 是全库未读总数（不受 severity 过滤影响；铃铛红点用）。
	Unread int `json:"unread"`
	// Limit 是生效的条数上限。
	Limit int `json:"limit"`
}

// alertsWriteBody 是 POST /api/v1/alerts 的请求体（severity/source 受控词表）。
type alertsWriteBody struct {
	Severity string `json:"severity"`
	Source   string `json:"source"`
	Title    string `json:"title"`
	Detail   string `json:"detail,omitempty"`
}

// alertsSeenBody 是 POST /api/v1/alerts/{id}/seen 的响应体。
type alertsSeenBody struct {
	Seen bool `json:"seen"`
}

// requireAlerts 取告警持久层；未装配时回 501（不假装有历史）。
func (s *Server) requireAlerts(w http.ResponseWriter) (AlertSink, bool) {
	if s.alerts == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"告警中心后端未装配", "")
		return nil, false
	}
	return s.alerts, true
}

// authorizeAlerts 先过目标操作校验（session 有效性），再要求指定能力：
// 列表 system:read，写入/已读 system:admin；缺能力一律 401（fail-closed）。
func (s *Server) authorizeAlerts(w http.ResponseWriter, r *http.Request, capability string) bool {
	if !s.authorizeTargetAction(w, r) {
		return false
	}
	if s.auth == nil {
		return true // 探活骨架（测试）未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, capability) {
		s.auditDenied(subject, "alerts", "", "", "需要 "+capability+" 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：告警中心需要 "+capability+" 能力", capability)
		return false
	}
	return true
}

// handleAlertsList 处理 GET /api/v1/alerts：解析 limit/severity → 持久层倒序查询。
func (s *Server) handleAlertsList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAlerts(w, r, alertCapRead) {
		return
	}
	sink, ok := s.requireAlerts(w)
	if !ok {
		return
	}
	q, problem := parseAlertsQuery(r)
	if problem != "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, problem, "")
		return
	}
	rows, unread, err := sink.ListAlerts(q)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, alertsListBody{
		Alerts: rows, Count: len(rows), Unread: unread, Limit: q.Limit,
	})
}

// handleAlertsWrite 处理 POST /api/v1/alerts：校验受控词表与长度后落库。
// 内核各检查点走进程内 recordAlert，不经 HTTP；本端点供运维与测试显式写入。
func (s *Server) handleAlertsWrite(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAlerts(w, r, alertCapAdmin) {
		return
	}
	sink, ok := s.requireAlerts(w)
	if !ok {
		return
	}
	var input alertsWriteBody
	if err := decodeJSONBody(w, r, &input); err != nil {
		writeFailure(w, err)
		return
	}
	if !validAlertWords(input.Severity, input.Source) || !validAlertTexts(input.Title, input.Detail) {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"severity 须为 critical/warning/info，source 须为 audit/plugin/resource/slot，"+
				"title 1..200 字符，detail ≤512 字符", "")
		return
	}
	rec, err := sink.PutAlert(input.Severity, input.Source, input.Title, input.Detail)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// handleAlertSeen 处理 POST /api/v1/alerts/{id}/seen；id 不存在回 404（不伪装成功）。
func (s *Server) handleAlertSeen(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAlerts(w, r, alertCapAdmin) {
		return
	}
	sink, ok := s.requireAlerts(w)
	if !ok {
		return
	}
	if err := sink.MarkAlertSeen(r.PathValue("id")); err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, alertsSeenBody{Seen: true})
}

// 告警端点能力要求（与管理端点同源的 6 特权能力语法）。
const (
	alertCapRead  = "system:read"
	alertCapAdmin = "system:admin"
)

// parseAlertsQuery 解析 limit（默认 100，上限 500）与可选 severity。
func parseAlertsQuery(r *http.Request) (AlertQuery, string) {
	values := r.URL.Query()
	limit := alertsDefaultLimit
	if values.Has("limit") {
		parsed, err := strconv.Atoi(values.Get("limit"))
		if err != nil || parsed <= 0 {
			return AlertQuery{}, "limit 必须是正整数"
		}
		if parsed > alertsMaxLimit {
			return AlertQuery{}, "limit 超过上限 " + strconv.Itoa(alertsMaxLimit)
		}
		limit = parsed
	}
	severity := values.Get("severity")
	switch severity {
	case "", alertSeverityCritical, alertSeverityWarning, alertSeverityInfo:
	default:
		return AlertQuery{}, "severity 只接受 critical/warning/info"
	}
	return AlertQuery{Severity: severity, Limit: limit}, ""
}

// validAlertWords 校验 severity/source 受控词表（与 store.PutAlert 同口径）。
func validAlertWords(severity, source string) bool {
	switch severity {
	case alertSeverityCritical, alertSeverityWarning, alertSeverityInfo:
	default:
		return false
	}
	switch source {
	case alertSourceAudit, alertSourcePlugin, alertSourceResource, alertSourceSlot:
	default:
		return false
	}
	return true
}

// validAlertTexts 校验 title/detail 长度（按 rune 计，与 store 同口径）。
func validAlertTexts(title, detail string) bool {
	n := len([]rune(title))
	if n == 0 || n > alertsTitleMaxRunes {
		return false
	}
	return len([]rune(detail)) <= alertsDetailMaxRunes
}
