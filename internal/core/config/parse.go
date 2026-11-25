package config

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

// 各层级的合法键名；未知键按"WARN + 建议最近键名"处理，不因拼写打死服务。
var (
	topKeys       = []string{"profile", "server", "auth", "paths", "log", "resources", "plugins", "store", "security", "audit", "cert_renew"}
	serverKeys    = []string{"addr", "socket", "tls"}
	authKeys      = []string{"admin_password_hash", "must_change_password", "session_ttl", "cookie_secure", "initialized"}
	pathsKeys     = []string{"state_dir", "log_dir", "run_dir", "plugin_dir", "index_dir"}
	storeKeys     = []string{"allow_unsigned"}
	logKeys       = []string{"level", "rotate"}
	rotateKeys    = []string{"max_size_mb", "max_backups"}
	resourcesKeys = []string{"defaults", "enforce", "resident_max"}
	defaultsKeys  = []string{"memory_mb", "cpu_quota", "pids_max"}
	pluginsKeys   = []string{"allow_unsigned", "autostart"}
	securityKeys  = []string{"login_rate_limit"}
	auditKeys     = []string{"invoke_all", "retention", "clean_enabled", "clean_interval", "clean_batch"}
	rateKeys      = []string{"attempts", "window", "lock"}
	certRenewKeys = []string{"enabled", "interval"}
)

// parser 在解析过程中积累字段行号与不阻断的告警。
type parser struct {
	source   string
	lines    map[string]int
	warnings []Warning
}

// parse 用 yaml.Node 逐节点解析，保留行号并区分"告警"与"致命错误"。
func parse(source string, data []byte) (*Snapshot, []Warning, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, nil, fmt.Errorf("%s: YAML 语法错误: %w", source, err)
	}
	p := &parser{source: source, lines: make(map[string]int)}
	snap := Default()
	initialProfile := snap.Profile
	if err := p.decode(&root, snap); err != nil {
		return nil, p.warnings, err
	}
	p.warnings = append(p.warnings, reconcileProfile(snap, p.lines, initialProfile)...)
	snap.Source = source
	if err := p.validate(snap); err != nil {
		return nil, p.warnings, err
	}
	return snap, p.warnings, nil
}

// decode 遍历顶层键；空文件等价于全部使用默认值。
func (p *parser) decode(root *yaml.Node, snap *Snapshot) error {
	if root.Kind == 0 || len(root.Content) == 0 {
		return nil
	}
	node := root
	if node.Kind == yaml.DocumentNode {
		if len(node.Content) == 0 {
			return nil
		}
		node = node.Content[0]
	}
	top, err := p.mapping(node, "", topKeys)
	if err != nil {
		return err
	}
	steps := []struct {
		key string
		fn  func(*yaml.Node) error
	}{
		{"profile", func(n *yaml.Node) error { return p.decodeProfile(n, snap) }},
		{"server", func(n *yaml.Node) error { return p.decodeServer(n, &snap.Server) }},
		{"auth", func(n *yaml.Node) error { return p.decodeAuth(n, &snap.Auth) }},
		{"paths", func(n *yaml.Node) error { return p.decodePaths(n, &snap.Paths) }},
		{"log", func(n *yaml.Node) error { return p.decodeLog(n, &snap.Log) }},
		{"resources", func(n *yaml.Node) error { return p.decodeResources(n, &snap.Resources) }},
		{"plugins", func(n *yaml.Node) error { return p.decodePlugins(n, &snap.Plugins) }},
		{"store", func(n *yaml.Node) error { return p.decodeStore(n, &snap.Store) }},
		{"security", func(n *yaml.Node) error { return p.decodeSecurity(n, &snap.Security) }},
		{"audit", func(n *yaml.Node) error { return p.decodeAudit(n, &snap.Audit) }},
		{"cert_renew", func(n *yaml.Node) error { return p.decodeCertRenew(n, &snap.CertRenew) }},
	}
	for _, step := range steps {
		if n := top[step.key]; n != nil {
			if err := step.fn(n); err != nil {
				return err
			}
		}
	}
	return nil
}

// decodeServer 解析 server.*。
func (p *parser) decodeServer(n *yaml.Node, out *Server) error {
	m, err := p.mapping(n, "server", serverKeys)
	if err != nil {
		return err
	}
	if v := m["addr"]; v != nil {
		if out.Addr, err = p.str(v, "server.addr"); err != nil {
			return err
		}
	}
	if v := m["socket"]; v != nil {
		if out.Socket, err = p.str(v, "server.socket"); err != nil {
			return err
		}
	}
	if v := m["tls"]; v != nil {
		if out.TLS, err = p.boolean(v, "server.tls"); err != nil {
			return err
		}
	}
	return nil
}

// decodeAuth 解析 auth.*。
func (p *parser) decodeAuth(n *yaml.Node, out *Auth) error {
	m, err := p.mapping(n, "auth", authKeys)
	if err != nil {
		return err
	}
	if v := m["admin_password_hash"]; v != nil {
		if out.AdminPasswordHash, err = p.str(v, "auth.admin_password_hash"); err != nil {
			return err
		}
	}
	if v := m["session_ttl"]; v != nil {
		if out.SessionTTL, err = p.duration(v, "auth.session_ttl"); err != nil {
			return err
		}
	}
	if v := m["cookie_secure"]; v != nil {
		if out.CookieSecure, err = p.str(v, "auth.cookie_secure"); err != nil {
			return err
		}
	}
	if v := m["initialized"]; v != nil {
		if out.Initialized, err = p.boolean(v, "auth.initialized"); err != nil {
			return err
		}
	}
	if v := m["must_change_password"]; v != nil {
		if out.MustChangePassword, err = p.boolean(v, "auth.must_change_password"); err != nil {
			return err
		}
	}
	return nil
}

// decodeProfile 解析顶层 profile：portable / fhs（ADR-0023）。
func (p *parser) decodeProfile(n *yaml.Node, out *Snapshot) error {
	raw, err := p.str(n, "profile")
	if err != nil {
		return err
	}
	profile := normalizeProfile(raw)
	if profile == "" {
		return fmt.Errorf("%s: profile 只接受 %q 或 %q，实际 %q", p.source, ProfilePortable, ProfileFHS, raw)
	}
	out.Profile = profile
	return nil
}

// decodePaths 解析 paths.*。
func (p *parser) decodePaths(n *yaml.Node, out *Paths) error {
	m, err := p.mapping(n, "paths", pathsKeys)
	if err != nil {
		return err
	}
	pairs := []struct {
		key string
		dst *string
	}{
		{"state_dir", &out.StateDir},
		{"log_dir", &out.LogDir},
		{"run_dir", &out.RunDir},
		{"plugin_dir", &out.PluginDir},
		{"index_dir", &out.IndexDir},
	}
	for _, pair := range pairs {
		if v := m[pair.key]; v != nil {
			if *pair.dst, err = p.str(v, "paths."+pair.key); err != nil {
				return err
			}
		}
	}
	return nil
}
