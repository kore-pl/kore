package httpapi

// ADR-0056 T3：POST /api/v1/system/restart 的 HTTP 入口。
// 时序：鉴权 → confirm（绑 action=system.restart + reason，5 分钟）→ 审计 fail-closed
// → flush pending marker → 调 SelfRestart（--no-block 提交）→ 返回"已提交"≠"已生效"。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"sync"
	"time"

	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	restartConfirmTTLDefault = 5 * time.Minute
	restartAuditBegin        = "system.restart"
	restartReasonMax         = 200
	restartBodyMax           = 4 << 10
)

// RestartService 是 httpapi 对自重启能力的最小依赖（由 cmd/kored 注入）。
type RestartServicer interface {
	// ConfirmToken 签发绑定 action+reason 的一次性令牌（5 分钟）。
	ConfirmToken(reason string) (string, time.Time, error)
	// Restart 校验 confirm → fail-closed 审计 → flush → 调原语 → 写 commit_result 审计。
	Restart(ctx context.Context, actor, reason, token string) (RestartResponseBody, error)
	// Unit 返回当前探测/配置的 unit 名（供响应展示；不接收用户命令字符串）。
	Unit() string
}

// RestartResponseBody 是 restart 成功响应（显式字段，G-24）。
type RestartResponseBody struct {
	Committed bool   `json:"committed"`
	Unit      string `json:"unit"`
	Mode      string `json:"mode"`
	Command   string `json:"command"`
	Message   string `json:"message"`
	Reason    string `json:"reason"`
}

// restartConfirmRequest 是 confirm-token 请求体（reason 必填）。
type restartConfirmRequest struct {
	Reason string `json:"reason"`
}

// restartRequest 是 restart 请求体（confirm 是 token 原文；绝不记口令）。
type restartRequest struct {
	Reason  string `json:"reason"`
	Confirm string `json:"confirm"`
}

// confirmTokenBodyWithReason 是绑定 reason 的确认令牌响应。
type confirmTokenBodyWithReason struct {
	Token     string `json:"token"`
	Action    string `json:"action"`
	Reason    string `json:"reason"`
	ExpiresAt string `json:"expires_at"`
}

// handleRestartConfirmToken 为 system.restart 签发绑定 reason 的一次性令牌。
// 需有效会话 + system:admin（与升级端点同口径）；插件 bearer 不得签发。
func (s *Server) handleRestartConfirmToken(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.authorizeRestart(w, r)
	if !ok {
		return
	}
	svc, ok := s.restartServiceOr501(w)
	if !ok {
		return
	}
	// GET 端点从 query string 读 reason（无请求体）；同时兼容带 body 的调用方。
	reasonRaw := r.URL.Query().Get("reason")
	if reasonRaw == "" {
		var body restartConfirmRequest
		if perr := readStrictBody(w, r, &body); perr == nil {
			reasonRaw = body.Reason
		}
	}
	reason := normalizeRestartReason(reasonRaw)
	if reason == "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "重启理由不能为空（请写明为什么重启）", "")
		return
	}
	token, expires, err := svc.ConfirmToken(reason)
	if err != nil {
		writeFailure(w, err)
		return
	}
	_ = actor // confirm 签发主体由会话中间件保证；审计在 Restart 落。
	writeJSON(w, http.StatusOK, confirmTokenBodyWithReason{
		Token: token, Action: privilege.RestartActionID, Reason: reason,
		ExpiresAt: expires.UTC().Format(time.RFC3339),
	})
}

// handleSystemRestart 提交一次自重启。返回 202 表示"已提交"，不等于已生效。
func (s *Server) handleSystemRestart(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.authorizeRestart(w, r)
	if !ok {
		return
	}
	svc, ok := s.restartServiceOr501(w)
	if !ok {
		return
	}
	var body restartRequest
	if perr := readStrictBody(w, r, &body); perr != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体格式不对："+perr.Error(), "")
		return
	}
	reason := normalizeRestartReason(body.Reason)
	if reason == "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "重启理由不能为空", "")
		return
	}
	if strings.TrimSpace(body.Confirm) == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "重启需要一次性 confirm 令牌", "先 GET /api/v1/system/restart/confirm-token?reason=...")
		return
	}
	result, err := svc.Restart(r.Context(), actor, reason, strings.TrimSpace(body.Confirm))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// authorizeRestart 校验会话 + system:admin；未登录 401、能力不足 401 + deny 审计。
func (s *Server) authorizeRestart(w http.ResponseWriter, r *http.Request) (string, bool) {
	if isPluginActor(r) {
		s.auditDenied("plugin", "system", "restart", "", "插件不得调用系统重启")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "插件不能重启内核", "")
		return "", false
	}
	if !s.authorizeTargetAction(w, r) {
		return "", false
	}
	if s.auth == nil {
		return "admin", true // M0 探活骨架
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, "system:admin") {
		s.auditDenied(subject, "system", "restart", "", "缺少 system:admin 特权能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "越权：系统重启需要 system:admin 能力", "system:admin")
		return "", false
	}
	return subject, true
}

// restartServiceOr501 未装配时显式 501，不假装成功。
func (s *Server) restartServiceOr501(w http.ResponseWriter) (RestartServicer, bool) {
	if s.restartService == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "当前内核未启用自服务重启", "")
		return nil, false
	}
	return s.restartService, true
}

// normalizeRestartReason 收口理由长度（与审计 detail 上限一致），去掉首尾空白。
func normalizeRestartReason(raw string) string {
	reason := strings.TrimSpace(raw)
	if len([]rune(reason)) > restartReasonMax {
		return string([]rune(reason)[:restartReasonMax])
	}
	return reason
}

// restartQueue 保证并发重启请求排队、不合并（ADR-0018:233）：
// 同一进程内任何时刻只有一个 Restart 在提交；后来者阻塞等待前序结束（不共享结果）。
type restartQueue struct {
	mu sync.Mutex
}

func (q *restartQueue) lock() func() {
	q.mu.Lock()
	return q.mu.Unlock
}

// asRestartErr 把原语错误映射成带 code/hint 的协议错误（E_NO_SELF_RESTART → 501）。
func asRestartErr(err error) error {
	var perr *pluginapi.Error
	if errors.As(err, &perr) {
		return perr
	}
	return &pluginapi.Error{Code: pluginapi.E_INTERNAL, Message: fmt.Sprintf("自重启失败：%v", err)}
}

// systemRestartPath 是自服务重启端点（ADR-0056 T3）。
const systemRestartPath = "/api/v1/system/restart"

// registerRestartRoutes 注册自服务重启端点（独立于 handlers.go 的 routes()，避免并行写域冲突）。
func (s *Server) registerRestartRoutes() {
	s.mux.HandleFunc("GET "+systemRestartPath+"/confirm-token", s.handleRestartConfirmToken)
	s.mux.HandleFunc("POST "+systemRestartPath, s.handleSystemRestart)
	s.mux.HandleFunc("POST /api/v1/system/config", s.handleConfigWrite)
}

// ---- 配置写入端点（ADR-0056 T4）：写入后用 coldChanged 判据返回 restart_required ----

// ConfigWriteResult 是配置写入响应（显式字段，G-24）。
type ConfigWriteResult struct {
	Saved           bool     `json:"saved"`
	RestartRequired bool     `json:"restart_required"`
	ColdFields      []string `json:"cold_fields,omitempty"`
	Applied         bool     `json:"applied"`
}

// ConfigWriter 是配置写入面（由 cmd/kored 注入；本包不 import config，G-01）。
type ConfigWriter interface {
	Write(updates ConfigUpdates) (cold []string, err error)
}

// ConfigUpdates 是面板允许写入的显式配置项（与 config.ConfigUpdates 逐字段对齐）。
type ConfigUpdates struct {
	IndexDir  *string `json:"index_dir,omitempty"`
	PluginDir *string `json:"plugin_dir,omitempty"`
	LogLevel  *string `json:"log_level,omitempty"`
	Addr      *string `json:"addr,omitempty"`
	InvokeAll *bool   `json:"invoke_all,omitempty"`
}

// handleConfigWrite 写入配置并返回 restart_required。
func (s *Server) handleConfigWrite(w http.ResponseWriter, r *http.Request) {
	_, ok := s.authorizeRestart(w, r)
	if !ok {
		return
	}
	if s.configWriter == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "当前实例未开放配置写入", "")
		return
	}
	var body ConfigUpdates
	if perr := readStrictBody(w, r, &body); perr != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体格式不对："+perr.Error(), "")
		return
	}
	cold, err := s.configWriter.Write(body)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ConfigWriteResult{
		Saved: true, RestartRequired: len(cold) > 0, ColdFields: cold, Applied: len(cold) == 0,
	})
}
