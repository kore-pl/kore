package pluginapi

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 本文件是 sshd drop-in 片段的**手写 allowlist 校验器**（C12 / ADR-0060，零第三方依赖）。
//
// 为什么必须存在：写进 `/etc/ssh/sshd_config.d/` 的片段由 **root sshd** 解析。
// `Include` 可把任意 root 可读文件拉进配置，`AuthorizedKeysCommand` 让 root sshd 执行任意
// 命令，`HostKey` 可加载任意密钥文件；`sshd -t` 只校验语法、不校验安全性（root 身份下
// `-t` 还会真实打开 HostKey 等文件），不能充当安全门。策略必须在写盘前对文本做纯解析。
//
// 与 nginxconf.go 同构的三层，缺一不可：
//  1. 结构：逐行 `Directive value...`，只接受行首指令 + 空白分隔参数 + 整行注释；
//  2. 指令 allowlist（默认全拒），危险指令另有显式拒绝理由（可解释 / 可逐条断言）；
//  3. 参数形状：枚举 / 整数范围 / MaxStartups 三段结构逐项校验。
//
// 残余风险（必须披露，不宣称消灭）：allowlist 内 `PasswordAuthentication no` +
// `PermitRootLogin no` 有把管理员锁在外面的业务后果，由「保留密钥登录 + 一键回滚 +
// 隔离 VM 先验」承担；主配置 Include 位置差异可能让 drop-in 静默失效，由写后
// `sshd -T` 复核生效值承担（方案 §2.3 / §6）。本校验器只保证「文本形状安全」。

// SSHDPolicy 是 sshd drop-in 片段的运行时策略。
//
// 首版没有安装路径相关的注入需求：零值 = 默认策略（fail-closed 语义不变）。
type SSHDPolicy struct {
	// MaxDirectives 是单片段指令数上限（防解析成本）。0 表示使用默认值。
	MaxDirectives int
}

// 解析器结构上限（协议常量；改值属协议变更，须走新 ADR 复审）。
const (
	// defaultSSHDMaxDirectives 是单片段指令数默认值：drop-in 片段极小，128 条留足余量。
	defaultSSHDMaxDirectives = 128
	// maxSSHDArgs 是单条指令的参数个数上限（allowlist 规则还会逐条锁定精确个数）。
	maxSSHDArgs = 4
	// maxSSHDTokenRunes 是单个 token 的字符数上限（防超长 token 拖垮校验）。
	maxSSHDTokenRunes = 1024
)

// DefaultSSHDPolicy 返回默认策略。
func DefaultSSHDPolicy() SSHDPolicy {
	return SSHDPolicy{MaxDirectives: defaultSSHDMaxDirectives}
}

// normalized 把零值补成默认值（与 NginxPolicy 同口径）。
func (p SSHDPolicy) normalized() SSHDPolicy {
	if p.MaxDirectives <= 0 {
		return DefaultSSHDPolicy()
	}
	return p
}

// DeniedSSHDDirective 是「无条件拒绝」的指令及原因（协议数据，供文档与红队用例引用）。
type DeniedSSHDDirective struct {
	Name   string
	Reason string
}

// DeniedSSHDDirectives 是显式拒绝清单：不在 allowlist 里本来也会被拒，
// 单独列出是为了错误信息可解释、用例可逐条断言、文档与实现同源。
var DeniedSSHDDirectives = []DeniedSSHDDirective{
	{"Include", "可把任意 root 可读文件拉进配置绕过 allowlist，解析错误还会回显目标首 token"},
	{"Match", "条件块可覆盖全局设置，且块体延续到 EOF 会吞掉后续配置"},
	{"AuthorizedKeysFile", "把认证锚点重定向到攻击者可写文件"},
	{"AuthorizedKeysCommand", "root sshd 以命令输出当公钥，等于任意命令执行"},
	{"AuthorizedKeysCommandUser", "指定执行命令的用户，与 AuthorizedKeysCommand 组合成执行链"},
	{"AuthorizedPrincipalsFile", "重定向证书 principals 锚点到攻击者可写文件"},
	{"AuthorizedPrincipalsCommand", "root sshd 执行任意命令取 principals"},
	{"AuthorizedPrincipalsCommandUser", "指定 principals 命令的执行用户，同命令执行链"},
	{"HostKey", "可让 root sshd 加载任意密钥文件"},
	{"Port", "改变监听面，可致管理员被锁在外面"},
	{"ListenAddress", "改变监听地址，可致管理入口消失"},
	{"Subsystem", "改变会话语义（如替换 sftp-server）"},
	{"ForceCommand", "强制会话执行指定命令，改变会话语义"},
	{"AllowTcpForwarding", "打开 TCP 转发面"},
	{"AllowStreamLocalForwarding", "打开 Unix socket 转发面"},
	{"PermitTunnel", "打开隧道转发面"},
	{"PermitListen", "打开远端监听转发面"},
	{"PermitOpen", "打开目标连接转发面"},
}

// deniedSSHDPatterns 是按前缀拒绝的指令族（避免枚举漏掉新变体，如 HostKeyAgent）。
var deniedSSHDPatterns = []struct {
	Match  string
	Reason string
}{
	{"AuthorizedKeys", "AuthorizedKeys 指令族：重定向认证锚点或让 root sshd 执行命令"},
	{"AuthorizedPrincipals", "AuthorizedPrincipals 指令族：重定向证书锚点或让 root sshd 执行命令"},
	{"HostKey", "HostKey 指令族：可让 root sshd 加载任意密钥文件"},
}

// validateSSHDDenied 返回显式拒绝理由（未命中返回空串）。
// 指令名大小写不敏感（sshd 本身如此），避免用大小写绕过拒绝理由。
func validateSSHDDenied(name string) string {
	for _, item := range DeniedSSHDDirectives {
		if strings.EqualFold(name, item.Name) {
			return item.Reason
		}
	}
	for _, pattern := range deniedSSHDPatterns {
		if strings.HasPrefix(strings.ToLower(name), strings.ToLower(pattern.Match)) {
			return pattern.Reason
		}
	}
	return ""
}

// sshdLeafRule 是一条 allowlist 指令的参数校验规则。
type sshdLeafRule struct {
	args int
	fn   func(args []string) error
}

// sshdEnumRule 生成精确枚举规则（大小写敏感，fail-closed）。
func sshdEnumRule(allowed ...string) func([]string) error {
	return func(args []string) error {
		for _, want := range allowed {
			if args[0] == want {
				return nil
			}
		}
		return fmt.Errorf("参数必须是 %s 之一（当前 %q）", strings.Join(allowed, "/"), args[0])
	}
}

// sshdIntRule 生成 ASCII 十进制整数的范围规则（拒 +、-、空白与非数字，避免解析差一）。
func sshdIntRule(minimum, maximum int) func([]string) error {
	return func(args []string) error {
		value, ok := sshdParseDecimal(args[0])
		if !ok {
			return fmt.Errorf("参数必须是 %d..%d 的十进制整数（当前 %q）", minimum, maximum, args[0])
		}
		if value < minimum || value > maximum {
			return fmt.Errorf("参数必须在 %d..%d 之间（当前 %d）", minimum, maximum, value)
		}
		return nil
	}
}

// sshdParseDecimal 只接受 ASCII 0-9（Atoi 会接受 "+1"/"-1"，这里先收口）。
func sshdParseDecimal(token string) (int, bool) {
	if token == "" {
		return 0, false
	}
	for index := 0; index < len(token); index++ {
		if token[index] < '0' || token[index] > '9' {
			return 0, false
		}
	}
	value, err := strconv.Atoi(token)
	if err != nil {
		return 0, false
	}
	return value, true
}

// checkMaxStartups 校验 `start:rate:full` 三段结构，每段 1..1000。
func checkMaxStartups(args []string) error {
	parts := strings.Split(args[0], ":")
	if len(parts) != 3 {
		return fmt.Errorf("参数必须是 start:rate:full 三段（当前 %q）", args[0])
	}
	for _, part := range parts {
		value, ok := sshdParseDecimal(part)
		if !ok || value < 1 || value > 1000 {
			return fmt.Errorf("每段必须是 1..1000 的整数（当前 %q）", args[0])
		}
	}
	return nil
}

// sshdLeafRules 是 allowlist 的**唯一真源**：不在表内的指令一律拒（默认全拒）。
// 指令名大小写敏感：sshd 虽大小写不敏感，但只放行规范写法可避免解析器差一。
var sshdLeafRules = map[string]sshdLeafRule{
	"PasswordAuthentication":       {args: 1, fn: sshdEnumRule("yes", "no")},
	"PermitRootLogin":              {args: 1, fn: sshdEnumRule("yes", "prohibit-password", "forced-commands-only", "no")},
	"PubkeyAuthentication":         {args: 1, fn: sshdEnumRule("yes", "no")},
	"KbdInteractiveAuthentication": {args: 1, fn: sshdEnumRule("yes", "no")},
	"PermitEmptyPasswords":         {args: 1, fn: sshdEnumRule("no")},
	"MaxAuthTries":                 {args: 1, fn: sshdIntRule(1, 100)},
	"ClientAliveInterval":          {args: 1, fn: sshdIntRule(0, 3600)},
	"ClientAliveCountMax":          {args: 1, fn: sshdIntRule(0, 10)},
	"LoginGraceTime":               {args: 1, fn: sshdIntRule(1, 600)},
	"MaxStartups":                  {args: 1, fn: checkMaxStartups},
}

// ValidateSSHDropinFragment 是内容策略 sshd.dropin.v1 的唯一实现。
//
// 只接受「行首指令 + 空格/制表符分隔参数 + 整行 # 注释」；行内 #、反斜杠续行、
// 引号、%、${}、;、{}、/ 一律拒——防止校验器看到的文本与 root sshd 解析的文本不一致。
func ValidateSSHDropinFragment(content []byte, policy SSHDPolicy) error {
	if !utf8.Valid(content) {
		return fmt.Errorf("sshd 片段必须是合法 UTF-8")
	}
	limit := policy.normalized().MaxDirectives
	directives := 0
	for index, rawLine := range strings.Split(string(content), "\n") {
		lineNo := index + 1
		line := strings.TrimSuffix(rawLine, "\r")
		for pos, char := range []byte(line) {
			if char == 0 || char == 0x7f || (char < 0x20 && char != '\t') {
				return fmt.Errorf("sshd 片段第 %d 行第 %d 字节是非法控制字符 %#x", lineNo, pos+1, char)
			}
		}
		line = strings.Trim(line, " \t")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.Contains(line, "#") {
			return fmt.Errorf("sshd 片段第 %d 行：行内 # 注释不允许（注释必须独占整行）", lineNo)
		}
		if strings.ContainsAny(line, "\"'\\%;${}") {
			return fmt.Errorf("sshd 片段第 %d 行：不允许引号/续行/变量展开/分号/花括号", lineNo)
		}
		tokens := splitSSHDFields(line)
		if len(tokens) == 0 {
			continue
		}
		name := tokens[0]
		for _, token := range tokens {
			if utf8.RuneCountInString(token) > maxSSHDTokenRunes {
				return fmt.Errorf("sshd 片段第 %d 行：token 超过 %d 个字符", lineNo, maxSSHDTokenRunes)
			}
		}
		if reason := validateSSHDDenied(name); reason != "" {
			return fmt.Errorf("sshd 片段第 %d 行：指令 %s 无条件拒绝——%s", lineNo, name, reason)
		}
		rule, ok := sshdLeafRules[name]
		if !ok {
			return fmt.Errorf("sshd 片段第 %d 行：指令 %q 不在 allowlist（默认全拒）", lineNo, name)
		}
		args := tokens[1:]
		if len(args) > maxSSHDArgs {
			return fmt.Errorf("sshd 片段第 %d 行：%s 的参数过多（最多 %d 项）", lineNo, name, maxSSHDArgs)
		}
		if len(args) != rule.args {
			return fmt.Errorf("sshd 片段第 %d 行：%s 必须恰好 %d 个参数（当前 %d）", lineNo, name, rule.args, len(args))
		}
		if err := rule.fn(args); err != nil {
			return fmt.Errorf("sshd 片段第 %d 行 %s 参数非法：%v", lineNo, name, err)
		}
		directives++
		if directives > limit {
			return fmt.Errorf("sshd 片段指令数超过 %d 条", limit)
		}
	}
	if directives == 0 {
		return fmt.Errorf("sshd 片段至少需要一个 allowlist 指令")
	}
	return nil
}

// splitSSHDFields 只按 ASCII 空格/制表符切分（不用 strings.Fields——它认 Unicode 空白，
// 与 sshd 的词法存在差一风险）。
func splitSSHDFields(line string) []string {
	tokens := make([]string, 0, 4)
	start := -1
	for index := 0; index <= len(line); index++ {
		if index < len(line) && line[index] != ' ' && line[index] != '\t' {
			if start < 0 {
				start = index
			}
			continue
		}
		if start >= 0 {
			tokens = append(tokens, line[start:index])
			start = -1
		}
	}
	return tokens
}
