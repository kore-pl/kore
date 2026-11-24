package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// maxRootActionBody 是 root-action 请求体上限（ADR-0052 §3.1.3.2）。
//
// 64 KiB 装不下受控写的 256 KiB 正文：JSON 转义最坏把 1 个控制字节放大成 6 字节
// （`\uXXXX`），256 KiB 正文最坏 ≈1.5 MiB。取 2 MiB 留余量；**解码后**正文仍按
// 协议硬顶 256 KiB 判（pluginapi.MaxFileWriteContentBytes），body 上限只负责
// 「不让进程被一个超大请求拖垮」，不是安全判据本身。
const maxRootActionBody = 2 << 20

// rootActionIDPattern 是 action_id 的协议语法（与 pluginapi/rootaction.go 同口径）。
var rootActionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// rootActionBody 是 POST /api/v1/plugins/{id}/root-action 的请求体。
type rootActionBody struct {
	// ActionID 是插件声明的动作 id（唯一入口；argv 由清单固定）。
	ActionID string `json:"action_id"`
	// Args 是追加参数（不能替换 argv[0]）；file_write 动作只用 args[0]（单层文件名）。
	Args []string `json:"args,omitempty"`
	// Content 是 file_write 动作的正文（exec 动作不得携带）。
	Content string `json:"content,omitempty"`
	// Confirm 是不可回滚动作的一次性令牌。
	Confirm string `json:"confirm,omitempty"`
}

// confirmTokenBody 是 confirm-token 端点的响应体。
type confirmTokenBody struct {
	// Token 是一次性令牌。
	Token string `json:"token"`
	// PluginID / ActionID 是绑定关系。
	PluginID string `json:"plugin_id"`
	ActionID string `json:"action_id"`
	// ExpiresAt 是过期时间（RFC3339，UTC）。
	ExpiresAt string `json:"expires_at"`
}

// handleRootAction 执行插件声明的 root 动作（ADR-0018 内核代理）。
//
// 校验顺序：身份（system:admin / 目标插件 bearer）→ 请求体 → 动作存在性 →
// 执行器（schema 复核、confirm 核销、审计 fail-closed、systemd-run）。
func (s *Server) handleRootAction(w http.ResponseWriter, r *http.Request) {
	pluginID := r.PathValue("id")
	actor, ok := s.authorizeRootAction(w, r, pluginID)
	if !ok {
		return
	}
	if s.privilege == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "提权执行器未装配", "")
		return
	}
	body, perr := readRootActionBody(w, r)
	if perr != nil {
		writeFailure(w, perr)
		return
	}
	action, perr := s.lookupRootAction(r.Context(), pluginID, body.ActionID)
	if perr != nil {
		writeFailure(w, perr)
		return
	}
	// 正文只属于受控写：exec 动作带 content 直接拒绝（不静默丢弃，不让两种语义混在一条请求里）。
	if body.Content != "" && action.FileWrite == nil {
		writeFailure(w, errCodeInvalid("content 仅用于 file_write 动作，exec 动作不得携带正文"))
		return
	}
	result, err := s.privilege.Execute(r.Context(), privilege.Request{
		Actor: actor, PluginID: pluginID, Action: action,
		Args: body.Args, Content: body.Content, Confirm: body.Confirm,
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handleConfirmToken 为不可回滚动作签发一次性 confirm 令牌（5 分钟、绑定 plugin+action）。
//
// 令牌只能由管理会话签发：插件 bearer 身份不得自行确认自己的不可回滚动作。
func (s *Server) handleConfirmToken(w http.ResponseWriter, r *http.Request) {
	pluginID := r.PathValue("id")
	if isPluginActor(r) {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"confirm 令牌只能由管理员签发", "")
		return
	}
	if _, ok := s.authorizeRootAction(w, r, pluginID); !ok {
		return
	}
	if s.privilege == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "提权执行器未装配", "")
		return
	}
	actionID := r.PathValue("action_id")
	if !rootActionIDPattern.MatchString(actionID) {
		writeFailure(w, errCodeInvalid("action_id 语法非法"))
		return
	}
	action, perr := s.lookupRootAction(r.Context(), pluginID, actionID)
	if perr != nil {
		writeFailure(w, perr)
		return
	}
	if !privilege.NeedsConfirm(action) {
		writeFailure(w, errCodeInvalid("该动作无需 confirm 令牌（既非不可回滚，也不缺回滚信息）"))
		return
	}
	grant, err := s.privilege.Confirm().Issue(pluginID, actionID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, confirmTokenBody{
		Token: grant.Token, PluginID: grant.PluginID, ActionID: grant.ActionID,
		ExpiresAt: grant.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// readRootActionBody 读取并严格解码请求体（未知字段、超限、非法 JSON 均 E_INVALID）。
func readRootActionBody(w http.ResponseWriter, r *http.Request) (rootActionBody, *pluginapi.Error) {
	var body rootActionBody
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRootActionBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		if errors.Is(err, io.EOF) {
			return body, errCodeInvalid("请求体不能为空（需要 action_id）")
		}
		return body, errCodeInvalid("请求体非法：" + err.Error())
	}
	if !rootActionIDPattern.MatchString(body.ActionID) {
		return body, errCodeInvalid("action_id 必填且须匹配 ^[a-z][a-z0-9-]*$")
	}
	return body, nil
}

// lookupRootAction 从装配层查询动作声明；未实现查询或动作不存在都显式失败。
func (s *Server) lookupRootAction(ctx context.Context, pluginID, actionID string) (pluginapi.RootAction, *pluginapi.Error) {
	provider, ok := s.opts.Backend.(RootActionLookup)
	if !ok {
		return pluginapi.RootAction{}, &pluginapi.Error{
			Code: pluginapi.E_UNSUPPORTED, Message: "后端未实现 root_actions 查询",
		}
	}
	action, found, err := provider.RootAction(ctx, pluginID, actionID)
	if err != nil {
		var protocolErr *pluginapi.Error
		if errors.As(err, &protocolErr) {
			return pluginapi.RootAction{}, protocolErr
		}
		return pluginapi.RootAction{}, &pluginapi.Error{Code: pluginapi.E_INTERNAL, Message: err.Error()}
	}
	if !found {
		return pluginapi.RootAction{}, &pluginapi.Error{
			Code: pluginapi.E_NOTFOUND, Message: "动作不存在或插件未声明：" + pluginID + "/" + actionID,
		}
	}
	return action, nil
}

// errCodeInvalid 构造 E_INVALID 协议错误。
func errCodeInvalid(message string) *pluginapi.Error {
	return &pluginapi.Error{Code: pluginapi.E_INVALID, Message: message}
}
