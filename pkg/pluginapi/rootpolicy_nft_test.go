package pluginapi_test

import (
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// nftShapeDeclarations 是 ADR-0022 验收用的 nft 声明 argv 夹具：
// 「建表 / 建集合（v4/v6）/ 建 base chain / 两种模式 / 清链 / 封禁解封 / 只读列表」。
//
// 名字取 `nft*`、表名固定 `kore_` 前缀——这是**协议形状**夹具，不是业务词表
// （G-01：内核不认识「这是 WAF」）。真正的消费方插件清单是否与这些形状一致，
// 由插件仓自己的 schema 自检 + SDK 版本门禁保证；本测试只锁内核形状表本身，
// 防止「改了形状表却没意识到某个既有声明会失效」。
var nftShapeDeclarations = [][]string{
	{"nft", "add table inet kore_waf"},
	{"nft", "add set inet kore_waf banned4 { type ipv4_addr ; flags interval,timeout ; }"},
	{"nft", "add set inet kore_waf banned6 { type ipv6_addr ; flags interval,timeout ; }"},
	{"nft", "add chain inet kore_waf input { type filter hook input priority -10 ; policy accept ; }"},
	{"nft", "flush chain inet kore_waf input"},
	{"nft", "flush chain inet kore_waf input", ";",
		"add rule inet kore_waf input ip saddr @banned4 counter drop", ";",
		"add rule inet kore_waf input ip6 saddr @banned6 counter drop", ";",
		"add rule inet kore_waf input tcp flags syn tcp dport { 80, 443 } " +
			"meter kore_syn4 { ip saddr limit rate over 60/second burst 120 packets } counter drop", ";",
		"add rule inet kore_waf input tcp dport { 80, 443 } ct count over 200 counter drop"},
	{"nft", "flush chain inet kore_waf input", ";",
		"add rule inet kore_waf input ip saddr @banned4 counter log prefix kore-waf-ban4 level warn", ";",
		"add rule inet kore_waf input ip6 saddr @banned6 counter log prefix kore-waf-ban6 level warn", ";",
		"add rule inet kore_waf input tcp flags syn tcp dport { 80, 443 } " +
			"meter kore_syn4 { ip saddr limit rate over 60/second burst 120 packets } " +
			"counter log prefix kore-waf-scan level warn", ";",
		"add rule inet kore_waf input tcp dport { 80, 443 } ct count over 200 " +
			"counter log prefix kore-waf-conn level warn"},
	{"nft", "add element inet kore_waf banned4"},
	{"nft", "add element inet kore_waf banned6"},
	{"nft", "delete element inet kore_waf banned4"},
	{"nft", "delete element inet kore_waf banned6"},
	{"nft", "-j", "list table inet kore_waf"},
}

// nftShapeAppends 是各声明允许的追加参数样本（按 argv 末段区分）。
var nftShapeAppends = map[string][][]string{
	"banned4": {{"{", "203.0.113.7", "}"}, {"{", "203.0.113.0/24", "timeout", "3600s", "}"}},
	"banned6": {{"{", "2001:db8::7", "}"}, {"{", "2001:db8::/48", "timeout", "600s", "}"}},
}

// TestNftShapeDeclarations 锁定 nft 的受控形状能覆盖真实数据面所需的声明 argv。
func TestNftShapeDeclarations(t *testing.T) {
	for _, argv := range nftShapeDeclarations {
		if err := pluginapi.ValidateRootArgv(argv); err != nil {
			t.Errorf("声明 argv 被拒绝（形状表与预期漂移）：%v\n  argv=%v", err, argv)
			continue
		}
		last := argv[len(argv)-1]
		appends, hasAppends := nftShapeAppends[last]
		if !hasAppends {
			// 其余动作必须拒绝任何追加参数：批处理/只读语句不能被追加改写成第二个动作。
			if err := pluginapi.ValidateRootAppendedArgv(argv, []string{"drop"}); err == nil {
				t.Errorf("该动作不应接受追加参数：%v", argv)
			}
			continue
		}
		for _, appended := range appends {
			if err := pluginapi.ValidateRootAppendedArgv(argv, appended); err != nil {
				t.Errorf("追加参数被拒绝：%v + %v：%v", argv, appended, err)
			}
		}
	}
}

// TestNftShapeRejectsSemanticEscapes 形状表必须挡住的语义越界（不看字符集，看语义）。
func TestNftShapeRejectsSemanticEscapes(t *testing.T) {
	cases := []struct {
		name     string
		argv     []string
		appended []string
	}{
		// 批处理里第二条语句是 flush ruleset（清空宿主全部规则）。
		{"flush ruleset", []string{"nft", "list ruleset", ";", "flush ruleset"}, nil},
		// 表名不在 kore_ 命名空间。
		{"宿主 filter 表", []string{"nft", "add rule ip filter INPUT counter drop"}, nil},
		// 用 -f 让 nft 读脚本文件（等价于任意命令）。
		{"nft -f", []string{"nft", "-f /etc/nftables.conf"}, nil},
		// 规则表达式里塞分号切出第二条语句。
		{"表达式内分号", []string{"nft", "add rule inet kore_waf input counter drop ; flush ruleset"}, nil},
		// 元素位置放非 IP。
		{"非 IP 元素", []string{"nft", "add element inet kore_waf banned4"},
			[]string{"{", "example.com", "}"}},
		// 只读列表动作被追加写参数（把只读变成写）。
		{"只读追加写参数", []string{"nft", "-j", "list table inet kore_waf"}, []string{"counter", "drop"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := pluginapi.ValidateRootAppendedArgv(tc.argv, tc.appended); err == nil {
				t.Fatalf("语义越界未被拒绝：argv=%v appended=%v", tc.argv, tc.appended)
			}
		})
	}
}
