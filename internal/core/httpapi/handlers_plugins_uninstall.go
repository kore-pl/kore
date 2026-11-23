package httpapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// pluginIDPattern 是插件 id 白名单正则（与 G-27 / info.json 一致）。
//
// 它同时是路径穿越防护：id 会被拼进 `data/plugins/<id>`，`..`、`/`、`\`
// 一律不匹配（`.` 不在字符集内），因此 `DELETE /plugins/../../etc` 在路由
// 匹配之前就被本层拒绝。
var pluginIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// PluginUninstaller 是装配层可选实现的插件卸载能力。
//
// 用可选接口而不是直接扩 Backend：卸载是新增能力，未装配的实现（测试替身、
// 只读后端）不会被强制改造；未实现时端点回 501 E_UNSUPPORTED，不假装成功。
type PluginUninstaller interface {
	// Uninstall 卸载插件（停进程 + 删 dist + 移除记录 + 写审计）。
	// 插件本就不存在时返回 AlreadyAbsent=true 且不报错（幂等）。
	Uninstall(ctx context.Context, id string) (UninstallOutcome, error)
}

// UninstallOutcome 是卸载结果。
type UninstallOutcome struct {
	// ID 是被卸载的插件 id。
	ID string `json:"id"`
	// Deleted 表示本次调用真的删掉了东西。
	Deleted bool `json:"deleted"`
	// AlreadyAbsent 表示调用前就不存在（幂等命中）。
	AlreadyAbsent bool `json:"already_absent"`
	// Stopped 表示卸载前该插件在运行、已被优雅停止。
	Stopped bool `json:"stopped"`
}

// handlePluginUninstall 处理 DELETE /api/v1/plugins/{id}。
//
// 鉴权：与其他管理端点同一条中间件链（会话 + CSRF + system:admin），
// 审计由 installer 在删除不可回滚步骤之前 fail-closed 写入。
//
// 幂等口径：对未安装的 id 回 **200 + already_absent=true**（不是 404）。
// 理由：卸载是幂等动作，客户端在"删除成功但响应丢失"后重试、或在没有插件的机器上
// 跑清理脚本时，404 会把"目标状态已达成"报成错误；而 404 与"路由不存在/权限不足"
// 在客户端侧难以区分。真正的输入错误（id 非法）仍回 400。
func (s *Server) handlePluginUninstall(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
	id := r.PathValue("id")
	if !pluginIDPattern.MatchString(id) || strings.ContainsAny(id, `/\`) ||
		id == "." || id == ".." || strings.Contains(id, "..") {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "插件 id 非法", id)
		return
	}
	if s.opts.Backend == nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "后端未装配", "")
		return
	}
	uninstaller, ok := s.opts.Backend.(PluginUninstaller)
	if !ok {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "当前装配不支持卸载", "")
		return
	}
	outcome, err := uninstaller.Uninstall(r.Context(), id)
	if err != nil {
		writeUninstallFailure(w, err)
		return
	}
	status := http.StatusOK
	writeJSON(w, status, outcome)
}

// writeUninstallFailure 把 installer 的卸载错误映射成 HTTP 状态码与错误码。
//
// 映射口径：id 非法 = 400；不存在 = 404（装配层若返回 E_NOTFOUND）；
// 停进程失败 = 409（插件仍在运行，可重试）；审计失败 = 503（依赖不可用，
// 调用方可重试且不会留下半删状态）；其余 = 500。
func writeUninstallFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, installer.ErrInvalid):
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "插件 id 非法", err.Error())
	case errors.Is(err, installer.ErrStop):
		writeError(w, http.StatusConflict, pluginapi.E_CONFLICT, "插件进程未能停止", err.Error())
	case errors.Is(err, installer.ErrAudit):
		writeError(w, http.StatusServiceUnavailable, pluginapi.E_INTERNAL, "审计写入失败，卸载已取消", err.Error())
	default:
		writeFailure(w, err)
	}
}
