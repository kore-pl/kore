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

// TestNewFileWriteOptionsClassDirsInjected 断言协议类别目录（conf.d）进入两个白名单。
func TestNewFileWriteOptionsClassDirsInjected(t *testing.T) {
	t.Setenv(fileWriteAllowDirsEnv, "")
	opts := newFileWriteOptions(t.TempDir())
	class := pluginapi.FileWritePrefixClasses["nginx.conf.d"]
	if !hasPrefix(opts.Policy.Nginx.CertPrefixes, class.Dir) ||
		!hasPrefix(opts.Policy.Nginx.AuthFilePrefixes, class.Dir) {
		t.Fatalf("类别目录 %q 必须进入证书/口令白名单：cert=%v auth=%v",
			class.Dir, opts.Policy.Nginx.CertPrefixes, opts.Policy.Nginx.AuthFilePrefixes)
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

// TestNewFileWriteOptionsInjectedDirsAllow 断言运行时注入后放行，且非法条目被丢弃、
// 前缀边界不被扩大（`/a/ssl/` 不放行 `/a/ssl-evil/`）。
func TestNewFileWriteOptionsInjectedDirsAllow(t *testing.T) {
	t.Setenv(fileWriteAllowDirsEnv, "/opt/kore/data/ssl/:/srv/certs:relative/dir:../evil")
	opts := newFileWriteOptions(t.TempDir())
	for _, want := range []string{"/opt/kore/data/ssl/", "/srv/certs/"} {
		if !hasPrefix(opts.Policy.Nginx.CertPrefixes, want) {
			t.Fatalf("注入目录 %q 未生效：%v", want, opts.Policy.Nginx.CertPrefixes)
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
