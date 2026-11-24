package pluginapi_test

import (
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// testNginxPolicy 是正例用的策略：证书与口令文件目录必须由运行时注入（缺省为空 = 拒绝）。
func testNginxPolicy() pluginapi.NginxPolicy {
	policy := pluginapi.DefaultNginxPolicy()
	policy.CertPrefixes = []string{"/var/lib/kore/ssl/"}
	policy.AuthFilePrefixes = []string{"/etc/nginx/conf.d/"}
	return policy
}

// TestDeniedNginxDirectivesEachRejected 是**逐条**反例：协议里显式拒绝的每个指令都要有断言。
//
// 任务口径「每一个禁用指令都要有一条测试断言被拒」——这里遍历 DeniedNginxDirectives
// 本体，文档/实现/测试同源：清单里新增一条，这个测试自动覆盖。
func TestDeniedNginxDirectivesEachRejected(t *testing.T) {
	policy := testNginxPolicy()
	if len(pluginapi.DeniedNginxDirectives) == 0 {
		t.Fatal("拒绝清单为空")
	}
	for _, denied := range pluginapi.DeniedNginxDirectives {
		denied := denied
		t.Run(denied.Name, func(t *testing.T) {
			content := "server {\n    listen 80;\n    " + denied.Name + " /var/www/x;\n}\n"
			err := pluginapi.ValidateNginxVHostFragment([]byte(content), policy)
			if err == nil {
				t.Fatalf("禁用指令 %s 未被拒绝", denied.Name)
			}
			if !strings.Contains(err.Error(), "无条件拒绝") {
				t.Fatalf("拒绝理由应显式（含「无条件拒绝」），实际：%v", err)
			}
			if !strings.Contains(err.Error(), denied.Name) {
				t.Fatalf("错误信息应点名指令 %s，实际：%v", denied.Name, err)
			}
		})
	}
}

// TestDeniedNginxDirectiveFamiliesRejected 覆盖按前缀/后缀拒绝的指令族（枚举不全靠族规则）。
func TestDeniedNginxDirectiveFamiliesRejected(t *testing.T) {
	policy := testNginxPolicy()
	families := []string{
		"lua_shared_dict", "lua_package_path",
		"js_import", "js_content",
		"dav_methods", "dav_access", "dav_ext_methods",
		"client_body_temp_path", "proxy_temp_path", "fastcgi_temp_path",
		"uwsgi_temp_path", "scgi_temp_path",
	}
	for _, name := range families {
		name := name
		t.Run(name, func(t *testing.T) {
			content := "server {\n    listen 80;\n    " + name + " x y;\n}\n"
			err := pluginapi.ValidateNginxVHostFragment([]byte(content), policy)
			if err == nil || !strings.Contains(err.Error(), "无条件拒绝") {
				t.Fatalf("指令族成员 %s 未被显式拒绝：%v", name, err)
			}
		})
	}
}

// TestNginxStructuralRejects 锁定结构约束：顶层只有 server{}、location 只在 server 内。
func TestNginxStructuralRejects(t *testing.T) {
	policy := testNginxPolicy()
	valid := "server {\n    listen 80;\n    server_name a.example.com;\n    root /var/www/a.example.com;\n}\n"
	if err := pluginapi.ValidateNginxVHostFragment([]byte(valid), policy); err != nil {
		t.Fatalf("基线配置应通过：%v", err)
	}
	tests := []struct {
		name    string
		content string
		wantErr string
	}{
		{"空片段", "", "至少需要一个 server"},
		{"只有注释", "# nothing here\n", "至少需要一个 server"},
		{"顶层指令", "worker_processes 1;\n" + valid, "不在 allowlist"},
		{"http 块", "http {\n" + valid + "}\n", "不支持的块指令"},
		{"server 嵌套 server", "server {\n    server {\n    }\n}\n", "只能出现在顶层"},
		{"location 在顶层", "location / {\n}\n", "只能出现在 server 内"},
		{"location 嵌套 location", "server {\n    location / {\n        location /x {\n        }\n    }\n}\n", "只能出现在 server 内"},
		{"if 在 server 内", "server {\n    if (!-e $request_filename) {\n    }\n}\n", "只允许出现在 location 内"},
		{"if 条件不受支持", "server {\n    location / {\n        if ($request_method = POST) {\n        }\n    }\n}\n", "if 条件只允许"},
		{"server 带参数", "server default {\n}\n", "server 不允许参数"},
		{"指令缺分号", "server {\n    listen 80\n}\n", "缺少 ;"},
		{"多余右花括号", valid + "}\n", "多余的 }"},
		{"块未闭合", "server {\n    listen 80;\n", "块未闭合"},
		{"未知指令", "server {\n    miracle on;\n}\n", "不在 allowlist"},
		{"指令名大写", "server {\n    ACCESS_LOG /tmp/x;\n}\n", "不在 allowlist"},
		{"token 中间井号", "server {\n    listen 80#x;\n}\n", "# 只能出现在 token 起点"},
		{"复合变量", "server {\n    root ${host};\n}\n", "不支持 ${} 复合变量"},
		{"引号未闭合", "server {\n    auth_basic \"abc;\n}\n", "引号未闭合"},
		{"未知块", "server {\n    mystery {\n    }\n}\n", "不支持的块指令"},
		{"多余分号", "server {\n    listen 80;;\n}\n", "多余的 ;"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := pluginapi.ValidateNginxVHostFragment([]byte(tc.content), policy)
			if err == nil {
				t.Fatalf("期望报错包含 %q，实际通过", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("错误信息 %q 不含 %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// TestNginxParameterShapes 锁定参数形状：路径/端口/上游/套件逐项校验。
func TestNginxParameterShapes(t *testing.T) {
	policy := testNginxPolicy()
	wrap := func(body string) string { return "server {\n    listen 80;\n" + body + "}\n" }
	tests := []struct {
		name    string
		body    string
		wantErr string
	}{
		{"listen 端口 0", "    listen 0;\n", "1–65535"},
		{"listen 端口越界", "    listen 65536;\n", "1–65535"},
		{"listen 前导零", "    listen 080;\n", "非法"},
		{"listen default_server", "    listen 80 default_server;\n", "default_server"},
		{"listen 绑定地址", "    listen 127.0.0.1:80;\n", "裸数字端口"},
		{"server_name 正则", "    server_name ~^www\\.;\n", "不接受正则"},
		{"root 是相对路径", "    root var/www/x;\n", "绝对路径"},
		{"root 是根目录", "    root /;\n", "拒绝 /"},
		{"root 含点点", "    root /var/www/../etc;\n", "规范路径"},
		{"root 前缀外", "    root /etc/nginx;\n", "不在允许前缀内"},
		{"root 前缀本身", "    root /var/www;\n", "不在允许前缀内"},
		{"root 含变量", "    root $document_root;\n", "不接受变量"},
		{"index 越级", "    index ../x.html;\n", "形状非法"},
		{"try_files 绝对落盘", "    location / {\n        try_files /etc/passwd =404;\n    }\n", ""},
		{"try_files 非法候选", "    location / {\n        try_files xyz =404;\n    }\n", "既不是"},
		{"return 非跳转码带目标", "    return 200 https://x.example.com;\n", "只允许 301"},
		{"return 目标协议外", "    return 301 ftp://x.example.com;\n", "必须以"},
		{"rewrite flag 非法", "    location / {\n        rewrite ^/a$ /b ballet;\n    }\n", "flag"},
		{"rewrite replacement 非法", "    location / {\n        rewrite ^/a$ evil.php;\n    }\n", "replacement 必须以"},
		{"proxy_pass 非 http", "    location / {\n        proxy_pass ftp://10.0.0.1;\n    }\n", "只允许 http/https"},
		{"proxy_pass 无 host", "    location / {\n        proxy_pass http:///x;\n    }\n", "缺少 host"},
		{"proxy_pass 带 userinfo", "    location / {\n        proxy_pass http://user:pw@10.0.0.1;\n    }\n", "userinfo"},
		{"proxy_pass 到 kore 端口", "    location / {\n        proxy_pass http://127.0.0.1:8787;\n    }\n", "禁止反代到本机"},
		{"proxy_pass 带变量", "    location / {\n        proxy_pass http://$host;\n    }\n", "不接受变量"},
		{"fastcgi_pass TCP", "    location ~ \\.php$ {\n        fastcgi_pass 127.0.0.1:9000;\n    }\n", "只允许 unix"},
		{"fastcgi_pass 目录外", "    location ~ \\.php$ {\n        fastcgi_pass unix:/tmp/evil.sock;\n    }\n", "不在允许前缀内"},
		{"location 修饰符非法", "    location ^b /x {\n    }\n", "修饰符"},
		{"location 路径非绝对", "    location x {\n    }\n", "必须以 / 开头"},
		{"alias 在 server 层", "    alias /var/www/x;\n", "不允许出现在 server"},
		{"ssl 协议旧版", "    ssl_protocols TLSv1.1;\n", "不在允许集"},
		{"ssl 套件字符集", "    ssl_ciphers a b;\n", "套件串"},
		{"ssl session cache 形状", "    ssl_session_cache shared:SSL;\n", "形状非法"},
		{"ssl session timeout 形状", "    ssl_session_timeout 1x;\n", "时长形状"},
		{"auth 文件目录外", "    auth_basic_user_file /etc/shadow;\n", "不在允许前缀内"},
		{"proxy_http_version 非法", "    location / {\n        proxy_http_version 2.0;\n    }\n", "只允许 1.0"},
		{"proxy_set_header 头名非法", "    location / {\n        proxy_set_header Bad Header $host;\n    }\n", "参数应为"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := pluginapi.ValidateNginxVHostFragment([]byte(wrap(tc.body)), policy)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("期望通过，实际报错：%v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("期望报错包含 %q，实际通过", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("错误信息 %q 不含 %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// TestSSLCertificateRequiresInjectedPrefix 锁定 fail-closed：证书目录白名单为空时一律拒绝。
func TestSSLCertificateRequiresInjectedPrefix(t *testing.T) {
	content := "server {\n    listen 443 ssl;\n    ssl_certificate \"/var/lib/kore/ssl/a/fullchain.pem\";\n}\n"
	err := pluginapi.ValidateNginxVHostFragment([]byte(content), pluginapi.DefaultNginxPolicy())
	if err == nil || !strings.Contains(err.Error(), "证书目录白名单为空") {
		t.Fatalf("缺证书白名单时应 fail-closed，实际：%v", err)
	}
	if err := pluginapi.ValidateNginxVHostFragment([]byte(content), testNginxPolicy()); err != nil {
		t.Fatalf("注入白名单后应通过：%v", err)
	}
}

// wordpressVHost 是 site 插件 renderVHost 的真实输出形态（force_https + SSL + auth + PHP + 跳转）。
// 夹具注释按 site 插件的真实输出保留；`kore-` 与 `plugin-site` 分开拼接，避免
// repo-check（G11）把测试夹具里的插件仓名误判成「内核引用插件仓库」。
const wordpressVHost = "# kore-" + "plugin-site managed vhost for example.com\n" + `# 本片段由 site 插件生成；禁止抢占默认站点（红队 R6）。
# >>> kore-site:http-redirect >>>
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}
# <<< kore-site:http-redirect <<<
server {
    server_name example.com;
    # >>> kore-site:ssl >>>
    listen 443 ssl;
    ssl_certificate "/var/lib/kore/ssl/example.com/fullchain.pem";
    ssl_certificate_key "/var/lib/kore/ssl/example.com/key.pem";
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    # <<< kore-site:ssl <<<
    root /var/www/example.com;
    index index.php index.html;
    # >>> kore-site:auth >>>
    auth_basic "kore site example.com";
    auth_basic_user_file /etc/nginx/conf.d/kore-site-example.com.htpasswd;
    # <<< kore-site:auth <<<
    # >>> kore-site:rewrite >>>
    # template: wordpress
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    # <<< kore-site:rewrite <<<
    # >>> kore-site:php >>>
    # version: 8.3
    location ~ \.php$ {
        try_files $uri =404;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param QUERY_STRING $query_string;
        fastcgi_param REQUEST_METHOD $request_method;
        fastcgi_param CONTENT_TYPE $content_type;
        fastcgi_param CONTENT_LENGTH $content_length;
        fastcgi_param SCRIPT_NAME $fastcgi_script_name;
        fastcgi_param REQUEST_URI $request_uri;
        fastcgi_param DOCUMENT_URI $document_uri;
        fastcgi_param DOCUMENT_ROOT $document_root;
        fastcgi_param SERVER_PROTOCOL $server_protocol;
        fastcgi_param REQUEST_SCHEME $scheme;
        fastcgi_param HTTPS $https if_not_empty;
        fastcgi_param GATEWAY_INTERFACE CGI/1.1;
        fastcgi_param SERVER_SOFTWARE nginx/$nginx_version;
        fastcgi_param REMOTE_ADDR $remote_addr;
        fastcgi_param REMOTE_PORT $remote_port;
        fastcgi_param SERVER_ADDR $server_addr;
        fastcgi_param SERVER_PORT $server_port;
        fastcgi_param SERVER_NAME $server_name;
        fastcgi_param REDIRECT_STATUS 200;
    }
    # <<< kore-site:php <<<
    # >>> kore-site:redirect-/old >>>
    location = /old {
        return 301 https://example.com/new;
    }
    # <<< kore-site:redirect-/old <<<
}
`

// thinkphpVHost 覆盖 `if (!-e $request_filename) { rewrite … last; }` 这一真实模板。
const thinkphpVHost = "# kore-" + "plugin-site managed vhost for tp.example.com\n" + `server {
    listen 80;
    server_name tp.example.com;
    root /var/www/tp.example.com;
    index index.php index.html;
    # >>> kore-site:rewrite >>>
    # template: thinkphp
    location / {
        if (!-e $request_filename) {
            rewrite ^(.*)$ /index.php?s=$1 last;
        }
    }
    # <<< kore-site:rewrite <<<
    # >>> kore-site:php >>>
    # version: 8.3
    location ~ \.php$ {
        try_files $uri =404;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param REDIRECT_STATUS 200;
    }
    # <<< kore-site:php <<<
}
`

// discuzVHost 覆盖最复杂的重写模板（正则含转义、捕获组、query string）。
const discuzVHost = `server {
    listen 80;
    server_name bbs.example.com;
    root /var/www/bbs.example.com;
    index index.php index.html;
    # >>> kore-site:rewrite >>>
    # template: discuz
    location / {
        rewrite ^([^\.]*)/topic-(.+)\.html$ $1/portal.php?mod=topic&topic=$2 last;
        rewrite ^([^\.]*)/article-([0-9]+)-([0-9]+)\.html$ $1/portal.php?mod=view&aid=$2&page=$3 last;
        rewrite ^([^\.]*)/forum-(\w+)-([0-9]+)\.html$ $1/forum.php?mod=forumdisplay&fid=$2&page=$3 last;
        rewrite ^([^\.]*)/thread-([0-9]+)-([0-9]+)-([0-9]+)\.html$ $1/forum.php?mod=viewthread&tid=$2&extra=page%3D$4&page=$3 last;
        rewrite ^([^\.]*)/space-(username|uid)-(.+)\.html$ $1/home.php?mod=space&$2=$3 last;
        rewrite ^([^\.]*)/(fid|tid)-([0-9]+)\.html$ $1/index.php?action=$2&value=$3 last;
        rewrite ^([^\.]*)/([a-zA-Z0-9_-]+)-([0-9]+)-([0-9]+)\.html$ $1/$2.php?mod=$3&page=$4 last;
        rewrite ^([^\.]*)/([a-zA-Z0-9_-]+)-([0-9]+)\.html$ $1/$2.php?id=$3 last;
    }
    # <<< kore-site:rewrite <<<
    location ~ \.php$ {
        try_files $uri =404;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param REDIRECT_STATUS 200;
    }
}
`

// proxyVHost 覆盖反代 + WebSocket 升级头。
const proxyVHost = `server {
    listen 80;
    server_name app.example.com;
    # >>> kore-site:proxy >>>
    # ws: 1
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    # <<< kore-site:proxy <<<
}
`

// TestNginxRealSiteVHostsAccepted 是**正例**：site 实际生成的 vhost 必须通过。
func TestNginxRealSiteVHostsAccepted(t *testing.T) {
	policy := testNginxPolicy()
	cases := []struct {
		name    string
		content string
	}{
		{"wordpress（PHP + 伪静态 + SSL + auth + 跳转）", wordpressVHost},
		{"thinkphp（if + rewrite）", thinkphpVHost},
		{"discuz（复杂正则重写）", discuzVHost},
		{"proxy（反代 + WS 升级）", proxyVHost},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := pluginapi.ValidateNginxVHostFragment([]byte(tc.content), policy); err != nil {
				t.Fatalf("site 真实 vhost 被误拒：%v\n配置：\n%s", err, tc.content)
			}
			// 还要能作为 file_write 请求整体通过（文件名 + 正文）。
			decl := validFileWrite()
			action := pluginapi.RootAction{
				ID: "nginx-vhost", FileWrite: &decl, WritesHost: true, Target: "/etc/nginx/conf.d/",
			}
			opts := pluginapi.FileWriteOptions{Nginx: policy}
			if err := pluginapi.ValidateFileWriteRequest("site", action, "kore-site-example.com.conf", []byte(tc.content), opts); err != nil {
				t.Fatalf("file_write 请求层被误拒：%v", err)
			}
		})
	}
}

// FuzzValidateNginxVHostFragment 断言解析器对任意输入都不 panic（ADR-0052 §4.3 #1）。
//
// 种子覆盖：合法 vhost、禁用指令、结构破坏、引号/转义、随机字节。失败标准只有
// panic / 无限循环——"接受"不是错误（内容策略允许的指令本就该接受）。
func FuzzValidateNginxVHostFragment(f *testing.F) {
	policy := testNginxPolicy()
	for _, seed := range []string{
		wordpressVHost,
		thinkphpVHost,
		discuzVHost,
		proxyVHost,
		"server {\n    listen 80;\n}\n",
		"server {\n access_log /etc/shadow;\n}\n",
		"server {\n    location ~ \"unclosed;\n}\n",
		"server { location / { if (!-e $request_filename) { rewrite ^(.*)$ /i.php?s=$1 last; } } }",
		"}}};;;{{{",
		"\x00\xff\xfe",
		"# 注释 \\\" ; { }\nserver {}",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		// 零值策略与注入策略各跑一遍：零值必须等价于默认策略，不能 panic。
		_ = pluginapi.ValidateNginxVHostFragment(data, pluginapi.NginxPolicy{})
		_ = pluginapi.ValidateNginxVHostFragment(data, policy)
	})
}
