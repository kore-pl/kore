package httpapi

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 通知通道管理端点（G-10：用户显式配置的出站推送，非内置遥测）：
//   - GET  /api/v1/webhook        配置列表 + 投递历史——system:read
//   - POST /api/v1/webhook        新增一条配置——system:admin
//   - DELETE /api/v1/webhook/{id} 删除一条配置——system:admin
//   - POST /api/v1/webhook/{id}/test  发一条测试事件（不落告警库）——system:admin
//
// 未装配 webhookRegistry 时一律 501 E_UNSUPPORTED（零服务路径不受影响）。

// webhookCreateResp 是新增响应（显式字段，G-24）。
type webhookCreateResp struct {
	Target WebhookTarget `json:"target"`
}

// webhookDeleteResp 是删除响应。
type webhookDeleteResp struct {
	Deleted bool `json:"deleted"`
}

// webhookTestResp 是测试按钮响应：立即返回，投递结果到 GET 的 history 里查。
type webhookTestResp struct {
	Queued bool   `json:"queued"`
	Event  string `json:"event"`
}

func (s *Server) requireWebhook(w http.ResponseWriter) (*webhookRegistry, bool) {
	if s.webhooks == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"通知通道后端未装配", "")
		return nil, false
	}
	return s.webhooks, true
}

// authorizeWebhook 列表 system:read，写/删/测试 system:admin（fail-closed）。
func (s *Server) authorizeWebhook(w http.ResponseWriter, r *http.Request, capability string) bool {
	if !s.authorizeTargetAction(w, r) {
		return false
	}
	if s.auth == nil {
		return true
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, capability) {
		s.auditDenied(subject, "webhook", "", "需要 "+capability+" 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：通知通道需要 "+capability+" 能力", capability)
		return false
	}
	return true
}

func (s *Server) handleWebhookList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeWebhook(w, r, "system:read") {
		return
	}
	reg, ok := s.requireWebhook(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, reg.list())
}

func (s *Server) handleWebhookCreate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeWebhook(w, r, alertCapAdmin) {
		return
	}
	reg, ok := s.requireWebhook(w)
	if !ok {
		return
	}
	var in webhookWriteBody
	if err := decodeJSONBody(w, r, &in); err != nil {
		writeFailure(w, err)
		return
	}
	target, err := reg.add(in)
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, webhookCreateResp{Target: target})
}

func (s *Server) handleWebhookDelete(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeWebhook(w, r, alertCapAdmin) {
		return
	}
	reg, ok := s.requireWebhook(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !reg.remove(id) {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "通知通道不存在", "")
		return
	}
	writeJSON(w, http.StatusOK, webhookDeleteResp{Deleted: true})
}

// handleWebhookTest 只向指定通道发一条测试事件；不写告警库、不触发其它通道。
func (s *Server) handleWebhookTest(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeWebhook(w, r, alertCapAdmin) {
		return
	}
	reg, ok := s.requireWebhook(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	reg.mu.RLock()
	st := reg.targets[id]
	reg.mu.RUnlock()
	if st == nil {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "通知通道不存在", "")
		return
	}
	var in webhookTestBody
	// 测试请求允许空 body（无事件参数就用 webhook_test）；非空才解析 JSON。
	if r.Body != nil {
		limited := http.MaxBytesReader(w, r.Body, maxSchedulerBody)
		data, readErr := io.ReadAll(limited)
		if readErr != nil {
			writeFailure(w, errf(pluginapi.E_INVALID, "读取请求体失败"))
			return
		}
		if len(data) > 0 {
			if jsonErr := json.Unmarshal(data, &in); jsonErr != nil {
				writeFailure(w, errf(pluginapi.E_INVALID, "请求体不是合法 JSON"))
				return
			}
		}
	}
	event := in.Event
	if event == "" {
		event = "webhook_test"
	} else if !webhookEvents[event] {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"event 须为 audit/plugin/resource/slot 或留空", "")
		return
	}
	go reg.deliver(st, event, "通知通道测试事件", "这是你在 Kore 配置的通知通道发出的测试消息", true)
	writeJSON(w, http.StatusOK, webhookTestResp{Queued: true, Event: event})
}
