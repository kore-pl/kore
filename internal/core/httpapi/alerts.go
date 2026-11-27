package httpapi

import (
	"fmt"
	"log/slog"
	"strconv"

	"github.com/pengtang1024/kore/internal/core/metrics"
)

// 告警中心（alerts bucket + /api/v1/alerts 端点）的 httpapi 侧：
//   - AlertSink 是持久层最小接口（cmd/kored 以 store 适配器注入，本包不 import store，G-01）；
//   - recordAlert 是内核各检查点的统一写入口（失败只 WARN，不打断请求路径）；
//   - 埋点（docs/DATA-MODEL.md §5 / docs/CORE.md §2.4）：
//     ① login.failed 连续 ≥3 次合并一条（登录成功清零计数，防暴力破解刷库）；
//     ② capability.denied / root.action 拒绝（统一走 auditDenied 出口）；
//     ③ 插件 state=failed / restarts>3（GET /plugins 观测时点写入）；
//     ④ 资源红线（RSS>16 MiB、goroutine>20，GET /system/metrics 采样时点写入）；
//     ⑤ 常驻槽位满（resident ≥ 3，GET /system/info 时点写入）。
//   - 全部埋点在请求路径上同步发生，不引入任何轮询/ticker/goroutine（G-19）；
//     重复场景由持久层 5 分钟同 title+source 去重合并收敛（store.PutAlert）。

// 告警严重级（与 store 同口径的受控词表；本包不 import store，故在此声明）。
const (
	alertSeverityCritical = "critical"
	alertSeverityWarning  = "warning"
	alertSeverityInfo     = "info"
)

// 告警来源（与 store 同口径的受控词表）。
const (
	alertSourceAudit    = "audit"
	alertSourcePlugin   = "plugin"
	alertSourceResource = "resource"
	alertSourceSlot     = "slot"
)

// 埋点阈值（G-03：RSS 红线 16 MiB / goroutine 红线 20 / 同时常驻硬上限 3；
// 登录连续失败与插件反复重启的触发线均为 3）。
const (
	alertRSSRedlineKiB    = 16 * 1024
	alertGoroutineMax     = 20
	alertResidentMax      = 3
	alertLoginStreakMin   = 3
	alertPluginRestartMin = 3
)

// AlertView 是一条告警的对外视图（显式字段，G-24）。ID 即存储键
// （`%020d-%06d`），Ts 由键纳秒段派生（RFC3339Nano，仅响应字段、不落库）。
type AlertView struct {
	ID       string `json:"id"`
	Ts       string `json:"ts"`
	Severity string `json:"severity"`
	Source   string `json:"source"`
	Title    string `json:"title"`
	Detail   string `json:"detail,omitempty"`
	Seen     bool   `json:"seen"`
	Count    int    `json:"count"`
}

// AlertQuery 是列表查询入参（显式字段）；Severity 空表示不限。
type AlertQuery struct {
	Severity string
	Limit    int
}

// AlertSink 是告警持久层的最小接口；未装配（nil）时端点回 501、埋点静默跳过，
// 保证零服务路径（测试/探活骨架）不受影响。
type AlertSink interface {
	// PutAlert 记录一条告警（去重合并/裁剪由实现方负责），返回落库后的记录。
	PutAlert(severity, source, title, detail string) (AlertView, error)
	// ListAlerts 按时间倒序返回记录；第二个返回值是全库未读总数（不受过滤影响）。
	ListAlerts(q AlertQuery) ([]AlertView, int, error)
	// MarkAlertSeen 标记一条已读；不存在返回含 E_NOTFOUND 的协议错误。
	MarkAlertSeen(id string) error
}

// recordAlert 是各检查点的统一写入口；写失败只记 WARN（告警是旁路，不阻断主流程）。
func (s *Server) recordAlert(severity, source, title, detail string) {
	if s.alerts == nil {
		return
	}
	// recordAlertView 已记 WARN，并按 ADR-0054 统一派发通知通道。
	_, _ = s.recordAlertView(severity, source, title, detail)
}

// recordAlertView 是 recordAlert 的带返回值版本：唯一落库入口仍是 AlertSink.PutAlert，
// 落库成功后统一走 dispatchAlert。供 POST /api/v1/alerts（如插件阈值告警桥接）复用，
// 保证显式写入也经过同一通知出口，不被绕过（ADR-0054 §2 判据 3）。
func (s *Server) recordAlertView(severity, source, title, detail string) (AlertView, error) {
	if s.alerts == nil {
		return AlertView{}, fmt.Errorf("告警中心后端未装配")
	}
	rec, err := s.alerts.PutAlert(severity, source, title, detail)
	if err != nil {
		slog.Warn("告警写入失败", "title", title, "err", err)
		return AlertView{}, err
	}
	// 通知通道（ADR-0054）：只在告警落库成功后派发，事件驱动、零常驻轮询；
	// 按「来源 + 级别」路由（通道可分别订阅），未配置/未启用任何通道时立即返回，
	// 出站恒 0（G-10/G-19）。
	s.webhooks.dispatchAlert(severity, source, title, detail)
	return rec, nil
}

// noteDeniedAlert 是 auditDenied 的告警埋点：capability.denied / root.action 拒绝
// 一律合并为「能力校验被拒绝」（5 分钟窗口内多条合并计数，明细取最新一次）。
func (s *Server) noteDeniedAlert(subject, plugin, target, reason string) {
	detail := "subject=" + alertDash(subject)
	if plugin != "" {
		detail += "；plugin=" + plugin
	}
	if target != "" {
		detail += "；target=" + target
	}
	detail += "；原因：" + reason
	s.recordAlert(alertSeverityCritical, alertSourceAudit, "能力校验被拒绝", detail)
}

// alertDash 空串显示为 "-"（detail 可读性；与日志口径一致）。
func alertDash(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

// notePluginAlerts 是 GET /plugins 的告警埋点：state=failed 记 critical、
// restarts>3 记 warning（与 web/alerts.js 本地聚合同标题，便于前端按 title 去重）。
func (s *Server) notePluginAlerts(plugins []PluginStatus) {
	for _, p := range plugins {
		name := p.Name
		if name == "" {
			name = p.ID
		}
		switch {
		case p.State == "failed":
			s.recordAlert(alertSeverityCritical, alertSourcePlugin,
				"插件 "+name+" 运行失败",
				"id="+p.ID+"；已重启 "+strconv.Itoa(p.Restarts)+" 次，可到「已装插件」停用或重装")
		case p.Restarts > alertPluginRestartMin:
			s.recordAlert(alertSeverityWarning, alertSourcePlugin,
				"插件 "+name+" 反复重启（"+strconv.Itoa(p.Restarts)+" 次）",
				"id="+p.ID+"；检查插件日志或升级到新版本")
		}
	}
}

// noteResourceAlerts 是 GET /system/metrics 的红线埋点：RSS 与 goroutine 触线记
// critical（红线是 G-03 硬约束，与前端「接近即 warning」的提示口径分开）。
func (s *Server) noteResourceAlerts(snap metrics.Snapshot) {
	if snap.RSSKiB > alertRSSRedlineKiB {
		s.recordAlert(alertSeverityCritical, alertSourceResource, "主壳内存超红线",
			fmt.Sprintf("当前 %.1f MiB，红线 16.0 MiB", float64(snap.RSSKiB)/1024))
	}
	if snap.Goroutines > alertGoroutineMax {
		s.recordAlert(alertSeverityCritical, alertSourceResource,
			"goroutine 数超红线（"+strconv.Itoa(snap.Goroutines)+"）",
			"红线 20；持续增长可能是泄漏")
	}
}

// noteSlotAlerts 是 GET /system/info 的槽位埋点：resident 达硬上限记 warning。
func (s *Server) noteSlotAlerts(stats SupervisorStats) {
	if stats.Resident >= alertResidentMax {
		s.recordAlert(alertSeverityWarning, alertSourceSlot,
			"常驻槽位已满（"+strconv.Itoa(stats.Resident)+" / "+strconv.Itoa(alertResidentMax)+"）",
			"同时常驻已达硬上限，启用新插件需先停用一个")
	}
}

// noteLoginFailure 是 recordLoginFailed 的告警埋点：「连续 ≥3 次合并一条」复用
// 审计突发合并思路——第 3 次触发一条告警后计数归零重新累计，窗口内的再次触发由
// 持久层 5 分钟去重合并为 count+1，不会刷库。计数纯内存，重启清零。
func (s *Server) noteLoginFailure() {
	s.loginStreakMu.Lock()
	defer s.loginStreakMu.Unlock()
	s.loginFailStreak++
	if s.loginFailStreak < alertLoginStreakMin {
		return
	}
	streak := s.loginFailStreak
	s.loginFailStreak = 0
	s.recordAlert(alertSeverityCritical, alertSourceAudit,
		"登录连续失败 3 次，疑似暴力破解",
		"连续失败 "+strconv.Itoa(streak)+" 次；明细见 GET /api/v1/audit?action=login.failed")
}

// resetLoginStreak 在登录成功时清零连续失败计数。
func (s *Server) resetLoginStreak() {
	s.loginStreakMu.Lock()
	s.loginFailStreak = 0
	s.loginStreakMu.Unlock()
}
