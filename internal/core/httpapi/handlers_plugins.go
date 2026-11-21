package httpapi

import (
	"net/http"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// pluginList 是 GET /api/v1/plugins 的成功响应体。
type pluginList struct {
	// Plugins 按 id 升序排列的插件视图。
	Plugins []PluginStatus `json:"plugins"`
}

// handlePlugins 返回全部已登记插件。
func (s *Server) handlePlugins(w http.ResponseWriter, r *http.Request) {
	if s.opts.Backend == nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "后端未装配", "")
		return
	}
	plugins, err := s.opts.Backend.Plugins(r.Context())
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pluginList{Plugins: plugins})
}

// handleEnable 启用插件并返回当前视图；重复 enable 幂等，不重复拉起进程。
func (s *Server) handleEnable(w http.ResponseWriter, r *http.Request) {
	s.handleLifecycle(w, r, true)
}

// handleDisable 停止插件并返回当前视图；重复 disable 幂等。
func (s *Server) handleDisable(w http.ResponseWriter, r *http.Request) {
	s.handleLifecycle(w, r, false)
}

// handleLifecycle 是 enable/disable 的共同流程：动作 → 回读单插件视图。
func (s *Server) handleLifecycle(w http.ResponseWriter, r *http.Request, enable bool) {
	if s.opts.Backend == nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "后端未装配", "")
		return
	}
	id := r.PathValue("id")
	var err error
	if enable {
		err = s.opts.Backend.Enable(r.Context(), id)
	} else {
		err = s.opts.Backend.Disable(r.Context(), id)
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	status, ok, err := s.opts.Backend.Plugin(r.Context(), id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "插件不存在", id)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// handleUnsupported 为 M2 端点占位：明确回 501 E_UNSUPPORTED，不假装成功。
func (s *Server) handleUnsupported(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
		"该端点尚未实现（M2 支持）", "")
}
