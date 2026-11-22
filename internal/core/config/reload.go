package config

import "log/slog"

// Reload 重新解析配置并只应用白名单字段，返回合并后的新快照。
//
// 解析或校验失败时返回错误且不修改旧快照，调用方必须继续使用旧快照。
// 白名单：log.*、resources.*、security.login_rate_limit.*、plugins.allow_unsigned、
// cert_renew.*、auth.session_ttl、auth.admin_password_hash；其余（含 paths.*、
// store.allow_unsigned 信任边界开关）需重启内核。
func (old *Snapshot) Reload(opts Options) (*Snapshot, []Warning, error) {
	next, warnings, err := load(opts)
	if err != nil {
		return nil, warnings, err
	}
	merged := *old
	applied, ignored := mergeHot(&merged, next)
	if old.Auth.AdminPasswordHash != next.Auth.AdminPasswordHash {
		warnings = append(warnings, Warning{
			Source:  next.Source,
			Key:     "auth.admin_password_hash",
			Message: "密码已更新，现有会话不吊销（如需强制下线请重启）",
		})
	}
	for _, key := range ignored {
		warnings = append(warnings, Warning{
			Source:  next.Source,
			Key:     key,
			Message: "不可热更，需重启内核；已保留旧值",
		})
	}
	logWarnings(opts.Logger, warnings)
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("config.reloaded", "applied", applied, "ignored", ignored)
	return &merged, warnings, nil
}

// mergeHot 把可热更字段写入 dst，并返回已应用与需重启的字段名。
func mergeHot(dst, src *Snapshot) (applied, ignored []string) {
	applied = append(applied, mergeLog(dst, src)...)
	applied = append(applied, mergeAuth(dst, src)...)
	applied = append(applied, mergeRateLimit(dst, src)...)
	applied = append(applied, mergeResources(dst, src)...)
	applied = append(applied, mergeMisc(dst, src)...)
	ignored = append(ignored, coldChanged(dst, src)...)
	return applied, ignored
}

// mergeLog 合并 log.* 可热更字段。
func mergeLog(dst, src *Snapshot) []string {
	var applied []string
	if dst.Log.Level != src.Log.Level {
		dst.Log.Level = src.Log.Level
		applied = append(applied, "log.level")
	}
	if dst.Log.Rotate.MaxSizeMB != src.Log.Rotate.MaxSizeMB {
		dst.Log.Rotate.MaxSizeMB = src.Log.Rotate.MaxSizeMB
		applied = append(applied, "log.rotate.max_size_mb")
	}
	if dst.Log.Rotate.MaxBackups != src.Log.Rotate.MaxBackups {
		dst.Log.Rotate.MaxBackups = src.Log.Rotate.MaxBackups
		applied = append(applied, "log.rotate.max_backups")
	}
	return applied
}

// mergeAuth 合并鉴权可热更字段；会话 TTL 与新密码只影响后续登录/续期。
func mergeAuth(dst, src *Snapshot) []string {
	var applied []string
	if dst.Auth.SessionTTL != src.Auth.SessionTTL {
		dst.Auth.SessionTTL = src.Auth.SessionTTL
		applied = append(applied, "auth.session_ttl")
	}
	if dst.Auth.AdminPasswordHash != src.Auth.AdminPasswordHash {
		dst.Auth.AdminPasswordHash = src.Auth.AdminPasswordHash
		applied = append(applied, "auth.admin_password_hash")
	}
	return applied
}

// mergeRateLimit 合并 security.login_rate_limit.* 可热更字段。
func mergeRateLimit(dst, src *Snapshot) []string {
	var applied []string
	current, next := dst.Security.LoginRateLimit, src.Security.LoginRateLimit
	if current.Attempts != next.Attempts {
		dst.Security.LoginRateLimit.Attempts = next.Attempts
		applied = append(applied, "security.login_rate_limit.attempts")
	}
	if current.Window != next.Window {
		dst.Security.LoginRateLimit.Window = next.Window
		applied = append(applied, "security.login_rate_limit.window")
	}
	if current.Lock != next.Lock {
		dst.Security.LoginRateLimit.Lock = next.Lock
		applied = append(applied, "security.login_rate_limit.lock")
	}
	return applied
}

// mergeResources 合并 resources.* 可热更字段。
func mergeResources(dst, src *Snapshot) []string {
	var applied []string
	current, next := dst.Resources.Defaults, src.Resources.Defaults
	if current.MemoryMB != next.MemoryMB {
		dst.Resources.Defaults.MemoryMB = next.MemoryMB
		applied = append(applied, "resources.defaults.memory_mb")
	}
	if current.CPUQuota != next.CPUQuota {
		dst.Resources.Defaults.CPUQuota = next.CPUQuota
		applied = append(applied, "resources.defaults.cpu_quota")
	}
	if current.PidsMax != next.PidsMax {
		dst.Resources.Defaults.PidsMax = next.PidsMax
		applied = append(applied, "resources.defaults.pids_max")
	}
	if dst.Resources.Enforce != src.Resources.Enforce {
		dst.Resources.Enforce = src.Resources.Enforce
		applied = append(applied, "resources.enforce")
	}
	return applied
}

// mergeMisc 合并其余可热更开关。
func mergeMisc(dst, src *Snapshot) []string {
	var applied []string
	if dst.Plugins.AllowUnsigned != src.Plugins.AllowUnsigned {
		dst.Plugins.AllowUnsigned = src.Plugins.AllowUnsigned
		applied = append(applied, "plugins.allow_unsigned")
	}
	if dst.CertRenew.Enabled != src.CertRenew.Enabled {
		dst.CertRenew.Enabled = src.CertRenew.Enabled
		applied = append(applied, "cert_renew.enabled")
	}
	if dst.CertRenew.Interval != src.CertRenew.Interval {
		dst.CertRenew.Interval = src.CertRenew.Interval
		applied = append(applied, "cert_renew.interval")
	}
	return applied
}

// coldChanged 列出需要重启才能生效的字段名（不修改 dst）。
func coldChanged(dst, src *Snapshot) []string {
	var keys []string
	if dst.Server.Addr != src.Server.Addr {
		keys = append(keys, "server.addr")
	}
	if dst.Server.Socket != src.Server.Socket {
		keys = append(keys, "server.socket")
	}
	if dst.Server.TLS != src.Server.TLS {
		keys = append(keys, "server.tls")
	}
	keys = append(keys, coldPathsChanged(dst, src)...)
	if dst.Store.AllowUnsigned != src.Store.AllowUnsigned {
		keys = append(keys, "store.allow_unsigned")
	}
	if dst.Auth.CookieSecure != src.Auth.CookieSecure {
		keys = append(keys, "auth.cookie_secure")
	}
	if dst.Auth.Initialized != src.Auth.Initialized {
		keys = append(keys, "auth.initialized")
	}
	if stringsDiffer(dst.Plugins.Autostart, src.Plugins.Autostart) {
		keys = append(keys, "plugins.autostart")
	}
	return keys
}

// coldPathsChanged 列出需要重启的路径字段。
func coldPathsChanged(dst, src *Snapshot) []string {
	var keys []string
	for key, pair := range map[string][2]string{
		"paths.state_dir":  {dst.Paths.StateDir, src.Paths.StateDir},
		"paths.log_dir":    {dst.Paths.LogDir, src.Paths.LogDir},
		"paths.run_dir":    {dst.Paths.RunDir, src.Paths.RunDir},
		"paths.plugin_dir": {dst.Paths.PluginDir, src.Paths.PluginDir},
		"paths.index_dir":  {dst.Paths.IndexDir, src.Paths.IndexDir},
	} {
		if pair[0] != pair[1] {
			keys = append(keys, key)
		}
	}
	return keys
}

// stringsDiffer 比较两个字符串切片内容是否不同。
func stringsDiffer(a, b []string) bool {
	if len(a) != len(b) {
		return true
	}
	for i := range a {
		if a[i] != b[i] {
			return true
		}
	}
	return false
}
