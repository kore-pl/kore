package httpapi

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 本机免密的两条通道（ADR-0041）：文件系统权限（UDS）与 loopback TCP。
//
// 安全边界（写进代码就是契约，别在别处重解释）：
//   - UDS：能读写 <run>/kore.sock（0600，属主=运行用户）的进程就是管理员——与
//     docker / systemd / postgres 的既有信任模型一致。对端凭据由 platform.PeerCred
//     （SO_PEERCRED）取，uid == socket 属主（即 kored 运行用户）或 uid == 0 才放行。
//   - loopback TCP：源地址是 127.0.0.0/8 或 ::1 的请求视为本机管理员。只认 TCP 层
//     RemoteAddr，**绝不读 X-Forwarded-For / X-Real-IP**——反代场景下伪造头就是提权。
//   - 两者都不是（局域网/公网）→ 保持原有会话鉴权，一行都不放开。
//
// 这不是多用户 RBAC（G-11 明确不做）：本机免密 == 「能登进这台机器的人就能管 Kore」。
// CSRF：loopback 仍是浏览器可达面，**必须**保留双提交校验；UDS 浏览器不可达
// （浏览器没有 unix socket 通道），故 UDS 豁免 CSRF，由文件系统权限兜底。
const (
	// localChannelUnix 是 UDS 免密通道名（审计 detail.channel）。
	localChannelUnix = "unix"
	// localChannelTCPLoopback 是 loopback TCP 免密通道名。
	localChannelTCPLoopback = "tcp-loopback"
	// localAccessAction 是本机免密访问的审计动作名。
	localAccessAction = "local.access"
)

// connInfo 是连接级状态：原始 net.Conn + 是否已记过 local.access（首次连接一次）。
type connInfo struct {
	conn    net.Conn
	audited atomic.Bool
}

// markAudited 返回本次是否抢到"首次连接"审计权（每连接只成功一次）。
func (c *connInfo) markAudited() bool { return c.audited.CompareAndSwap(false, true) }

// connKey 是连接信息在 context 中的私有键（ConnContext 注入）。
type connKey struct{}

// connInfoFrom 取连接级信息；测试直接构造请求时可能缺失（返回 nil）。
func connInfoFrom(ctx context.Context) *connInfo {
	info, _ := ctx.Value(connKey{}).(*connInfo)
	return info
}

// peerCred 是本机对端身份的最小视图（pid/comm 只在 Linux 可用）。
type peerCred struct {
	uid   int32
	pid   int32
	comm  string
	known bool
}

// localAccessKey 是本机免密判定结果在 context 中的私有键（withAuth 注入）。
type localAccessKey struct{}

// localAccessFrom 取本机免密判定结果；缺失返回 false。
func localAccessFrom(ctx context.Context) (localRequest, bool) {
	local, ok := ctx.Value(localAccessKey{}).(localRequest)
	return local, ok
}

// localRequest 是一次"本机免密"判定的结果。
type localRequest struct {
	// channel 是通道名（unix / tcp-loopback）；空串表示不是本机请求。
	channel string
	// cred 是对端凭据（UDS 有；loopback 只有 RemoteAddr，known=false）。
	cred peerCred
}

// isLocal 表示该请求命中本机免密通道。
func (l localRequest) isLocal() bool { return l.channel != "" }

// resolveLocal 判定请求是否来自本机免密通道；blocked=true 表示"是本机 socket
// 但身份不合规"，必须回 403 EACCES 而不是退化成会话鉴权或被当成 TCP 放行。
func (s *Server) resolveLocal(r *http.Request) (local localRequest, blocked bool) {
	info := connInfoFrom(r.Context())
	if info != nil && info.conn != nil {
		if isUnixConn(info.conn) {
			return s.unixLocal(info.conn)
		}
	}
	// ConnContext 缺省（测试直接构造请求）时按 RemoteAddr 兜底判 UDS：
	// unix socket 的对端地址在 Linux 上是 "@" 或以 @ 开头（抽象命名空间）。
	if addr := r.RemoteAddr; addr == "" || strings.HasPrefix(addr, "@") {
		if info == nil || info.conn == nil {
			return localRequest{channel: localChannelUnix}, false
		}
	}
	if isLoopbackAddr(r.RemoteAddr) {
		return localRequest{channel: localChannelTCPLoopback}, false
	}
	return localRequest{}, false
}

// unixLocal 用 platform.PeerCred（SO_PEERCRED）校验 UDS 对端身份。
// uid == 0（root）或 uid == socket 属主（= kored 运行用户，socket 由本进程创建且
// 不 chown）才放行；其余一律 blocked。
func (s *Server) unixLocal(conn net.Conn) (localRequest, bool) {
	if s.transport == nil {
		return localRequest{}, true // 无法取对端凭据：拒绝，不静默放行
	}
	cred, err := s.transport.PeerCred(conn)
	if err != nil {
		return localRequest{}, true
	}
	uid := int32(cred.UID)
	if uid != 0 && uid != localOwnerUID() {
		return localRequest{}, true
	}
	return localRequest{channel: localChannelUnix, cred: peerCred{
		uid: uid, pid: cred.PID, comm: procComm(cred.PID), known: true,
	}}, false
}

// localOwnerUID 是"本机管理员"的属主 uid：socket 由 kored 自己创建、属主即运行
// 用户；loopback 请求没有对端凭据，同一口径取运行用户。G-16：不碰 syscall。
func localOwnerUID() int32 { return int32(os.Getuid()) }

// isUnixConn 判断连接是否 UDS（net.UnixConn 或 LocalAddr 网络为 unix）。
func isUnixConn(conn net.Conn) bool {
	if _, ok := conn.(*net.UnixConn); ok {
		return true
	}
	if addr := conn.LocalAddr(); addr != nil {
		return addr.Network() == "unix"
	}
	return false
}

// isLoopbackAddr 用 net.ParseIP + IsLoopback 判 loopback；解析失败一律不信任
// （绝不做 127. 前缀匹配，也不读任何转发头）。
func isLoopbackAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// procComm 读对端进程名（/proc/<pid>/comm）；非 Linux 或读不到时返回空串，
// 不影响放行判定（comm 只是审计可读性，不是鉴权依据）。
func procComm(pid int32) string {
	if runtime.GOOS != "linux" || pid <= 0 {
		return ""
	}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// noteLocalAccess 记一条 local.access 审计。
//
// 写放大取舍：**只记写操作 + 每连接第一次**。面板/CLI 高频轮询如果每请求一条，
// 审计库会被读请求淹掉，反而看不见真正的管理动作。
func (s *Server) noteLocalAccess(r *http.Request, local localRequest) {
	info := connInfoFrom(r.Context())
	first := false
	if info != nil {
		first = info.markAudited()
	}
	if isSafeMethod(r.Method) && !first {
		return
	}
	detail := map[string]string{
		"channel":     local.channel,
		"source":      "local",
		"method":      r.Method,
		"path":        r.URL.Path,
		"remote_addr": r.RemoteAddr,
	}
	if local.cred.known {
		detail["uid"] = fmt.Sprintf("%d", local.cred.uid)
		detail["pid"] = fmt.Sprintf("%d", local.cred.pid)
		detail["comm"] = local.cred.comm
	}
	s.recordAudit(AuditEvent{Subject: "admin", Action: localAccessAction, Result: auditResultOK, Detail: detail})
}

// writeLocalDenied 统一回 403（EACCES 语义），与 401 明确区分：
// 这不是"你没登录"，而是"你这个身份不许直接连本机 socket"。
func writeLocalDenied(w http.ResponseWriter) {
	writeError(w, 403, pluginapi.E_NEED_ROOT, "本机 socket 访问被拒：对端 uid 既不是 socket 属主也不是 root", "")
}
