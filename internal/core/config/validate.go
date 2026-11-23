package config

import (
	"fmt"
	"strings"
	"time"
)

// validate 收集全部非法字段后一次返回；类型错误已在解析阶段提前返回。
func (p *parser) validate(s *Snapshot) error {
	var msgs []string
	add := func(key, msg string) {
		msgs = append(msgs, fmt.Sprintf("%s%s %s", p.where(key), key, msg))
	}
	validateServer(s, add)
	validateAuth(s, add)
	validatePaths(s, add)
	validateLog(s, add)
	validateResources(s, add)
	validatePlugins(s, add)
	validateSecurity(s, add)
	validateCertRenew(s, add)
	validateAudit(s, add)
	if len(msgs) == 0 {
		return nil
	}
	return fmt.Errorf("配置校验失败:\n%s", strings.Join(msgs, "\n"))
}

// where 返回字段定位前缀；未知行号时只给文件路径。
func (p *parser) where(key string) string {
	if line, ok := p.lines[key]; ok && line > 0 {
		return fmt.Sprintf("%s:%d: ", p.source, line)
	}
	return p.source + ": "
}

// validateServer 校验入口配置：非回环地址与 TLS 在 MVP 直接拒绝。
func validateServer(s *Snapshot, add func(string, string)) {
	if s.Server.Socket == "" {
		add("server.socket", "不能为空")
	}
	if s.Server.Addr != "" {
		if msg := addrError(s.Server.Addr); msg != "" {
			add("server.addr", msg)
		}
	}
	if s.Server.TLS {
		add("server.tls", "MVP 固定 off，请由反向代理终结 TLS")
	}
}

// validateAuth 校验鉴权配置与首启状态一致性。
func validateAuth(s *Snapshot, add func(string, string)) {
	if s.Auth.Initialized && s.Auth.AdminPasswordHash == "" {
		add("auth.initialized", "为 true 但 auth.admin_password_hash 为空（配置不一致，拒绝重新生成）")
	}
	if s.Auth.AdminPasswordHash != "" {
		if msg := hashError(s.Auth.AdminPasswordHash); msg != "" {
			add("auth.admin_password_hash", msg)
		}
	}
	if msg := durationRange(s.Auth.SessionTTL, time.Minute, 720*time.Hour); msg != "" {
		add("auth.session_ttl", msg)
	}
	secure := strings.ToLower(s.Auth.CookieSecure)
	switch secure {
	case "auto", "true", "false":
		s.Auth.CookieSecure = secure
	default:
		add("auth.cookie_secure", `必须是 auto / true / false，实际为 `+s.Auth.CookieSecure)
	}
}

// validatePaths 校验目录非空；plugin_dir 允许为空（由 state_dir 派生）。
func validatePaths(s *Snapshot, add func(string, string)) {
	for _, pair := range []struct{ key, value string }{
		{"paths.state_dir", s.Paths.StateDir},
		{"paths.log_dir", s.Paths.LogDir},
		{"paths.run_dir", s.Paths.RunDir},
		{"paths.index_dir", s.Paths.IndexDir},
	} {
		if pair.value == "" {
			add(pair.key, "不能为空")
		}
	}
}

// validateLog 校验日志级别与轮转阈值。
func validateLog(s *Snapshot, add func(string, string)) {
	level := strings.ToLower(s.Log.Level)
	switch level {
	case "debug", "info", "warn", "error":
		s.Log.Level = level
	default:
		add("log.level", "必须是 debug / info / warn / error，实际为 "+s.Log.Level)
	}
	if msg := intRange(s.Log.Rotate.MaxSizeMB, 1, 100); msg != "" {
		add("log.rotate.max_size_mb", msg)
	}
	if msg := intRange(s.Log.Rotate.MaxBackups, 1, 20); msg != "" {
		add("log.rotate.max_backups", msg)
	}
}

// residentMaxSlotsLimit 是 resources.resident_max 的取值上限，必须与
// supervisor 的 max_slots（defaultMaxSlots = 3）保持一致（G-03 / RESOURCE-MODEL §2.6）。
const residentMaxSlotsLimit = 3

// validateResources 校验插件缺省资源与槽位配额。
func validateResources(s *Snapshot, add func(string, string)) {
	if msg := intRange(s.Resources.Defaults.MemoryMB, 4, 12); msg != "" {
		add("resources.defaults.memory_mb", msg)
	}
	if msg := cpuQuotaError(s.Resources.Defaults.CPUQuota); msg != "" {
		add("resources.defaults.cpu_quota", msg)
	}
	if msg := intRange(s.Resources.Defaults.PidsMax, 16, 512); msg != "" {
		add("resources.defaults.pids_max", msg)
	}
	if msg := intRange(s.Resources.ResidentMax, 1, residentMaxSlotsLimit); msg != "" {
		add("resources.resident_max", msg+"（3 表示放弃槽位保护）")
	}
}

// validatePlugins 校验自启列表元素非空。
func validatePlugins(s *Snapshot, add func(string, string)) {
	for i, id := range s.Plugins.Autostart {
		if strings.TrimSpace(id) == "" {
			add("plugins.autostart", fmt.Sprintf("第 %d 个元素不能为空", i+1))
		}
	}
}

// validateSecurity 校验登录限速三项。
func validateSecurity(s *Snapshot, add func(string, string)) {
	r := s.Security.LoginRateLimit
	if msg := intRange(r.Attempts, 1, 20); msg != "" {
		add("security.login_rate_limit.attempts", msg)
	}
	if msg := durationRange(r.Window, 10*time.Second, time.Hour); msg != "" {
		add("security.login_rate_limit.window", msg)
	}
	if msg := durationRange(r.Lock, 30*time.Second, 24*time.Hour); msg != "" {
		add("security.login_rate_limit.lock", msg)
	}
}

// validateCertRenew 校验唯一常驻定时器的周期。
func validateCertRenew(s *Snapshot, add func(string, string)) {
	if msg := durationRange(s.CertRenew.Interval, time.Hour, 24*time.Hour); msg != "" {
		add("cert_renew.interval", msg)
	}
}

// validateAudit 校验审计保留策略：保留期 1 天–1 年、清理周期 30s–7 天、
// 单次上限 1–10000 条（与 scheduler.maxAuditCleanBatch 同口径）。
func validateAudit(s *Snapshot, add func(string, string)) {
	if msg := durationRange(s.Audit.Retention, 24*time.Hour, 365*24*time.Hour); msg != "" {
		add("audit.retention", msg)
	}
	if msg := durationRange(s.Audit.CleanInterval, 30*time.Second, 7*24*time.Hour); msg != "" {
		add("audit.clean_interval", msg)
	}
	if s.Audit.CleanBatch < 1 || s.Audit.CleanBatch > 10000 {
		add("audit.clean_batch", "必须在 1–10000 之间")
	}
}
