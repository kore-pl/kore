package main

import (
	"os"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fileWriteSSLVHost 是含证书指令的 vhost 片段（证书路径由调用方指定）。
func fileWriteSSLVHost(certDir string) string {
	return "server {\n    listen 443 ssl;\n    server_name example.com;\n" +
		"    ssl_certificate " + certDir + "example/fullchain.pem;\n" +
		"    ssl_certificate_key " + certDir + "example/key.pem;\n" +
		"    root /var/www/example;\n}\n"
}

// fileWriteAuthVHost 是含 basic auth 的 vhost 片段（口令文件路径由调用方指定），
// 形状取站点插件实际渲染的 auth 段（kore-plugin-site/password.go writeAuthBlock）。
func fileWriteAuthVHost(authFile string) string {
	return "server {\n    listen 80;\n    server_name example.com;\n" +
		"    auth_basic \"kore site example.com\";\n" +
		"    auth_basic_user_file " + authFile + ";\n" +
		"    root /var/www/example;\n}\n"
}

// fileWriteDecl 是 nginx.conf.d 类别的动作声明（内容策略校验需要它）。
func fileWriteDecl() *pluginapi.FileWrite {
	return &pluginapi.FileWrite{
		PrefixClass:   "nginx.conf.d",
		Mode:          pluginapi.FileWriteModeRoot0644,
		ContentPolicy: pluginapi.ContentPolicyNginxVHost,
	}
}

// hasPrefix 报告列表里是否有给定前缀。
func hasPrefix(prefixes []string, want string) bool {
	for _, prefix := range prefixes {
		if prefix == want {
			return true
		}
	}
	return false
}

// confDDir 返回协议类别目录（当前唯一类别 = `/etc/nginx/conf.d/`）。
func confDDir(t *testing.T) string {
	t.Helper()
	class, ok := pluginapi.FileWritePrefixClasses["nginx.conf.d"]
	if !ok {
		t.Fatalf("缺少 nginx.conf.d 类别（测试前提不再成立）")
	}
	return class.Dir
}

// TestNewFileWriteOptionsCertDirsAreEnvOnly 锁定证书面最小：类别目录**不得**进入
// CertPrefixes（它只进 vhost 写盘白名单与 AuthFilePrefixes），安装注入目录才进。
func TestNewFileWriteOptionsCertDirsAreEnvOnly(t *testing.T) {
	class := confDDir(t)
	t.Setenv(fileWriteAllowDirsEnv, "/opt/kore/data/ssl/")
	opts := newFileWriteOptions(t.TempDir())

	if hasPrefix(opts.Policy.Nginx.CertPrefixes, class) {
		t.Fatalf("类别目录 %q 不得进入证书白名单（证书面最小）：cert=%v",
			class, opts.Policy.Nginx.CertPrefixes)
	}
	if !hasPrefix(opts.Policy.Nginx.CertPrefixes, "/opt/kore/data/ssl/") {
		t.Fatalf("注入目录未进入证书白名单：cert=%v", opts.Policy.Nginx.CertPrefixes)
	}
	if !hasPrefix(opts.Policy.Nginx.AuthFilePrefixes, class) {
		t.Fatalf("类别目录 %q 必须进入口令白名单（站点 htpasswd 与 vhost 同目录）：auth=%v",
			class, opts.Policy.Nginx.AuthFilePrefixes)
	}
	if !hasPrefix(opts.Policy.Nginx.AuthFilePrefixes, "/opt/kore/data/ssl/") {
		t.Fatalf("注入目录应继续对 auth 生效（口令文件可放安装目录）：auth=%v",
			opts.Policy.Nginx.AuthFilePrefixes)
	}

	// 类别来自 map：装配层必须排序后再拼，否则校验器错误文案里的「允许：…」每次不同。
	certOrder := strings.Join(opts.Policy.Nginx.CertPrefixes, ",")
	authOrder := strings.Join(opts.Policy.Nginx.AuthFilePrefixes, ",")
	for i := 0; i < 20; i++ {
		again := newFileWriteOptions(t.TempDir()).Policy
		if got := strings.Join(again.Nginx.CertPrefixes, ","); got != certOrder {
			t.Fatalf("证书白名单顺序不稳定（错误文案会抖）：%q vs %q", certOrder, got)
		}
		if got := strings.Join(again.Nginx.AuthFilePrefixes, ","); got != authOrder {
			t.Fatalf("口令白名单顺序不稳定（错误文案会抖）：%q vs %q", authOrder, got)
		}
	}
}

// TestNewFileWriteOptionsConfDCertRejected 是本次收窄的**核心回归用例**：
// `ssl_certificate` 指向类别目录（conf.d 下的 .conf/.pem）必须被拒绝，
// 即使安装目录已注入——注入只放宽证书目录，不放宽 vhost 目录。
func TestNewFileWriteOptionsConfDCertRejected(t *testing.T) {
	class := confDDir(t)
	t.Setenv(fileWriteAllowDirsEnv, "/opt/kore/data/ssl/")
	opts := newFileWriteOptions(t.TempDir())

	// 证书指令指向 conf.d 下的文件：收窄前被放行（certDirs = dirs），现在必须拒绝。
	for _, target := range []string{
		fileWriteSSLVHost(class),             // /etc/nginx/conf.d/example/fullchain.pem
		fileWriteSSLVHost(class + "kore-x/"), // /etc/nginx/conf.d/kore-x/fullchain.pem
	} {
		err := pluginapi.ValidateFileWriteContent(fileWriteDecl(), []byte(target), opts.Policy)
		if err == nil {
			t.Fatalf("ssl_certificate 指向类别目录 %q 必须被拒绝", class)
		}
		if !strings.Contains(err.Error(), "证书") {
			t.Fatalf("拒绝原因应指向证书路径受限：%v", err)
		}
	}
}

// TestNewFileWriteOptionsInjectedCertAllowed 断言证书仍按安装注入目录放行，
// 且前缀边界不被扩大（`/a/ssl/` 不放行 `/a/ssl-evil/`）。
func TestNewFileWriteOptionsInjectedCertAllowed(t *testing.T) {
	t.Setenv(fileWriteAllowDirsEnv, "/opt/kore/data/ssl/:/srv/certs:relative/dir:../evil")
	opts := newFileWriteOptions(t.TempDir())
	for _, want := range []string{"/opt/kore/data/ssl/", "/srv/certs/"} {
		if !hasPrefix(opts.Policy.Nginx.CertPrefixes, want) {
			t.Fatalf("注入目录 %q 未进入证书白名单：%v", want, opts.Policy.Nginx.CertPrefixes)
		}
	}
	for _, bad := range []string{"relative/dir", "../evil", "/srv/certs"} {
		if hasPrefix(opts.Policy.Nginx.CertPrefixes, bad) {
			t.Fatalf("非法/未规范条目 %q 不应进入白名单：%v", bad, opts.Policy.Nginx.CertPrefixes)
		}
	}
	if err := pluginapi.ValidateFileWriteContent(fileWriteDecl(),
		[]byte(fileWriteSSLVHost("/opt/kore/data/ssl/")), opts.Policy); err != nil {
		t.Fatalf("注入后合法证书路径应放行：%v", err)
	}
	if err := pluginapi.ValidateFileWriteContent(fileWriteDecl(),
		[]byte(fileWriteSSLVHost("/opt/kore/data/ssl-evil/")), opts.Policy); err == nil {
		t.Fatalf("前缀边界必须生效：/opt/kore/data/ssl/ 不得放行 /opt/kore/data/ssl-evil/")
	}
}

// TestNewFileWriteOptionsEmptyEnvKeepsDeny 断言未注入安装路径目录时，指向
// `<install>/data/ssl` 的证书仍被拒绝（缺省空即拒绝，不猜安装路径）。
func TestNewFileWriteOptionsEmptyEnvKeepsDeny(t *testing.T) {
	t.Setenv(fileWriteAllowDirsEnv, "")
	opts := newFileWriteOptions(t.TempDir())
	err := pluginapi.ValidateFileWriteContent(fileWriteDecl(),
		[]byte(fileWriteSSLVHost("/opt/kore/data/ssl/")), opts.Policy)
	if err == nil {
		t.Fatalf("未注入证书目录时 ssl_certificate 必须被拒绝")
	}
	if !strings.Contains(err.Error(), "证书") {
		t.Fatalf("拒绝原因应指向证书路径受限：%v", err)
	}
}

// TestNewFileWriteOptionsAuthFileAllocation 锁定口令文件白名单的分配：
// 类别目录（站点 htpasswd 与 vhost 同目录）放行、安装注入目录放行、
// 类别目录之外（如 `/etc/nginx/other/`）拒绝；auth 不依赖 env 是否注入。
func TestNewFileWriteOptionsAuthFileAllocation(t *testing.T) {
	class := confDDir(t)
	cases := []struct {
		name     string
		env      string
		authFile string
		allow    bool
		why      string
	}{
		{
			name:     "conf.d 下 htpasswd（站点插件实际路径）",
			env:      "",
			authFile: class + "kore-site-auth.example.com.htpasswd",
			allow:    true,
			why:      "站点插件把 htpasswd 与 vhost 写在同一目录",
		},
		{
			name:     "安装注入目录下的口令文件",
			env:      "/opt/kore/data/auth/",
			authFile: "/opt/kore/data/auth/site.htpasswd",
			allow:    true,
			why:      "env 的文档语义本就含口令文件目录",
		},
		{
			name:     "未注入 env 时安装目录仍拒绝",
			env:      "",
			authFile: "/opt/kore/data/auth/site.htpasswd",
			allow:    false,
			why:      "fail-closed：不猜安装布局",
		},
		{
			name:     "类别目录之外的同级目录",
			env:      "/opt/kore/data/auth/",
			authFile: "/etc/nginx/other/site.htpasswd",
			allow:    false,
			why:      "auth 只认类别目录与注入目录，不扩到 nginx 配置树其它位置",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(fileWriteAllowDirsEnv, tc.env)
			opts := newFileWriteOptions(t.TempDir())
			err := pluginapi.ValidateFileWriteContent(fileWriteDecl(),
				[]byte(fileWriteAuthVHost(tc.authFile)), opts.Policy)
			if tc.allow && err != nil {
				t.Fatalf("%s：应放行（%s），实际失败：%v", tc.name, tc.why, err)
			}
			if !tc.allow && err == nil {
				t.Fatalf("%s：应拒绝（%s）", tc.name, tc.why)
			}
		})
	}
}

// TestNewFileWriteOptionsMutantOldAllocationFails 是**反例自证**的常驻形式：
// 用收窄前的分配方式（certDirs = authDirs = 类别目录 + 注入目录）构造一个 mutant，
// 断言它确实放行 conf.d 下的 ssl_certificate。
//
// 于是 TestNewFileWriteOptionsConfDCertRejected 是"有牙齿"的：把 certDirs 改回
// `classDirs + envDirs`（即 `dirs`），该用例立刻 FAIL。若哪天有人"顺手统一"两个参数，
// 这里不会拦住（它只证明 mutant 行为），拦截来自核心回归用例。
func TestNewFileWriteOptionsMutantOldAllocationFails(t *testing.T) {
	class := confDDir(t)
	t.Setenv(fileWriteAllowDirsEnv, "/opt/kore/data/ssl/")
	envDirs := splitDirList(os.Getenv(fileWriteAllowDirsEnv))
	allDirs := make([]string, 0, len(classPrefixDirs())+len(envDirs))
	allDirs = append(allDirs, classPrefixDirs()...)
	allDirs = append(allDirs, envDirs...)

	mutant := pluginapi.FileWriteOptionsWithDirs(allDirs, allDirs)
	if !hasPrefix(mutant.Nginx.CertPrefixes, class) {
		t.Fatalf("反例前提不成立：mutant 的证书白名单应含类别目录 %q", class)
	}
	if err := pluginapi.ValidateFileWriteContent(fileWriteDecl(),
		[]byte(fileWriteSSLVHost(class)), mutant); err != nil {
		t.Fatalf("反例自证失败：收窄前的分配（certDirs = dirs）应放行 conf.d 证书，实际 %v", err)
	}
}

// TestNewFileWriteOptionsOwnerCheckWired 断言属主复核已接线（非 root 环境下
// root:root 校验必然失败，说明装配的不是 no-op）。
func TestNewFileWriteOptionsOwnerCheckWired(t *testing.T) {
	opts := newFileWriteOptions(t.TempDir())
	if opts.OwnerCheck == nil {
		t.Fatalf("属主复核未装配（必须注入 internal/platform.VerifyOwner）")
	}
	file := t.TempDir() + "/x.conf"
	if err := os.WriteFile(file, []byte("server {}\n"), 0o644); err != nil {
		t.Fatalf("构造测试文件失败：%v", err)
	}
	// 当前用户不是 root（本机非 root 的常规情况）；若恰好在 root 下跑则跳过。
	if err := opts.OwnerCheck(file, 0o644); err == nil {
		t.Skip("当前进程属主即 root:root，无法用该文件证明非 no-op")
	}
}
