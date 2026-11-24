package pluginapi

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 本文件是 nginx vhost 片段的**手写 allowlist 校验器**（ADR-0052 §3.3，不引第三方依赖）。
//
// 为什么必须存在：被写进 `/etc/nginx/conf.d/` 的片段会被 **root master** 解析执行。
// ADR-0052 §2 实测：`log_format` + `access_log` 能让 root master 创建 `/etc/cron.d/*`、
// 写 `/etc/ld.so.preload`；`root /;` 能通过 HTTP 读任意 worker 可读文件；而 `nginx -t`
// 对这些配置**全部 exit 0**（它只校验语法，且 root 下"测试"本身就会执行 access_log 打开）。
// 因此校验只能是对文本的纯解析，**禁止把 `nginx -t` 当校验**。
//
// 策略分三层，缺一不可：
//  1. 结构：顶层只有 `server{}`；`location` 只在 server 内；`if` 只在 location 内且条件锁定。
//  2. 指令 allowlist：不在表内一律拒绝；危险指令另有显式拒绝理由（便于排障）。
//  3. 参数形状：路径/端口/目标/套件逐项校验（正则 + 结构化复核）。
//
// 残余风险（必须披露，不能宣称消灭）：allowlist 内仍有副作用——`proxy_pass` 可达本机
// 服务（产品功能）、`root` 指向的站点根内可能有敏感文件。这些由部署侧与审计承担。

// NginxPolicy 是 nginx 片段的运行时策略。安装路径相关的白名单（证书/口令文件目录）
// 只能在运行时得到，**缺省为空 = 拒绝**（fail-closed）。
type NginxPolicy struct {
	// SiteRootPrefixes 是 `root`/`alias` 允许的站点根前缀（以 / 结尾）。
	SiteRootPrefixes []string
	// CertPrefixes 是 `ssl_certificate`/`ssl_certificate_key` 允许的前缀（如 <install>/data/ssl/）。
	// 为空时任何证书指令都被拒绝——不要猜安装路径。
	CertPrefixes []string
	// AuthFilePrefixes 是 `auth_basic_user_file` 允许的前缀（口令文件应在受控目录内）。
	AuthFilePrefixes []string
	// FastCGIDirs 是 `fastcgi_pass unix:` 允许的 socket 目录（以 / 结尾）。
	FastCGIDirs []string
	// ForbiddenProxyPorts 是 `proxy_pass` 禁止指向的本机端口（kore 自身管理 API）。
	ForbiddenProxyPorts []int
	// MaxDirectives 是单片段指令数上限（防御解析成本）。0 表示默认 2048。
	MaxDirectives int
}

// 解析器结构上限（协议常量；改值属协议变更）。
const (
	// maxNginxDepth 是块嵌套深度上限：server > location > if = 3 层，留 1 层余量。
	maxNginxDepth = 4
	// maxNginxRegexRunes 是 location/rewrite 正则的最大长度。
	maxNginxRegexRunes = 512
	// maxNginxValueRunes 是单参数最大长度（防超长 token 拖垮校验）。
	maxNginxValueRunes = 1024
	// maxNginxArgs 是单条指令的参数个数上限（防「一条指令挂十万个参数」的解析放大）。
	maxNginxArgs = 64
)

// DefaultNginxPolicy 返回默认策略：站点根 /var/www/、FPM socket 的标准目录、
// 禁止反代到 kore 自身端口 8787。证书/口令文件目录故意留空（运行时注入）。
func DefaultNginxPolicy() NginxPolicy {
	return NginxPolicy{
		SiteRootPrefixes:    []string{"/var/www/"},
		FastCGIDirs:         []string{"/run/php/", "/var/run/php/", "/run/php-fpm/", "/var/run/php-fpm/"},
		ForbiddenProxyPorts: []int{8787},
		MaxDirectives:       2048,
	}
}

// normalized 把零值补成默认值。口径：**零值结构 = DefaultNginxPolicy()**；
// 需要收紧就基于 DefaultNginxPolicy() 改字段（而不是传一个空结构）。
func (p NginxPolicy) normalized() NginxPolicy {
	if p.MaxDirectives == 0 && p.SiteRootPrefixes == nil && p.FastCGIDirs == nil &&
		p.CertPrefixes == nil && p.AuthFilePrefixes == nil && p.ForbiddenProxyPorts == nil {
		return DefaultNginxPolicy()
	}
	if p.MaxDirectives == 0 {
		p.MaxDirectives = 2048
	}
	return p
}

// DeniedNginxDirective 是「无条件拒绝」的指令及原因（协议数据，供文档与红队用例引用）。
type DeniedNginxDirective struct {
	// Name 是指令名（前缀/后缀类除外，见 deniedNginxPatterns）。
	Name string
	// Reason 是拒绝理由（能直接告诉插件作者"为什么这条不行"）。
	Reason string
}

// DeniedNginxDirectives 是**显式**拒绝的指令清单。
//
// 它们不在 allowlist 里本来也会被拒；单独列出来是为了：① 错误信息可解释；② 红队/单测
// 可以逐条断言；③ 文档与实现同源，不会出现"文档说拒、实现漏了"。
var DeniedNginxDirectives = []DeniedNginxDirective{
	{"include", "可读取任意 root 可读文件，解析错误还会回显目标文件首 token（ADR-0052 §2 #7）"},
	{"load_module", "在主配置上下文加载任意 .so，等于把代码注入 root nginx 进程（§2 #3）"},
	{"log_format", "定义日志格式即「整行任意内容」的参数化模板，配合 access_log 就是 root 任意写（§2 #4）"},
	{"access_log", "以 root master 打开/创建任意文件，可写 /etc/cron.d、/etc/ld.so.preload、口令文件（§2 #4/#5）"},
	{"error_log", "同 access_log：以 root master 打开任意文件；即使只说路径也是任意文件创建/截断面"},
	{"perl", "内嵌 Perl 模块，可在 root 进程内执行任意 Perl 代码"},
	{"perl_modules", "加载任意 Perl 模块路径，等于在 root 进程内执行代码"},
	{"perl_require", "加载并执行任意 Perl 文件"},
	{"perl_set", "以 Perl 表达式求值并写入变量，可执行任意代码"},
	{"lua_package_path", "把任意目录加入 Lua 搜索路径，随后可用 Lua 代码执行"},
	{"lua_package_cpath", "把任意目录加入 Lua C 模块搜索路径，加载任意 .so"},
	{"lua_shared_dict", "在 root 进程内分配共享内存并暴露给 Lua 生态"},
	{"lua_code_cache", "改变 Lua 代码加载/执行语义，配合任意 Lua 指令即代码执行"},
	{"lua_ssl_trusted_certificate", "读取任意 PEM 文件，且是 Lua 生态的信任锚点"},
	{"js_import", "加载任意 JS 模块（njs），在 root 进程内执行"},
	{"js_include", "加载任意 njs 脚本文件"},
	{"js_set", "以 njs 表达式求值并写入变量，可执行任意代码"},
	{"js_content", "以 njs 脚本处理请求，可执行任意代码"},
	{"js_periodic", "以 njs 周期任务执行代码"},
	{"dav_methods", "开启 WebDAV 写盘（ADR-0052 §2 #9 实测 PUT 201，worker 身份任意写）"},
	{"dav_access", "控制 WebDAV 落盘权限，与 dav_methods 叠加扩大写面"},
	{"dav_min_access", "同上：WebDAV 访问控制，属写盘能力的一部分"},
	{"dav_ext_methods", "扩展 WebDAV 方法集，扩大写/删面"},
	{"map", "在 http 上下文定义变量映射，可被后续指令组合成注入链；site 不需要"},
	{"upstream", "定义任意后端组，绕过 proxy_pass 的目标形状校验（含 kore 端口）"},
	{"geo", "按来源地址定义变量，同 map 的组合风险；site 不需要"},
	{"limit_req_zone", "在 http 上下文定义限流区，属共享内存/全局状态，site 不需要"},
	{"limit_conn_zone", "同上：全局共享内存状态，site 不需要"},
	{"proxy_cache_path", "指定任意缓存目录，等于给 root 进程一个任意写盘入口"},
	{"ssi", "服务端包含可把任意文件拼进响应，配合 root 变成文件读取面"},
	{"sub_filter", "响应体替换可改写上游内容，属响应注入面，site 不需要"},
	{"auth_request", "子请求可打到任意内部 location，扩大 SSRF 面"},
}

// deniedNginxPatterns 是**按前缀/后缀**拒绝的指令族（逐个枚举会漏掉未列出的成员）。
var deniedNginxPatterns = []struct {
	Match  string
	Reason string
}{
	{"lua_", "OpenResty Lua 指令族：均可在 root 进程内执行代码；kore 不捆绑 OpenResty"},
	{"js_", "njs（nginx JavaScript）指令族：可在 root 进程内执行代码"},
	{"dav_", "WebDAV 指令族：开启 worker 身份任意写盘（ADR-0052 §2 #9）"},
	{"_temp_path", "临时目录指令族：给 root 进程指定任意可写目录（任意写盘入口）"},
}

// validateNginxDenied 返回显式拒绝理由（未命中返回空串）。
func validateNginxDenied(name string) string {
	for _, item := range DeniedNginxDirectives {
		if item.Name == name {
			return item.Reason
		}
	}
	for _, pattern := range deniedNginxPatterns {
		if strings.HasPrefix(pattern.Match, "_") {
			if strings.HasSuffix(name, pattern.Match) {
				return pattern.Reason
			}
			continue
		}
		if strings.HasPrefix(name, pattern.Match) {
			return pattern.Reason
		}
	}
	return ""
}

// nginxTokenKind 是词法单元类型。
type nginxTokenKind int

const (
	nginxTokenWord nginxTokenKind = iota
	nginxTokenSemicolon
	nginxTokenOpenBrace
	nginxTokenCloseBrace
	nginxTokenEOF
)

// nginxToken 是带行号的词法单元（错误信息必须有行号，否则排障等于盲猜）。
type nginxToken struct {
	kind  nginxTokenKind
	value string
	line  int
}

// tokenizeNginx 把片段切成词法单元。
//
// 与 nginx 词法的关键对齐点（错一个就是绕过）：
//   - 引号内的 `;`/`{`/`}`/`#` 是普通字符（必须先整体吃掉引号内容）；
//   - 反斜杠转义按**原样保留**（正则 `\.php$` 必须保持 `\.`），不在这里做语义解释；
//   - `#` 只有出现在 token 起点才是注释；出现在 token 中间一律报错——
//     nginx 对 `root /x#y;` 的解释存在歧义，校验器必须 fail-closed 而不是猜。
func tokenizeNginx(text string) ([]nginxToken, error) {
	tokens := make([]nginxToken, 0, 128)
	line := 1
	for index := 0; index < len(text); {
		char := text[index]
		switch {
		case char == ' ' || char == '\t' || char == '\r':
			index++
		case char == '\n':
			line++
			index++
		case char == '#':
			for index < len(text) && text[index] != '\n' {
				index++
			}
		case char == ';':
			tokens = append(tokens, nginxToken{kind: nginxTokenSemicolon, line: line})
			index++
		case char == '{':
			tokens = append(tokens, nginxToken{kind: nginxTokenOpenBrace, line: line})
			index++
		case char == '}':
			tokens = append(tokens, nginxToken{kind: nginxTokenCloseBrace, line: line})
			index++
		case char == '"' || char == '\'':
			quote := char
			startLine := line
			index++
			var builder strings.Builder
			closed := false
			for index < len(text) {
				current := text[index]
				if current == '\\' {
					if index+1 >= len(text) {
						return nil, fmt.Errorf("nginx 片段第 %d 行：引号内转义符出现在文件末尾", startLine)
					}
					builder.WriteByte(text[index+1])
					index += 2
					continue
				}
				if current == quote {
					closed = true
					index++
					break
				}
				if current == '\n' {
					line++
				}
				builder.WriteByte(current)
				index++
			}
			if !closed {
				return nil, fmt.Errorf("nginx 片段第 %d 行：引号未闭合", startLine)
			}
			tokens = append(tokens, nginxToken{kind: nginxTokenWord, value: builder.String(), line: startLine})
		default:
			startLine := line
			var builder strings.Builder
			for index < len(text) {
				current := text[index]
				if current == ' ' || current == '\t' || current == '\r' || current == '\n' ||
					current == ';' || current == '{' || current == '}' {
					break
				}
				// `${name}` 在 nginx 里是合法变量写法，但会把 `{` 混进 token 边界；
				// 当前策略不支持，显式拒绝而不是让解析器把它当块起始。
				if current == '$' && index+1 < len(text) && text[index+1] == '{' {
					return nil, fmt.Errorf("nginx 片段第 %d 行：不支持 ${} 复合变量写法（用 $name）", line)
				}
				if current == '"' || current == '\'' {
					return nil, fmt.Errorf("nginx 片段第 %d 行：未加引号的 token 中出现引号", line)
				}
				if current == '#' {
					return nil, fmt.Errorf("nginx 片段第 %d 行：# 只能出现在 token 起点（注释必须独占）", line)
				}
				if current == '\\' {
					if index+1 >= len(text) {
						return nil, fmt.Errorf("nginx 片段第 %d 行：转义符出现在文件末尾", line)
					}
					builder.WriteByte(current)
					builder.WriteByte(text[index+1])
					index += 2
					continue
				}
				builder.WriteByte(current)
				index++
			}
			word := builder.String()
			if strings.Contains(word, "${") {
				return nil, fmt.Errorf("nginx 片段第 %d 行：不支持 ${} 复合变量写法（用 $name）", startLine)
			}
			tokens = append(tokens, nginxToken{kind: nginxTokenWord, value: word, line: startLine})
		}
	}
	tokens = append(tokens, nginxToken{kind: nginxTokenEOF, line: line})
	return tokens, nil
}

// nginxContext 是解析上下文（结构约束靠它，而不是靠"看起来像"）。
type nginxContext int

const (
	nginxContextRoot nginxContext = iota
	nginxContextServer
	nginxContextLocation
	nginxContextIf
)

// nginxValidator 持有策略与解析状态。
type nginxValidator struct {
	policy     NginxPolicy
	tokens     []nginxToken
	position   int
	directives int
	servers    int
}

// ValidateNginxVHostFragment 是内容策略 nginx.vhost.v1 的唯一实现。
func ValidateNginxVHostFragment(content []byte, policy NginxPolicy) error {
	if !utf8.Valid(content) {
		return fmt.Errorf("nginx 片段必须是合法 UTF-8")
	}
	tokens, err := tokenizeNginx(string(content))
	if err != nil {
		return err
	}
	validator := &nginxValidator{policy: policy.normalized(), tokens: tokens}
	if err := validator.parseBlock(nginxContextRoot, 0); err != nil {
		return err
	}
	if validator.servers == 0 {
		return fmt.Errorf("nginx 片段至少需要一个 server 块")
	}
	return nil
}

// parseBlock 解析当前上下文直到 `}`（顶层要求 EOF）。
func (v *nginxValidator) parseBlock(context nginxContext, depth int) error {
	if depth > maxNginxDepth {
		return fmt.Errorf("nginx 片段嵌套超过 %d 层", maxNginxDepth)
	}
	for {
		token := v.next()
		switch token.kind {
		case nginxTokenEOF:
			if context != nginxContextRoot {
				return fmt.Errorf("nginx 片段第 %d 行：块未闭合（缺少 }）", token.line)
			}
			return nil
		case nginxTokenCloseBrace:
			if context == nginxContextRoot {
				return fmt.Errorf("nginx 片段第 %d 行：多余的 }", token.line)
			}
			return nil
		case nginxTokenSemicolon:
			return fmt.Errorf("nginx 片段第 %d 行：多余的 ;", token.line)
		case nginxTokenOpenBrace:
			return fmt.Errorf("nginx 片段第 %d 行：缺少块名", token.line)
		}
		name := token.value
		if name == "" {
			return fmt.Errorf("nginx 片段第 %d 行：空指令名", token.line)
		}
		args := make([]string, 0, 4)
		for v.peek().kind == nginxTokenWord {
			if len(args) >= maxNginxArgs {
				return fmt.Errorf("nginx 片段第 %d 行：%s 的参数过多（最多 %d 项）", token.line, name, maxNginxArgs)
			}
			arg := v.next().value
			if utf8.RuneCountInString(arg) > maxNginxValueRunes {
				return fmt.Errorf("nginx 片段第 %d 行：%s 的参数超过 %d 个字符", token.line, name, maxNginxValueRunes)
			}
			args = append(args, arg)
		}
		next := v.peek()
		switch next.kind {
		case nginxTokenSemicolon:
			v.next()
			if err := v.validateLeaf(context, name, args, token.line); err != nil {
				return err
			}
		case nginxTokenOpenBrace:
			v.next()
			child, err := v.blockContext(context, name, args, token.line)
			if err != nil {
				return err
			}
			if err := v.parseBlock(child, depth+1); err != nil {
				return err
			}
		case nginxTokenCloseBrace:
			return fmt.Errorf("nginx 片段第 %d 行：指令 %s 缺少 ;", token.line, name)
		case nginxTokenEOF:
			return fmt.Errorf("nginx 片段第 %d 行：指令 %s 未以 ; 或 { 结尾", token.line, name)
		}
	}
}

// next / peek 是带边界安全的位置推进。
func (v *nginxValidator) next() nginxToken {
	if v.position >= len(v.tokens) {
		return nginxToken{kind: nginxTokenEOF}
	}
	token := v.tokens[v.position]
	v.position++
	return token
}

func (v *nginxValidator) peek() nginxToken {
	if v.position >= len(v.tokens) {
		return nginxToken{kind: nginxTokenEOF}
	}
	return v.tokens[v.position]
}

// blockContext 判定块的合法性并返回子上下文。
func (v *nginxValidator) blockContext(context nginxContext, name string, args []string, line int) (nginxContext, error) {
	if reason := validateNginxDenied(name); reason != "" {
		return context, fmt.Errorf("nginx 片段第 %d 行：无条件拒绝 %s —— %s", line, name, reason)
	}
	switch name {
	case "server":
		if context != nginxContextRoot {
			return context, fmt.Errorf("nginx 片段第 %d 行：server 只能出现在顶层（当前嵌套在 %s 内）", line, contextName(context))
		}
		if len(args) != 0 {
			return context, fmt.Errorf("nginx 片段第 %d 行：server 不允许参数（当前 %v）", line, args)
		}
		v.directives++
		if v.directives > v.policy.MaxDirectives {
			return context, fmt.Errorf("nginx 片段指令数超过上限 %d", v.policy.MaxDirectives)
		}
		v.servers++
		return nginxContextServer, nil
	case "location":
		if context != nginxContextServer {
			return context, fmt.Errorf("nginx 片段第 %d 行：location 只能出现在 server 内（当前在 %s 内）", line, contextName(context))
		}
		if err := v.checkLocationArgs(args); err != nil {
			return context, fmt.Errorf("nginx 片段第 %d 行：%w", line, err)
		}
		v.directives++
		if v.directives > v.policy.MaxDirectives {
			return context, fmt.Errorf("nginx 片段指令数超过上限 %d", v.policy.MaxDirectives)
		}
		return nginxContextLocation, nil
	case "if":
		if context != nginxContextLocation {
			return context, fmt.Errorf("nginx 片段第 %d 行：if 只允许出现在 location 内（当前在 %s 内）", line, contextName(context))
		}
		condition := strings.Join(args, " ")
		if condition != "(!-e $request_filename)" {
			return context, fmt.Errorf("nginx 片段第 %d 行：if 条件只允许 (!-e $request_filename)（当前 %q）", line, condition)
		}
		v.directives++
		if v.directives > v.policy.MaxDirectives {
			return context, fmt.Errorf("nginx 片段指令数超过上限 %d", v.policy.MaxDirectives)
		}
		return nginxContextIf, nil
	default:
		return context, fmt.Errorf("nginx 片段第 %d 行：不支持的块指令 %q（只允许 server/location/if）", line, name)
	}
}

// contextName 返回上下文的中文名（错误信息用）。
func contextName(context nginxContext) string {
	switch context {
	case nginxContextServer:
		return "server"
	case nginxContextLocation:
		return "location"
	case nginxContextIf:
		return "if"
	default:
		return "顶层"
	}
}

// validateLeaf 校验叶子指令：显式拒绝 → 上下文 → allowlist → 参数形状。
func (v *nginxValidator) validateLeaf(context nginxContext, name string, args []string, line int) error {
	if reason := validateNginxDenied(name); reason != "" {
		return fmt.Errorf("nginx 片段第 %d 行：无条件拒绝 %s —— %s", line, name, reason)
	}
	v.directives++
	if v.directives > v.policy.MaxDirectives {
		return fmt.Errorf("nginx 片段指令数超过上限 %d", v.policy.MaxDirectives)
	}
	check, ok := nginxLeafRules[name]
	if !ok {
		return fmt.Errorf("nginx 片段第 %d 行：指令 %q 不在 allowlist 内", line, name)
	}
	if (nginxContext(1)<<context)&check.contexts == 0 {
		return fmt.Errorf("nginx 片段第 %d 行：指令 %s 不允许出现在 %s 内", line, name, contextName(context))
	}
	if err := check.validate(v, args); err != nil {
		return fmt.Errorf("nginx 片段第 %d 行：%s %w", line, name, err)
	}
	return nil
}

// nginxLeafRule 是一条叶子指令的约束。
type nginxLeafRule struct {
	// contexts 是允许出现的上下文位掩码。
	contexts nginxContext
	// validate 校验参数形状。
	validate func(v *nginxValidator, args []string) error
}

// 上下文位掩码：不同指令的合法出现位置不同，混用即拒绝。
const (
	nginxInServer   nginxContext = 1 << nginxContextServer
	nginxInLocation nginxContext = 1 << nginxContextLocation
	nginxInIf       nginxContext = 1 << nginxContextIf
)

// nginxLeafRules 是**指令 allowlist**（ADR-0052 §3.3 的全部约 20 条，site 实际产出）。
//
// 新增指令 = 扩内容安全边界：必须同步 ADR-0052 §7#2 复审并更新协议文档。
var nginxLeafRules = map[string]nginxLeafRule{
	"listen":                    {contexts: nginxInServer, validate: checkListen},
	"server_name":               {contexts: nginxInServer, validate: checkServerName},
	"root":                      {contexts: nginxInServer | nginxInLocation, validate: checkSiteRoot},
	"alias":                     {contexts: nginxInLocation, validate: checkAlias},
	"index":                     {contexts: nginxInServer | nginxInLocation, validate: checkIndex},
	"auth_basic":                {contexts: nginxInServer | nginxInLocation, validate: checkAuthBasic},
	"auth_basic_user_file":      {contexts: nginxInServer | nginxInLocation, validate: checkAuthFile},
	"try_files":                 {contexts: nginxInLocation, validate: checkTryFiles},
	"return":                    {contexts: nginxInServer | nginxInLocation, validate: checkReturn},
	"rewrite":                   {contexts: nginxInLocation | nginxInIf, validate: checkRewrite},
	"proxy_pass":                {contexts: nginxInLocation, validate: checkProxyPass},
	"proxy_set_header":          {contexts: nginxInLocation, validate: checkProxyHeader},
	"proxy_http_version":        {contexts: nginxInLocation, validate: checkProxyHTTPVersion},
	"fastcgi_pass":              {contexts: nginxInLocation, validate: checkFastCGIPass},
	"fastcgi_index":             {contexts: nginxInLocation, validate: checkFastCGIIndex},
	"fastcgi_param":             {contexts: nginxInLocation, validate: checkFastCGIParam},
	"ssl_certificate":           {contexts: nginxInServer, validate: checkSSLCert},
	"ssl_certificate_key":       {contexts: nginxInServer, validate: checkSSLCert},
	"ssl_protocols":             {contexts: nginxInServer, validate: checkSSLProtocols},
	"ssl_ciphers":               {contexts: nginxInServer, validate: checkSSLCiphers},
	"ssl_prefer_server_ciphers": {contexts: nginxInServer, validate: checkOnOff},
	"ssl_session_cache":         {contexts: nginxInServer, validate: checkSSLSessionCache},
	"ssl_session_timeout":       {contexts: nginxInServer, validate: checkSSLSessionTimeout},
}

// ---- 参数形状校验 ----

var (
	// nginxPortPattern 拒绝前导零（"080" 在十进制/八进制之间歧义）。
	nginxPortPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
	// nginxStatusCodePattern 约束三位状态码。
	nginxStatusCodePattern = regexp.MustCompile(`^[1-5][0-9]{2}$`)
	// nginxFileNamePattern 是 index/fastcgi_index 的文件名形状（单层、无扩展名限制）。
	nginxFileNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	// nginxHeaderNamePattern 是 HTTP 头名形状。
	nginxHeaderNamePattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	// nginxFastCGIParamNamePattern 是 FastCGI 参数名形状。
	nginxFastCGIParamNamePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	// nginxSessionCachePattern 是 ssl_session_cache 的形状。
	nginxSessionCachePattern = regexp.MustCompile(`^(off|none|builtin(:[1-9][0-9]*[kKmM]?)?|shared:[A-Za-z0-9_-]{1,64}:[1-9][0-9]*[kKmM]?)$`)
	// nginxSessionTimeoutPattern 是 ssl_session_timeout 的形状。
	nginxSessionTimeoutPattern = regexp.MustCompile(`^[1-9][0-9]{0,5}[smhd]?$`)
	// nginxCiphersPattern 是 OpenSSL 套件串的字符集（长度由 maxNginxValueRunes 兜底）。
	nginxCiphersPattern = regexp.MustCompile(`^[A-Za-z0-9_:!+.-]+$`)
	// nginxServerNamePattern 是域名形状（含通配与下划线占位）。
	nginxServerNamePattern = regexp.MustCompile(`^(\*\.)?[A-Za-z0-9_]([A-Za-z0-9._-]{0,252})?$`)
	// nginxURIPattern 是 URI 形状（允许 nginx 变量与 query string）。
	nginxURIPattern = regexp.MustCompile(`^/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*$`)
	// nginxTokenPattern 是通用安全 token 字符集（正则/参数值用）。
	nginxTokenPattern = regexp.MustCompile("^[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%^|\\-\\\\ ]+$")
)

// checkListen 校验 `listen <port> [ssl] [http2]`。
//
// 只允许端口形式：ADR-0052 明确禁 `default_server`（抢占默认站点 = 劫持所有未匹配域名）。
// 也不接受 `address:port` —— site 不生成绑定地址，放开等于扩大监听面。
func checkListen(v *nginxValidator, args []string) error {
	if len(args) == 0 || len(args) > 3 {
		return fmt.Errorf("参数应为 <port> [ssl] [http2]（当前 %d 项）", len(args))
	}
	if !nginxPortPattern.MatchString(args[0]) {
		return fmt.Errorf("端口 %q 非法（只允许 1–65535 的裸数字端口，禁止前导零与 address:port）", args[0])
	}
	port, err := strconv.Atoi(args[0])
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("端口 %q 超出 1–65535", args[0])
	}
	for _, option := range args[1:] {
		switch option {
		case "ssl", "http2":
		case "default_server":
			return fmt.Errorf("禁止 default_server（会抢占默认站点，劫持所有未匹配域名的请求）")
		default:
			return fmt.Errorf("listen 选项 %q 不在允许集 {ssl, http2} 内", option)
		}
	}
	return nil
}

// checkServerName 校验域名列表：不接受正则（`~...`）与空名。
func checkServerName(v *nginxValidator, args []string) error {
	if len(args) == 0 || len(args) > 32 {
		return fmt.Errorf("参数应为 1–32 个域名（当前 %d 项）", len(args))
	}
	for _, name := range args {
		if name == "_" {
			continue
		}
		if strings.HasPrefix(name, "~") {
			return fmt.Errorf("server_name 不接受正则（%q）：正则匹配范围不可预估", name)
		}
		if !nginxServerNamePattern.MatchString(name) {
			return fmt.Errorf("域名 %q 形状非法", name)
		}
		if strings.Contains(name, "..") || strings.HasSuffix(name, ".") {
			return fmt.Errorf("域名 %q 含空标签", name)
		}
	}
	return nil
}

// checkSiteRoot 校验 root 路径：绝对、规范化、不以 / 为根、落在站点根前缀内。
func checkSiteRoot(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个路径（当前 %d 项）", len(args))
	}
	return checkPathInPrefixes(args[0], v.policy.SiteRootPrefixes, "站点根",
		"拒绝 /（会把整机根目录当站点根，ADR-0052 §2 #1）")
}

// checkAlias 与 root 同一套前缀约束：alias / 等价根映射（§2 #2）。
func checkAlias(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个路径（当前 %d 项）", len(args))
	}
	return checkPathInPrefixes(args[0], v.policy.SiteRootPrefixes, "alias 目标",
		"拒绝 /（alias / 等价根映射，ADR-0052 §2 #2）")
}

// checkPathInPrefixes 是路径类参数的统一形状校验。
func checkPathInPrefixes(value string, allowed []string, label, rootHint string) error {
	if strings.ContainsAny(value, "$") {
		return fmt.Errorf("%s 不接受变量（%q）：路径必须可静态判定", label, value)
	}
	if !strings.HasPrefix(value, "/") {
		return fmt.Errorf("%s 必须是绝对路径：%q", label, value)
	}
	if path.Clean(value) != value {
		return fmt.Errorf("%s 必须是规范路径（拒绝 .. / 重复分隔符 / 尾斜杠）：%q", label, value)
	}
	if value == "/" || value == "." {
		return fmt.Errorf("%s：%s（当前 %q）", label, rootHint, value)
	}
	if len(allowed) == 0 {
		return fmt.Errorf("%s 白名单为空（运行时未注入允许目录，fail-closed）：%q", label, value)
	}
	for _, prefix := range allowed {
		if strings.HasPrefix(value, prefix) && len(value) > len(prefix) {
			return nil
		}
	}
	return fmt.Errorf("%s 不在允许前缀内：%q（允许：%s）", label, value, strings.Join(allowed, "、"))
}

// checkIndex 校验 index 文件名列表。
func checkIndex(v *nginxValidator, args []string) error {
	if len(args) == 0 || len(args) > 16 {
		return fmt.Errorf("参数应为 1–16 个文件名（当前 %d 项）", len(args))
	}
	for _, name := range args {
		if !nginxFileNamePattern.MatchString(name) || name == "." || name == ".." {
			return fmt.Errorf("文件名 %q 形状非法", name)
		}
	}
	return nil
}

// checkAuthBasic 校验 realm 字符串。
func checkAuthBasic(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个 realm（当前 %d 项）", len(args))
	}
	if args[0] == "off" {
		return nil
	}
	if args[0] == "" || utf8.RuneCountInString(args[0]) > 128 {
		return fmt.Errorf("realm 长度非法（1–128）")
	}
	for _, value := range args[0] {
		if value < 0x20 || value == 0x7f {
			return fmt.Errorf("realm 含控制字符")
		}
	}
	return nil
}

// checkAuthFile 校验口令文件路径：必须在受控目录内（不猜安装路径，缺白名单即拒绝）。
func checkAuthFile(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个路径（当前 %d 项）", len(args))
	}
	return checkPathInPrefixes(args[0], v.policy.AuthFilePrefixes, "auth_basic_user_file",
		"口令文件必须在受控目录内")
}

// checkTryFiles 校验 try_files 的候选链。
func checkTryFiles(v *nginxValidator, args []string) error {
	if len(args) == 0 || len(args) > 16 {
		return fmt.Errorf("参数应为 1–16 个候选（当前 %d 项）", len(args))
	}
	for _, candidate := range args {
		switch {
		case candidate == "$uri" || candidate == "$uri/" || candidate == "$uri/index.html":
			continue
		case strings.HasPrefix(candidate, "="):
			code := strings.TrimPrefix(candidate, "=")
			if !nginxStatusCodePattern.MatchString(code) {
				return fmt.Errorf("fallback %q 不是三位状态码", candidate)
			}
			status, _ := strconv.Atoi(code)
			if status < 400 || status > 599 {
				return fmt.Errorf("fallback 状态码 %q 必须是 4xx/5xx", candidate)
			}
		case strings.HasPrefix(candidate, "/"):
			if !nginxURIPattern.MatchString(candidate) {
				return fmt.Errorf("候选 URI %q 含非法字符", candidate)
			}
		default:
			return fmt.Errorf("候选 %q 既不是 $uri 形式、也不是 /URI 或 =状态码", candidate)
		}
	}
	return nil
}

// checkReturn 校验 return：只允许跳转语义（3xx + 目标）或无目标的 4xx/5xx。
func checkReturn(v *nginxValidator, args []string) error {
	if len(args) == 0 || len(args) > 2 {
		return fmt.Errorf("参数应为 <code> [target]（当前 %d 项）", len(args))
	}
	if !nginxStatusCodePattern.MatchString(args[0]) {
		return fmt.Errorf("状态码 %q 不是三位数字", args[0])
	}
	status, _ := strconv.Atoi(args[0])
	if len(args) == 1 {
		if status < 400 || status > 599 {
			return fmt.Errorf("单参数 return 只允许 4xx/5xx（跳转必须给目标）：%d", status)
		}
		return nil
	}
	switch status {
	case 301, 302, 303, 307, 308:
	default:
		return fmt.Errorf("带目标的 return 只允许 301/302/303/307/308（当前 %d）", status)
	}
	target := args[1]
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") &&
		!strings.HasPrefix(target, "$scheme://") && !strings.HasPrefix(target, "/") {
		return fmt.Errorf("跳转目标必须以 http(s)://、$scheme:// 或 / 开头：%q", target)
	}
	if !nginxTokenPattern.MatchString(target) {
		return fmt.Errorf("跳转目标含非法字符：%q", target)
	}
	return nil
}

// checkRewrite 校验 rewrite 的三段式。
func checkRewrite(v *nginxValidator, args []string) error {
	if len(args) < 2 || len(args) > 3 {
		return fmt.Errorf("参数应为 <regex> <replacement> [flag]（当前 %d 项）", len(args))
	}
	if utf8.RuneCountInString(args[0]) > maxNginxRegexRunes {
		return fmt.Errorf("正则超过 %d 个字符", maxNginxRegexRunes)
	}
	if !nginxTokenPattern.MatchString(args[0]) {
		return fmt.Errorf("正则含非法字符：%q", args[0])
	}
	replacement := args[1]
	if !strings.HasPrefix(replacement, "/") && !strings.HasPrefix(replacement, "$") &&
		!strings.HasPrefix(replacement, "http://") && !strings.HasPrefix(replacement, "https://") {
		return fmt.Errorf("replacement 必须以 /、$ 或 http(s):// 开头：%q", replacement)
	}
	if !nginxTokenPattern.MatchString(replacement) {
		return fmt.Errorf("replacement 含非法字符：%q", replacement)
	}
	if len(args) == 3 {
		switch args[2] {
		case "last", "break", "redirect", "permanent":
		default:
			return fmt.Errorf("flag %q 不在 {last, break, redirect, permanent} 内", args[2])
		}
	}
	return nil
}

// checkProxyPass 校验反代目标：只允许 http(s)、合法 host:port、拒绝 kore 自身端口。
func checkProxyPass(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个上游（当前 %d 项）", len(args))
	}
	raw := args[0]
	if strings.HasPrefix(raw, "unix:") {
		return fmt.Errorf("不接受 unix: 上游（%q）：本通道只允许 http(s) 目标", raw)
	}
	if strings.Contains(raw, "$") {
		return fmt.Errorf("上游不接受变量（%q）：目标必须可静态判定", raw)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("上游 %q 不是合法 URL：%v", raw, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("上游协议 %q 只允许 http/https", parsed.Scheme)
	}
	if parsed.User != nil {
		return fmt.Errorf("上游不得携带 userinfo")
	}
	if parsed.Host == "" {
		return fmt.Errorf("上游缺少 host")
	}
	if parsed.Fragment != "" {
		return fmt.Errorf("上游不得带 fragment")
	}
	port := 80
	if parsed.Scheme == "https" {
		port = 443
	}
	if parsed.Port() != "" {
		value, err := strconv.Atoi(parsed.Port())
		if err != nil || value < 1 || value > 65535 {
			return fmt.Errorf("上游端口 %q 非法", parsed.Port())
		}
		port = value
	}
	for _, forbidden := range v.policy.ForbiddenProxyPorts {
		if port == forbidden {
			return fmt.Errorf("禁止反代到本机 %d（kore 管理 API 端口）：会把控制面暴露到公网", forbidden)
		}
	}
	return nil
}

// checkProxyHeader 校验 `Header value`。
func checkProxyHeader(v *nginxValidator, args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("参数应为 <name> <value>（当前 %d 项）", len(args))
	}
	if !nginxHeaderNamePattern.MatchString(args[0]) {
		return fmt.Errorf("头名 %q 形状非法", args[0])
	}
	if !nginxTokenPattern.MatchString(args[1]) {
		return fmt.Errorf("头值 %q 含非法字符", args[1])
	}
	return nil
}

// checkProxyHTTPVersion 只允许 1.0 / 1.1。
func checkProxyHTTPVersion(v *nginxValidator, args []string) error {
	if len(args) != 1 || (args[0] != "1.0" && args[0] != "1.1") {
		return fmt.Errorf("只允许 1.0 或 1.1（当前 %v）", args)
	}
	return nil
}

// checkFastCGIPass 校验 FPM 上游：只允许 unix: + 允许目录内的 socket。TCP FPM 不开（可指向任意主机）。
func checkFastCGIPass(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个上游（当前 %d 项）", len(args))
	}
	raw := args[0]
	if !strings.HasPrefix(raw, "unix:") {
		return fmt.Errorf("只允许 unix: socket 上游（TCP FPM 可指向任意主机，未开放）：%q", raw)
	}
	socket := strings.TrimPrefix(raw, "unix:")
	if !strings.HasPrefix(socket, "/") {
		return fmt.Errorf("socket 必须是绝对路径：%q", socket)
	}
	return checkPathInPrefixes(socket, v.policy.FastCGIDirs, "fastcgi socket",
		"FPM socket 必须在标准运行时目录内")
}

// checkFastCGIIndex 校验默认脚本名。
func checkFastCGIIndex(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个文件名（当前 %d 项）", len(args))
	}
	if !nginxFileNamePattern.MatchString(args[0]) || args[0] == "." || args[0] == ".." {
		return fmt.Errorf("文件名 %q 形状非法", args[0])
	}
	return nil
}

// checkFastCGIParam 校验 `NAME value [if_not_empty]`。
func checkFastCGIParam(v *nginxValidator, args []string) error {
	if len(args) < 2 || len(args) > 4 {
		return fmt.Errorf("参数应为 <NAME> <value> [if_not_empty]（当前 %d 项）", len(args))
	}
	if !nginxFastCGIParamNamePattern.MatchString(args[0]) {
		return fmt.Errorf("参数名 %q 形状非法（只允许大写字母/数字/下划线）", args[0])
	}
	values := args[1:]
	if last := values[len(values)-1]; last == "if_not_empty" {
		values = values[:len(values)-1]
	}
	if len(values) == 0 {
		return fmt.Errorf("缺少参数值")
	}
	for _, value := range values {
		if !nginxTokenPattern.MatchString(value) {
			return fmt.Errorf("参数值 %q 含非法字符", value)
		}
	}
	return nil
}

// checkSSLCert 校验证书/私钥路径：必须在受控证书目录内（缺白名单即拒绝，不猜安装路径）。
func checkSSLCert(v *nginxValidator, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("参数应为 1 个路径（当前 %d 项）", len(args))
	}
	if len(v.policy.CertPrefixes) == 0 {
		return fmt.Errorf("证书目录白名单为空（内核须按实际 data/ssl 注入，fail-closed）：%q", args[0])
	}
	return checkPathInPrefixes(args[0], v.policy.CertPrefixes, "证书/私钥路径", "证书必须在受控目录内")
}

// checkSSLProtocols 只允许 TLSv1.2 / TLSv1.3。
func checkSSLProtocols(v *nginxValidator, args []string) error {
	if len(args) == 0 || len(args) > 2 {
		return fmt.Errorf("参数应为 TLSv1.2 / TLSv1.3（当前 %v）", args)
	}
	for _, protocol := range args {
		switch protocol {
		case "TLSv1.2", "TLSv1.3":
		default:
			return fmt.Errorf("协议 %q 不在允许集 {TLSv1.2, TLSv1.3} 内", protocol)
		}
	}
	return nil
}

// checkSSLCiphers 校验套件串字符集（语义安全性由 OpenSSL 与固定串保证）。
func checkSSLCiphers(v *nginxValidator, args []string) error {
	if len(args) != 1 || !nginxCiphersPattern.MatchString(args[0]) {
		return fmt.Errorf("套件串形状非法：%v", args)
	}
	return nil
}

// checkOnOff 校验 on/off 开关。
func checkOnOff(v *nginxValidator, args []string) error {
	if len(args) != 1 || (args[0] != "on" && args[0] != "off") {
		return fmt.Errorf("只允许 on/off（当前 %v）", args)
	}
	return nil
}

// checkSSLSessionCache 校验 shared:NAME:SIZE / builtin / off。
func checkSSLSessionCache(v *nginxValidator, args []string) error {
	if len(args) != 1 || !nginxSessionCachePattern.MatchString(args[0]) {
		return fmt.Errorf("形状非法（allow: off | none | builtin[:size] | shared:name:size）：%v", args)
	}
	return nil
}

// checkSSLSessionTimeout 校验时长（数字 + s/m/h/d）。
func checkSSLSessionTimeout(v *nginxValidator, args []string) error {
	if len(args) != 1 || !nginxSessionTimeoutPattern.MatchString(args[0]) {
		return fmt.Errorf("时长形状非法（例：1d / 10m）：%v", args)
	}
	return nil
}

// checkLocationArgs 校验 location 的参数：只接受 4 种前缀形式或 2 种正则形式。
func (v *nginxValidator) checkLocationArgs(args []string) error {
	if len(args) == 0 || len(args) > 2 {
		return fmt.Errorf("location 参数应为 [修饰符] <path|regex>（当前 %d 项）", len(args))
	}
	if len(args) == 1 {
		return checkLocationPath(args[0])
	}
	switch args[0] {
	case "=", "^~":
		return checkLocationPath(args[1])
	case "~", "~*":
		if utf8.RuneCountInString(args[1]) > maxNginxRegexRunes {
			return fmt.Errorf("location 正则超过 %d 个字符", maxNginxRegexRunes)
		}
		if !nginxTokenPattern.MatchString(args[1]) {
			return fmt.Errorf("location 正则含非法字符：%q", args[1])
		}
		return nil
	default:
		return fmt.Errorf("location 修饰符 %q 不在 {=, ^~, ~, ~*} 内", args[0])
	}
}

// checkLocationPath 校验前缀式 location 的路径。
func checkLocationPath(value string) error {
	if !strings.HasPrefix(value, "/") {
		return fmt.Errorf("location 路径必须以 / 开头：%q", value)
	}
	if !nginxURIPattern.MatchString(value) {
		return fmt.Errorf("location 路径含非法字符：%q", value)
	}
	return nil
}
