package httpapi

// API token 的可选来源绑定门（DESIGN-TOKEN-IP-BIND §3）。
//
// 安全口径（与登录白名单的 auth.ClientIP 刻意分叉）：
//   - 只取 TCP 对端 r.RemoteAddr；绝不读 X-Forwarded-For / X-Real-IP / Forwarded，
//     包括回环与 UDS 请求。token 是持有即授权的 bearer 凭据，请求头自证零成本绕过。
//   - 回环不是隐式可信：没有绑定才完全放行；有绑定时 127.0.0.1 / ::1 也逐条匹配。
//   - UDS 没有 peer IP，有绑定时只在连接可确认且 SO_PEERCRED uid 合规时豁免 IP 匹配；
//     取不到连接/凭据一律 fail-closed（401），不因为"看起来像本机"就跳过。
//   - 无缓存：绑定随每次 Bearer 请求从库里读出的记录即时生效。
import (
	"net/http"
	"net/netip"
	"strings"

	"github.com/pengtang1024/kore/internal/core/auth"
)

// tokenPeerIP 从 r.RemoteAddr 解析 TCP 对端 IP，带端口走 ParseAddrPort，不带端口
// 退到 ParseAddr（测试/特殊监听）。zone 非空或解析失败一律返回 false（fail-closed）。
// 映射地址用 Unmap 归一，使 ::ffff:127.0.0.1 能匹配持久化的 127.0.0.1/32。
func tokenPeerIP(r *http.Request) (netip.Addr, bool) {
	if r == nil {
		return netip.Addr{}, false
	}
	raw := strings.TrimSpace(r.RemoteAddr)
	if raw == "" {
		return netip.Addr{}, false
	}
	var addr netip.Addr
	if parsed, err := netip.ParseAddrPort(raw); err == nil {
		addr = parsed.Addr()
	} else {
		parsed, err := netip.ParseAddr(raw)
		if err != nil {
			return netip.Addr{}, false
		}
		addr = parsed
	}
	addr = addr.Unmap()
	if !addr.IsValid() || addr.Zone() != "" {
		return netip.Addr{}, false
	}
	return addr, true
}

// tokenPeerAllowed 判定 Bearer token 的来源是否满足绑定。
// 空绑定 = 不限制（存量 token 零改动）；非空绑定按下列顺序：
//  1. 请求确实来自 UDS（ConnContext 的 net.Conn 可确认且 isUnixConn）→ 仅当
//     SO_PEERCRED uid ∈ {0, kored uid} 才豁免；否则拒绝；
//  2. 其余（含回环 TCP）→ 只按 r.RemoteAddr 与 AllowedCIDRs 逐条匹配；
//  3. 对端不可解析、CIDR 损坏、未命中 → 拒绝。
//
// 没有 ConnContext 的测试请求即使 RemoteAddr 是 "@" 也不能靠"像 UDS"豁免：
// 取不到连接就无法取 SO_PEERCRED，必须 401。
func (s *Server) tokenPeerAllowed(r *http.Request, rec auth.APITokenRecord) bool {
	if len(rec.AllowedCIDRs) == 0 {
		return true
	}
	if info := connInfoFrom(r.Context()); info != nil && info.conn != nil && isUnixConn(info.conn) {
		local, blocked := s.unixLocal(info.conn)
		return !blocked && local.channel == localChannelUnix
	}
	peer, ok := tokenPeerIP(r)
	if !ok {
		return false
	}
	for _, raw := range rec.AllowedCIDRs {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil || !prefix.Contains(peer) {
			continue
		}
		return true
	}
	return false
}
