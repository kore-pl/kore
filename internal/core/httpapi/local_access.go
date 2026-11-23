package httpapi

import (
	"context"
	"net"
	"net/http"
	"os"
	"strings"
)

// 本机通道的**识别**（ADR-0043）：UDS 与 loopback TCP。
//
// 这不是一条认证通道。ADR-0041 曾把「本机通道」直接当作免登录身份（UDS 文件系统
// 权限 / loopback 可达性即认证，withAuth 跳过会话校验），实测后果是面板打开后没有
// 登录页、未登录也能操作管理 API——与用户「面板必须要有登录页面」的要求相反，已被
// ADR-0043 更正。现在本文件只剩两件**非认证**用途：
//   - CSRF 双提交的本机引导（csrf_local.go）：幂等请求补发 kore_csrf，避免登录前
//     首屏 GET 之后写请求拿不到令牌；仅本机通道下发。
//   - UDS 的 CSRF 豁免判定：浏览器没有 unix socket 通道，跨站请求打不到这里。
//
// 所有 /api/v1/* 的认证口径统一在 withAuth：没有有效会话一律 401，本机不例外。
// 操作免密（含 root 特权动作）由「登录一次 + 7 天滑动会话 + ADR-0042 的内核 root
// 服务」共同实现，不靠跳过登录。
const (
	// localChannelUnix 是 UDS 通道名。
	localChannelUnix = "unix"
	// localChannelTCPLoopback 是 loopback TCP 通道名。
	localChannelTCPLoopback = "tcp-loopback"
)

// connInfo 是连接级状态：原始 net.Conn（ConnContext 注入），用于识别 UDS。
type connInfo struct {
	conn net.Conn
}

// connKey 是连接信息在 context 中的私有键（ConnContext 注入）。
type connKey struct{}

// connInfoFrom 取连接级信息；测试直接构造请求时可能缺失（返回 nil）。
func connInfoFrom(ctx context.Context) *connInfo {
	info, _ := ctx.Value(connKey{}).(*connInfo)
	return info
}

// localRequest 是一次"本机通道"判定的结果（仅用于 CSRF 引导/豁免，不是身份）。
type localRequest struct {
	// channel 是通道名（unix / tcp-loopback）；空串表示不是本机请求。
	channel string
}

// isLocal 表示该请求命中本机通道。
func (l localRequest) isLocal() bool { return l.channel != "" }

// resolveLocal 判定请求是否来自本机通道；blocked=true 表示"是本机 socket
// 但身份不合规"（对端 uid 既非 socket 属主也非 root）。blocked 只用于拒绝
// 为这类连接补发 CSRF 令牌，**不是**鉴权结论——鉴权由 withAuth 的会话校验负责。
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

// unixLocal 用 platform.PeerCred（SO_PEERCRED）校验 UDS 对端身份：
// uid == 0（root）或 uid == socket 属主（= kored 运行用户，socket 由本进程创建且
// 不 chown）才算合规；其余 blocked。
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
	return localRequest{channel: localChannelUnix}, false
}

// localOwnerUID 是"本机管理员"的属主 uid：socket 由 kored 自己创建、属主即运行
// 用户。G-16：不碰 syscall。
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
