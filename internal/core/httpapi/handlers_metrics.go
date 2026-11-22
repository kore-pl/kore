package httpapi

import (
	"errors"
	"net/http"

	"github.com/pengtang1024/kore/internal/core/metrics"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// MetricsCollector 是一次系统资源快照的取数口，由装配层注入。
type MetricsCollector interface {
	// Collect 现场采集一次快照；首次调用 CPU 百分比为 0（仅建立基线）。
	Collect() (metrics.Snapshot, error)
}

// authorizeMetricsRead 是 GET /api/v1/system/metrics 的目标操作鉴权，口径与
// authorizeAuditRead 一致：先过通用目标操作校验（session 有效性），再要求
// system:read 能力；缺能力一律 401，不区分"缺"与"不足"（fail-closed）。
func (s *Server) authorizeMetricsRead(w http.ResponseWriter, r *http.Request) bool {
	if !s.authorizeTargetAction(w, r) {
		return false
	}
	if s.auth == nil {
		return true // M0 探活骨架未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if !hasCapability(granted, "system:read") {
		s.auditDenied(subject, "system", "读取资源采样需要 system:read 能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：资源采样需要 system:read 能力", "system:read")
		return false
	}
	return true
}

// handleSystemMetrics 处理 GET /api/v1/system/metrics：鉴权 → 现场采样 → 显式 DTO。
func (s *Server) handleSystemMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMetricsRead(w, r) {
		return
	}
	if s.metrics == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"资源采样后端未装配", "")
		return
	}
	snap, err := s.metrics.Collect()
	if err != nil {
		if errors.Is(err, metrics.ErrUnsupported) {
			writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
				"当前平台不支持资源采样（Tier B 降级）", err.Error())
			return
		}
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, metricsBody{
		CPUPercent: snap.CPUPercent, RSSKiB: snap.RSSKiB,
		DiskUsedKiB: snap.DiskUsedKiB, DiskTotalKiB: snap.DiskTotalKiB,
		Load1: snap.Load1, Goroutines: snap.Goroutines,
		FDs: snap.FDs, UptimeSec: snap.UptimeSec,
	})
}
