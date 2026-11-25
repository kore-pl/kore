package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// 宝塔样本：静态站点（listen 80 + server_name + root + index）。
const btStaticConf = `
server
{
    listen 80;
    server_name demo.kore.test www.demo.kore.test;
    index index.php index.html index.htm default.php default.htm default.html;
    root /www/wwwroot/demo.kore.test;

    #SSL-START SSL相关配置
    #error_page 404/404.html;
    #SSL-END

    #REWRITE-START
    include /www/server/panel/vhost/rewrite/demo.kore.test.conf;
    #REWRITE-END

    location ~ .*\\.(gif|jpg|jpeg|png|bmp|swf)$
    {
        expires      30d;
        error_log /dev/null;
        access_log /dev/null;
    }

    location ~ .*\\.(js|css)?$
    {
        expires      12h;
        error_log /dev/null;
        access_log /dev/null;
    }
    access_log  /www/wwwlogs/demo.kore.test.log;
    error_log  /www/wwwlogs/demo.kore.test.error.log;
}
`

// 宝塔样本：PHP 站点（include enable-php-74.conf + fastcgi_pass php-cgi-74.sock）。
const btPHPConf = `
server
{
    listen 80;
    server_name php.kore.test;
    index index.php index.html;
    root /www/wwwroot/php.kore.test;

    include enable-php-74.conf;

    location ~ [^/]\\.php(/|$)
    {
        try_files $uri =404;
        fastcgi_pass unix:/tmp/php-cgi-74.sock;
        fastcgi_index index.php;
        include fastcgi.conf;
    }
}
`

// 宝塔样本：80 与 443 两个 server 块同域名（开 SSL 后的真实形态）+ 反向代理。
const btSSLProxyConf = `
server
{
    listen 80;
    server_name app.kore.test;
    return 301 https://$host$request_uri;
}
server
{
    listen 443 ssl http2;
    server_name app.kore.test;
    root /www/wwwroot/app.kore.test;
    ssl_certificate    /www/server/panel/vhost/cert/app.kore.test/fullchain.pem;
    ssl_certificate_key    /www/server/panel/vhost/cert/app.kore.test/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
`

// 1Panel 样本：OpenResty 站点（enable-php-82.conf）。
const onePanelConf = `
server {
    listen 80;
    server_name panel.kore.test;
    root /opt/1panel/www/sites/panel.kore.test/index;
    index index.php index.html;

    include /opt/1panel/apps/openresty/openresty/conf/enable-php-82.conf;
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
}
`

// 无法导入样本：server_name 是占位符 + 根目录是变量。
const btBrokenConf = `
server
{
    listen 80;
    server_name _;
    root /www/wwwroot/$host;
}
`

func scanConfText(t *testing.T, text string) []siteImportSite {
	t.Helper()
	nodes, err := parseNginxNodes([]byte(text))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	scans := scanNginxServers(nodes)
	sites, _ := buildSiteImportSites([]siteImportCandidate{
		{panel: "bt", confPath: "/tmp/sample.conf", scans: scans},
	})
	return sites
}

// TestSiteImportBtStatic 验证宝塔静态站点被识别为主域名 + 别名 + 静态类型。
func TestSiteImportBtStatic(t *testing.T) {
	sites := scanConfText(t, btStaticConf)
	if len(sites) != 1 {
		t.Fatalf("站点数 = %d，期望 1", len(sites))
	}
	s := sites[0]
	if s.PrimaryDomain != "demo.kore.test" {
		t.Fatalf("主域名 = %q，期望 demo.kore.test", s.PrimaryDomain)
	}
	if len(s.Aliases) != 1 || s.Aliases[0] != "www.demo.kore.test" {
		t.Fatalf("别名 = %v，期望 [www.demo.kore.test]", s.Aliases)
	}
	if s.Root != "/www/wwwroot/demo.kore.test" {
		t.Fatalf("根目录 = %q", s.Root)
	}
	if s.Kind != "static" || s.KindLabel != "静态站点" {
		t.Fatalf("类型 = %s/%s，期望 static/静态站点", s.Kind, s.KindLabel)
	}
	if !s.Importable {
		t.Fatalf("应可导入，blockers=%v", s.Blockers)
	}
}

// TestSiteImportBtPHP 验证 PHP 版本识别（enable-php-74.conf → 7.4）。
func TestSiteImportBtPHP(t *testing.T) {
	sites := scanConfText(t, btPHPConf)
	if len(sites) != 1 {
		t.Fatalf("站点数 = %d，期望 1", len(sites))
	}
	if sites[0].Kind != "php" || sites[0].PHPVersion != "7.4" {
		t.Fatalf("类型/版本 = %s/%s，期望 php/7.4", sites[0].Kind, sites[0].PHPVersion)
	}
}

// TestSiteImportMergeSSLBlocks 验证同域名 80 + 443 两块合并、识别反代与证书路径。
func TestSiteImportMergeSSLBlocks(t *testing.T) {
	sites := scanConfText(t, btSSLProxyConf)
	if len(sites) != 1 {
		t.Fatalf("站点数 = %d，期望合并为 1（同域名两个 server 块）", len(sites))
	}
	s := sites[0]
	if !s.HTTPS {
		t.Fatal("HTTPS 应为 true（443 + ssl）")
	}
	if len(s.Ports) != 2 || s.Ports[0] != 80 || s.Ports[1] != 443 {
		t.Fatalf("端口 = %v，期望 [80 443]", s.Ports)
	}
	if s.Kind != "proxy" || s.ProxyUpstream != "http://127.0.0.1:3000" {
		t.Fatalf("类型/上游 = %s/%q，期望 proxy/http://127.0.0.1:3000", s.Kind, s.ProxyUpstream)
	}
	if s.SSLCert == "" || s.SSLKey == "" {
		t.Fatalf("证书路径未解析: cert=%q key=%q", s.SSLCert, s.SSLKey)
	}
	if s.SSLReady {
		t.Fatal("证书文件在本机不存在，SSLReady 应为 false")
	}
}

// TestSiteImport1Panel 验证 1Panel 的 OpenResty 站点（enable-php-82.conf → 8.2）。
func TestSiteImport1Panel(t *testing.T) {
	nodes, err := parseNginxNodes([]byte(onePanelConf))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	sites, _ := buildSiteImportSites([]siteImportCandidate{
		{panel: "1panel", confPath: "/opt/1panel/apps/openresty/openresty/conf/conf.d/panel.conf",
			scans: scanNginxServers(nodes)},
	})
	if len(sites) != 1 {
		t.Fatalf("站点数 = %d，期望 1", len(sites))
	}
	if sites[0].PHPVersion != "8.2" {
		t.Fatalf("PHP 版本 = %q，期望 8.2", sites[0].PHPVersion)
	}
	if sites[0].Root != "/opt/1panel/www/sites/panel.kore.test/index" {
		t.Fatalf("根目录 = %q", sites[0].Root)
	}
}

// TestSiteImportBlockers 验证占位域名与变量根目录被逐条列出原因 + 怎么办。
func TestSiteImportBlockers(t *testing.T) {
	sites := scanConfText(t, btBrokenConf)
	if len(sites) != 1 {
		t.Fatalf("站点数 = %d，期望 1", len(sites))
	}
	s := sites[0]
	if s.Importable {
		t.Fatal("占位域名 + 变量根目录不应标记为可导入")
	}
	if len(s.Blockers) != 2 {
		t.Fatalf("blockers = %d 条，期望 2 条（域名不可用 / 根目录是变量）", len(s.Blockers))
	}
	for _, b := range s.Blockers {
		if b.Reason == "" || b.Hint == "" {
			t.Fatalf("每条 blocker 必须有 reason 与 hint: %+v", b)
		}
	}
}

// TestSiteImportUnbalanced 验证花括号不配对的半截文件被拒绝（不静默产出错站点）。
func TestSiteImportUnbalanced(t *testing.T) {
	if _, err := parseNginxNodes([]byte("server { listen 80; server_name a.kore.test;")); err == nil {
		t.Fatal("未闭合的配置应返回错误")
	}
}

// TestSiteImportQuotedValues 验证引号内的空格与分号不会被当成分隔符。
func TestSiteImportQuotedValues(t *testing.T) {
	nodes, err := parseNginxNodes([]byte("server { server_name \"a.kore.test b.kore.test\"; return 200 \"a;b\"; }"))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	scans := scanNginxServers(nodes)
	if len(scans) != 1 || len(scans[0].Domains) != 2 {
		t.Fatalf("引号内的多个域名应被拆成 2 个：%+v", scans)
	}
}

// TestSiteImportScanDir 验证目录扫描：宝塔布局命中、坏文件进 skipped、域名重复被标出。
func TestSiteImportScanDir(t *testing.T) {
	root := t.TempDir()
	confDir := filepath.Join(root, "vhost", "nginx")
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(confDir, name), []byte(body), 0o600); err != nil {
			t.Fatalf("写样例失败: %v", err)
		}
	}
	write("demo.kore.test.conf", btStaticConf)
	write("php.kore.test.conf", btPHPConf)
	write("broken.conf", "server { listen 80;")
	write("upstream-only.conf", "upstream backend { server 127.0.0.1:9000; }")
	write("dup.kore.test.conf", `
server
{
    listen 80;
    server_name demo.kore.test;
    root /www/wwwroot/dup.kore.test;
}
`)

	body, err := scanSiteImport(t.Context(), root, "bt")
	if err != nil {
		t.Fatalf("扫描失败: %v", err)
	}
	if body.Panel != "bt" || body.PanelLabel != "宝塔面板" {
		t.Fatalf("面板 = %s/%s，期望 bt/宝塔面板", body.Panel, body.PanelLabel)
	}
	if body.Scanned != 3 {
		t.Fatalf("成功解析文件数 = %d，期望 3（5 个文件里 2 个不可解析）", body.Scanned)
	}
	if len(body.Sites) != 3 {
		t.Fatalf("站点数 = %d，期望 3", len(body.Sites))
	}
	if len(body.Skipped) != 2 {
		t.Fatalf("跳过文件数 = %d，期望 2（语法坏 + 无 server 块）", len(body.Skipped))
	}
	importable := 0
	dupFlagged := 0
	for _, s := range body.Sites {
		if s.Importable {
			importable++
		}
		for _, b := range s.Blockers {
			if s.PrimaryDomain == "demo.kore.test" && len(b.Reason) > 0 {
				dupFlagged++
			}
		}
	}
	if importable != 2 {
		t.Fatalf("可导入站点数 = %d，期望 2（重复域名那条不可导入）", importable)
	}
	if dupFlagged == 0 {
		t.Fatal("重复域名应及时标出（同一域名在两个文件里各写一次）")
	}
}

// TestSiteImportScanHandler 验证端点：鉴权骨架下 200 + JSON 形状；目录不存在时 400。
func TestSiteImportScanHandler(t *testing.T) {
	root := t.TempDir()
	confDir := filepath.Join(root, "vhost", "nginx")
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(confDir, "demo.conf"), []byte(btStaticConf), 0o600); err != nil {
		t.Fatalf("写样例失败: %v", err)
	}
	srv := newTestServer()

	rec := serve(t, srv, http.MethodGet, siteImportScanPath+"?root="+root)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200；body=%s", rec.Code, rec.Body.String())
	}
	var body siteImportScanBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if len(body.Sites) != 1 || body.Sites[0].PrimaryDomain != "demo.kore.test" {
		t.Fatalf("站点解析不符合预期: %+v", body.Sites)
	}

	bad := serve(t, srv, http.MethodGet, siteImportScanPath+"?root=/nonexistent-kore-dir")
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("不存在目录状态码 = %d，期望 400", bad.Code)
	}

	blank := serve(t, srv, http.MethodGet, siteImportScanPath)
	if blank.Code != http.StatusOK {
		t.Fatalf("自动检测状态码 = %d，期望 200", blank.Code)
	}
	var auto siteImportScanBody
	if err := json.Unmarshal(blank.Body.Bytes(), &auto); err != nil {
		t.Fatalf("自动检测响应不是 JSON: %v", err)
	}
	if len(auto.Detected) != len(siteImportPanels) {
		t.Fatalf("detected = %d 条，期望 %d 条（宝塔 + 1Panel）", len(auto.Detected), len(siteImportPanels))
	}
}
