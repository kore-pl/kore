package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 通道路径常量：与主 mux 的 root-action 路由保持同形，但通道只接受这一个路径。
const (
	channelPathPrefix = "/api/v1/plugins/"
	channelPathSuffix = "/root-action"
)

// channelConnKey 是通道连接对象的 context 键（ConnContext 写入，处理器取出做
// SO_PEERCRED 校验）。只在通道 http.Server 上写入，主监听器不受影响。
type channelConnKey struct{}

// channelPluginID 解析通道请求：**只**允许 POST /api/v1/plugins/<id>/root-action。
//
// 通道是插件专用入口，不开放任何管理/查询端点：拿不到 id 即 404，不做会话回退。
func channelPluginID(r *http.Request) (string, bool) {
	if r.Method != http.MethodPost || r.URL.Path == "" {
		return "", false
	}
	path := r.URL.Path
	if !strings.HasPrefix(path, channelPathPrefix) || !strings.HasSuffix(path, channelPathSuffix) {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(path, channelPathPrefix), channelPathSuffix)
	if id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

// channelHandler 是独立通道 socket 的唯一处理器（ADR-0018 方案①）。
//
// 三重校验，缺一即 401（不泄露具体失败点，原因只进审计/日志）：
//  1. 插件 bearer：token 必须有效且 token 所属 id == 路径里的插件 id；
//  2. SO_PEERCRED：对端 uid 必须等于该插件的 kore-<id> uid、pid 必须等于
//     supervisor 记录的子进程 pid（防同组其它插件 / 本地进程借组权限冒用）；
//  3. 能力：该插件必须已获 system:admin。
//
// 通过后把插件身份注入 context 并复用 handleRootAction（schema/confirm/审计不变）。
// 管理会话 cookie 在通道上**完全无效**：这里不读 session、不做 CSRF 回退。
func (s *Server) channelHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pluginID, ok := channelPluginID(r)
		if !ok {
			http.NotFound(w, r)
			return
		}
		header := r.Header.Get(authorizationHeader)
		if !strings.HasPrefix(header, bearerPrefix) {
			s.denyChannel(w, pluginID, "缺少插件 bearer 身份")
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(header, bearerPrefix))
		id, grants, ok := s.pluginAuth(token)
		if !ok || id != pluginID {
			s.denyChannel(w, pluginID, "bearer 无效或与目标插件不一致")
			return
		}
		if !hasCapability(grants, "system:admin") {
			s.denyChannel(w, pluginID, "插件未获 system:admin 能力")
			return
		}
		conn, _ := r.Context().Value(channelConnKey{}).(net.Conn)
		if conn == nil {
			s.denyChannel(w, pluginID, "通道连接对象缺失")
			return
		}
		cred, err := s.transport.PeerCred(conn)
		if err != nil {
			s.denyChannel(w, pluginID, "对端凭据不可用："+err.Error())
			return
		}
		wantUID, wantPID, ok := s.opts.PluginPeer(pluginID)
		if !ok {
			s.denyChannel(w, pluginID, "插件未就绪或未降权（无期望 uid/pid）")
			return
		}
		if int(cred.UID) != wantUID || int(cred.PID) != wantPID {
			s.denyChannel(w, pluginID, fmt.Sprintf("对端凭据不符：uid=%d pid=%d，期望 uid=%d pid=%d",
				cred.UID, cred.PID, wantUID, wantPID))
			return
		}
		// 直接调用 handler（不经 mux），显式补 PathValue，与路由解析保持同形。
		r.SetPathValue("id", id)
		ctx := context.WithValue(r.Context(), pluginActorKey{}, &pluginActor{id: id, grants: grants})
		s.handleRootAction(w, r.WithContext(ctx))
	})
}

// denyChannel 统一返回 401（不向调用方暴露具体失败原因），原因落审计与日志。
func (s *Server) denyChannel(w http.ResponseWriter, pluginID, reason string) {
	slog.Warn("通道请求被拒绝", "plugin_id", pluginID, "reason", reason)
	s.auditDenied("channel", pluginID, "root-action", "", reason)
	writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "通道校验失败", "")
}
