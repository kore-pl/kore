package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"time"

	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// helloMethod 是握手首帧的固定方法名。
const helloMethod = "kore.hello"

// helloParams 是 kore.hello 的请求参数（PLUGIN-PROTOCOL §5）。
type helloParams struct {
	// PluginID 必须与内核登记 id 一致。
	PluginID string `json:"plugin_id"`
	// Version 插件版本，与 info.json 一致。
	Version string `json:"version"`
	// Protocol 协议主版本。
	Protocol string `json:"protocol"`
	// RequiresKore 内核版本区间，与 info.json 一致。
	RequiresKore string `json:"requires_kore"`
	// PID 插件进程号，用于与对端凭据交叉校验。
	PID int `json:"pid"`
	// Capabilities 必须是 info.json 声明的子集。
	Capabilities []string `json:"capabilities"`
	// StartedAt 进程启动时间（RFC 3339 带时区）。
	StartedAt string `json:"started_at"`
}

// helloResult 是 kore.hello 的响应结果（M1 只回必要字段）。
type helloResult struct {
	// OK 恒为 true；失败走 error 分支。
	OK bool `json:"ok"`
	// KernelVersion 内核版本。
	KernelVersion string `json:"kernel_version"`
	// Protocol 协议主版本。
	Protocol string `json:"protocol"`
	// ProtocolMinor 次版本，M1 固定 0。
	ProtocolMinor int `json:"protocol_minor"`
	// Encoding 本连接编码，M1 固定 json。
	Encoding string `json:"encoding"`
}

// handshake 在 exec→hello 的硬超时内完成握手：accept → 读首帧 → 校验 → 回响应。
func (m *Manager) handshake(ctx context.Context, inst *instance) (net.Conn, error) {
	deadline, ok := inst.deadline(m.opts.HelloTimeout)
	if !ok {
		return nil, errf(pluginapi.E_UPSTREAM, "插件 %s 启动超过 %s 仍未就绪", inst.manifest.ID, m.opts.HelloTimeout)
	}
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	listener := inst.listenerRef()
	if listener == nil {
		return nil, errf(pluginapi.E_INTERNAL, "插件 %s 监听器缺失", inst.manifest.ID)
	}
	if setter, ok := listener.(interface{ SetDeadline(time.Time) error }); ok {
		_ = setter.SetDeadline(deadline)
	}
	conn, err := listener.Accept()
	if err != nil {
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return nil, errf(pluginapi.E_UPSTREAM, "插件 %s 在 %s 内未连接，判定 hello 超时",
				inst.manifest.ID, m.opts.HelloTimeout)
		}
		return nil, errf(pluginapi.E_UPSTREAM, "插件 %s 连接失败：%v", inst.manifest.ID, err)
	}
	if err := m.readHello(conn, inst, deadline); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

// readHello 读取并校验握手首帧，成功后回 kore.hello 响应。
func (m *Manager) readHello(conn net.Conn, inst *instance, deadline time.Time) error {
	if err := conn.SetReadDeadline(deadline); err != nil {
		return errf(pluginapi.E_UPSTREAM, "设置握手读超时失败：%v", err)
	}
	payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
	if err != nil {
		return errf(pluginapi.E_UPSTREAM, "插件 %s 首帧读取失败：%v", inst.manifest.ID, err)
	}
	env, err := pluginapi.DecodeFrame(payload)
	if err != nil {
		if errors.Is(err, pluginapi.ErrUnknownType) {
			return errf(pluginapi.E_UNSUPPORTED, "插件 %s 首帧类型不受支持：%v", inst.manifest.ID, err)
		}
		return errf(pluginapi.E_INVALID, "插件 %s 首帧不是合法信封：%v", inst.manifest.ID, err)
	}
	req, ok := env.(*pluginapi.Request)
	if !ok || req.Method != helloMethod {
		return errf(pluginapi.E_UPSTREAM, "插件 %s 首帧必须是 %s 请求", inst.manifest.ID, helloMethod)
	}
	if err := m.checkHello(conn, inst, req); err != nil {
		return err
	}
	if err := m.replyHello(conn, inst, req, deadline); err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Time{})
	return nil
}

// checkHello 校验 hello 参数与对端凭据；任一不符即拒绝进入 ready。
func (m *Manager) checkHello(conn net.Conn, inst *instance, req *pluginapi.Request) error {
	var p helloParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return errf(pluginapi.E_INVALID, "kore.hello 参数不是合法 JSON：%v", err)
	}
	if p.PluginID != inst.manifest.ID {
		return errf(pluginapi.E_UNAUTHORIZED, "hello.plugin_id=%q 与登记 id %q 不一致", p.PluginID, inst.manifest.ID)
	}
	if p.Protocol != pluginapi.Protocol {
		return errf(pluginapi.E_UNSUPPORTED, "hello.protocol=%q 与内核协议 %q 不匹配", p.Protocol, pluginapi.Protocol)
	}
	if p.Version != inst.manifest.Version {
		return errf(pluginapi.E_UNSUPPORTED, "hello.version=%q 与清单版本 %q 不一致", p.Version, inst.manifest.Version)
	}
	if p.RequiresKore != inst.manifest.RequiresKore {
		return errf(pluginapi.E_UNSUPPORTED, "hello.requires_kore=%q 与清单 %q 不一致", p.RequiresKore, inst.manifest.RequiresKore)
	}
	for _, capability := range p.Capabilities {
		if !hasCapability(inst.manifest.Capabilities, capability) {
			return errf(pluginapi.E_UNAUTHORIZED, "hello 声明的 capability %q 超出清单范围", capability)
		}
	}
	return m.checkPeer(conn, inst, p.PID)
}

// checkPeer 用 SO_PEERCRED 交叉校验 hello 里的 pid（以及降权后的 uid）。
//
// 降权生效时校验必须成功：uid 不符即拒绝（socket 已被 chown 到该 uid，正常情况下
// 只可能是监听路径被替换 / 权限被放宽）。未降权（非 root 内核 / 无凭据的 Tier B）
// 时按原口径 WARN 跳过，不阻断——这是显式降级，不是静默通过。
func (m *Manager) checkPeer(conn net.Conn, inst *instance, pid int) error {
	cred, err := m.opts.Transport.PeerCred(conn)
	acct := inst.accountValue()
	if err != nil {
		if acct.UID > 0 {
			return errf(pluginapi.E_UNAUTHORIZED,
				"插件 %s 已降权到 %s，但对端凭据不可用（%v），拒绝进入 ready", inst.manifest.ID, describeAccount(acct), err)
		}
		m.logger.Warn("对端凭据不可用，跳过 hello pid 校验", "plugin_id", inst.manifest.ID, "err", err)
		return nil
	}
	if verr := verifyPeer(cred, acct, pid); verr != nil {
		return verr
	}
	return nil
}

// verifyPeer 是凭据校验的纯函数：pid 必须一致；降权时 uid 也必须一致。
func verifyPeer(cred platform.Cred, acct platform.Account, pid int) error {
	if int(cred.PID) != pid {
		return errf(pluginapi.E_UNAUTHORIZED, "hello.pid=%d 与对端 pid=%d 不一致", pid, cred.PID)
	}
	if acct.UID > 0 && int(cred.UID) != acct.UID {
		return errf(pluginapi.E_UNAUTHORIZED,
			"hello 对端 uid=%d 与插件低权身份 %s(uid=%d) 不一致", cred.UID, acct.Name, acct.UID)
	}
	return nil
}

// replyHello 回写握手响应（回显 id 与 req_id）。
func (m *Manager) replyHello(conn net.Conn, inst *instance, req *pluginapi.Request, deadline time.Time) error {
	result, err := json.Marshal(helloResult{
		OK:            true,
		KernelVersion: m.opts.Version,
		Protocol:      pluginapi.Protocol,
		Encoding:      "json",
	})
	if err != nil {
		return errf(pluginapi.E_INTERNAL, "序列化 hello 响应失败：%v", err)
	}
	_ = conn.SetWriteDeadline(deadline)
	response := &pluginapi.Response{Type: pluginapi.TypeResponse, ID: req.ID, ReqID: req.ReqID, Result: result}
	if err := pluginapi.WriteJSON(conn, response); err != nil {
		return errf(pluginapi.E_UPSTREAM, "插件 %s 握手响应写入失败：%v", inst.manifest.ID, err)
	}
	return nil
}

// hasCapability 判断能力是否在声明列表内。
func hasCapability(declared []string, capability string) bool {
	for _, item := range declared {
		if item == capability {
			return true
		}
	}
	return false
}
