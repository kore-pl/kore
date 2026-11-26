package httpapi

import (
	"fmt"
	"net/http"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 日志关键字告警端点（R23 新功能7）：
//   - GET    /api/v1/log-alerts          规则列表 + 命中历史——system:read
//   - POST   /api/v1/log-alerts          新增规则——system:admin
//   - PUT    /api/v1/log-alerts/{id}     编辑/启停规则——system:admin
//   - DELETE /api/v1/log-alerts/{id}     删除规则——system:admin
//   - POST   /api/v1/log-alerts/scan     请求级命中扫描——system:admin
//
// 挂点由 server.go 的 New() 调用 registerLogAlertRoutes() 完成：
// 本文件不碰 handlers.go 的 routes()（该处存在并行写域），Go 1.22 ServeMux
// 按最长前缀匹配、与注册顺序无关，注册在 routes() 之后同样生效。
// 未装配 AlertSink 时扫描仍可做（只记命中历史）；命中告警写不进去只 WARN，不打断扫描。

// logAlertResp 是新增/编辑响应（显式字段，G-24）。
type logAlertResp struct {
	Rule LogAlertRule `json:"rule"`
}

// logAlertDeleteResp 是删除响应。
type logAlertDeleteResp struct {
	Deleted bool `json:"deleted"`
}

// requireLogAlerts 取规则注册表；未装配时回 501（零服务路径不受影响）。
func (s *Server) requireLogAlerts(w http.ResponseWriter) (*logAlertRegistry, bool) {
	if s.logAlerts == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"日志告警后端未装配", "")
		return nil, false
	}
	return s.logAlerts, true
}

// authorizeLogAlerts 列表 system:read，写/删/扫描 system:admin（fail-closed）。
func (s *Server) authorizeLogAlerts(w http.ResponseWriter, r *http.Request, capability string) bool {
	if !s.authorizeTargetAction(w, r) {
		return false
	}
	if s.auth == nil {
		return true // 探活骨架（测试）未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, capability) {
		s.auditDenied(subject, "log-alerts", "", "", "需要 "+capability+" 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：日志告警需要 "+capability+" 能力", capability)
		return false
	}
	return true
}

// registerLogAlertRoutes 注册本模块的精确路由；/{id} 参数路由须在 /scan 之后。
func (s *Server) registerLogAlertRoutes() {
	s.mux.HandleFunc("GET "+logAlertsPath, s.handleLogAlertsList)
	s.mux.HandleFunc("POST "+logAlertsPath, s.handleLogAlertsCreate)
	s.mux.HandleFunc("POST "+logAlertsPath+"/scan", s.handleLogAlertsScan)
	s.mux.HandleFunc("PUT "+logAlertsPath+"/{id}", s.handleLogAlertsUpdate)
	s.mux.HandleFunc("DELETE "+logAlertsPath+"/{id}", s.handleLogAlertsDelete)
	s.mux.HandleFunc(logAlertsPath+"/", s.handleNotFound)
}

func (s *Server) handleLogAlertsList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeLogAlerts(w, r, alertCapRead) {
		return
	}
	reg, ok := s.requireLogAlerts(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, reg.list())
}

func (s *Server) handleLogAlertsCreate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeLogAlerts(w, r, alertCapAdmin) {
		return
	}
	reg, ok := s.requireLogAlerts(w)
	if !ok {
		return
	}
	var in logAlertWriteBody
	if err := decodeJSONBody(w, r, &in); err != nil {
		writeFailure(w, err)
		return
	}
	rule, err := reg.add(in)
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, logAlertResp{Rule: rule})
}

func (s *Server) handleLogAlertsUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeLogAlerts(w, r, alertCapAdmin) {
		return
	}
	reg, ok := s.requireLogAlerts(w)
	if !ok {
		return
	}
	var in logAlertWriteBody
	if err := decodeJSONBody(w, r, &in); err != nil {
		writeFailure(w, err)
		return
	}
	rule, found, err := reg.update(r.PathValue("id"), in)
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "规则不存在或已被删除", "")
		return
	}
	writeJSON(w, http.StatusOK, logAlertResp{Rule: rule})
}

func (s *Server) handleLogAlertsDelete(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeLogAlerts(w, r, alertCapAdmin) {
		return
	}
	reg, ok := s.requireLogAlerts(w)
	if !ok {
		return
	}
	if !reg.remove(r.PathValue("id")) {
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, "规则不存在或已被删除", "")
		return
	}
	writeJSON(w, http.StatusOK, logAlertDeleteResp{Deleted: true})
}

// handleLogAlertsScan 是唯一的命中检测入口：请求级同步扫描，零常驻循环（G-19）。
// 日志行由前端经现有 logs.tail / logs.search 读取后提交，内核不读插件日志文件（G-01）。
// 命中后经 s.recordAlert 写入现有 alerts 中心（复用 5 分钟去重与 webhook 出站），
// source 固定 plugin、title 以「日志命中」开头，与 r23-alertrules 的阈值规则天然区分。
func (s *Server) handleLogAlertsScan(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeLogAlerts(w, r, alertCapAdmin) {
		return
	}
	reg, ok := s.requireLogAlerts(w)
	if !ok {
		return
	}
	var in logAlertScanBody
	if err := decodeJSONBody(w, r, &in); err != nil {
		writeFailure(w, err)
		return
	}
	if len(in.Lines) == 0 {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"没有可扫描的日志行，请先在日志页读取内容再扫描", "")
		return
	}
	result := reg.scan(in.Source, in.Lines, time.Now())
	// 告警写入是旁路：失败只 WARN（recordAlert 内部），不打断扫描结果返回。
	for _, hit := range result.Hits {
		s.recordAlert(hit.Severity, alertSourcePlugin,
			"日志命中："+hit.Keyword,
			fmt.Sprintf("来源=%s；第 %d 行；%s", hit.Source, hit.LineNo, hit.Snippet))
	}
	writeJSON(w, http.StatusOK, result)
}
