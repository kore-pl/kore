package config

import (
	"log/slog"

	"gopkg.in/yaml.v3"
)

// decodeLog 解析 log.* 与 log.rotate.*。
func (p *parser) decodeLog(n *yaml.Node, out *Log) error {
	m, err := p.mapping(n, "log", logKeys)
	if err != nil {
		return err
	}
	if v := m["level"]; v != nil {
		if out.Level, err = p.str(v, "log.level"); err != nil {
			return err
		}
	}
	if v := m["rotate"]; v != nil {
		return p.decodeRotate(v, &out.Rotate)
	}
	return nil
}

// decodeRotate 解析 log.rotate.*。
func (p *parser) decodeRotate(n *yaml.Node, out *Rotate) error {
	m, err := p.mapping(n, "log.rotate", rotateKeys)
	if err != nil {
		return err
	}
	if v := m["max_size_mb"]; v != nil {
		if out.MaxSizeMB, err = p.integer(v, "log.rotate.max_size_mb"); err != nil {
			return err
		}
	}
	if v := m["max_backups"]; v != nil {
		if out.MaxBackups, err = p.integer(v, "log.rotate.max_backups"); err != nil {
			return err
		}
	}
	return nil
}

// decodeResources 解析 resources.* 与 resources.defaults.*。
func (p *parser) decodeResources(n *yaml.Node, out *Resources) error {
	m, err := p.mapping(n, "resources", resourcesKeys)
	if err != nil {
		return err
	}
	if v := m["defaults"]; v != nil {
		if err := p.decodeDefaults(v, &out.Defaults); err != nil {
			return err
		}
	}
	if v := m["enforce"]; v != nil {
		if out.Enforce, err = p.boolean(v, "resources.enforce"); err != nil {
			return err
		}
	}
	if v := m["resident_max"]; v != nil {
		if out.ResidentMax, err = p.integer(v, "resources.resident_max"); err != nil {
			return err
		}
	}
	return nil
}

// decodeDefaults 解析 resources.defaults.*。
func (p *parser) decodeDefaults(n *yaml.Node, out *Defaults) error {
	m, err := p.mapping(n, "resources.defaults", defaultsKeys)
	if err != nil {
		return err
	}
	if v := m["memory_mb"]; v != nil {
		if out.MemoryMB, err = p.integer(v, "resources.defaults.memory_mb"); err != nil {
			return err
		}
	}
	if v := m["cpu_quota"]; v != nil {
		if out.CPUQuota, err = p.str(v, "resources.defaults.cpu_quota"); err != nil {
			return err
		}
	}
	if v := m["pids_max"]; v != nil {
		if out.PidsMax, err = p.integer(v, "resources.defaults.pids_max"); err != nil {
			return err
		}
	}
	return nil
}

// decodePlugins 解析 plugins.*。
func (p *parser) decodePlugins(n *yaml.Node, out *Plugins) error {
	m, err := p.mapping(n, "plugins", pluginsKeys)
	if err != nil {
		return err
	}
	if v := m["allow_unsigned"]; v != nil {
		if out.AllowUnsigned, err = p.boolean(v, "plugins.allow_unsigned"); err != nil {
			return err
		}
	}
	if v := m["autostart"]; v != nil {
		if out.Autostart, err = p.strings(v, "plugins.autostart"); err != nil {
			return err
		}
	}
	return nil
}

// decodeStore 解析 store.*。
//
// store.allow_unsigned 是索引级签名的显式审计开关（M2，pre-mortem S-01）：
// 仅当配置文件显式写 true 才生效，默认零值 false；每次启用写 WARN 审计。
func (p *parser) decodeStore(n *yaml.Node, out *Store) error {
	m, err := p.mapping(n, "store", storeKeys)
	if err != nil {
		return err
	}
	if v := m["allow_unsigned"]; v != nil {
		if out.AllowUnsigned, err = p.boolean(v, "store.allow_unsigned"); err != nil {
			return err
		}
		if out.AllowUnsigned {
			slog.Warn("审计：索引签名校验被显式放行（信任空窗，仅允许显式审计配置）",
				"source", p.source, "key", "store.allow_unsigned")
		}
	}
	return nil
}

// decodeSecurity 解析 security.* 与 security.login_rate_limit.*。
func (p *parser) decodeSecurity(n *yaml.Node, out *Security) error {
	m, err := p.mapping(n, "security", securityKeys)
	if err != nil {
		return err
	}
	if v := m["login_rate_limit"]; v != nil {
		return p.decodeRateLimit(v, &out.LoginRateLimit)
	}
	return nil
}

// decodeRateLimit 解析 security.login_rate_limit.*。
func (p *parser) decodeRateLimit(n *yaml.Node, out *RateLimit) error {
	m, err := p.mapping(n, "security.login_rate_limit", rateKeys)
	if err != nil {
		return err
	}
	if v := m["attempts"]; v != nil {
		if out.Attempts, err = p.integer(v, "security.login_rate_limit.attempts"); err != nil {
			return err
		}
	}
	if v := m["window"]; v != nil {
		if out.Window, err = p.duration(v, "security.login_rate_limit.window"); err != nil {
			return err
		}
	}
	if v := m["lock"]; v != nil {
		if out.Lock, err = p.duration(v, "security.login_rate_limit.lock"); err != nil {
			return err
		}
	}
	return nil
}

// decodeAudit 解析 audit.*。
//
// audit.invoke_all 是调试开关（默认 false）：true 时 HTTP 层审计全部 invoke
// （含只读方法），false 时只审计需要 admin 能力的写/管理类方法，避免日志爆炸。
func (p *parser) decodeAudit(n *yaml.Node, out *Audit) error {
	m, err := p.mapping(n, "audit", auditKeys)
	if err != nil {
		return err
	}
	if v := m["invoke_all"]; v != nil {
		if out.InvokeAll, err = p.boolean(v, "audit.invoke_all"); err != nil {
			return err
		}
	}
	if v := m["retention"]; v != nil {
		if out.Retention, err = p.duration(v, "audit.retention"); err != nil {
			return err
		}
	}
	if v := m["clean_enabled"]; v != nil {
		if out.CleanEnabled, err = p.boolean(v, "audit.clean_enabled"); err != nil {
			return err
		}
	}
	if v := m["clean_interval"]; v != nil {
		if out.CleanInterval, err = p.duration(v, "audit.clean_interval"); err != nil {
			return err
		}
	}
	if v := m["clean_batch"]; v != nil {
		if out.CleanBatch, err = p.integer(v, "audit.clean_batch"); err != nil {
			return err
		}
	}
	return nil
}

// decodeCertRenew 解析 cert_renew.*。
func (p *parser) decodeCertRenew(n *yaml.Node, out *CertRenew) error {
	m, err := p.mapping(n, "cert_renew", certRenewKeys)
	if err != nil {
		return err
	}
	if v := m["enabled"]; v != nil {
		if out.Enabled, err = p.boolean(v, "cert_renew.enabled"); err != nil {
			return err
		}
	}
	if v := m["interval"]; v != nil {
		if out.Interval, err = p.duration(v, "cert_renew.interval"); err != nil {
			return err
		}
	}
	return nil
}
