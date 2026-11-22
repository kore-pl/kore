package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// storeList 是 GET /api/v1/store/plugins 的成功响应体。
type storeList struct {
	// Plugins 按 id 升序排列的索引条目。
	Plugins []market.Plugin `json:"plugins"`
}

// storeInstallRequest 是 POST /api/v1/store/install 的请求体（显式字段，禁 any，G-24）。
type storeInstallRequest struct {
	// ID 插件 id。
	ID string `json:"id"`
	// Version 目标版本。
	Version string `json:"version"`
	// PackagePath 本地 tar.gz 路径（M2 不下载包）。
	PackagePath string `json:"package_path"`
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

// handleStoreInstall 触发本地包安装；body 为 {id,version,package_path}。
func (s *Server) handleStoreInstall(w http.ResponseWriter, r *http.Request) {
	var req storeInstallRequest
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
	job, err := svc.Install(req.ID, req.Version, req.PackagePath)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, job)
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
