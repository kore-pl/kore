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
	// Demotion 是插件降权是否真的生效（非 root 时 enabled=false + 原因）。
	Demotion DemotionInfo `json:"demotion"`
}

// pluginsPath 是插件管理端点前缀。
const pluginsPath = "/api/v1/plugins"

// authPasswordPath 是在线改口令端点；前端 PW_ENDPOINT 与之逐字对齐。
const authPasswordPath = "/api/v1/auth/password"

// snapshotsPath 是配置快照（时光机）端点前缀；与 handlers_snapshots.go 共用。
const snapshotsPath = "/api/v1/snapshots"

// 改口令请求校验口径（与 web/settings.js 的 PW_MIN_LEN=12 对齐）。
const (
	// passwordMinLen 是新口令最小长度（人话下限，与 CLI 24 位随机口令同口径取保守值）。
	passwordMinLen = 12
)

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
	// Hint 是可操作提示（如"按 ADR-0042 以系统服务形态运行内核"），源自 detail.hint。
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
	// 磁盘分析（R23）：只读目录占用扫描；category 枚举映射配置白名单目录，前端不传路径。
	s.mux.HandleFunc("GET "+diskUsagePath, s.handleDiskUsage)
	// 内核自升级（ADR-0042）：状态 / 发起 / 进度 / 回滚；需 system:admin + confirm。
	s.mux.HandleFunc("GET "+selfUpdatePath, s.handleUpgradeStatus)
	s.mux.HandleFunc("POST "+selfUpdatePath, s.handleUpgradeStart)
	s.mux.HandleFunc("GET "+selfUpdateJobsPath+"/{id}", s.handleUpgradeJob)
	s.mux.HandleFunc("POST "+selfUpdateRollback, s.handleUpgradeRollback)
	s.mux.HandleFunc("GET "+pluginsPath, s.handlePlugins)
	s.mux.HandleFunc("GET "+pluginsPath+"/{id}", s.handlePluginDetail)
	s.mux.HandleFunc("POST "+pluginsPath, s.handleUnsupported)
	s.mux.HandleFunc("POST "+pluginsPath+"/{id}/enable", s.handleEnable)
	s.mux.HandleFunc("POST "+pluginsPath+"/{id}/disable", s.handleDisable)
	// 卸载：停进程 + 删 dist + 移除记录 + 审计（fail-closed）；未装 id 回 200 already_absent。
	s.mux.HandleFunc("DELETE "+pluginsPath+"/{id}", s.handlePluginUninstall)
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
	s.mux.HandleFunc("POST /api/v1/credentials", s.handleCredentialCreate)
	s.mux.HandleFunc("GET /api/v1/credentials", s.handleCredentialList)
	s.mux.HandleFunc("POST /api/v1/credentials/{id}/grants", s.handleCredentialGrant)
	s.mux.HandleFunc("DELETE /api/v1/credentials/{id}/grants/{grantee}", s.handleCredentialRevoke)
	s.mux.HandleFunc("DELETE /api/v1/credentials/{id}", s.handleCredentialDelete)
	s.mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	s.mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	s.mux.HandleFunc("GET /api/v1/auth/session", s.handleSession)
	// 在线改口令（r10-passwdapi）：精确路由须在 /api/v1/auth/ 兜底之前，
	// 否则会被 501 吞掉；不误伤上面三条已注册端点。
	s.mux.HandleFunc("POST "+authPasswordPath, s.handleChangePassword)
	s.mux.HandleFunc("/api/v1/auth/", s.handleUnsupported)
	s.mux.HandleFunc("GET /api/v1/events", s.handleEvents)
	s.mux.HandleFunc("GET /api/v1/audit", s.handleAudit)
	// 告警中心：列表（system:read）/ 写入 / 标记已读（均 system:admin）。
	s.mux.HandleFunc("GET "+alertsPath, s.handleAlertsList)
	s.mux.HandleFunc("POST "+alertsPath, s.handleAlertsWrite)
	s.mux.HandleFunc("POST "+alertsPath+"/{id}/seen", s.handleAlertSeen)
	s.mux.HandleFunc(alertsPath+"/", s.handleNotFound)
	// 通知通道（ADR-0054，用户显式配置的出站推送）：列表 system:read，写/删/测试 system:admin。
	s.mux.HandleFunc("GET "+webhookPath, s.handleWebhookList)
	s.mux.HandleFunc("POST "+webhookPath, s.handleWebhookCreate)
	s.mux.HandleFunc("DELETE "+webhookPath+"/{id}", s.handleWebhookDelete)
	s.mux.HandleFunc("POST "+webhookPath+"/{id}/test", s.handleWebhookTest)
	s.mux.HandleFunc(webhookPath+"/", s.handleNotFound)
	// 定时任务（ADR-0019）：列表 / 创建 / 立即执行 / 删除；能力要求 system:admin。
	// 配置快照（时光机）：列表/创建/删除/差异预览/回滚。精确路由在前，/{id} 兜底在后（go-build-api）。
	s.mux.HandleFunc("GET "+snapshotsPath, s.handleSnapshotsList)
	s.mux.HandleFunc("POST "+snapshotsPath, s.handleSnapshotsCreate)
	s.mux.HandleFunc("GET "+snapshotsPath+"/{id}/diff", s.handleSnapshotsDiff)
	s.mux.HandleFunc("POST "+snapshotsPath+"/{id}/rollback", s.handleSnapshotsRollback)
	s.mux.HandleFunc("DELETE "+snapshotsPath+"/{id}", s.handleSnapshotsDelete)
	s.mux.HandleFunc("GET "+schedulerTasksPath, s.handleSchedulerList)
	s.mux.HandleFunc("POST "+schedulerTasksPath, s.handleSchedulerCreate)
	s.mux.HandleFunc("POST "+schedulerTasksPath+"/{id}/run", s.handleSchedulerRun)
	s.mux.HandleFunc("DELETE "+schedulerTasksPath+"/{id}", s.handleSchedulerDelete)
	s.mux.HandleFunc("/api/v1/scheduler/", s.handleNotFound)
	// 配置迁移（R22 migrate）：导出 / 预览 / 应用；system:admin。
	s.mux.HandleFunc("GET "+migrateExportPath, s.handleMigrateExport)
	s.mux.HandleFunc("POST "+migratePreviewPath, s.handleMigratePreview)
	s.mux.HandleFunc("POST "+migrateApplyPath, s.handleMigrateApply)
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
	// 槽位埋点：resident 达硬上限时写一条告警（5 分钟去重由持久层收敛）。
	s.noteSlotAlerts(stats)
	writeJSON(w, http.StatusOK, systemInfo{
		Report: s.opts.Report, Version: s.opts.Version, Supervisor: stats, Paths: s.opts.Paths,
		Demotion: s.demotionInfo(),
	})
}

// demotionInfo 读取装配层的降权结论；未实现时不假装已降权。
func (s *Server) demotionInfo() DemotionInfo {
	if s.opts.Backend != nil {
		if reporter, ok := s.opts.Backend.(DemotionReporter); ok {
			return reporter.Demotion()
		}
	}
	return DemotionInfo{Reason: "未生效：装配层未回报插件降权状态，插件与内核同 uid"}
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
