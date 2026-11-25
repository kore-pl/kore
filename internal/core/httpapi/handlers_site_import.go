package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 站点迁移扫描端点：GET /api/v1/site-import/scan?root=&panel=
//
// 它只做一件事：把**别的面板**写的 nginx 站点配置读成显式 DTO，供「站点迁移」向导
// 预览、勾选、逐条说明「为什么不支持 + 怎么办」。真正的建站不走这里——向导拿到勾选
// 后调 site 插件自己的 site.create（权限 / 审计 / nginx -t / 回滚都在插件侧）。
//
// 为什么只读：
//   - 迁移的第一步是"先看清楚"，写动作必须显式确认（USABILITY §7：危险操作的可逆性优先）；
//   - 源面板是**别人的系统**，任何写入都可能把它弄坏——只读是硬约束；
//   - 本端点不 import 插件包、不执行外部命令、不碰 nginx（G-01）。
//
// 挂点由 server.go 的 New() 调用 registerSiteImportRoutes() 完成，
// 与 handlers_logalerts.go 同策略：不碰 handlers.go 的 routes()（并行写域）。

const siteImportScanPath = "/api/v1/site-import/scan"

// siteImportScanTimeout 是单次扫描的硬上限；超时返回已解析部分并标 partial。
const siteImportScanTimeout = 5 * time.Second

// siteImportSource 是一个源面板的探测结果（显式 DTO，G-24）。
type siteImportSource struct {
	Panel     string `json:"panel"`     // bt / 1panel
	Label     string `json:"label"`     // 宝塔面板 / 1Panel
	Root      string `json:"root"`      // 探测的根目录
	ConfDir   string `json:"conf_dir"`  // 实际命中的站点配置目录
	Available bool   `json:"available"` // true = 本机有这个面板的配置
	Note      string `json:"note"`      // 给用户看的一句说明
}

// siteImportIssue 是「为什么不支持」的一条原因（reason + 怎么办 hint）。
type siteImportIssue struct {
	Reason string `json:"reason"`
	Hint   string `json:"hint"`
}

// siteImportSite 是一个可预览的站点（显式 DTO，G-24）。
type siteImportSite struct {
	ID            string            `json:"id"`
	Panel         string            `json:"panel"`
	ConfPath      string            `json:"conf_path"`
	Domains       []string          `json:"domains"`   // 原始 server_name 列表
	Aliases       []string          `json:"aliases"`   // 除主域名外的其余域名（导入后需手工添加）
	PrimaryDomain string            `json:"primary_domain"`
	Root          string            `json:"root"`
	Kind          string            `json:"kind"`       // static / php / proxy / unknown
	KindLabel     string            `json:"kind_label"` // 静态站点 / PHP 站点 / 反向代理 / 未识别
	PHPVersion    string            `json:"php_version"`
	ProxyUpstream string            `json:"proxy_upstream"`
	Ports         []int             `json:"ports"`
	HTTPS         bool              `json:"https"`
	SSLCert       string            `json:"ssl_cert"`
	SSLKey        string            `json:"ssl_key"`
	SSLReady      bool              `json:"ssl_ready"` // 证书与私钥在**本机**存在且可读
	Importable    bool              `json:"importable"`
	Blockers      []siteImportIssue `json:"blockers"`
	Notes         []string          `json:"notes"`
}

// siteImportSkip 是一个没能解析成站点的文件（逐条说明原因与怎么办）。
type siteImportSkip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Hint   string `json:"hint"`
}

// siteImportScanBody 是扫描响应（显式 DTO，G-24）。
type siteImportScanBody struct {
	Panel      string             `json:"panel"`       // bt / 1panel / generic / none
	PanelLabel string             `json:"panel_label"`
	SourceRoot string             `json:"source_root"`
	ConfDir    string             `json:"conf_dir"`
	Scanned    int                `json:"scanned"`     // 成功解析的文件数
	Partial    bool               `json:"partial"`     // true = 有文件因超时/超限未解析
	Sites      []siteImportSite   `json:"sites"`
	Skipped    []siteImportSkip   `json:"skipped"`
	Warnings   []string           `json:"warnings"`
	Detected   []siteImportSource `json:"detected"`
	Note       string             `json:"note"`
}

// registerSiteImportRoutes 注册站点迁移的只读路由。
func (s *Server) registerSiteImportRoutes() {
	s.mux.HandleFunc("GET "+siteImportScanPath, s.handleSiteImportScan)
	s.mux.HandleFunc(siteImportScanPath+"/", s.handleNotFound)
}

// handleSiteImportScan 只读扫描源面板的站点配置。
func (s *Server) handleSiteImportScan(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTargetAction(w, r) {
		return
	}
	root := strings.TrimSpace(r.URL.Query().Get("root"))
	panel := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("panel")))
	if len(root) > 512 {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"目录路径过长，请填到站点配置所在的目录", "例：/www/server/panel/vhost/nginx")
		return
	}
	if panel != "" && panel != "auto" && panel != "bt" && panel != "1panel" {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID,
			"不支持的面板类型", "目前支持宝塔面板与 1Panel；其它面板请用「自定义目录」直接指向站点配置目录")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), siteImportScanTimeout)
	defer cancel()

	body, err := scanSiteImport(ctx, root, panel)
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(),
			"请确认目录存在且当前账号可读；图省事可以先留空让 Kore 自动检测")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, body)
}

// scanSiteImport 是扫描主流程：定位目录 → 读文件 → 解析 → 合并 → 出 DTO。
func scanSiteImport(ctx context.Context, root, panel string) (siteImportScanBody, error) {
	body := siteImportScanBody{
		Sites: []siteImportSite{}, Skipped: []siteImportSkip{}, Warnings: []string{},
		Detected: detectSiteImportSources(root),
	}
	if root != "" {
		info, err := os.Stat(root)
		if err != nil {
			return body, fmt.Errorf("目录 %s 不存在或不可访问", root)
		}
		if !info.IsDir() {
			return body, fmt.Errorf("%s 不是目录", root)
		}
	}

	def, confDir := pickSiteImportTarget(root, panel)
	switch {
	case confDir == "" && root == "":
		body.Panel = "none"
		body.PanelLabel = "未检测到"
		body.Note = "本机没有发现宝塔面板或 1Panel 的站点配置目录。若面板装在自定义位置，" +
			"请在「自定义目录」里填它的站点配置目录（宝塔一般是 vhost/nginx，1Panel 一般是 " +
			"apps/openresty/openresty/conf/conf.d）。"
		return body, nil
	case confDir == "":
		// 用户直接指向了某个目录：就地扫它（支持任意布局与样例目录）
		confDir = root
		def = siteImportPanelDef{ID: "generic", Label: "自定义目录"}
	}
	body.Panel = def.ID
	body.PanelLabel = def.Label
	body.ConfDir = confDir
	if root != "" {
		body.SourceRoot = root
	} else {
		body.SourceRoot = def.Root
	}

	files, note := findSiteImportConfFiles(ctx, confDir)
	if note != "" {
		body.Warnings = append(body.Warnings, note)
		body.Partial = true
	}
	if len(files) == 0 {
		body.Note = "该目录下没有找到 .conf 站点配置。请确认目录是否选对，再从「自定义目录」扫一次。"
		return body, nil
	}

	cands := make([]siteImportCandidate, 0, len(files))
	for _, f := range files {
		if ctx.Err() != nil {
			body.Partial = true
			body.Warnings = append(body.Warnings, "扫描超时，已返回解析完成的部分；可缩小到具体站点目录后再扫一次")
			break
		}
		scans, skip, err := loadSiteImportFile(f.Path)
		if err != nil {
			body.Skipped = append(body.Skipped, *skip)
			continue
		}
		body.Scanned++
		cands = append(cands, siteImportCandidate{panel: def.ID, confPath: f.Path, scans: scans})
	}

	sites, skips := buildSiteImportSites(cands)
	body.Sites = sites
	body.Skipped = append(body.Skipped, skips...)
	sort.Slice(body.Skipped, func(i, j int) bool { return body.Skipped[i].Path < body.Skipped[j].Path })
	markSiteImportDuplicates(body.Sites)
	if len(body.Sites) == 0 && len(body.Skipped) > 0 {
		body.Note = "这些文件都不是站点定义，暂无可导入的站点。详情见下方逐条说明。"
	}
	return body, nil
}

// pickSiteImportTarget 选面板与配置目录：显式 root 优先，其次自动检测标准位置。
func pickSiteImportTarget(root, panel string) (siteImportPanelDef, string) {
	bases := make([]struct {
		def    siteImportPanelDef
		root   string
	}, 0, len(siteImportPanels))
	for _, def := range siteImportPanels {
		base := root
		if base == "" {
			base = def.Root
		}
		if panel != "" && panel != "auto" && panel != def.ID {
			continue
		}
		bases = append(bases, struct {
			def  siteImportPanelDef
			root string
		}{def: def, root: base})
	}
	for _, b := range bases {
		if dir := resolvePanelConfDir(b.root, b.def); dir != "" {
			return b.def, dir
		}
	}
	return siteImportPanelDef{}, ""
}

// siteImportCandidate 是一个文件解析出的 server 块集合。
type siteImportCandidate struct {
	panel    string
	confPath string
	scans    []nginxServerScan
}

// loadSiteImportFile 读并解析单个 conf；返回 (server 块, skip 说明, err)。
func loadSiteImportFile(path string) ([]nginxServerScan, *siteImportSkip, error) {
	skip := &siteImportSkip{Path: path}
	info, err := os.Stat(path)
	if err != nil {
		skip.Reason = "文件读不到：" + err.Error()
		skip.Hint = "请确认当前账号有读取权限；也可把该文件复制到其它目录后再扫"
		return nil, skip, err
	}
	if info.Size() > siteImportMaxFileBytes {
		skip.Reason = fmt.Sprintf("文件超过 %d KiB，本页只解析正常大小的站点配置", siteImportMaxFileBytes/1024)
		skip.Hint = "请手工对照该文件在「网站」页创建站点"
		return nil, skip, fmt.Errorf("file too large")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		skip.Reason = "文件读不到：" + err.Error()
		skip.Hint = "请确认当前账号有读取权限"
		return nil, skip, err
	}
	nodes, err := parseNginxNodes(raw)
	if err != nil {
		skip.Reason = "解析失败：" + err.Error()
		skip.Hint = "先在原面板确认该文件能被 nginx 正常加载，或对照文件在「网站」页手工创建站点"
		return nil, skip, err
	}
	scans := scanNginxServers(nodes)
	if len(scans) == 0 {
		skip.Reason = "该文件不含 server 块（通常是全局配置或 upstream 定义）"
		skip.Hint = "无需导入，直接忽略即可"
		return nil, skip, fmt.Errorf("no server block")
	}
	return scans, nil, nil
}

// buildSiteImportSites 把 server 块合并成站点 DTO，并给每个不可导入项写原因与怎么办。
func buildSiteImportSites(cands []siteImportCandidate) ([]siteImportSite, []siteImportSkip) {
	sites := make([]siteImportSite, 0, len(cands))
	skips := make([]siteImportSkip, 0)
	for _, cand := range cands {
		merged := mergeServerScans(cand.scans)
		if len(merged) == 0 {
			continue
		}
		for idx, scan := range merged {
			if len(sites) >= siteImportMaxSites {
				skips = append(skips, siteImportSkip{
					Path: cand.confPath, Reason: "本次解析的站点已达上限",
					Hint: "请缩小到具体站点目录后再扫一次",
				})
				break
			}
			sites = append(sites, newSiteImportSite(cand.panel, cand.confPath, idx, scan))
		}
	}
	return sites, skips
}

// mergeServerScans 合并同文件里域名集合相同的 server 块（宝塔 80 与 443 常写成两块）。
func mergeServerScans(scans []nginxServerScan) []nginxServerScan {
	out := make([]nginxServerScan, 0, len(scans))
	index := make(map[string]int, len(scans))
	for _, scan := range scans {
		key := strings.Join(scan.Domains, "|")
		if pos, ok := index[key]; ok {
			// 同一个域名集合：合并端口 / 证书 / 根目录等字段
			cur := out[pos]
			for _, p := range scan.Ports {
				cur.Ports = appendUniqInt(cur.Ports, p)
			}
			cur.SSL = cur.SSL || scan.SSL
			if cur.Root == "" {
				cur.Root = scan.Root
			}
			if cur.CertPath == "" {
				cur.CertPath = scan.CertPath
			}
			if cur.KeyPath == "" {
				cur.KeyPath = scan.KeyPath
			}
			if cur.Proxy == "" {
				cur.Proxy = scan.Proxy
			}
			if cur.PHP == "" {
				cur.PHP = scan.PHP
			}
			for _, x := range scan.Index {
				cur.Index = appendUniq(cur.Index, x)
			}
			cur.Rewrites = append(cur.Rewrites, scan.Rewrites...)
			out[pos] = cur
			continue
		}
		index[key] = len(out)
		out = append(out, scan)
	}
	return out
}

// koreDomainOK 与 site 插件同口径的域名判定（小写字母数字连字符与点，至少两个标签）。
func koreDomainOK(domain string) bool {
	if domain == "" || len(domain) > 253 {
		return false
	}
	if domain != strings.ToLower(domain) {
		return false
	}
	if strings.ContainsAny(domain, "*_$/: ") {
		return false
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return false
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
				continue
			}
			return false
		}
	}
	return true
}

// newSiteImportSite 把一次合并结果翻成 DTO：能导的标 can，不能导的写清原因与怎么办。
func newSiteImportSite(panel, confPath string, idx int, scan nginxServerScan) siteImportSite {
	site := siteImportSite{
		Panel: panel, ConfPath: confPath,
		Domains: []string{}, Aliases: []string{},
		Blockers: []siteImportIssue{}, Notes: []string{},
		Root: scan.Root, Ports: scan.Ports, HTTPS: scan.SSL,
		SSLCert: scan.CertPath, SSLKey: scan.KeyPath,
		ProxyUpstream: scan.Proxy, PHPVersion: scan.PHP,
	}
	valid := make([]string, 0, len(scan.Domains))
	invalid := make([]string, 0)
	for _, d := range scan.Domains {
		if d == "_" || d == "localhost" {
			invalid = append(invalid, d)
			continue
		}
		if koreDomainOK(d) {
			valid = append(valid, d)
			continue
		}
		invalid = append(invalid, d)
	}
	site.Domains = append(site.Domains, scan.Domains...)
	if len(valid) > 0 {
		site.PrimaryDomain = valid[0]
		site.Aliases = append(site.Aliases, valid[1:]...)
	}
	site.ID = fmt.Sprintf("%s:%d:%s", panel, idx, site.PrimaryDomain)

	switch {
	case scan.Proxy != "":
		site.Kind = "proxy"
		site.KindLabel = "反向代理"
	case scan.PHP != "":
		site.Kind = "php"
		site.KindLabel = "PHP 站点"
	case scan.Root != "":
		site.Kind = "static"
		site.KindLabel = "静态站点"
	default:
		site.Kind = "unknown"
		site.KindLabel = "未识别"
	}

	if len(invalid) > 0 {
		site.Notes = append(site.Notes, "这些域名 Kore 不能直接建站："+strings.Join(invalid, "、")+
			"（例：下划线、通配符或占位名）；导入后请在站点详情里手工添加")
	}
	if len(site.Aliases) > 0 {
		site.Notes = append(site.Notes, fmt.Sprintf("原站还有 %d 个别名域名（%s）：导入只写主域名 %s，别名需在站点详情手工添加",
			len(site.Aliases), strings.Join(site.Aliases, "、"), site.PrimaryDomain))
	}
	if len(scan.Ports) > 0 {
		site.Notes = append(site.Notes, fmt.Sprintf("原站监听端口：%s", joinInts(scan.Ports)))
	}
	if scan.Root == "" {
		if site.Kind == "static" || site.Kind == "php" {
			site.Notes = append(site.Notes, "原配置没写网站根目录，导入后 Kore 会用默认目录 /var/www/"+site.PrimaryDomain+
				"；请把网站文件放到该目录，或在站点详情改成原目录")
		}
	}
	if scan.Proxy != "" {
		site.Notes = append(site.Notes, "反向代理上游："+scan.Proxy+
			"；导入只建站点，上游地址需在站点详情「反向代理」里重新保存")
	}
	if scan.PHP != "" {
		site.Notes = append(site.Notes, "原站使用 PHP "+scan.PHP+
			"；导入时会尝试启用，本机没有该版本时站点按静态站导入（可到「运行环境」装好后再开）")
	}
	if scan.CertPath != "" {
		certOK, keyOK := fileReadable(scan.CertPath), fileReadable(scan.KeyPath)
		site.SSLReady = certOK && keyOK
		if site.SSLReady {
			site.Notes = append(site.Notes, "原站证书可用（"+scan.CertPath+"）：导入后可在站点详情一键绑定 HTTPS")
		} else {
			site.Notes = append(site.Notes, "原站写了证书路径但本机读不到（"+scan.CertPath+"）：导入后需重新签发或上传证书")
		}
	}

	// ── 不可导入：逐条原因 + 怎么办 ──
	if site.PrimaryDomain == "" {
		raw := strings.Join(scan.Domains, "、")
		if raw == "" {
			raw = "（空）"
		}
		site.Blockers = append(site.Blockers, siteImportIssue{
			Reason: "没有可用的域名，原配置的 server_name 是：" + raw,
			Hint:   "这种配置通常只做端口转发或占位；请到「网站」页手工创建站点并填真实域名",
		})
	}
	if strings.Contains(scan.Root, "$") {
		site.Blockers = append(site.Blockers, siteImportIssue{
			Reason: "网站根目录是变量（" + scan.Root + "），Kore 无法确定真实目录",
			Hint:   "请到「网站」页手工创建站点并把根目录填成实际路径（去掉变量的那一层目录）",
		})
	}
	site.Importable = len(site.Blockers) == 0
	return site
}

// markSiteImportDuplicates 标出本次扫描里域名重复的站点（多半是两个文件同时生效）。
func markSiteImportDuplicates(sites []siteImportSite) {
	seen := make(map[string]int, len(sites))
	for i := range sites {
		d := sites[i].PrimaryDomain
		if d == "" {
			continue
		}
		if first, ok := seen[d]; ok {
			sites[i].Importable = false
			sites[i].Blockers = append(sites[i].Blockers, siteImportIssue{
				Reason: fmt.Sprintf("域名 %s 与 %s 重复（同一域名在两个文件里各写了一次）", d, sites[first].ConfPath),
				Hint:   "请先确认哪个文件是生效的，把废弃的那个移走后再扫一次；直接导入会互相覆盖",
			})
			continue
		}
		seen[d] = i
	}
}

// fileReadable 判断本机能否读到该文件（只读探测，不读内容）。
func fileReadable(path string) bool {
	if path == "" {
		return false
	}
	f, err := os.Open(filepath.Clean(path))
	if err != nil {
		slog.Debug("站点迁移：证书文件不可读", "path", path, "err", err)
		return false
	}
	_ = f.Close()
	return true
}

func joinInts(nums []int) string {
	parts := make([]string, 0, len(nums))
	for _, n := range nums {
		parts = append(parts, fmt.Sprintf("%d", n))
	}
	return strings.Join(parts, "、")
}
