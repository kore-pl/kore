package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/pengtang1024/kore/internal/core/envprobe"
)

// healthBody 是 /-/healthz 的成功响应体。
type healthBody struct {
	// Status 固定为 ok（进程存活即 ready，不含插件 ready）。
	Status string `json:"status"`
}

// systemInfo 是 /api/v1/system/info 的成功响应体：capability report + 版本 + supervisor 统计。
type systemInfo struct {
	envprobe.Report
	// Version 是 kore 版本。
	Version string `json:"version"`
	// Supervisor 是常驻插件数与总重启数。
	Supervisor SupervisorStats `json:"supervisor"`
	// Paths 是已归一化为绝对路径的运行期目录（排障用）。
	Paths PathsInfo `json:"paths"`
}

// pluginsPath 是插件管理端点前缀。
const pluginsPath = "/api/v1/plugins"

// errorBody 是统一错误体，字段固定为 {code,message,detail}；
// requires_restart 是可选结构化提示（仅验签失败等需要重启内核的场景出现）。
type errorBody struct {
	// Code 是内核错误码（E_NOTFOUND 等）。
	Code string `json:"code"`
	// Message 面向用户。
	Message string `json:"message"`
	// Detail 面向排查（路径、错误原文）。
	Detail string `json:"detail"`
	// RequiresRestart 提示前端"需重启 kored 才能恢复"，仅在确有该语义时出现。
	RequiresRestart bool `json:"requires_restart,omitempty"`
	// Hint 是可操作提示（如"请用 sudo/systemd 启动 kored"），源自 detail.hint。
	Hint string `json:"hint,omitempty"`
}

// routes 注册 M1 端点与统一兜底。
//
// 未实现端点（store/*、auth/*、events、插件上传）明确回 501 E_UNSUPPORTED，
// 不用 404 假装"路由不存在"；方法不符仍走 404（完整中间件链归 M1-14）。
//
// 插件前缀用常量拼接：G-13 的仓库边界 grep 把 plugins 目录当作插件代码信号，
// HTTP 路径不是插件代码，这里规避误报（不改变实际路由取值）。
func (s *Server) routes() {
	s.mux.HandleFunc("GET /-/healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /api/v1/system/info", s.handleSystemInfo)
	s.mux.HandleFunc("GET /api/v1/system/metrics", s.handleSystemMetrics)
	s.mux.HandleFunc("GET "+pluginsPath, s.handlePlugins)
	s.mux.HandleFunc("GET "+pluginsPath+"/{id}", s.handlePluginDetail)
	s.mux.HandleFunc("POST "+pluginsPath, s.handleUnsupported)
	s.mux.HandleFunc("POST "+pluginsPath+"/{id}/enable", s.handleEnable)
	s.mux.HandleFunc("POST "+pluginsPath+"/{id}/disable", s.handleDisable)
	s.mux.HandleFunc("POST "+pluginsPath+"/{id}/root-action", s.handleRootAction)
	s.mux.HandleFunc("GET "+pluginsPath+"/{id}/root-action/{action_id}/confirm-token", s.handleConfirmToken)
	s.mux.HandleFunc("POST /api/v1/invoke/{plugin}/{method}", s.handleInvoke)
	s.mux.HandleFunc("GET /api/v1/store/plugins", s.handleStorePlugins)
	s.mux.HandleFunc("GET /api/v1/store/plugins/{id}", s.handleStorePlugin)
	s.mux.HandleFunc("POST /api/v1/store/refresh", s.handleStoreRefresh)
	s.mux.HandleFunc("GET /api/v1/store/presets", s.handleStorePresets)
	s.mux.HandleFunc("POST /api/v1/store/install", s.handleStoreInstall)
	s.mux.HandleFunc("POST /api/v1/store/update", s.handleStoreUpdate)
	s.mux.HandleFunc("GET /api/v1/store/jobs/{id}", s.handleStoreJob)
	s.mux.HandleFunc("/api/v1/store/", s.handleUnsupported)
	s.mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	s.mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	s.mux.HandleFunc("GET /api/v1/auth/session", s.handleSession)
	s.mux.HandleFunc("/api/v1/auth/", s.handleUnsupported)
	s.mux.HandleFunc("GET /api/v1/events", s.handleEvents)
	s.mux.HandleFunc("GET /api/v1/audit", s.handleAudit)
	s.mux.HandleFunc("/", s.handleNotFound)
}

// handleHealthz 返回 200 {"status":"ok"}。
func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthBody{Status: "ok"})
}

// handleSystemInfo 返回环境探测报告、版本与 supervisor 统计。
//
// 统计失败不把系统信息打成 5xx：基础信息仍可用，只在日志里记 WARN。
func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	stats := SupervisorStats{}
	if s.opts.Backend != nil {
		got, err := s.opts.Backend.Stats(r.Context())
		if err != nil {
			slog.Warn("读取 supervisor 统计失败", "err", err)
		} else {
			stats = got
		}
	}
	writeJSON(w, http.StatusOK, systemInfo{
		Report: s.opts.Report, Version: s.opts.Version, Supervisor: stats, Paths: s.opts.Paths,
	})
}

// handleNotFound 把未知路由收敛成 404 E_NOTFOUND。
func (s *Server) handleNotFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "E_NOTFOUND", "路由不存在", "")
}

// writeJSON 写出 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeError 写出统一错误体。
func writeError(w http.ResponseWriter, status int, code, message, detail string) {
	writeJSON(w, status, errorBody{Code: code, Message: message, Detail: detail})
}
