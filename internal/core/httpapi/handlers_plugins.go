package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/pengtang1024/kore/internal/core/market"
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
	s.alignIndexVersions(plugins)
	// 告警埋点：state=failed / restarts>3 的插件写一条告警（5 分钟去重由持久层收敛）。
	s.notePluginAlerts(plugins)
	writeJSON(w, http.StatusOK, pluginList{Plugins: plugins})
}

// alignIndexVersions 把已装视图与已验签索引按 id 对齐，填入 latest_version /
// latest_sha256 / update_available。
//
// G-01 边界：这里只做两个数据源的对齐（索引有该 id、版本字符串是否相同），
// 不判断"哪个更高"、不决定是否升级、不碰依赖与兼容性——升级语义留在前端与
// installer/market。索引不可读时保持字段为空并记 WARN：商店页会显示索引错误，
// 已装插件页不因索引故障整体不可用。
func (s *Server) alignIndexVersions(plugins []PluginStatus) {
	if s.market == nil || len(plugins) == 0 {
		return
	}
	index, err := s.market.Load()
	if err != nil {
		slog.Warn("已装插件版本对齐失败：索引不可读", "err", err)
		return
	}
	byID := make(map[string]market.Plugin, len(index.Plugins))
	for _, p := range index.Plugins {
		byID[p.ID] = p
	}
	for i := range plugins {
		entry, ok := byID[plugins[i].ID]
		if !ok {
			continue
		}
		plugins[i].LatestVersion = entry.Version
		plugins[i].LatestSHA256 = entry.SHA256
		plugins[i].UpdateAvailable = entry.Version != plugins[i].Version
	}
}

// handlePluginDetail 返回单个插件视图（GET /api/v1/plugins/{id}）。
//
// 与列表端点共用同一个 Backend.Plugin：新字段 web / granted_capabilities
// 由装配层填入 PluginStatus，本层只做存在性判定与错误映射，不重复组装。
func (s *Server) handlePluginDetail(w http.ResponseWriter, r *http.Request) {
	if s.opts.Backend == nil {
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "后端未装配", "")
		return
	}
	id := r.PathValue("id")
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

// handleEnable 启用插件并返回当前视图；重复 enable 幂等，不重复拉起进程。
func (s *Server) handleEnable(w http.ResponseWriter, r *http.Request) {
	s.handleLifecycle(w, r, true)
}

// handleDisable 停止插件并返回当前视图；重复 disable 幂等。
func (s *Server) handleDisable(w http.ResponseWriter, r *http.Request) {
	s.handleLifecycle(w, r, false)
}

// handleLifecycle 是 enable/disable 的共同流程：目标操作校验 → 动作 → 回读单插件视图。
//
// 管理端点按目标操作做 capability 校验的挂点见 authorizeTargetAction（TODO 裁决40）。
func (s *Server) handleLifecycle(w http.ResponseWriter, r *http.Request, enable bool) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
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
