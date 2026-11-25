package httpapi

// ADR-0058：本机静默更新的 UDS 专用入口（选项 A）。
//
// 这是**独立 socket + 独立 http.Server** 上的单一端点，与主 mux / withAuth / CSRF
// 完全分离：公开门零变化（ADR-0043），主 socket 上的 /api/v1/store/install 等端点
// 仍一律会话校验，本机未登录同样 401。
//
// 严格三重鉴权（吸收 1Panel CVE-2025-54424「只验有连接就放行」的教训）：
//  1. 连接来源：只接受 UDS（net.UnixConn / LocalAddr.Network()=="unix"），
//     loopback TCP 与远程地址一律拒绝；
//  2. 进程身份：transport.PeerCred 取 SO_PEERCRED，uid ∈ {0, os.Getuid()}，
//     取不到凭据即 fail-closed；
//  3. 专用能力：通道只授予单一 system:self_update，**不含 6 项 admin 能力**，
//     也不进会话能力集；公开会话即使持 admin 也不自动获得本能力。
//
// 审计：每次调用（含拒绝）写 system.self_update，detail 只含 uid / channel /
// capability / target_version，绝不记口令、token 或任何凭据字段；审计写不进
// 就不执行更新（fail-closed）。
//
// 能力的实际执行复用 SelfUpdater（与进程内编排共用同一份语义，ADR-0058 §3.2），
// 本文件只负责「受控入口」，不重复实现更新编排（G-01 薄壳）。

import (
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// localUpdatePath 是 ADR-0058 的专用更新端点路径（UDS-only）。
	localUpdatePath = "/api/v1/system/self-update"
	// auditActionSelfUpdate 是专用端点的审计动作名（DATA-MODEL §9 动作表）。
	auditActionSelfUpdate = "system.self_update"
	// localUpdateChannel 是审计 detail 中的通道标识（与 local_access.go 同口径）。
	localUpdateChannel = "unix"
)

// selfUpdateConnKey 是专用 UDS 连接对象的 context 键（ConnContext 写入）。
type selfUpdateConnKey struct{}

// SelfUpdateAuditRecorder 是专用端点的 fail-closed 审计出口。
//
// 与 AuditRecorder（无错误返回）不同，这里 Record 必须返回错误：审计写不进就
// 不执行更新（ADR-0058 §3.1.5）。由 cmd/kored 注入 store.PutAudit 适配器；
// nil 时端点回 501，绝不"没审计就更新"。
type SelfUpdateAuditRecorder interface {
	Record(AuditEvent) error
}

// LocalUpdateCapability 返回专用通道授予的唯一能力名（ADR-0058 §3.1.4）。
// 导出供装配层显式注入 resolver，避免在 cmd/kored 重复硬编码能力字符串。
func LocalUpdateCapability() string { return selfUpdateCapability }

// defaultSelfUpdateCapabilityResolver 是内置兜底：通过 UDS + peercred 的调用方
// 只获得单一专用能力，不含任何 admin 能力。装配层未注入时使用，保证
// "不配置也安全"（fail-closed 到最小能力，而不是放行全部）。
func defaultSelfUpdateCapabilityResolver(int32) []string {
	return []string{selfUpdateCapability}
}

// LocalUpdateRequest 是专用端点请求体（显式字段，G-24；未知字段拒绝）。
type LocalUpdateRequest struct {
	// SourcePath 新二进制的本机绝对路径（不接受 URL）。
	SourcePath string `json:"source_path"`
	// SHA256 新二进制期望摘要（64 位小写 hex）。
	SHA256 string `json:"sha256"`
	// Version 目标版本（审计与展示用；缺省时用 sha256 标识）。
	Version string `json:"version,omitempty"`
	// Confirm 高危二次确认，必须显式为 true。
	Confirm bool `json:"confirm"`
}

// selfUpdateHandler 是专用 socket 的唯一处理器。
//
// 只接受 POST /api/v1/system/self-update，其余路径/方法 404；所有鉴权失败统一
// 收敛到 401（连接/凭据不成立）或 403（身份成立但未授权），不回显具体失败点。
func (s *Server) selfUpdateHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != localUpdatePath || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}

		// ---- 1. 连接来源：UDS only ----
		conn, _ := r.Context().Value(selfUpdateConnKey{}).(net.Conn)
		if conn == nil || !isUnixConn(conn) {
			s.denyLocalUpdate(w, "unknown", "", "专用更新端点只接受 UDS 连接")
			return
		}

		// ---- 2. 进程身份：SO_PEERCRED uid ∈ {0, kored uid} ----
		if s.transport == nil {
			s.denyLocalUpdate(w, "unknown", "", "对端凭据不可用")
			return
		}
		cred, err := s.transport.PeerCred(conn)
		if err != nil {
			s.denyLocalUpdate(w, "unknown", "", "对端凭据不可用")
			return
		}
		uid := int32(cred.UID)
		if uid != 0 && uid != localOwnerUID() {
			s.denyLocalUpdate(w, strconv.FormatInt(int64(uid), 10), "", "对端 uid 不在可信集合")
			return
		}
		actor := "uid:" + strconv.FormatInt(int64(uid), 10)

		// ---- 3. 专用能力：单一 system:self_update，不含 admin ----
		resolver := s.selfUpdateCapabilityResolver
		if resolver == nil {
			resolver = defaultSelfUpdateCapabilityResolver
		}
		granted := resolver(uid)
		if !isSingleDedicatedCapability(granted) {
			s.denyLocalUpdate(w, actor, "", "专用能力校验失败")
			return
		}

		// ---- 4. 请求体（confirm 必填）----
		var body LocalUpdateRequest
		if perr := readStrictBody(w, r, &body); perr != nil {
			writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, perr.Error(), "")
			return
		}
		if !body.Confirm {
			writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
				"本机更新会替换内核/插件，必须显式确认（confirm=true）", "")
			return
		}
		targetVersion := strings.TrimSpace(body.Version)
		if targetVersion == "" {
			targetVersion = strings.TrimSpace(body.SHA256)
		}

		// ---- 5. 后端可用性先探（未装配 → 501，不写"ok"审计误导取证）----
		updater, ok := s.availableSelfUpdater()
		if !ok {
			writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
				"当前装配不支持本机专用更新", "")
			return
		}

		// ---- 6. 审计 fail-closed：写不进就不执行 ----
		if err := s.auditLocalUpdate(actor, targetVersion, auditResultOK); err != nil {
			writeError(w, http.StatusServiceUnavailable, pluginapi.E_INTERNAL,
				"更新审计写入失败，本次更新未执行", "")
			return
		}

		// ---- 7. 委托共享更新编排（与进程内调用共用同一 SelfUpdater）----
		job, err := updater.StartUpgrade(r.Context(), actor, SelfUpdateRequest{
			SourcePath: body.SourcePath, SHA256: body.SHA256, Confirm: body.Confirm,
		})
		if err != nil {
			writeUpgradeFailure(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, job)
	})
}

// isSingleDedicatedCapability 判定能力集恰好只有 system:self_update 一项。
// 显式排除 6 项 admin 能力：通道即使被误配成 admin 全权也 fail-closed，
// 双向隔离会话能力集（ADR-0058 §3.1.4 / 复审条件 §7.1）。
func isSingleDedicatedCapability(granted []string) bool {
	if len(granted) != 1 || granted[0] != selfUpdateCapability {
		return false
	}
	return !hasCapability(granted, "system:admin")
}

// auditLocalUpdate 写一条 system.self_update 审计（fail-closed）。
// detail 只含 uid（在 subject 中）/ channel / capability / target_version，
// 不含 source_path 之外的任何输入，更不含口令或 token（G-30）。
func (s *Server) auditLocalUpdate(actor, targetVersion, result string) error {
	if s.selfUpdateAuditRecorder == nil {
		return errors.New("专用更新审计出口未装配")
	}
	return s.selfUpdateAuditRecorder.Record(AuditEvent{
		Subject: actor,
		Action:  auditActionSelfUpdate,
		Target:  targetVersion,
		Result:  result,
		Detail: map[string]string{
			"channel":        localUpdateChannel,
			"capability":     selfUpdateCapability,
			"target_version": targetVersion,
		},
	})
}

// denyLocalUpdate 统一拒绝：连接/凭据不成立回 401，身份成立但未授权回 403。
// 具体原因只进 WARN 日志，不回显给调用方（不泄露是哪一关失败）。
func (s *Server) denyLocalUpdate(w http.ResponseWriter, actor, targetVersion, reason string) {
	status := http.StatusUnauthorized
	if actor != "" && actor != "unknown" {
		status = http.StatusForbidden
	}
	_ = s.auditLocalUpdate(actor, targetVersion, auditResultDenied) // 审计失败不改变拒绝结论
	writeError(w, status, pluginapi.E_UNAUTHORIZED, "专用更新端点鉴权失败", "")
}

// selfUpdateHandlerForTest 供单测直接取处理器（不经真实 socket）。
func (s *Server) selfUpdateHandlerForTest() http.Handler { return s.selfUpdateHandler() }
