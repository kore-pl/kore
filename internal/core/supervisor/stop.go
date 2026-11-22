package supervisor

import (
	"context"
	"encoding/json"
	"net"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// shutdownMethod 是优雅停止的协议方法名。
const shutdownMethod = "kore.shutdown"

// shutdownParams 是 kore.shutdown 的请求参数（PLUGIN-PROTOCOL §7.1）。
type shutdownParams struct {
	// Reason 停止原因（disable / upgrade / shutdown）。
	Reason string `json:"reason"`
	// GraceMS 宽限期（毫秒），默认 5000。
	GraceMS int `json:"grace_ms"`
}

// Stop 优雅停止插件：kore.shutdown → 等宽限期 → SIGKILL；退出后清理 socket。
//
// 幂等：stopped / draining 直接返回。在途调用的连接会被关闭，bus 侧按 E_UPSTREAM
// 处理（M1 不跟踪在途计数，drain 的「等在途结束」归 M1-09 的 pending map）。
func (m *Manager) Stop(ctx context.Context, id string) error {
	inst, ok := m.lookup(id)
	state := StateStopped
	if ok {
		state = inst.currentState()
	}
	// M3-C：disable 动作在发生时直接落审计（plugin.disable），不等下次请求对账；
	// 重复 Stop 各记一条——审计的是动作，不是状态迁移。
	m.record(ctx, AuditEvent{
		Subject: AuditSubjectAdmin, Action: AuditDisable, Plugin: id,
		Result: AuditResultOK, Detail: detail("state", string(state)),
	})
	if !ok {
		return nil
	}
	switch inst.currentState() {
	case StateStopped, StateDraining:
		return nil
	}
	inst.setState(StateDraining)
	listener, conn, cmd := inst.takeRuntime()
	if conn != nil {
		m.sendShutdown(inst.manifest.ID, conn)
	}
	if cmd != nil && cmd.Process != nil {
		if !waitChan(ctx, inst.exitedRef(), m.opts.ShutdownGrace) {
			if err := cmd.Process.Kill(); !isProcessDone(err) {
				m.logger.Warn("SIGKILL 插件失败", "plugin_id", id, "err", err)
			}
			waitChan(context.Background(), inst.exitedRef(), defaultKillWait)
		}
	}
	if conn != nil {
		_ = conn.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
	m.removeSocket(inst.socket)
	inst.clearToken()
	inst.markStopped()
	m.logger.Info("插件已停止", "plugin_id", id)
	return nil
}

// sendShutdown 发 kore.shutdown 请求；写失败只 WARN，剩余宽限期后仍走 SIGKILL。
func (m *Manager) sendShutdown(id string, conn net.Conn) {
	requestID, err := randomHex(16)
	if err != nil {
		m.logger.Warn("生成 shutdown 请求 id 失败", "plugin_id", id, "err", err)
		return
	}
	graceMS := int(m.opts.ShutdownGrace / time.Millisecond)
	params, err := json.Marshal(shutdownParams{Reason: "disable", GraceMS: graceMS})
	if err != nil {
		m.logger.Warn("序列化 shutdown 参数失败", "plugin_id", id, "err", err)
		return
	}
	request := &pluginapi.Request{
		Type:      pluginapi.TypeRequest,
		ID:        requestID,
		Method:    shutdownMethod,
		Params:    params,
		TimeoutMS: graceMS,
	}
	_ = conn.SetWriteDeadline(time.Now().Add(defaultKillWait))
	if err := pluginapi.WriteJSON(conn, request); err != nil {
		m.logger.Warn("发送 kore.shutdown 失败", "plugin_id", id, "err", err)
	}
}
