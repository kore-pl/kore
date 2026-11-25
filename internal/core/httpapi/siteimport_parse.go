package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// 站点迁移：只读解析「别的面板」的 nginx 站点配置（竞品清单条目 7）。
//
// 设计红线：
//   - 只读：仅 os.ReadDir / WalkDir / ReadFile，不写、不改、不删源面板任何文件；
//     也不加载源面板的数据库（宝塔 SQLite / 1Panel SQLite 都要 sqlite 依赖，G-02 禁）。
//   - 不碰 nginx：不执行 nginx -t / reload，不写任何 vhost（写站点走 site 插件自己的方法）。
//   - G-01：本文件是**只读适配层**（把外部格式翻成显式 DTO），不含站点生命周期逻辑，
//     import 任何插件包；与 handlers_disk.go（只读盘点）同类，属主壳系统能力。
//   - G-24：对外结构全部显式字段，无 any / object / map[string]any。
//   - G-19：无定时器；单次扫描用请求级 ctx（handler 内 WithTimeout + defer cancel）。

const (
	// siteImportMaxFiles 是单次扫描的文件上限（防止指向 / 之类的大目录把内核拖住）。
	siteImportMaxFiles = 240
	// siteImportMaxFileBytes 是单个 conf 的读取上限；正常 vhost 远小于此。
	siteImportMaxFileBytes = 1 << 20
	// siteImportMaxDepth 是递归搜索 .conf 的目录深度上限。
	siteImportMaxDepth = 5
	// siteImportMaxSites 是单次返回的站点条数上限。
	siteImportMaxSites = 240
)

// errNginxUnbalanced 表示花括号不配对（半截文件 / 非 nginx 语法）。
var errNginxUnbalanced = errors.New("配置块的花括号不配对，可能不是 nginx 站点配置")

// ── nginx 配置的极简语法树 ────────────────────────────────────────────────
//
// nginx 配置只需要三样东西：指令名、参数、子块。注释与引号由 tokenizer 收口，
// 词法足够覆盖宝塔 / 1Panel 生成的 vhost（实测样本见 handlers_site_import_test.go）。

type nginxNode struct {
	Name  string
	Args  []string
	Block []nginxNode
}

type nginxToken struct {
	Text string
	Kind byte // 'w' 词 / '{' / '}' / ';'
}

// tokenizeNginx 把配置切成 token；引号内的空白与分号不作为分隔符。
func tokenizeNginx(src []byte) []nginxToken {
	toks := make([]nginxToken, 0, 256)
	i, n := 0, len(src)
	for i < n {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n':
			i++
		case c == '#':
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '{' || c == '}' || c == ';':
			toks = append(toks, nginxToken{Text: string(c), Kind: c})
			i++
		case c == '"' || c == '\'':
			quote := c
			i++
			var b strings.Builder
			for i < n && src[i] != quote {
				if src[i] == '\\' && i+1 < n {
					i++
					b.WriteByte(src[i])
					i++
					continue
				}
				b.WriteByte(src[i])
				i++
			}
			if i < n {
				i++ // 吃掉右引号
			}
			toks = append(toks, nginxToken{Text: b.String(), Kind: 'w'})
		default:
			start := i
			for i < n {
				c2 := src[i]
				if c2 == ' ' || c2 == '\t' || c2 == '\r' || c2 == '\n' ||
					c2 == '{' || c2 == '}' || c2 == ';' || c2 == '#' {
					break
				}
				i++
			}
			if i > start {
				toks = append(toks, nginxToken{Text: string(src[start:i]), Kind: 'w'})
			}
		}
	}
	return toks
}

// parseNginxNodes 把 token 还原成指令树；花括号不配对时返回 errNginxUnbalanced。
func parseNginxNodes(src []byte) ([]nginxNode, error) {
	toks := tokenizeNginx(src)
	type frame struct {
		node  nginxNode
		nodes []nginxNode
	}
	stack := []*frame{{}}
	words := make([]string, 0, 8)
	emit := func(name string, args []string) {
		cp := make([]string, len(args))
		copy(cp, args)
		top := stack[len(stack)-1]
		top.nodes = append(top.nodes, nginxNode{Name: strings.ToLower(name), Args: cp})
	}
	for _, tk := range toks {
		switch tk.Kind {
		case 'w':
			words = append(words, tk.Text)
		case ';':
			if len(words) > 0 {
				emit(words[0], words[1:])
				words = words[:0]
			}
		case '{':
			if len(words) == 0 {
				return nil, errNginxUnbalanced
			}
			cp := make([]string, len(words)-1)
			copy(cp, words[1:])
			stack = append(stack, &frame{node: nginxNode{Name: strings.ToLower(words[0]), Args: cp}})
			words = words[:0]
		case '}':
			if len(stack) == 1 {
				return nil, errNginxUnbalanced
			}
			if len(words) > 0 {
				emit(words[0], words[1:])
				words = words[:0]
			}
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			node := top.node
			node.Block = top.nodes
			parent := stack[len(stack)-1]
			parent.nodes = append(parent.nodes, node)
		}
	}
	if len(stack) != 1 {
		return nil, errNginxUnbalanced
	}
	if len(words) > 0 { // 文件末尾少了分号：宽容收口，不因一个符号判定整站不可读
		emit(words[0], words[1:])
	}
	return stack[0].nodes, nil
}

// nginxServerScan 是单个 server 块里与"能不能搬过来"相关的字段。
type nginxServerScan struct {
	Domains  []string
	Ports    []int
	SSL      bool
	Root     string
	CertPath string
	KeyPath  string
	Proxy    string
	PHP      string
	Index    []string
	Rewrites []string
}

// scanNginxServers 收集指令树里的全部 server 块（含 http{} 包裹的情形）。
func scanNginxServers(nodes []nginxNode) []nginxServerScan {
	out := make([]nginxServerScan, 0, 4)
	var walk func(ns []nginxNode, depth int)
	walk = func(ns []nginxNode, depth int) {
		if depth > 3 {
			return
		}
		for i := range ns {
			n := ns[i]
			if n.Name == "server" && n.Block != nil {
				out = append(out, scanOneServer(n.Block))
				continue
			}
			if n.Block != nil {
				walk(n.Block, depth+1)
			}
		}
	}
	walk(nodes, 0)
	return out
}

// scanOneServer 抽取单个 server 块的关键指令；location 内的覆盖值只在无值时兜底。
func scanOneServer(block []nginxNode) nginxServerScan {
	var s nginxServerScan
	var walk func(ns []nginxNode, depth int)
	walk = func(ns []nginxNode, depth int) {
		if depth > 4 {
			return
		}
		for _, n := range ns {
			switch n.Name {
			case "server_name":
				// nginx 允许把多个域名写在一个引号串里（"a.com b.com"），按空白拆开。
				for _, a := range n.Args {
					for _, one := range strings.Fields(a) {
						one = strings.ToLower(strings.TrimSpace(one))
						if one != "" {
							s.Domains = appendUniq(s.Domains, one)
						}
					}
				}
			case "listen":
				if len(n.Args) > 0 {
					if port := parseListenPort(n.Args[0]); port > 0 {
						s.Ports = appendUniqInt(s.Ports, port)
						if port == 443 {
							s.SSL = true
						}
					}
					for _, a := range n.Args[1:] {
						if strings.EqualFold(a, "ssl") {
							s.SSL = true
						}
					}
				}
			case "ssl":
				if len(n.Args) > 0 && strings.EqualFold(n.Args[0], "on") {
					s.SSL = true
				}
			case "root":
				if v := lastArg(n.Args); v != "" {
					if depth == 0 || s.Root == "" { // server 级 root 优先，location 级只兜底
						s.Root = strings.TrimRight(v, "/")
					}
				}
			case "ssl_certificate":
				if v := lastArg(n.Args); v != "" && s.CertPath == "" {
					s.CertPath = v
				}
			case "ssl_certificate_key":
				if v := lastArg(n.Args); v != "" && s.KeyPath == "" {
					s.KeyPath = v
				}
			case "proxy_pass":
				if v := lastArg(n.Args); v != "" && s.Proxy == "" {
					s.Proxy = v
				}
			case "fastcgi_pass":
				if v := phpFromPath(lastArg(n.Args)); v != "" && s.PHP == "" {
					s.PHP = v
				}
			case "include":
				if v := phpFromInclude(lastArg(n.Args)); v != "" && s.PHP == "" {
					s.PHP = v
				}
			case "index":
				for _, a := range n.Args {
					s.Index = appendUniq(s.Index, a)
				}
			case "rewrite":
				if len(n.Args) > 0 {
					s.Rewrites = append(s.Rewrites, strings.Join(n.Args, " "))
				}
			}
			if n.Block != nil {
				walk(n.Block, depth+1)
			}
		}
	}
	walk(block, 0)
	return s
}

// parseListenPort 从 listen 的第一个参数取端口："443" / "443 ssl" / "1.2.3.4:8080" / "[::]:80"。
func parseListenPort(arg string) int {
	arg = strings.TrimSpace(arg)
	if i := strings.LastIndex(arg, ":"); i >= 0 {
		arg = arg[i+1:]
	}
	arg = strings.Trim(arg, "[]")
	port, err := strconv.Atoi(arg)
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

// phpFromInclude 从 include 目标识别 PHP 版本：enable-php-74.conf → 7.4。
func phpFromInclude(arg string) string {
	lower := strings.ToLower(arg)
	idx := strings.Index(lower, "enable-php")
	if idx < 0 {
		return ""
	}
	rest := lower[idx+len("enable-php"):]
	rest = strings.TrimPrefix(rest, "-")
	var digits strings.Builder
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if (c >= '0' && c <= '9') || c == '.' {
			digits.WriteByte(c)
			continue
		}
		break
	}
	return normalizePHPVersion(digits.String())
}

// phpFromPath 从 fastcgi_pass 目标识别 PHP 版本：
// unix:/tmp/php-cgi-74.sock → 7.4；/run/php/php8.2-fpm.sock → 8.2；127.0.0.1:9000 → 认不出返回空。
func phpFromPath(arg string) string {
	lower := strings.ToLower(arg)
	idx := strings.Index(lower, "php-cgi-")
	if idx >= 0 {
		rest := lower[idx+len("php-cgi-"):]
		var digits strings.Builder
		for i := 0; i < len(rest); i++ {
			c := rest[i]
			if (c >= '0' && c <= '9') || c == '.' {
				digits.WriteByte(c)
				continue
			}
			break
		}
		if v := normalizePHPVersion(digits.String()); v != "" {
			return v
		}
	}
	idx = strings.Index(lower, "php")
	if idx < 0 {
		return ""
	}
	rest := lower[idx+len("php"):]
	var digits strings.Builder
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if (c >= '0' && c <= '9') || c == '.' {
			digits.WriteByte(c)
			continue
		}
		if digits.Len() > 0 {
			break
		}
		return "" // php-fpm.sock 这类不带版本号：认不出
	}
	return normalizePHPVersion(digits.String())
}

// normalizePHPVersion 把 "74" / "8" / "8.2" 归一成 "7.4" / "8" / "8.2"。
func normalizePHPVersion(raw string) string {
	raw = strings.Trim(raw, ".")
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, ".") {
		return raw
	}
	switch len(raw) {
	case 1:
		return raw
	case 2:
		return raw[:1] + "." + raw[1:]
	default:
		return ""
	}
}

func lastArg(args []string) string {
	for i := len(args) - 1; i >= 0; i-- {
		if v := strings.TrimSpace(args[i]); v != "" {
			return v
		}
	}
	return ""
}

func appendUniq(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

func appendUniqInt(list []int, v int) []int {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

// ── 面板定位与配置目录发现 ────────────────────────────────────────────────

type siteImportPanelDef struct {
	ID       string
	Label    string
	Root     string
	ConfDirs []string // 相对 Root 的候选目录，按优先顺序探测
	Note     string   // 未检测到时的提示（说清装在哪）
}

// siteImportPanels 是支持的源面板清单。只认"可只读解析的配置文件"，
// 不认 SQLite（宝塔 / 1Panel 的站点元数据在 SQLite 里，读它要 sqlite 依赖，G-02 禁止）。
var siteImportPanels = []siteImportPanelDef{
	{
		ID: "bt", Label: "宝塔面板", Root: "/www/server/panel",
		ConfDirs: []string{"vhost/nginx", "vhost/nginx/conf.d", "vhost"},
		Note:     "宝塔的站点配置在 /www/server/panel/vhost/nginx/*.conf，本机没有这个目录说明未装宝塔或装在自定义位置",
	},
	{
		ID: "1panel", Label: "1Panel", Root: "/opt/1panel",
		ConfDirs: []string{
			"apps/openresty/openresty/conf/conf.d",
			"apps/openresty/conf/conf.d",
			"www/sites",
			"apps",
		},
		Note: "1Panel 的站点配置在 /opt/1panel/apps/openresty/openresty/conf/conf.d/*.conf，本机没有这个目录说明未装 1Panel 或装在自定义位置",
	},
}

// resolvePanelConfDir 返回第一个存在的配置目录（相对 root 的候选顺序）。
func resolvePanelConfDir(root string, def siteImportPanelDef) string {
	for _, rel := range def.ConfDirs {
		dir := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Stat(dir)
		if err == nil && info.IsDir() {
			return dir
		}
	}
	return ""
}

// detectSiteImportSources 探测本机（或给定根目录下）有哪些源面板可用。
func detectSiteImportSources(root string) []siteImportSource {
	out := make([]siteImportSource, 0, len(siteImportPanels))
	for _, def := range siteImportPanels {
		base := root
		if base == "" {
			base = def.Root
		}
		dir := resolvePanelConfDir(base, def)
		src := siteImportSource{
			Panel: def.ID, Label: def.Label, Root: base,
			Available: dir != "", ConfDir: dir, Note: def.Note,
		}
		if dir != "" {
			src.Note = "已找到站点配置目录，可直接扫描"
		}
		out = append(out, src)
	}
	return out
}

// siteImportConfFile 是一个待解析的 conf 文件（绝对路径）。
type siteImportConfFile struct {
	Path string
}

// findSiteImportConfFiles 在 dir 下递归收集 *.conf；返回"目录不存在"与"超限"两类提示。
func findSiteImportConfFiles(ctx context.Context, dir string) (files []siteImportConfFile, note string) {
	baseDepth := strings.Count(filepath.Clean(dir), string(filepath.Separator))
	truncated := false
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || ctx.Err() != nil {
			return nil
		}
		if d.IsDir() {
			depth := strings.Count(filepath.Clean(path), string(filepath.Separator)) - baseDepth
			if depth > siteImportMaxDepth {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".conf") {
			return nil
		}
		if len(files) >= siteImportMaxFiles {
			truncated = true
			return filepath.SkipAll
		}
		files = append(files, siteImportConfFile{Path: path})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	if truncated {
		note = fmt.Sprintf("配置文件超过 %d 个，本次只解析前 %d 个；请缩小到具体站点目录后再扫一次", siteImportMaxFiles, siteImportMaxFiles)
	}
	return files, note
}
