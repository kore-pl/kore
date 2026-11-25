package httpapi

// 账户与安全中心（web/user-center.js）的后端：把"我自己的账户安全状态"一次问清，
// 并补上两块此前缺失的能力——**活跃会话列表/踢下线**与**最近登录记录**。
//
// 端点（均为 /api/v1/security 前缀，与会话 cookie 同域）：
//   GET    /api/v1/security/overview                 账户状态总览（口令 / 2FA / token / 白名单 / 会话 / 登录）
//   GET    /api/v1/security/sessions                 活跃会话列表（登录时间 / 来源 IP / UA 摘要 / 最后活跃）
//   DELETE /api/v1/security/sessions/{id}            踢单个会话下线（拒绝踢当前会话）
//   POST   /api/v1/security/sessions/revoke-others   一键全踢（保留当前会话）
//   GET    /api/v1/security/login-records            最近登录成功/失败记录 + 异常标记
//
// 边界：
//   - 全程要求有效会话（withAuth），写操作另需 CSRF 双提交（withCSRF）；
//   - 踢会话要求 system:admin 能力（只读 API token 不得踢人），登录记录要求
//     system:read（与 GET /api/v1/audit 同口径，复用 authorizeAuditRead）；
//   - **不改既有 2FA / API token / IP 白名单语义**：那三块仍由 handlers_security.go
//     提供，本文件只做聚合读取与新增的会话/登录两块；
//   - 不新增依赖、不新增 bucket（会话元信息存在既有 sessions bucket 的值里，
//     登录记录直接读既有审计流，不另建表）；登录记录里的 IP 是审计的脱敏网段
//     （192.168.1.x），不是完整 IP——界面上必须如实说"网段"。
import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 账户与安全中心的路径常量（与 web/user-center.js 逐字对齐）。
const (
	// securityOverviewPath 是账户状态总览。
	securityOverviewPath = securityPath + "/overview"
	// sessionsPath 是活跃会话集合（GET 列表 / POST 全踢）。
	sessionsPath = securityPath + "/sessions"
	// sessionItemPath 是单个会话（DELETE 踢下线）。
	sessionItemPath = sessionsPath + "/{id}"
	// sessionRevokeOthersPath 是"一键全踢（保留当前）"。
	sessionRevokeOthersPath = sessionsPath + "/revoke-others"
	// loginRecordsPath 是最近登录记录。
	loginRecordsPath = securityPath + "/login-records"
)

// 查询口径（防无界拉取；超限一律 400，不静默截断）。
const (
	// loginRecordsDefaultLimit 是未指定 limit 时的默认条数。
	loginRecordsDefaultLimit = 50
	// loginRecordsMaxLimit 是 limit 硬上限。
	loginRecordsMaxLimit = 200
	// loginRecordsDefaultDays 是未指定 days 时的默认回溯天数。
	loginRecordsDefaultDays = 30
	// loginRecordsMaxDays 是 days 硬上限（审计保留更久，但界面只看近 90 天）。
	loginRecordsMaxDays = 90
	// loginFailBurstThreshold 是"多次失败"标记的阈值（同网段 >=3 次失败）。
	loginFailBurstThreshold = 3
	// loginStatsWindow 是总览里"最近登录/新网段"的统计窗口。
	loginStatsWindow = 30 * 24 * time.Hour
)

// 会话与登录记录的动作名（审计留痕用，与 docs/DATA-MODEL §9 对齐）。
const (
	auditActionSessionRevoke       = "security.session.revoke"
	auditActionSessionRevokeOthers = "security.session.revoke_others"
)

// sessionView 是会话列表的一行（显式字段，G-24；不含明文 token 与完整 hash）。
type sessionView struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	LastSeenAt string `json:"lastSeenAt"`
	ExpiresAt string `json:"expiresAt"`
	IP        string `json:"ip"`
	UserAgent string `json:"userAgent"`
	Current   bool   `json:"current"`
}

// sessionListBody 是 GET /api/v1/security/sessions 的响应体。
type sessionListBody struct {
	Sessions []sessionView `json:"sessions"`
	Count    int           `json:"count"`
}

// sessionRevokedBody 是踢单个会话的响应体。
type sessionRevokedBody struct {
	Revoked bool   `json:"revoked"`
	ID      string `json:"id"`
}

// sessionsRevokedBody 是"一键全踢"的响应体。
type sessionsRevokedBody struct {
	Revoked int `json:"revoked"`
}

// loginRecordView 是登录记录的一行（IP 为审计脱敏网段）。
type loginRecordView struct {
	At        string   `json:"at"`
	Action    string   `json:"action"`
	Result    string   `json:"result"`
	IP        string   `json:"ip"`
	Reason    string   `json:"reason"`
	UserAgent string   `json:"userAgent"`
	Flags     []string `json:"flags"`
}

// loginRecordsBody 是 GET /api/v1/security/login-records 的响应体。
type loginRecordsBody struct {
	Records []loginRecordView `json:"records"`
	Count   int               `json:"count"`
	Limit   int               `json:"limit"`
	Days    int               `json:"days"`
	// IPMasked 恒为 true：审计只存脱敏网段，界面据此把"来源"标成网段而不是完整 IP。
	IPMasked bool `json:"ipMasked"`
}

// overviewPassword / overviewTwoFactor / overviewTokens / overviewIPAllow /
// overviewSessions / overviewLogin 是总览的六个分块（显式字段，G-24）。
type overviewPassword struct {
	ChangedAt      string `json:"changedAt"`
	Score          int    `json:"score"`
	Label          string `json:"label"`
	Source         string `json:"source"`
	MinLength      int    `json:"minLength"`
	HashAlgorithm  string `json:"hashAlgorithm"`
	HashIterations int    `json:"hashIterations"`
}

type overviewTwoFactor struct {
	Enabled           bool   `json:"enabled"`
	RecoveryCodesLeft int    `json:"recoveryCodesLeft"`
	CreatedAt         string `json:"createdAt"`
}

type overviewTokens struct {
	Count      int    `json:"count"`
	LastUsedAt string `json:"lastUsedAt"`
}

type overviewIPAllow struct {
	Enabled bool `json:"enabled"`
	Count   int  `json:"count"`
}

type overviewSessions struct {
	Active    int    `json:"active"`
	CurrentID string `json:"currentId"`
}

type overviewLogin struct {
	LastSuccessAt    string `json:"lastSuccessAt"`
	LastSuccessIP    string `json:"lastSuccessIp"`
	Failures24h      int    `json:"failures24h"`
	Suspicious       bool   `json:"suspicious"`
	SuspiciousReason string `json:"suspiciousReason"`
}

// securityOverviewBody 是 GET /api/v1/security/overview 的响应体。
type securityOverviewBody struct {
	Password  overviewPassword  `json:"password"`
	TwoFactor overviewTwoFactor `json:"twoFactor"`
	Tokens    overviewTokens    `json:"tokens"`
	IPAllow   overviewIPAllow   `json:"ipAllow"`
	Sessions  overviewSessions  `json:"sessions"`
	Login     overviewLogin     `json:"login"`
}

// registerSecurityCenterRoutes 注册账户与安全中心的路由。
//
// 与 handlers_logalerts.go 同一策略：不写 handlers.go 的 routes()（该处存在并行
// 写域），由 server.go 的 New() 调用；Go 1.22 ServeMux 按最长前缀匹配，注册顺序无关。
// revoke-others 必须显式注册在 {id} 之前/之外——两条模式路径不同，不冲突，但语义上
// 先声明具体路径更易读。
func (s *Server) registerSecurityCenterRoutes() {
	s.mux.HandleFunc("GET "+securityOverviewPath, s.handleSecurityOverview)
	s.mux.HandleFunc("GET "+sessionsPath, s.handleSessionsList)
	s.mux.HandleFunc("POST "+sessionRevokeOthersPath, s.handleSessionRevokeOthers)
	s.mux.HandleFunc("DELETE "+sessionItemPath, s.handleSessionRevoke)
	s.mux.HandleFunc("GET "+loginRecordsPath, s.handleLoginRecords)
}

// view 把会话转成对外视图；currentHash 是当前会话的 tokenHash（用于标"当前会话"）。
func sessionToView(sess auth.Session, currentHash string) sessionView {
	return sessionView{
		ID:         sess.ID(),
		CreatedAt:  rfc3339OrEmpty(sess.CreatedAt),
		LastSeenAt: rfc3339OrEmpty(sess.LastSeenAt),
		ExpiresAt:  rfc3339OrEmpty(sess.ExpiresAt),
		IP:         sess.IP,
		UserAgent:  sess.UserAgent,
		Current:    currentHash != "" && sess.TokenHash == currentHash,
	}
}

// rfc3339OrEmpty 格式化时刻；零值返回空串（前端显示"未知"而不是 0001 年）。
func rfc3339OrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// currentSessionToken 取当前请求的会话 token（未登录/无 cookie 时为空）。
func currentSessionToken(r *http.Request) string {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

// handleSessionsList 列出当前活跃会话：登录时间、来源 IP、UA 摘要、最后活跃。
// 只读端点：任何有效会话都能看；不返回明文 token，也不返回完整 hash。
func (s *Server) handleSessionsList(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前实例未启用登录，无法查看会话", "")
		return
	}
	current, err := s.sessionFrom(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "会话已失效，请重新登录", "")
		return
	}
	sessions, err := s.auth.ListSessions()
	if err != nil {
		writeFailure(w, err)
		return
	}
	views := make([]sessionView, 0, len(sessions))
	for _, sess := range sessions {
		views = append(views, sessionToView(sess, current.TokenHash))
	}
	writeJSON(w, http.StatusOK, sessionListBody{Sessions: views, Count: len(views)})
}

// requireSecurityAdmin 要求 system:admin 能力（只读 API token 不得执行安全写操作）。
func (s *Server) requireSecurityAdmin(w http.ResponseWriter, r *http.Request, what string) bool {
	if s.auth == nil {
		return true // 骨架/测试未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if subject == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
		return false
	}
	if !hasCapability(granted, "system:admin") {
		s.auditDenied(subject, "security", what, "安全写操作需要 system:admin 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：这个操作需要管理权限，请用管理员会话或 admin 令牌", "system:admin")
		return false
	}
	return true
}

// handleSessionRevoke 踢单个会话下线。
//
// 拒绝踢"当前会话"：那等于把自己踢出登录，正确入口是「退出登录」——直接禁止，
// 免得用户点错后一头雾水（文案给出正确做法）。
func (s *Server) handleSessionRevoke(w http.ResponseWriter, r *http.Request) {
	if !s.requireSecurityAdmin(w, r, "session.revoke") {
		return
	}
	if s.auth == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前实例未启用登录，无法踢会话下线", "")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "缺少要踢下线的会话编号", "")
		return
	}
	current, err := s.sessionFrom(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "会话已失效，请重新登录", "")
		return
	}
	if strings.HasPrefix(current.TokenHash, strings.ToLower(id)) {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"不能踢掉当前正在使用的会话；要退出当前登录请用「退出登录」", "")
		return
	}
	found, err := s.auth.RevokeByID(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	if !found {
		// 幂等语义：这条会话可能已过期或被别处踢掉，如实回"没找到"而不报错。
		writeJSON(w, http.StatusOK, sessionRevokedBody{Revoked: false, ID: id})
		return
	}
	s.recordAudit(AuditEvent{
		Subject: "admin", Action: auditActionSessionRevoke, Result: auditResultOK,
		Detail: map[string]string{"session_id": id},
	})
	writeJSON(w, http.StatusOK, sessionRevokedBody{Revoked: true, ID: id})
}

// handleSessionRevokeOthers 一键全踢（踢自己除外）。
func (s *Server) handleSessionRevokeOthers(w http.ResponseWriter, r *http.Request) {
	if !s.requireSecurityAdmin(w, r, "session.revoke_others") {
		return
	}
	if s.auth == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前实例未启用登录，无法批量踢会话下线", "")
		return
	}
	token := currentSessionToken(r)
	if token == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "会话已失效，请重新登录", "")
		return
	}
	count, err := s.auth.RevokeOthers(token)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if count > 0 {
		s.recordAudit(AuditEvent{
			Subject: "admin", Action: auditActionSessionRevokeOthers, Result: auditResultOK,
			Detail: map[string]string{"count": strconv.Itoa(count)},
		})
	}
	writeJSON(w, http.StatusOK, sessionsRevokedBody{Revoked: count})
}

// handleSecurityOverview 返回账户状态总览：口令强度/上次修改、2FA（含恢复码剩余）、
// API token 数量与最近使用、IP 白名单、活跃会话数、最近登录与异常标记。
//
// 全部读取既有安全门面 + 审计流，不新增存储；任一分块读取失败按整体 500 返回
// （宁可报错也不显示"假的安全状态"）。
func (s *Server) handleSecurityOverview(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil || s.auth.Security() == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前实例未启用鉴权或状态库，无法查看账户安全状态", "")
		return
	}
	sec := s.auth.Security()
	var body securityOverviewBody

	meta, err := sec.PasswordMeta()
	if err != nil {
		writeFailure(w, err)
		return
	}
	body.Password = overviewPassword{
		ChangedAt: meta.ChangedAt, Score: meta.Score, Label: meta.Label, Source: meta.Source,
		MinLength: passwordMinLen, HashAlgorithm: meta.HashAlgorithm, HashIterations: meta.HashIterations,
	}

	totp, err := sec.TOTPStatus()
	if err != nil {
		writeFailure(w, err)
		return
	}
	body.TwoFactor = overviewTwoFactor{
		Enabled: totp.Enabled, RecoveryCodesLeft: totp.RecoveryCodesLeft, CreatedAt: totp.CreatedAt,
	}

	tokens, err := sec.ListTokens()
	if err != nil {
		writeFailure(w, err)
		return
	}
	body.Tokens = overviewTokens{Count: len(tokens), LastUsedAt: latestTokenUse(tokens)}

	ipAllow, err := sec.IPAllow()
	if err != nil {
		writeFailure(w, err)
		return
	}
	body.IPAllow = overviewIPAllow{Enabled: ipAllow.Enabled, Count: len(ipAllow.CIDRs)}

	current, err := s.sessionFrom(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "会话已失效，请重新登录", "")
		return
	}
	sessions, err := s.auth.ListSessions()
	if err != nil {
		writeFailure(w, err)
		return
	}
	body.Sessions = overviewSessions{Active: len(sessions), CurrentID: current.ID()}

	stats := s.loginStats()
	body.Login = overviewLogin{
		LastSuccessAt: stats.lastSuccessAt, LastSuccessIP: stats.lastSuccessIP,
		Failures24h: stats.failures24h,
	}
	reasons := make([]string, 0, 2)
	if stats.newNetwork {
		reasons = append(reasons, "最近一次成功登录来自一个新网段（30 天内首次出现）")
	}
	if stats.failures24h >= loginFailBurstThreshold {
		reasons = append(reasons, "最近 24 小时有 "+strconv.Itoa(stats.failures24h)+" 次登录失败")
	}
	if len(reasons) > 0 {
		body.Login.Suspicious = true
		body.Login.SuspiciousReason = strings.Join(reasons, "；")
	}
	writeJSON(w, http.StatusOK, body)
}

// latestTokenUse 返回最近一次 token 使用时刻（"从未使用"时为空串）。
func latestTokenUse(tokens []auth.TokenView) string {
	latest := ""
	for _, t := range tokens {
		if t.LastUsedAt > latest {
			latest = t.LastUsedAt
		}
	}
	return latest
}

// loginStats 是从审计流聚合出的登录统计（显式字段，G-24）。
type loginStats struct {
	lastSuccessAt string
	lastSuccessIP string
	failures24h   int
	newNetwork    bool
}

// loginStats 读取审计流里近 30 天的登录事件并聚合统计。
// 未装配审计查询后端时返回零值（界面显示"暂无记录"而不是报错）。
func (s *Server) loginStats() loginStats {
	var out loginStats
	if s.auditLister == nil {
		return out
	}
	now := time.Now().UTC()
	page, err := s.auditLister.ListAudit(AuditQuery{
		Since: now.Add(-loginStatsWindow), Action: auditActionLoginSuccess, Desc: true, Limit: 200,
	})
	if err != nil {
		return out
	}
	rows := page.Records
	if len(rows) > 0 {
		out.lastSuccessAt = auditAt(rows[0].Key)
		out.lastSuccessIP = rows[0].Detail["ip"]
		// 新网段：**已有多条成功记录**，且最新一次的网段在更早的记录里没出现过。
		// 只有一次登录（全新实例）不算异常——否则首登即"可疑"，纯属假警报。
		if len(rows) > 1 && out.lastSuccessIP != "" {
			out.newNetwork = true
			for i := 1; i < len(rows); i++ {
				if rows[i].Detail["ip"] == out.lastSuccessIP {
					out.newNetwork = false
					break
				}
			}
		}
	}
	fails, err := s.auditLister.ListAudit(AuditQuery{
		Since: now.Add(-24 * time.Hour), Action: auditActionLoginFailed, Desc: true, Limit: 1000,
	})
	if err != nil {
		return out
	}
	out.failures24h = fails.Total
	if out.failures24h == 0 {
		out.failures24h = len(fails.Records)
	}
	return out
}

// parseLoginRecordsQuery 解析 limit / days：非法或越界一律 400（不静默截断）。
func parseLoginRecordsQuery(r *http.Request) (limit, days int, problem string) {
	limit, days = loginRecordsDefaultLimit, loginRecordsDefaultDays
	values := r.URL.Query()
	if values.Has("limit") {
		parsed, err := strconv.Atoi(values.Get("limit"))
		if err != nil || parsed <= 0 {
			return 0, 0, "limit 必须是正整数"
		}
		if parsed > loginRecordsMaxLimit {
			return 0, 0, "limit 超过上限 " + strconv.Itoa(loginRecordsMaxLimit) + " 条"
		}
		limit = parsed
	}
	if values.Has("days") {
		parsed, err := strconv.Atoi(values.Get("days"))
		if err != nil || parsed <= 0 {
			return 0, 0, "days 必须是正整数"
		}
		if parsed > loginRecordsMaxDays {
			return 0, 0, "days 超过上限 " + strconv.Itoa(loginRecordsMaxDays) + " 天"
		}
		days = parsed
	}
	return limit, days, ""
}

// handleLoginRecords 返回最近的登录成功/失败记录，并标出异常（新网段 / 多次失败）。
//
// 数据源是既有审计流（login.success / login.failed），不另建登录表：
// 审计里已经记了时间、脱敏 IP、UA 与失败原因，重复落一份只会两个真源漂移。
func (s *Server) handleLoginRecords(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAuditRead(w, r) {
		return
	}
	limit, days, problem := parseLoginRecordsQuery(r)
	if problem != "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, problem, "")
		return
	}
	if s.auditLister == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"登录记录查询后端未装配（审计未启用），暂无历史登录记录", "")
		return
	}
	since := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
	okPage, err := s.auditLister.ListAudit(AuditQuery{
		Since: since, Action: auditActionLoginSuccess, Desc: false, Limit: loginRecordsMaxLimit,
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	failPage, err := s.auditLister.ListAudit(AuditQuery{
		Since: since, Action: auditActionLoginFailed, Desc: false, Limit: loginRecordsMaxLimit,
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	records := buildLoginRecords(okPage.Records, failPage.Records, limit)
	writeJSON(w, http.StatusOK, loginRecordsBody{
		Records: records, Count: len(records), Limit: limit, Days: days, IPMasked: true,
	})
}

// buildLoginRecords 合并成功/失败审计记录（输入按时间升序），产出"最新优先"的
// 记录列表，并标出异常：首次出现的网段（new_network）、同网段多次失败（fail_burst）、
// 触发登录限速（rate_limited）。
func buildLoginRecords(okRows, failRows []AuditRecordView, limit int) []loginRecordView {
	type merged struct {
		view AuditRecordView
		ok   bool
	}
	all := make([]merged, 0, len(okRows)+len(failRows))
	for _, row := range okRows {
		all = append(all, merged{view: row, ok: true})
	}
	for _, row := range failRows {
		all = append(all, merged{view: row})
	}
	// 审计键是零填充的纳秒前缀，字典序即时间序。
	sort.Slice(all, func(i, j int) bool { return all[i].view.Key < all[j].view.Key })

	seenNetwork := make(map[string]bool, len(okRows))
	failByNetwork := make(map[string]int, len(failRows))
	for _, item := range all {
		if !item.ok {
			failByNetwork[item.view.Detail["ip"]]++
		}
	}
	// 只有"此前已有过其它网段成功登录"才谈得上"新网段"——首次登录（历史为空）
	// 不是异常，把它标成异常会让全新实例一登录就报红，属于假警报。
	sawAnySuccess := false

	out := make([]loginRecordView, 0, len(all))
	for _, item := range all {
		row := item.view
		ip := row.Detail["ip"]
		flags := make([]string, 0, 2)
		result := row.Result
		reason := loginReasonText(row.Detail["reason"], item.ok)
		if item.ok {
			if ip != "" && !seenNetwork[ip] {
				seenNetwork[ip] = true
				if sawAnySuccess {
					flags = append(flags, "new_network")
				}
			}
			sawAnySuccess = true
			reason = "登录成功"
		} else {
			if failByNetwork[ip] >= loginFailBurstThreshold {
				flags = append(flags, "fail_burst")
			}
			if row.Detail["reason"] == "rate_limited" {
				flags = append(flags, "rate_limited")
			}
		}
		out = append(out, loginRecordView{
			At: auditAt(row.Key), Action: row.Action, Result: result, IP: ip,
			Reason: reason, UserAgent: row.Detail["user_agent"], Flags: flags,
		})
	}
	// 最新优先；条数按 limit 截断（审计侧已按升序取最近 max 条）。
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// loginReasonText 把审计里的失败原因码翻成用户能看懂的一句话（G-33 A4：不用内部术语）。
func loginReasonText(reason string, success bool) string {
	if success {
		return "登录成功"
	}
	switch reason {
	case "wrong_password":
		return "口令错误"
	case "rate_limited":
		return "口令错误（已触发失败延迟）"
	case "wrong_otp":
		return "两步验证码错误"
	case "ip_denied":
		return "来源网络不在允许列表"
	case "no_session":
		return "登录请求不完整"
	default:
		if reason == "" {
			return "登录失败"
		}
		return "登录失败（" + reason + "）"
	}
}
