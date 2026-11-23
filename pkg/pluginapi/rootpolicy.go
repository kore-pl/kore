package pluginapi

import (
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 本文件是 root_actions 的**受控命令策略**（ADR-0022）：把「命令名白名单」升级为
// 「命令 + 子命令 + 参数形状」三级约束。
//
// 为什么必须锁形状：root-action 通道以 uid=0 执行 argv，argv 不经 shell，所以注入
// 面不是 shell 元字符而是**程序自己的语义**——`nft add rule … drop` 能锁死宿主、
// `sed -i <表达式> <文件>` 能写任意文件、`-f <脚本>` 能让程序读任意脚本。只校验
// argv[0] 的「命令名白名单」等于把通道变成通用提权口子。策略因此分两层：
//
//  1. **声明 argv**（来自插件 info.json，启用时由用户确认）必须匹配某个
//     CommandPattern.Tokens：逐位 Literal 或 ArgShape；
//  2. **追加参数**（运行时由插件进程给出，视为不可信）必须逐位匹配该 pattern 的
//     Tail 形状，长度也要对上；Tail 为空表示该动作**禁止任何追加参数**。
//
// 分隔符：声明 argv 里独立的 `;` 元素把语句切成多段（nft 一条命令可含多条语句），
// 每段都要匹配某个语句 pattern，**只有最后一段**可携带追加参数。这样
// `nft flush chain … ; add rule … drop` 这类批处理不会被追加参数改写。
//
// G-01 边界：本表只描述「程序参数形状」（inet/ip 族、kore_ 前缀表名、IP/CIDR、
// 端口、单元名…），不出现任何业务语义（「这是 waf 的封禁集合」这类知识留在插件）。

// maxNftStatements 是单条 nft 动作允许的语句数上限（一次 systemd-run 内的批处理）。
const maxNftStatements = 8

// sysBinaryDirs 是 argv[0] 用绝对路径时允许的目录（顺序无意义）。
//
// 绝对路径不是为了绕过形状校验，而是解决「同一命令在 /sbin 与 /usr/bin」的发行版
// 差异。**必须限定目录**：否则插件可以把可执行文件放进自己的 state 目录（或 /tmp）
// 并声明 `/tmp/evil/nft`，形状校验全部通过、实际执行的是攻击者的二进制。
var sysBinaryDirs = map[string]struct{}{
	"/bin":            {},
	"/sbin":           {},
	"/usr/bin":        {},
	"/usr/sbin":       {},
	"/usr/local/bin":  {},
	"/usr/local/sbin": {},
}

// ArgShape 是一个 argv 元素允许的**形状**：正则 + 可选的结构化复核。
//
// 正则可以拦住字符集（`;` / 引号 / 换行 …），但拦不住语义（`99999` 是合法端口写法
// 吗），所以复杂形状再挂一个 Check 做数值/地址族复核。
type ArgShape struct {
	// Name 是形状的语义名，出现在错误提示与 ADR/文档里。
	Name string
	// Pattern 是 **`^…$` 锚定**的正则。
	Pattern *regexp.Regexp
	// Check 可空；非空时在正则命中后再做一次结构化校验。
	Check func(value string) bool
}

// Match 报告 value 是否满足形状。
func (s ArgShape) Match(value string) bool {
	if s.Pattern == nil || !s.Pattern.MatchString(value) {
		return false
	}
	if s.Check != nil {
		return s.Check(value)
	}
	return true
}

// TokenSpec 是声明 argv 某一位置的约束：Literal 与 Shape 二选一（Literal 优先）。
type TokenSpec struct {
	// Literal 非空时要求逐字相等。
	Literal string
	// Shape 非零值时要求匹配该形状。
	Shape ArgShape
}

// lit 构造「逐字相等」约束。
func lit(value string) TokenSpec { return TokenSpec{Literal: value} }

// shp 构造「匹配形状」约束。
func shp(shape ArgShape) TokenSpec { return TokenSpec{Shape: shape} }

// matches 报告 token 是否满足本约束。
func (s TokenSpec) matches(token string) bool {
	if s.Literal != "" {
		return token == s.Literal
	}
	return s.Shape.Match(token)
}

// describe 返回人类可读的约束描述（错误提示用）。
func (s TokenSpec) describe() string {
	if s.Literal != "" {
		return s.Literal
	}
	return "<" + s.Shape.Name + ">"
}

// CommandPattern 是一条**受控语句形状**。
//
// Tokens 描述声明 argv 的逐位约束（不含 argv[0]）；Tail 描述追加参数的逐位形状。
type CommandPattern struct {
	// Tokens 是声明部分的逐位约束（不含 argv[0]）。
	Tokens []TokenSpec
	// Tail 是追加参数的逐位形状；空表示禁止追加。
	Tail []ArgShape
	// TailRepeat 为 true 时 Tail 的最后一项可重复（0..N）；否则追加个数必须等于 len(Tail)。
	TailRepeat bool
	// Note 是这条形状的用途说明（错误提示与文档引用）。
	Note string
}

// CommandPolicy 是一个命令的全部受控形状。
type CommandPolicy struct {
	// Patterns 是允许的语句形状（任选其一，逐条匹配）。
	Patterns []CommandPattern
	// MaxStatements 是单条动作允许的语句数（以独立 `;` 元素分隔）；0 表示 1。
	MaxStatements int
	// FlattenArgs 为 true 时按空白把 argv 元素再切成 token 后校验。
	//
	// 只对**自己把 argv 拼成一行再解析**的程序开启：nft 就是把 argv 以空格连接后
	// 统一词法分析的（`nft "flush chain inet t c" ";" "add rule …"` 与逐 token 传入
	// 等价），所以它的安全单位是 token 序列而不是 argv 边界。不开启的程序（ufw 等）
	// 逐个 argv 校验，避免出现「内核按空格切开、程序按 argv 边界看」的口径分裂。
	FlattenArgs bool
}

// RootCommandPolicies 是 argv[0] 命令名 → 受控形状的**唯一实现**。
//
// 增删命令或放宽形状属安全边界调整：必须同步 docs/PLUGIN-PROTOCOL §3.1.3 并新增 ADR。
var RootCommandPolicies = map[string]CommandPolicy{
	// nginx：只读自检 + reload（不提供 stop/quit：停服等于 Denial of Service）。
	"nginx": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("-s"), lit("reload")}, Note: "重载配置"},
		{Tokens: []TokenSpec{lit("-t")}, Note: "配置语法检查"},
		{Tokens: []TokenSpec{lit("-T")}, Note: "打印配置并检查语法"},
		{Tokens: []TokenSpec{lit("-v")}, Note: "版本"},
		{Tokens: []TokenSpec{lit("-V")}, Note: "版本与编译参数"},
	}},

	// ufw：状态/规则查看只读；allow/deny/delete 的目标只能是端口、端口/协议或应用配置名。
	"ufw": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("status")}, Note: "状态概要"},
		{Tokens: []TokenSpec{lit("status"), lit("verbose")}, Note: "状态明细"},
		{Tokens: []TokenSpec{lit("status"), lit("numbered")}, Note: "带编号规则"},
		{Tokens: []TokenSpec{lit("show"), lit("added")}, Note: "本工具添加的规则"},
		{Tokens: []TokenSpec{lit("show"), lit("raw")}, Note: "底层规则"},
		{Tokens: []TokenSpec{lit("--version")}, Note: "版本"},
		{Tokens: []TokenSpec{lit("reload")}, Note: "重载规则"},
		{Tokens: []TokenSpec{lit("allow")}, Tail: []ArgShape{shapeUFWTarget}, TailRepeat: true, Note: "放行目标"},
		{Tokens: []TokenSpec{lit("deny")}, Tail: []ArgShape{shapeUFWTarget}, TailRepeat: true, Note: "拒绝目标"},
		{Tokens: []TokenSpec{lit("delete")}, Tail: []ArgShape{shapeUFWTarget}, TailRepeat: true, Note: "删除目标规则"},
	}},

	// iptables：**只读**。写规则（-A/-I/-D/-F）不外露：那等于任意改宿主防火墙。
	"iptables": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("-S")}, Note: "列出规则"},
		{Tokens: []TokenSpec{lit("-S"), shp(shapeChainName)}, Note: "列出链规则"},
		{Tokens: []TokenSpec{lit("-L")}, Note: "列出链"},
		{Tokens: []TokenSpec{lit("-L"), shp(shapeChainName)}, Note: "列出指定链"},
		{Tokens: []TokenSpec{lit("-L"), lit("-n")}, Note: "列出链（数字）"},
		{Tokens: []TokenSpec{lit("-L"), lit("-n"), lit("-v")}, Note: "列出链（数字+计数）"},
		{Tokens: []TokenSpec{lit("-L"), shp(shapeChainName), lit("-n")}, Note: "列出指定链（数字）"},
		{Tokens: []TokenSpec{lit("-L"), shp(shapeChainName), lit("-n"), lit("-v")}, Note: "列出指定链（数字+计数）"},
		{Tokens: []TokenSpec{lit("-t"), shp(shapeIPTables), lit("-S")}, Note: "列出表规则"},
		{Tokens: []TokenSpec{lit("-t"), shp(shapeIPTables), lit("-S"), shp(shapeChainName)}, Note: "列出表内链规则"},
		{Tokens: []TokenSpec{lit("-t"), shp(shapeIPTables), lit("-L"), lit("-n"), lit("-v")}, Note: "列出表链（数字+计数）"},
	}},

	// systemctl：**只读**。restart/stop 不外露（任意单元重启 = DoS）。
	"systemctl": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("is-active"), shp(shapeUnitName)}, Note: "单元是否活跃"},
		{Tokens: []TokenSpec{lit("is-enabled"), shp(shapeUnitName)}, Note: "单元是否自启"},
		{Tokens: []TokenSpec{lit("status"), shp(shapeUnitName)}, Note: "单元状态"},
		{Tokens: []TokenSpec{lit("status"), shp(shapeUnitName), lit("--no-pager")}, Note: "单元状态（不分页）"},
		{Tokens: []TokenSpec{lit("show"), shp(shapeUnitName)}, Note: "单元属性"},
		{Tokens: []TokenSpec{lit("cat"), shp(shapeUnitName)}, Note: "单元定义"},
		{Tokens: []TokenSpec{lit("list-units")}, Note: "单元列表"},
		{Tokens: []TokenSpec{lit("list-unit-files")}, Note: "单元文件列表"},
		{Tokens: []TokenSpec{lit("--version")}, Note: "版本"},
	}},

	// crontab：只读列表。写入（`crontab -` / 文件参数）不外露：那等于任意定时执行。
	"crontab": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("-l")}, Note: "当前用户任务"},
		{Tokens: []TokenSpec{lit("-l"), lit("-u"), shp(shapeUserName)}, Note: "指定用户任务"},
		{Tokens: []TokenSpec{lit("-u"), shp(shapeUserName), lit("-l")}, Note: "指定用户任务"},
	}},

	// chmod：只允许三位八进制（无 setuid/setgid/sticky 位）且路径限定在 kore 自有目录。
	"chmod": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{shp(shapeOctalMode), shp(shapeKorePath)}, Note: "调整 kore 自有文件权限"},
	}},

	// chown：属主/属组限定语法，路径限定在 kore 自有目录。
	"chown": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{shp(shapeUserGroup), shp(shapeKorePath)}, Note: "调整 kore 自有文件属主"},
	}},

	// docker：**只读**。run/exec 不外露（等价 root shell）；start/stop/restart 待有真实
	// 消费者时按受控形状补齐并更新 ADR。
	"docker": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("ps")}, Note: "容器列表"},
		{Tokens: []TokenSpec{lit("ps"), lit("-a")}, Note: "容器列表（含停止）"},
		{Tokens: []TokenSpec{lit("inspect"), shp(shapeContainerRef)}, Note: "容器详情"},
		{Tokens: []TokenSpec{lit("logs"), shp(shapeContainerRef)}, Note: "容器日志"},
		{Tokens: []TokenSpec{lit("stats"), lit("--no-stream"), shp(shapeContainerRef)}, Note: "容器资源"},
		{Tokens: []TokenSpec{lit("images")}, Note: "镜像列表"},
		{Tokens: []TokenSpec{lit("version")}, Note: "版本"},
		{Tokens: []TokenSpec{lit("info")}, Note: "运行信息"},
	}},

	// nft：kore 自有 netfilter 表（表名必须 `kore_` 前缀），语句级白名单。
	// 一条动作可含多条语句（独立 `;` 元素分隔，≤8 句），只有最后一句可带追加参数。
	"nft": {MaxStatements: maxNftStatements, FlattenArgs: true, Patterns: nftPatterns()},

	// resolvectl：只读查询 + 缓存刷新；不改 resolv.conf / 不改每链路 DNS。
	"resolvectl": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("status")}, Note: "解析器状态"},
		{Tokens: []TokenSpec{lit("status"), shp(shapeIfaceName)}, Note: "指定链路状态"},
		{Tokens: []TokenSpec{lit("statistics")}, Note: "缓存统计"},
		{Tokens: []TokenSpec{lit("query"), shp(shapeDNSName)}, Note: "域名解析"},
		{Tokens: []TokenSpec{lit("query"), shp(shapeDNSName), shp(shapeDNSType)}, Note: "指定类型解析"},
		{Tokens: []TokenSpec{lit("resolve"), shp(shapeDNSName)}, Note: "解析（含链路信息）"},
		{Tokens: []TokenSpec{lit("flush-caches")}, Note: "刷新缓存"},
		{Tokens: []TokenSpec{lit("dns"), shp(shapeIfaceName)}, Note: "链路 DNS"},
		{Tokens: []TokenSpec{lit("domain"), shp(shapeIfaceName)}, Note: "链路域"},
	}},

	// unbound-control：只读统计 + 区域/缓存刷新；不改配置（set_option 不外露）。
	"unbound-control": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("status")}, Note: "状态"},
		{Tokens: []TokenSpec{lit("stats")}, Note: "统计（清零）"},
		{Tokens: []TokenSpec{lit("stats_noreset")}, Note: "统计（不清零）"},
		{Tokens: []TokenSpec{lit("list_forwards")}, Note: "转发区"},
		{Tokens: []TokenSpec{lit("list_local_zones")}, Note: "本地区"},
		{Tokens: []TokenSpec{lit("get_option"), shp(shapeUnboundOption)}, Note: "读取选项"},
		{Tokens: []TokenSpec{lit("flush_zone"), shp(shapeDNSName)}, Note: "刷新区域缓存"},
		{Tokens: []TokenSpec{lit("flush_bogus")}, Note: "刷新 bogus 缓存"},
		{Tokens: []TokenSpec{lit("flush_negative")}, Note: "刷新否定缓存"},
	}},

	// dig：只读 DNS 查询。查询名/类型/@服务器/+选项都锁形状（拒绝 `-f`、`-k` 等读文件开关）。
	"dig": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{shp(shapeDNSName)}},
		{Tokens: []TokenSpec{shp(shapeDNSName), shp(shapeDNSType)}},
		{Tokens: []TokenSpec{shp(shapeDNSName), shp(shapeDigOption)}},
		{Tokens: []TokenSpec{shp(shapeDNSName), shp(shapeDNSType), shp(shapeDigOption)}},
		{Tokens: []TokenSpec{shp(shapeDigServer), shp(shapeDNSName)}},
		{Tokens: []TokenSpec{shp(shapeDigServer), shp(shapeDNSName), shp(shapeDNSType)}},
		{Tokens: []TokenSpec{shp(shapeDigServer), shp(shapeDNSName), shp(shapeDNSType), shp(shapeDigOption)}},
	}},

	// fail2ban-client：现有 ssh-guard 0.2.x 的三条动作。只允许对**已配置 jail** 做
	// status/banip/unbanip；不允许 reload/unban --all 这类全局操作。
	"fail2ban-client": {Patterns: []CommandPattern{
		{Tokens: []TokenSpec{lit("status")}, Note: "总状态"},
		{Tokens: []TokenSpec{lit("status"), shp(shapeJailName)}, Note: "jail 状态"},
		{Tokens: []TokenSpec{lit("set"), shp(shapeJailName), lit("banip")}, Tail: []ArgShape{shapeIPOrCIDR},
			Note: "封禁 IP"},
		{Tokens: []TokenSpec{lit("set"), shp(shapeJailName), lit("unbanip")}, Tail: []ArgShape{shapeIPOrCIDR},
			Note: "解封 IP"},
	}},
}

// nftPatterns 返回 nft 的语句形状表。
//
// 设计取舍：语句头（add/delete/flush/list + 族 + kore_ 表 + 链/集合名）全部锁死，
// 表达式部分用「单 token 字符集」约束——禁 `;`、引号、反引号、`$`、换行，因此不能
// 用追加参数拼接出第二条语句；允许 `|` `&` `(` `)` `{` `}` `,` 是因为 nft 表达式
// 合法需要它们，且 argv 不经 shell，这些字符没有 shell 语义。
func nftPatterns() []CommandPattern {
	fam := shp(shapeNftFamily)
	table := shp(shapeKoreNftTable)
	chain := shp(shapeNftName)
	expr := shp(shapeNftExpr)

	patterns := []CommandPattern{
		{Tokens: []TokenSpec{lit("add"), lit("table"), fam, table}, Note: "建 kore 表"},
		{Tokens: []TokenSpec{lit("delete"), lit("table"), fam, table}, Note: "删 kore 表"},
		{Tokens: []TokenSpec{lit("add"), lit("set"), fam, table, chain, lit("{"), lit("type"), shp(shapeNftSetType),
			lit(";"), lit("flags"), shp(shapeNftSetFlags), lit(";"), lit("}")}, Note: "建集合"},
		{Tokens: []TokenSpec{lit("add"), lit("chain"), fam, table, chain, lit("{"), lit("type"), lit("filter"),
			lit("hook"), shp(shapeNftHook), lit("priority"), shp(shapeNftPriority), lit(";"),
			lit("policy"), shp(shapeNftPolicy), lit(";"), lit("}")}, Note: "建 base chain"},
		{Tokens: []TokenSpec{lit("flush"), lit("chain"), fam, table, chain}, Note: "清空链"},
		{Tokens: []TokenSpec{lit("add"), lit("element"), fam, table, chain},
			Tail: []ArgShape{{Name: "nft-set-open", Pattern: regexp.MustCompile(`^\{$`)},
				shapeIPOrCIDR,
				{Name: "nft-set-close", Pattern: regexp.MustCompile(`^\}$`)}},
			Note: "加集合元素"},
		{Tokens: []TokenSpec{lit("add"), lit("element"), fam, table, chain},
			Tail: []ArgShape{{Name: "nft-set-open", Pattern: regexp.MustCompile(`^\{$`)},
				shapeIPOrCIDR,
				{Name: "nft-timeout-kw", Pattern: regexp.MustCompile(`^timeout$`)},
				shapeNftTimeout,
				{Name: "nft-set-close", Pattern: regexp.MustCompile(`^\}$`)}},
			Note: "加带超时的集合元素"},
		{Tokens: []TokenSpec{lit("delete"), lit("element"), fam, table, chain},
			Tail: []ArgShape{{Name: "nft-set-open", Pattern: regexp.MustCompile(`^\{$`)},
				shapeIPOrCIDR,
				{Name: "nft-set-close", Pattern: regexp.MustCompile(`^\}$`)}},
			Note: "删集合元素"},
		{Tokens: []TokenSpec{lit("list"), lit("table"), fam, table}, Note: "列出 kore 表"},
		{Tokens: []TokenSpec{lit("-j"), lit("list"), lit("table"), fam, table}, Note: "列出 kore 表（JSON）"},
		{Tokens: []TokenSpec{lit("-a"), lit("-j"), lit("list"), lit("table"), fam, table}, Note: "列出 kore 表（句柄+JSON）"},
		{Tokens: []TokenSpec{lit("list"), lit("set"), fam, table, chain}, Note: "列出集合"},
		{Tokens: []TokenSpec{lit("-j"), lit("list"), lit("set"), fam, table, chain}, Note: "列出集合（JSON）"},
		{Tokens: []TokenSpec{lit("list"), lit("ruleset")}, Note: "列出全部规则"},
		{Tokens: []TokenSpec{lit("list"), lit("tables")}, Note: "列出全部表"},
	}

	// add rule：语句头后接 1..28 个表达式 token。表达式 token 形状统一，
	// 因此这里按「表达式 token 数」枚举，保证追加参数无法延长成另一条语句。
	for count := 1; count <= 28; count++ {
		tokens := []TokenSpec{lit("add"), lit("rule"), fam, table, chain}
		for index := 0; index < count; index++ {
			tokens = append(tokens, expr)
		}
		patterns = append(patterns, CommandPattern{Tokens: tokens, Note: "加链规则"})
	}
	return patterns
}

// shapeChainName 是 iptables 链名（含内建链与用户链）。
var shapeChainName = ArgShape{Name: "chain-name",
	Pattern: regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)}

// shapeIPTables 是 iptables 表名。
var shapeIPTables = ArgShape{Name: "iptables-table",
	Pattern: regexp.MustCompile(`^(?:filter|nat|mangle|raw|security)$`)}

// shapeUnitName 是 systemd 单元名（拒绝 glob 与路径分隔符）。
var shapeUnitName = ArgShape{Name: "unit-name",
	Pattern: regexp.MustCompile(`^[A-Za-z0-9@][A-Za-z0-9@._:\\-]{0,127}$`)}

// shapeUserName 是 passwd 用户名（crontab -u 用）。
var shapeUserName = ArgShape{Name: "user-name",
	Pattern: regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)}

// shapeUserGroup 是 chown 的属主[:属组]。
var shapeUserGroup = ArgShape{Name: "user[:group]",
	Pattern: regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}(?::[a-z_][a-z0-9_-]{0,31})?$`)}

// shapeOctalMode 是三位八进制权限位。
//
// **刻意只允许三位**：四位八进制（如 4755）会带 setuid/setgid/sticky 位，
// 那正是「把插件自己的二进制变成 root 后门」的最短路径。
var shapeOctalMode = ArgShape{Name: "octal-mode",
	Pattern: regexp.MustCompile(`^[0-7]{3}$`)}

// shapeKorePath 是 kore 自有运行路径（/etc/kore、/var/lib/kore、/var/log/kore、/run/kore）。
var shapeKorePath = ArgShape{Name: "kore-path",
	Pattern: regexp.MustCompile(`^/(?:etc|var/lib|var/log|run)/kore(?:/[A-Za-z0-9._@+-]+)+$`)}

// shapeContainerRef 是 docker 容器引用（名称或 12/64 位 id）。
var shapeContainerRef = ArgShape{Name: "container-ref",
	Pattern: regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`)}

// shapeUFWTarget 是 ufw 的目标：端口、端口/协议、端口列表或应用配置名。
var shapeUFWTarget = ArgShape{Name: "ufw-target",
	Pattern: regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9._+-]{0,63}|[1-9][0-9]{0,4}(?:,[1-9][0-9]{0,4})*(?:/(?:tcp|udp))?)$`),
	Check: func(value string) bool {
		head := value
		if index := strings.IndexByte(value, '/'); index >= 0 {
			head = value[:index]
		}
		for _, part := range strings.Split(head, ",") {
			if part == "" || part[0] < '0' || part[0] > '9' {
				return true // 应用配置名，不按端口校验
			}
			port, err := strconv.Atoi(part)
			if err != nil || port < 1 || port > 65535 {
				return false
			}
		}
		return true
	},
}

// shapeNftFamily 是 nft 地址族。
var shapeNftFamily = ArgShape{Name: "nft-family",
	Pattern: regexp.MustCompile(`^(?:inet|ip|ip6|arp|bridge)$`)}

// shapeKoreNftTable 是 kore 自有 nft 表名：**必须 kore_ 前缀**，防插件操作别的表。
var shapeKoreNftTable = ArgShape{Name: "kore-nft-table",
	Pattern: regexp.MustCompile(`^kore_[a-z0-9_]{1,24}$`)}

// shapeNftName 是表内的集合/链名。
var shapeNftName = ArgShape{Name: "nft-name",
	Pattern: regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)}

// shapeNftSetType 是集合元素类型。
var shapeNftSetType = ArgShape{Name: "nft-set-type",
	Pattern: regexp.MustCompile(`^(?:ipv4_addr|ipv6_addr|inet_service|ether_addr)$`)}

// shapeNftSetFlags 是集合 flags（interval/timeout 的逗号组合）。
var shapeNftSetFlags = ArgShape{Name: "nft-set-flags",
	Pattern: regexp.MustCompile(`^(?:interval|timeout)(?:,(?:interval|timeout))?$`)}

// shapeNftHook 是 base chain 的 hook 点。
var shapeNftHook = ArgShape{Name: "nft-hook",
	Pattern: regexp.MustCompile(`^(?:prerouting|input|forward|output|postrouting)$`)}

// shapeNftPriority 是链优先级（数值或标准优先级名）。
var shapeNftPriority = ArgShape{Name: "nft-priority",
	Pattern: regexp.MustCompile(`^(?:-?[0-9]{1,4}|raw|mangle|dstnat|filter|security|srcnat|conntrack|first|last)$`)}

// shapeNftPolicy 是链策略。
var shapeNftPolicy = ArgShape{Name: "nft-policy",
	Pattern: regexp.MustCompile(`^(?:accept|drop)$`)}

// shapeNftExpr 是 nft 表达式的单个 token。
//
// 允许：字母数字、`_.:@/[]{}()!<>=&|+,*~-`；禁止：空白、`;`、引号、反引号、`$`、
// 换行（这些是「把追加参数拼成第二语句」的唯一通道）。首字符不得是 `-`，否则会被
// nft 当成自己的选项（如 `-f` 读脚本文件）。
var shapeNftExpr = ArgShape{Name: "nft-expr-token",
	Pattern: regexp.MustCompile(`^[A-Za-z0-9_.:@/\[\]{}()!<>=&|+,*~][A-Za-z0-9_.:@/\[\]{}()!<>=&|+,*~-]{0,63}$`)}

// shapeNftTimeout 是 nft 集合元素超时（1s..999999d）。
var shapeNftTimeout = ArgShape{Name: "nft-timeout",
	Pattern: regexp.MustCompile(`^[1-9][0-9]{0,5}(?:s|m|h|d)$`)}

// shapeIfaceName 是网络接口名。
var shapeIfaceName = ArgShape{Name: "iface-name",
	Pattern: regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,15}$`)}

// shapeDNSName 是 DNS 域名 / FQDN（端点允许尾点，标签允许下划线）。
var shapeDNSName = ArgShape{Name: "dns-name",
	Pattern: regexp.MustCompile(`^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,251}[A-Za-z0-9_])?\.?$`),
	Check: func(value string) bool {
		return !strings.Contains(value, "..")
	},
}

// shapeDNSType 是 DNS 记录类型。
var shapeDNSType = ArgShape{Name: "dns-type",
	Pattern: regexp.MustCompile(`^(?:A|AAAA|CAA|CNAME|DNSKEY|DS|HTTPS|MX|NAPTR|NS|PTR|SOA|SRV|SSHFP|SVCB|TLSA|TXT|ANY)$`)}

// shapeDigServer 是 dig 的 `@server` 参数（IP 或主机名）。
var shapeDigServer = ArgShape{Name: "@server",
	Pattern: regexp.MustCompile(`^@(?:[0-9A-Fa-f:.]{2,45}|[A-Za-z0-9_][A-Za-z0-9_.-]{0,251})$`),
	Check: func(value string) bool {
		host := strings.TrimPrefix(value, "@")
		if strings.Contains(host, ":") || net.ParseIP(host) != nil {
			return true
		}
		return !strings.Contains(host, "..")
	},
}

// shapeDigOption 是 dig 的 `+option` 白名单（不提供 `+trace` 之外的写/读文件开关）。
var shapeDigOption = ArgShape{Name: "dig-option",
	Pattern: regexp.MustCompile(`^\+(?:short|noall|answer|authority|additional|tcp|notcp|dnssec|norecurse|recurse|besteffort|time=[1-9][0-9]?|tries=[1-9][0-9]?)$`)}

// shapeUnboundOption 是 unbound-control get_option 的配置键。
var shapeUnboundOption = ArgShape{Name: "unbound-option",
	Pattern: regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,63}$`)}

// shapeJailName 是 fail2ban jail 名。
var shapeJailName = ArgShape{Name: "fail2ban-jail",
	Pattern: regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)}

// shapeIPOrCIDR 是 IPv4/IPv6 地址或 CIDR（集合元素与封禁参数用）。
var shapeIPOrCIDR = ArgShape{Name: "ipv4-or-ipv6[/cidr]",
	Pattern: regexp.MustCompile(`^[0-9A-Fa-f:.]{2,45}(?:/(?:12[0-8]|[1-9]?[0-9]|3[0-2])?)?$`),
	Check: func(value string) bool {
		address, bits, hasBits := strings.Cut(value, "/")
		ip := net.ParseIP(address)
		if ip == nil {
			return false
		}
		if !hasBits {
			return true
		}
		prefix, err := strconv.Atoi(bits)
		if err != nil {
			return false
		}
		width := 32
		if ip.To4() == nil {
			width = 128
		}
		return prefix >= 0 && prefix <= width
	},
}

// ValidateRootArgv 校验一条 root 动作的**声明 argv** 是否落在受控形状内。
//
// 追加参数（运行时由插件进程给出）请用 ValidateRootAppendedArgv 单独校验。
func ValidateRootArgv(declared []string) error {
	return validateRootArgv(declared, nil)
}

// ValidateRootAppendedArgv 校验「声明 argv + 运行时追加参数」的合成结果。
//
// 这是提权通道的**执行期**校验点：声明 argv 来自 info.json（用户确认过），追加参数
// 来自插件进程（可能已被攻破），因此追加部分只能落在该动作命中形状的 Tail 上。
func ValidateRootAppendedArgv(declared, appended []string) error {
	return validateRootArgv(declared, appended)
}

// validateRootArgv 是声明/追加两层的唯一实现。
func validateRootArgv(declared, appended []string) error {
	if len(declared) == 0 {
		return fmt.Errorf("argv 不能为空")
	}
	name, err := resolveCommandName(declared[0])
	if err != nil {
		return err
	}
	policy, ok := RootCommandPolicies[name]
	if !ok {
		return fmt.Errorf("argv[0]=%q 不在受控命令白名单内（允许：%s）", declared[0], allowedCommandNames())
	}
	declaredTokens := declared[1:]
	appendedTokens := appended
	if policy.FlattenArgs {
		declaredTokens = flattenTokens(declaredTokens)
		appendedTokens = flattenTokens(appended)
	}
	segments := splitStatements(declaredTokens)
	maxStatements := policy.MaxStatements
	if maxStatements <= 0 {
		maxStatements = 1
	}
	if len(segments) == 0 {
		segments = [][]string{{}}
	}
	if len(segments) > maxStatements {
		return fmt.Errorf("%s 单条动作最多 %d 条语句（当前 %d，以独立 \";\" 元素分隔）",
			name, maxStatements, len(segments))
	}
	var tailErr error
	for index, segment := range segments {
		candidates := matchStatements(policy.Patterns, segment)
		if len(candidates) == 0 {
			return fmt.Errorf("%s 的语句 %q 不在受控形状内（允许：%s）", name,
				strings.Join(segment, " "), describePatterns(policy.Patterns))
		}
		isLast := index == len(segments)-1
		if !isLast {
			if len(appendedTokens) > 0 {
				return fmt.Errorf("%s：追加参数只能附在**最后一条语句**之后（当前语句 %q）", name,
					strings.Join(segment, " "))
			}
			continue
		}
		// 同一段 token 可能命中多个形状（如「加元素」与「加带超时元素」），
		// 以**追加参数也匹配**的那个为准；全不匹配时返回最接近的错误。
		matched := false
		for _, pattern := range candidates {
			if err := checkTail(name, pattern, appendedTokens); err != nil {
				if tailErr == nil {
					tailErr = err
				}
				continue
			}
			matched = true
			break
		}
		if !matched {
			if tailErr == nil {
				tailErr = fmt.Errorf("%s 的该形状不接受追加参数（收到 %q）", name, appended)
			}
			return tailErr
		}
	}
	return nil
}

// checkTail 校验追加参数是否匹配命中的 pattern 的 Tail。
func checkTail(name string, pattern CommandPattern, appended []string) error {
	if len(appended) == 0 {
		return nil
	}
	if len(pattern.Tail) == 0 {
		return fmt.Errorf("%s 的该形状不接受追加参数（收到 %q）", name, appended)
	}
	if !pattern.TailRepeat && len(appended) != len(pattern.Tail) {
		return fmt.Errorf("%s 的该形状要求 %d 个追加参数（收到 %d 个：%q）",
			name, len(pattern.Tail), len(appended), appended)
	}
	for index, value := range appended {
		shape := pattern.Tail[len(pattern.Tail)-1]
		if index < len(pattern.Tail) {
			shape = pattern.Tail[index]
		}
		if !shape.Match(value) {
			return fmt.Errorf("%s 追加参数[%d]=%q 不满足形状 <%s>", name, index, value, shape.Name)
		}
	}
	return nil
}

// flattenTokens 按空白把 argv 元素再切成 token（仅对 FlattenArgs 的命令生效）。
func flattenTokens(tokens []string) []string {
	flat := make([]string, 0, len(tokens))
	for _, token := range tokens {
		flat = append(flat, strings.Fields(token)...)
	}
	return flat
}

// splitStatements 按**顶层**独立 `;` 元素切分语句。
//
// 花括号内的 `;` 是集合/链定义的一部分（`{ type ipv4_addr; flags interval; }`），
// 不切分；连续/首尾分隔符保留为空语句，由形状匹配拒绝——不静默忽略 `; ;`。
func splitStatements(tokens []string) [][]string {
	segments := make([][]string, 0, 1)
	current := make([]string, 0, len(tokens))
	depth := 0
	for _, token := range tokens {
		switch token {
		case "{":
			depth++
		case "}":
			if depth > 0 {
				depth--
			}
		case ";":
			if depth == 0 {
				segments = append(segments, current)
				current = make([]string, 0, len(tokens))
				continue
			}
		}
		current = append(current, token)
	}
	segments = append(segments, current)
	return segments
}

// matchStatements 返回所有逐位匹配该语句的形状（可能多条：同一 token 序列的
// 不同追加参数形状）。
func matchStatements(patterns []CommandPattern, segment []string) []CommandPattern {
	matches := make([]CommandPattern, 0, 2)
	for _, pattern := range patterns {
		if len(pattern.Tokens) != len(segment) {
			continue
		}
		matched := true
		for index, spec := range pattern.Tokens {
			if !spec.matches(segment[index]) {
				matched = false
				break
			}
		}
		if matched {
			matches = append(matches, pattern)
		}
	}
	return matches
}

// resolveCommandName 把 argv[0] 归一为白名单键：命令名原样，绝对路径取 basename
// 并限定在系统二进制目录内。
func resolveCommandName(program string) (string, error) {
	if !strings.HasPrefix(program, "/") {
		if strings.ContainsAny(program, `/\`) {
			return "", fmt.Errorf("argv[0]=%q 既不是绝对路径也不是命令名", program)
		}
		return program, nil
	}
	cleaned := pathClean(program)
	if cleaned == "/" || cleaned != program {
		return "", fmt.Errorf("argv[0]=%q 不是规范化的绝对路径", program)
	}
	dir := cleaned[:strings.LastIndexByte(cleaned, '/')]
	if dir == "" {
		dir = "/"
	}
	if _, ok := sysBinaryDirs[dir]; !ok {
		return "", fmt.Errorf("argv[0]=%q 所在目录不在系统二进制目录内（允许：%s）",
			program, strings.Join(sortedKeys(sysBinaryDirs), "/"))
	}
	return cleaned[strings.LastIndexByte(cleaned, '/')+1:], nil
}

// pathClean 是 path.Clean 的薄包装（此文件不 import path，避免与 URL 语义混淆）。
func pathClean(value string) string {
	parts := strings.Split(value, "/")
	stack := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "", ".":
			continue
		case "..":
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		default:
			stack = append(stack, part)
		}
	}
	return "/" + strings.Join(stack, "/")
}

// sortedKeys 返回有序 key 列表（错误提示稳定）。
func sortedKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// describePatterns 把形状表压成一行提示（最多 6 条，避免错误体膨胀）。
func describePatterns(patterns []CommandPattern) string {
	parts := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		if len(parts) >= 6 {
			parts = append(parts, "…")
			break
		}
		tokens := make([]string, 0, len(pattern.Tokens))
		for _, spec := range pattern.Tokens {
			tokens = append(tokens, spec.describe())
		}
		text := strings.Join(tokens, " ")
		if len(pattern.Tail) > 0 {
			tail := make([]string, 0, len(pattern.Tail))
			for _, shape := range pattern.Tail {
				tail = append(tail, "<"+shape.Name+">")
			}
			text += " + " + strings.Join(tail, " ")
		}
		parts = append(parts, strings.TrimSpace(text))
	}
	return strings.Join(parts, " | ")
}
