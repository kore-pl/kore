package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/kore-project/kore/internal/core/envprobe"
)

// healthBody 是 /-/healthz 的成功响应体。
type healthBody struct {
	// Status 固定为 ok（进程存活即 ready，不含插件 ready）。
	Status string `json:"status"`
}

// systemInfo 是 /api/v1/system/info 的成功响应体：capability report + 版本。
type systemInfo struct {
	envprobe.Report
	// Version 是 kore 版本。
	Version string `json:"version"`
}

// errorBody 是统一错误体，字段固定为 {code,message,detail}。
type errorBody struct {
	// Code 是内核错误码（E_NOTFOUND 等）。
	Code string `json:"code"`
	// Message 面向用户。
	Message string `json:"message"`
	// Detail 面向排查（路径、错误原文）。
	Detail string `json:"detail"`
}

// routes 注册 M1 的两个端点与统一 404 兜底。
//
// 兜底用 "/" 捕获所有未匹配路径并返回 JSON 错误体；代价是方法不符也走 404
// （405 语义属 M1-14 的完整中间件链，本阶段不实现）。
func (s *Server) routes() {
	s.mux.HandleFunc("GET /-/healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /api/v1/system/info", s.handleSystemInfo)
	s.mux.HandleFunc("/", s.handleNotFound)
}

// handleHealthz 返回 200 {"status":"ok"}。
func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthBody{Status: "ok"})
}

// handleSystemInfo 返回环境探测报告与版本。
func (s *Server) handleSystemInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, systemInfo{Report: s.opts.Report, Version: s.opts.Version})
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

// writeError 写出统一错误体；本阶段无业务错误，作为后续端点的辅助函数保留。
func writeError(w http.ResponseWriter, status int, code, message, detail string) {
	writeJSON(w, status, errorBody{Code: code, Message: message, Detail: detail})
}
