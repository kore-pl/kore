package pluginapi

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

// mustValidate 断言 argv 通过受控形状校验。
func mustValidate(t *testing.T, argv ...string) {
	t.Helper()
	if err := ValidateRootArgv(argv); err != nil {
		t.Fatalf("应当通过：%v\n  argv=%v", err, argv)
	}
}

// mustReject 断言 argv 被拒绝，且错误信息包含 wantHint（便于确认拒绝原因没跑偏）。
func mustReject(t *testing.T, wantHint string, argv ...string) {
	t.Helper()
	err := ValidateRootArgv(argv)
	if err == nil {
		t.Fatalf("应当拒绝（期望提示含 %q）：%v", wantHint, argv)
	}
	if wantHint != "" && !strings.Contains(err.Error(), wantHint) {
		t.Fatalf("拒绝原因不含 %q：%v\n  argv=%v", wantHint, err, argv)
	}
}

// TestRootArgvLegalShapes 覆盖每个命令的合法形状（含绝对路径形式）。
func TestRootArgvLegalShapes(t *testing.T) {
	cases := [][]string{
		{"nginx", "-s", "reload"},
		{"nginx", "-t"},
		{"nginx", "-V"},
		{"/usr/sbin/nginx", "-s", "reload"},
		{"ufw", "status"},
		{"ufw", "status", "verbose"},
		{"ufw", "show", "added"},
		{"ufw", "reload"},
		{"iptables", "-S"},
		{"iptables", "-t", "nat", "-S"},
		{"iptables", "-L", "INPUT", "-n", "-v"},
		{"systemctl", "is-active", "nginx.service"},
		{"systemctl", "status", "sshd", "--no-pager"},
		{"crontab", "-l"},
		{"crontab", "-l", "-u", "root"},
		{"chmod", "640", "/etc/kore/waf.conf"},
		{"chown", "kore-waf:root", "/var/lib/kore/plugins/waf"},
		{"docker", "ps"},
		{"docker", "inspect", "kore-site-1"},
		{"docker", "stats", "--no-stream", "kore-site-1"},
		{"nft", "add", "table", "inet", "kore_waf"},
		{"nft", "add", "set", "inet", "kore_waf", "banned4", "{", "type", "ipv4_addr", ";",
			"flags", "interval,timeout", ";", "}"},
		{"nft", "add", "chain", "inet", "kore_waf", "input", "{", "type", "filter", "hook",
			"input", "priority", "-10", ";", "policy", "accept", ";", "}"},
		{"nft", "flush", "chain", "inet", "kore_waf", "input"},
		{"nft", "list", "table", "inet", "kore_waf"},
		{"nft", "-j", "list", "table", "inet", "kore_waf"},
		// 批处理：多条语句用独立 ";" 元素分隔。
		{"nft", "add", "table", "inet", "kore_waf", ";", "add", "set", "inet", "kore_waf",
			"banned4", "{", "type", "ipv4_addr", ";", "flags", "interval", ";", "}"},
		// add rule：表达式 token（集合引用、计数器、verdict）。
		{"nft", "add", "rule", "inet", "kore_waf", "input", "ip", "saddr", "@banned4",
			"counter", "drop"},
		{"nft", "add", "rule", "inet", "kore_waf", "input", "tcp", "dport", "{", "80,", "443",
			"}", "ct", "count", "over", "200", "counter", "drop"},
		{"resolvectl", "status"},
		{"resolvectl", "query", "example.com"},
		{"resolvectl", "query", "example.com", "AAAA"},
		{"resolvectl", "flush-caches"},
		{"unbound-control", "stats_noreset"},
		{"unbound-control", "flush_zone", "example.com"},
		{"dig", "example.com"},
		{"dig", "example.com", "MX"},
		{"dig", "@9.9.9.9", "example.com", "TXT"},
		{"dig", "example.com", "A", "+short"},
		{"fail2ban-client", "status", "sshd"},
		{"/usr/bin/fail2ban-client", "set", "sshd", "banip"},
	}
	for _, argv := range cases {
		t.Run(strings.Join(argv, "_"), func(t *testing.T) {
			mustValidate(t, argv...)
		})
	}
}

// TestRootArgvRejectsUnknownOrUnshaped 非法子命令 / 无形状命令 / 越权路径。
func TestRootArgvRejectsUnknownOrUnshaped(t *testing.T) {
	cases := []struct {
		hint string
		argv []string
	}{
		{"不在受控命令白名单", []string{"rm", "-rf", "/"}},
		{"不在受控命令白名单", []string{"sh", "-c", "id"}},
		{"不在受控命令白名单", []string{"sed", "-i", "s/a/b/", "/etc/passwd"}},
		// 绝对路径不能绕过：目录必须是系统二进制目录。
		{"所在目录不在系统二进制目录内", []string{"/tmp/payload/nft", "list", "ruleset"}},
		{"所在目录不在系统二进制目录内", []string{"/var/lib/kore/plugins/waf/nft", "list", "ruleset"}},
		{"不是规范化的绝对路径", []string{"/usr/bin/../bin/nft", "list", "ruleset"}},
		// 子命令必须被锁定。
		{"不在受控形状内", []string{"ufw", "enable", "--force"}},
		{"不在受控形状内", []string{"nginx", "-s", "stop"}},
		{"不在受控形状内", []string{"systemctl", "restart", "sshd"}},
		{"不在受控形状内", []string{"iptables", "-A", "INPUT", "-j", "DROP"}},
		{"不在受控形状内", []string{"crontab", "-r"}},
		{"不在受控形状内", []string{"docker", "run", "--privileged", "alpine"}},
		// ipset 按裁决不进表：整条命令都不可达（不是"子命令未锁定"，是"没有这个命令"）。
		{"不在受控命令白名单", []string{"ipset", "create", "kore_banned4", "hash:ip", "family", "inet"}},
		{"不在受控命令白名单", []string{"ipset", "list", "kore_banned4"}},
		{"不在受控形状内", []string{"resolvectl", "set-dns", "eth0", "1.1.1.1"}},
		{"不在受控形状内", []string{"unbound-control", "set_option", "verbosity:1"}},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.argv, "_"), func(t *testing.T) {
			mustReject(t, tc.hint, tc.argv...)
		})
	}
}

// TestRootArgvInjectionSurface 注入面逐类拒绝。
//
// 通道 argv 不经 shell，所以真正要防的是「程序语义注入」：
// 用 `;` 拼出第二条 nft 语句、用 `-f` 让程序读脚本、用引号/空白/换行拆 token、
// 用 `$(` 触发程序侧展开、用超长 token 撑爆解析。
func TestRootArgvInjectionSurface(t *testing.T) {
	cases := []struct {
		name string
		argv []string
	}{
		// 分号拼接：把追加参数变成第二语句（`flush ruleset` 会清空宿主防火墙）。
		{"分号拼接 nft 语句", []string{"nft", "list", "table", "inet", "kore_waf;", "flush", "ruleset"}},
		{"分号声明第二条语句但形状不合法", []string{"nft", "list", "ruleset", ";", "flush", "ruleset"}},
		{"ufw 目标里塞分号", []string{"ufw", "allow", "22/tcp; ufw disable"}},
		// 管道 / 与号（对非 shell 程序无意义，但会污染参数语义）。
		{"管道符", []string{"nft", "list", "table", "inet", "kore_waf|flush"}},
		{"与号", []string{"ufw", "allow", "22&reboot"}},
		// 命令替换 / 变量展开。
		{"命令替换", []string{"nft", "add", "table", "inet", "$(reboot)"}},
		{"反引号", []string{"nft", "add", "table", "inet", "`reboot`"}},
		// 空白与换行：token 内出现空白说明调用方在拼字符串。
		{"token 内空格", []string{"nft", "add", "table", "inet", "kore_waf drop"}},
		{"token 内换行", []string{"nft", "add", "table", "inet", "kore_waf\nflush", "ruleset"}},
		{"token 内制表", []string{"ufw", "allow", "22\t/tcp"}},
		// 引号：nft 会自己处理引号，等于让调用方控制 token 边界。
		{"双引号", []string{"nft", "add", "rule", "inet", "kore_waf", "input", "log", "prefix",
			`"kore waf "`}},
		{"单引号", []string{"ufw", "allow", "'22/tcp'"}},
		// 程序自己的「读文件/执行」开关。
		{"nft -f 读脚本", []string{"nft", "-f", "/etc/passwd"}},
		{"dig -f 读文件", []string{"dig", "-f", "/etc/passwd"}},
		{"nginx -c 覆盖配置", []string{"nginx", "-c", "/tmp/evil.conf"}},
		// 表名越界：只能操作 kore_ 前缀的表。
		{"非 kore 表名", []string{"nft", "add", "table", "inet", "filter"}},
		{"表名带通配", []string{"nft", "delete", "table", "inet", "kore_*"}},
		// 集合元素只能是 IP/CIDR。
		{"集合元素非 IP", []string{"nft", "add", "element", "inet", "kore_waf", "banned4",
			"{", "localhost", "}"}},
		// chmod 带 setuid 位 = 把文件变成 root 后门。
		{"chmod setuid", []string{"chmod", "4755", "/var/lib/kore/plugins/waf/bin/waf"}},
		{"chmod 系统路径", []string{"chmod", "777", "/etc/passwd"}},
		{"chown 系统路径", []string{"chown", "root:root", "/usr/bin/sudo"}},
		// 空 / 超长 / 元素过多。
		{"空 argv", []string{}},
		{"空参数", []string{"nft", ""}},
		{"超长 token", []string{"nft", "add", "table", "inet", "kore_" + strings.Repeat("a", 200)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateRootArgv(tc.argv); err == nil {
				t.Fatalf("注入面未被拒绝：%v", tc.argv)
			}
		})
	}
}

// TestRootArgvAppendedShapes 追加参数（运行时不可信）逐位形状校验。
func TestRootArgvAppendedShapes(t *testing.T) {
	ok := []struct {
		declared []string
		appended []string
	}{
		{[]string{"ufw", "allow"}, []string{"18080/udp"}},
		{[]string{"ufw", "allow"}, []string{"22", "443"}},
		{[]string{"ufw", "deny"}, []string{"18081/udp"}},
		{[]string{"ufw", "delete"}, []string{"22/tcp"}},
		{[]string{"/usr/bin/fail2ban-client", "set", "sshd", "banip"}, []string{"203.0.113.7"}},
		{[]string{"nft", "add", "element", "inet", "kore_waf", "banned4"}, []string{"{", "203.0.113.7", "}"}},
		{[]string{"nft", "add", "element", "inet", "kore_waf", "banned4"},
			[]string{"{", "203.0.113.7", "timeout", "1h", "}"}},
		{[]string{"nft", "add", "element", "inet", "kore_waf", "banned6"}, []string{"{", "2001:db8::7", "}"}},
		{[]string{"nft", "delete", "element", "inet", "kore_waf", "banned4"}, []string{"{", "203.0.113.0/24", "}"}},
	}
	for _, tc := range ok {
		t.Run(strings.Join(append(append([]string{}, tc.declared...), tc.appended...), "_"), func(t *testing.T) {
			if err := ValidateRootAppendedArgv(tc.declared, tc.appended); err != nil {
				t.Fatalf("应当通过：%v", err)
			}
		})
	}

	bad := []struct {
		name     string
		declared []string
		appended []string
	}{
		{"分号注入", []string{"ufw", "allow"}, []string{"22; ufw disable"}},
		{"命令替换", []string{"ufw", "allow"}, []string{"$(reboot)"}},
		{"反引号", []string{"ufw", "allow"}, []string{"`reboot`"}},
		{"管道", []string{"ufw", "allow"}, []string{"22|reboot"}},
		{"换行", []string{"ufw", "allow"}, []string{"22\ndisable"}},
		{"空参数", []string{"ufw", "allow"}, []string{""}},
		{"超长参数", []string{"ufw", "allow"}, []string{strings.Repeat("9", 300)}},
		{"端口越界", []string{"ufw", "allow"}, []string{"70000/tcp"}},
		{"集合元素非 IP", []string{"nft", "add", "element", "inet", "kore_waf", "banned4"},
			[]string{"{", "not-an-ip", "}"}},
		{"集合大括号被替换", []string{"nft", "add", "element", "inet", "kore_waf", "banned4"},
			[]string{"203.0.113.7"}},
		{"追加到只读语句", []string{"nft", "list", "table", "inet", "kore_waf"},
			[]string{"counter", "drop"}},
		{"追加到批处理非末语句", []string{"nft", "add", "table", "inet", "kore_waf", ";",
			"list", "ruleset"}, []string{"drop"}},
		{"fail2ban 非 IP", []string{"fail2ban-client", "set", "sshd", "banip"}, []string{"all"}},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateRootAppendedArgv(tc.declared, tc.appended); err == nil {
				t.Fatalf("应当拒绝：declared=%v appended=%v", tc.declared, tc.appended)
			}
		})
	}
}

// TestRootCommandPoliciesWellFormed 锁定策略表自身的结构不变量。
//
// 这些不变量比"逐条枚举 argv"更能防回归：新增命令时若忘了写形状、写了空语句、
// 或声明了重复形状，测试立即失败。
func TestRootCommandPoliciesWellFormed(t *testing.T) {
	for name, policy := range RootCommandPolicies {
		if name == "" {
			t.Fatal("策略表的命令名不能为空")
		}
		if !commandNamePattern.MatchString(name) {
			t.Errorf("命令名 %q 必须是裸命令名（不含路径/空白）", name)
		}
		if len(policy.Patterns) == 0 {
			t.Errorf("%s 没有声明任何形状（等于放行任意参数）", name)
		}
		seen := make(map[string]struct{}, len(policy.Patterns))
		for index, pattern := range policy.Patterns {
			if len(pattern.Tokens) == 0 {
				t.Errorf("%s 的形状[%d]为空（空语句无意义）", name, index)
			}
			key := fmt.Sprintf("%v|%v", pattern.Tokens, pattern.Tail)
			if _, ok := seen[key]; ok {
				t.Errorf("%s 的形状[%d]重复：%v", name, index, pattern.Tokens)
			}
			seen[key] = struct{}{}
			for _, spec := range pattern.Tokens {
				if spec.Literal == "" && spec.Shape.Pattern == nil {
					t.Errorf("%s 的形状[%d] 有既无 Literal 又无 Shape 的约束", name, index)
				}
			}
			for _, shape := range pattern.Tail {
				if shape.Pattern == nil {
					t.Errorf("%s 的形状[%d] 追加参数形状 %q 缺正则", name, index, shape.Name)
				}
			}
			if pattern.TailRepeat && len(pattern.Tail) == 0 {
				t.Errorf("%s 的形状[%d] TailRepeat 但没有 Tail", name, index)
			}
		}
	}
}

// TestRootCommandAllowlistDerived 白名单集合必须与策略表一一对应（不许有"只有名字
// 没有形状"的历史遗留项）。
func TestRootCommandAllowlistDerived(t *testing.T) {
	if len(RootCommandAllowlist) != len(RootCommandPolicies) {
		t.Fatalf("白名单 %d 项 ≠ 策略 %d 项", len(RootCommandAllowlist), len(RootCommandPolicies))
	}
	for name := range RootCommandAllowlist {
		if _, ok := RootCommandPolicies[name]; !ok {
			t.Errorf("白名单命令 %q 没有对应策略", name)
		}
	}
}

// commandNamePattern 是裸命令名语法（与 resolveCommandName 的判定一致）。
var commandNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]*$`)
