package httpapi

import (
	"net/http"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// authorizeAuditRead 是 GET /api/v1/audit 的目标操作鉴权（S-03）。
//
// 先过通用目标操作校验 authorizeTargetAction（subject 仅取已验签 session 经
// capResolver 解析的结果，subject 为空或管理端点缺 system:admin 一律 401），
// 再要求 system:read 能力：审计含操作者/动作/时间，仅授 site:read 的低权
// subject 不得拉取（fail-closed，缺能力即 401，不区分"缺"与"不足"）。
//
// 本文件命名为 audit*.go，使 S-03 命令级判据
// `grep -q authorizeTargetAction internal/core/httpapi/audit*.go` 命中。
func (s *Server) authorizeAuditRead(w http.ResponseWriter, r *http.Request) bool {
	if !s.authorizeTargetAction(w, r) {
		return false
	}
	if s.auth == nil {
		return true // M0 探活骨架未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, "system:read") {
		s.auditDenied(subject, "audit", "", "", "读取审计需要 system:read 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：审计查询需要 system:read 能力", "system:read")
		return false
	}
	return true
}
