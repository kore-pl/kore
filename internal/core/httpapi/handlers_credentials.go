package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// ADR-0026 §2 的 4 个端点：创建/列出/授权/撤销；全部要求 system:admin。
// 响应永不含 secret（List 只回元数据）。

func (s *Server) authorizeCredentials(w http.ResponseWriter, r *http.Request) bool {
	if !s.authorizeTargetAction(w, r) {
		return false
	}
	if s.auth == nil {
		return true
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, "system:admin") {
		s.auditDenied(subject, "credentials", "", "需要 system:admin 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：凭据管理需要 system:admin 能力", "system:admin")
		return false
	}
	return true
}

func (s *Server) requireCredentials(w http.ResponseWriter) bool {
	if s.opts.Credentials == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "凭据库未装配", "")
		return false
	}
	return true
}

// handleCredentialCreate 处理 POST /api/v1/credentials。
func (s *Server) handleCredentialCreate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeCredentials(w, r) || !s.requireCredentials(w) {
		return
	}
	var body struct {
		Owner  string `json:"owner"`
		Name   string `json:"name"`
		EnvVar string `json:"envVar"`
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体不是合法 JSON", "")
		return
	}
	entry, err := s.opts.Credentials.Set(r.Context(), "admin", body.Owner, body.Name, body.EnvVar, []byte(body.Secret))
	if err != nil {
		writeCredentialError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		ID string `json:"id"`
	}{ID: entry.ID})
}

// handleCredentialList 处理 GET /api/v1/credentials?owner=。
func (s *Server) handleCredentialList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeCredentials(w, r) || !s.requireCredentials(w) {
		return
	}
	entries, err := s.opts.Credentials.List(r.Context(), "admin", r.URL.Query().Get("owner"))
	if err != nil {
		writeCredentialError(w, err)
		return
	}
	// 显式响应形状；绝不返回 secret。
	type item struct {
		ID        string   `json:"id"`
		Owner     string   `json:"owner"`
		Name      string   `json:"name"`
		EnvVar    string   `json:"envVar"`
		GrantedTo []string `json:"grantedTo"`
	}
	items := make([]item, 0, len(entries))
	for _, entry := range entries {
		items = append(items, item{ID: entry.ID, Owner: entry.Owner, Name: entry.Name,
			EnvVar: entry.EnvVar, GrantedTo: append([]string{}, entry.GrantedTo...)})
	}
	writeJSON(w, http.StatusOK, struct {
		Credentials []item `json:"credentials"`
	}{Credentials: items})
}

// handleCredentialGrant 处理 POST /api/v1/credentials/{id}/grants。
func (s *Server) handleCredentialGrant(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeCredentials(w, r) || !s.requireCredentials(w) {
		return
	}
	var body struct {
		Grantee string `json:"grantee"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体不是合法 JSON", "")
		return
	}
	grantedAt, err := s.opts.Credentials.Grant(r.Context(), "admin", r.PathValue("id"), body.Grantee)
	if err != nil {
		writeCredentialError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Granted   bool   `json:"granted"`
		Grantee   string `json:"grantee"`
		GrantedAt string `json:"grantedAt"`
	}{Granted: true, Grantee: body.Grantee, GrantedAt: grantedAt.Format("2006-01-02T15:04:05Z07:00")})
}

// handleCredentialRevoke 处理 DELETE /api/v1/credentials/{id}/grants/{grantee}。
func (s *Server) handleCredentialRevoke(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeCredentials(w, r) || !s.requireCredentials(w) {
		return
	}
	grantee := r.PathValue("grantee")
	if err := s.opts.Credentials.Revoke(r.Context(), "admin", r.PathValue("id"), grantee); err != nil {
		writeCredentialError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Revoked bool   `json:"revoked"`
		Grantee string `json:"grantee"`
	}{Revoked: true, Grantee: grantee})
}

// writeCredentialError 把凭据错误映射为 HTTP 状态码（E_NEED_GRANT/E_AUDIT 按 ADR-0026 §3）。
func writeCredentialError(w http.ResponseWriter, err error) {
	if apiErr, ok := err.(*pluginapi.Error); ok {
		switch apiErr.Code {
		case "E_NEED_GRANT":
			writeError(w, http.StatusForbidden, apiErr.Code, apiErr.Message, "")
		case "E_AUDIT":
			writeError(w, http.StatusInternalServerError, apiErr.Code, apiErr.Message, "")
		case pluginapi.E_NOTFOUND:
			writeError(w, http.StatusNotFound, apiErr.Code, apiErr.Message, "")
		case pluginapi.E_UNAUTHORIZED:
			writeError(w, http.StatusUnauthorized, apiErr.Code, apiErr.Message, "")
		default:
			writeError(w, http.StatusBadRequest, apiErr.Code, apiErr.Message, "")
		}
		return
	}
	writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "凭据操作失败", "")
}
