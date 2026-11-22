package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// storeList 是 GET /api/v1/store/plugins 的成功响应体。
type storeList struct {
	// Plugins 按 id 升序排列的索引条目。
	Plugins []market.Plugin `json:"plugins"`
}

// storeInstallResponse 是 POST /api/v1/store/install 的成功响应：
// 安装任务字段 + 安装后重载结果（reloaded 仅登记 / restarted 已按期望态拉起）。
type storeInstallResponse struct {
	*market.InstallJob
	// Reload 是安装后登记重载结果；未装配回调时为空。
	Reload string `json:"reload,omitempty"`
}

// storeInstallRequest 是 POST /api/v1/store/install 的请求体（显式字段，禁 any，G-24）。
//
// 安装来源三选一（显式，无 any）：
//   - package_path：本地包安装（离线场景，用户自备 tar.gz）；
//   - download=true + id/version：从**已验签索引**取 download_url 与 sha256 下载安装；
//   - 两者同给 → 歧义拒绝；两者都不给 → 无法确定来源，拒绝并提示。
type storeInstallRequest struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Version 目标版本。
	Version string `json:"version"`
	// PackagePath 本地 tar.gz 路径（离线安装用）。
	PackagePath string `json:"package_path"`
	// Download 为 true 时按索引 download_url 下载安装（请求体不携带 URL，防 SSRF）。
	Download bool `json:"download"`
	// Force 为 true 时允许覆盖已装同版本（修复/重装）；仍走索引摘要与包校验。
	Force bool `json:"force"`
}

// validate 判定安装来源：id/version 恒定必填，package_path 与 download 恰好二选一。
// 返回的错误直接作为 400 E_INVALID 的 message，所以文案要给用户可执行的下一步。
func (r storeInstallRequest) validate() error {
	if r.ID == "" || r.Version == "" {
		return errors.New("id/version 必填")
	}
	hasPath := strings.TrimSpace(r.PackagePath) != ""
	switch {
	case hasPath && r.Download:
		return errors.New("package_path 与 download=true 不可同时给（安装来源歧义）")
	case !hasPath && !r.Download:
		return errors.New("给 package_path（本地包）或 download=true（从索引下载）")
	default:
		return nil
	}
}

// storeUpdateRequest 是 POST /api/v1/store/update 的请求体（显式字段，禁 any，G-24）。
type storeUpdateRequest struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Version 目标版本。
	Version string `json:"version"`
	// PackagePath 本地 tar.gz 路径。
	PackagePath string `json:"package_path"`
}

// storeUpdateResponse 是 POST /api/v1/store/update 的成功响应：
// 更新结果 + 安装后重载结果（与 store/install 共用同一重载路径）。
type storeUpdateResponse struct {
	*market.UpdateResult
	// Reload 是安装后登记重载结果；未装配回调时为空。
	Reload string `json:"reload,omitempty"`
}

// storePresets 是 GET /api/v1/store/presets 的成功响应体。
type storePresets struct {
	// Presets 按 id 升序排列的预设元数据。
	Presets []market.Preset `json:"presets"`
}

// requireStore 取商店后端；未装配时回 501 E_UNSUPPORTED（不假装成功）。
func (s *Server) requireStore(w http.ResponseWriter) (*market.Service, bool) {
	if s.market == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "商店后端未装配", "")
		return nil, false
	}
	return s.market, true
}

// handleStorePlugins 返回本地索引的全部插件条目（零出站）。
func (s *Server) handleStorePlugins(w http.ResponseWriter, r *http.Request) {
	svc, ok := s.requireStore(w)
	if !ok {
		return
	}
	index, err := svc.Load()
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, storeList{Plugins: index.Plugins})
}

// handleStorePlugin 返回单个插件详情；未收录返回 404 E_NOTFOUND。
func (s *Server) handleStorePlugin(w http.ResponseWriter, r *http.Request) {
	svc, ok := s.requireStore(w)
	if !ok {
		return
	}
	p, err := svc.Plugin(r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "索引中不存在该插件", r.PathValue("id"))
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// handleStoreRefresh 重读索引并验签；失败拒绝并保留旧索引（R4）。
func (s *Server) handleStoreRefresh(w http.ResponseWriter, r *http.Request) {
	svc, ok := s.requireStore(w)
	if !ok {
		return
	}
	res, err := svc.Refresh()
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleStorePresets 返回预设元数据；索引验签失败时拒绝，不读未签名缓存（R4）。
func (s *Server) handleStorePresets(w http.ResponseWriter, r *http.Request) {
	svc, ok := s.requireStore(w)
	if !ok {
		return
	}
	presets, err := svc.Presets()
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, storePresets{Presets: presets})
}

// handleStoreUpdate 走现有 installer 装新版本（索引验签 + 包 sha256 双门，R4）。
func (s *Server) handleStoreUpdate(w http.ResponseWriter, r *http.Request) {
	var req storeUpdateRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体非法", err.Error())
		return
	}
	if req.ID == "" || req.Version == "" || req.PackagePath == "" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "id/version/package_path 必填", "")
		return
	}
	svc, ok := s.requireStore(w)
	if !ok {
		return
	}
	res, err := svc.Update(req.ID, req.Version, req.PackagePath)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// 更新同样落盘了新版本：与 store/install 共用 reloadOne，否则 /plugins 仍报旧版本。
	var reload string
	if s.installRefresh != nil {
		result, err := s.installRefresh(req.ID)
		if err != nil {
			slog.Error("更新后重载插件失败", "plugin_id", req.ID, "result", result, "err", err)
			writeFailure(w, err)
			return
		}
		reload = result
	}
	writeJSON(w, http.StatusOK, storeUpdateResponse{UpdateResult: res, Reload: reload})
}

// handleStoreInstall 触发安装：本地包（package_path）或索引下载（download=true）。
//
// 下载路径的 URL 与 sha256 只来自已验签索引，请求体无法注入地址（防 SSRF）；
// 目标版本、摘要不符等失败由 market/installer 映射成 E_UPSTREAM / E_INVALID。
func (s *Server) handleStoreInstall(w http.ResponseWriter, r *http.Request) {
	var req storeInstallRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体非法", err.Error())
		return
	}
	if err := req.validate(); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	svc, ok := s.requireStore(w)
	if !ok {
		return
	}
	var job *market.InstallJob
	var installErr error
	switch {
	case req.Download && req.Force:
		job, installErr = svc.InstallDownloadForce(r.Context(), req.ID, req.Version)
	case req.Download:
		job, installErr = svc.InstallDownload(r.Context(), req.ID, req.Version)
	case req.Force:
		job, installErr = svc.InstallForce(req.ID, req.Version, req.PackagePath)
	default:
		job, installErr = svc.Install(req.ID, req.Version, req.PackagePath)
	}
	if installErr != nil {
		writeFailure(w, installErr)
		return
	}
	// 安装已落盘，但 registry/supervisor 是内存态：不刷新则 /plugins 仍报旧版本、
	// 新方法 404。回调失败不吞——返回 500 显式暴露"重载未完成"，避免假装成功埋雷。
	var reload string
	if s.installRefresh != nil {
		result, err := s.installRefresh(req.ID)
		if err != nil {
			slog.Error("安装后重载插件失败", "plugin_id", req.ID, "result", result, "err", err)
			writeFailure(w, err)
			return
		}
		reload = result
	}
	writeJSON(w, http.StatusOK, storeInstallResponse{InstallJob: job, Reload: reload})
}

// handleStoreJob 返回安装任务进度。
//
// M2 只做索引读取/验签/安装触发，异步 job 队列留 M3：
// 已成功安装的内联任务返回 succeeded，其余固定返回 E_UNSUPPORTED 并注明 M3。
func (s *Server) handleStoreJob(w http.ResponseWriter, r *http.Request) {
	svc, ok := s.requireStore(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	job, err := svc.Plugin(id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "任务不存在", id)
		return
	}
	writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
		"安装任务进度查询未实现（M3 支持异步 job 队列）", id)
}
