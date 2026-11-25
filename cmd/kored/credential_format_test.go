package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
)

// withCredentialPathFn 把凭据文件路径指向临时目录，测试结束还原。
func withCredentialPathFn(t *testing.T, path string) {
	t.Helper()
	old := initialAdminCredentialPathFn
	initialAdminCredentialPathFn = func(string) string { return path }
	t.Cleanup(func() { initialAdminCredentialPathFn = old })
}

// TestCredentialFileContentTwoLines 钉死 ADR-0057 T2 的两行凭据格式：
// 第一行 username: admin，第二行 password: <明文>，顺序固定。
func TestCredentialFileContentTwoLines(t *testing.T) {
	got := credentialFileContent("admin", "some-one-time-secret")
	want := "username: admin\npassword: some-one-time-secret\n"
	if got != want {
		t.Fatalf("两行凭据格式 = %q，want %q", got, want)
	}
	if !isTwoLineCredential(got) {
		t.Fatal("新格式应被 isTwoLineCredential 识别")
	}
}

// TestFirstInstallWritesTwoLineCredential 覆盖首次安装：凭据文件两行、0600，
// 配置哈希能校验第二行的口令；非 TTY 不打印明文。
func TestFirstInstallWritesTwoLineCredential(t *testing.T) {
	root := t.TempDir()
	cfg := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(cfg, []byte("server:\n  addr: \"127.0.0.1:1\"\n"), 0o600); err != nil {
		t.Fatalf("准备配置失败: %v", err)
	}
	cred := filepath.Join(root, "initial-admin-credential")
	withCredentialPathFn(t, cred)
	withAdminFakes(t, false)

	var stderr bytes.Buffer
	ensureInitialAdminCredential(cfg, filepath.Join(root, "state"), &stderr)
	data, err := os.ReadFile(cred)
	if err != nil {
		t.Fatalf("凭据文件未生成: %v", err)
	}
	info, err := os.Stat(cred)
	if err != nil {
		t.Fatalf("stat 凭据文件失败: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("凭据文件权限应为 0600，实际 %04o", perm)
	}
	if !isTwoLineCredential(string(data)) {
		t.Fatalf("首启凭据应为两行格式: %q", string(data))
	}
	plain := strings.TrimSpace(strings.TrimPrefix(string(data),
		credentialUsernamePrefix+auth.DefaultAdminUsername+"\n"+credentialPasswordPrefix))
	if len(plain) != adminPasswordLength {
		t.Fatalf("口令长度应为 %d，实际 %d", adminPasswordLength, len(plain))
	}
	if strings.Contains(stderr.String(), plain) {
		t.Fatal("非 TTY 输出泄露了明文口令")
	}
	if !strings.Contains(stderr.String(), "账号与口令") {
		t.Fatalf("非 TTY 提示应说明账号+口令登录: %q", stderr.String())
	}
}

// TestMigrateLegacySingleLineCredential 覆盖老一行凭据升级：包装成两行、
// 口令不变、不生成新凭据、不动配置哈希；已是两行格式则幂等不动。
func TestMigrateLegacySingleLineCredential(t *testing.T) {
	root := t.TempDir()
	cred := filepath.Join(root, "initial-admin-credential")
	withCredentialPathFn(t, cred)
	cfg := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(cfg, []byte("auth:\n  initialized: true\n"), 0o600); err != nil {
		t.Fatalf("准备配置失败: %v", err)
	}
	const legacy = "legacy-one-line-secret"
	if err := os.WriteFile(cred, []byte(legacy+"\n"), 0o600); err != nil {
		t.Fatalf("准备老凭据失败: %v", err)
	}

	var stderr bytes.Buffer
	ensureInitialAdminCredential(cfg, filepath.Join(root, "state"), &stderr)
	data, err := os.ReadFile(cred)
	if err != nil {
		t.Fatalf("读凭据失败: %v", err)
	}
	want := credentialFileContent(auth.DefaultAdminUsername, legacy)
	if string(data) != want {
		t.Fatalf("老凭据应包装为两行且口令不变: got=%q want=%q", string(data), want)
	}
	info, err := os.Stat(cred)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("迁移后权限应仍为 0600: err=%v", err)
	}
	// 配置不得被改动（更新安装守门）。
	cfgData, _ := os.ReadFile(cfg)
	if string(cfgData) != "auth:\n  initialized: true\n" {
		t.Fatalf("迁移不得改配置: %q", string(cfgData))
	}
	// 幂等：再跑一次不动。
	var second bytes.Buffer
	ensureInitialAdminCredential(cfg, filepath.Join(root, "state"), &second)
	again, _ := os.ReadFile(cred)
	if string(again) != want {
		t.Fatalf("二次迁移不应改动两行凭据: %q", string(again))
	}
}

// TestMigrateInconsistentLegacyBackup 覆盖 §3.3.3：老凭据与配置哈希不一致时
// 先备份原文为 .legacy（0600、gitignore）再包装，不删数据、不猜口令。
func TestMigrateInconsistentLegacyBackup(t *testing.T) {
	root := t.TempDir()
	cred := filepath.Join(root, "initial-admin-credential")
	withCredentialPathFn(t, cred)
	hash, err := auth.HashPassword("the-real-password")
	if err != nil {
		t.Fatalf("生成哈希失败: %v", err)
	}
	cfg := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(cfg, []byte("auth:\n  admin_password_hash: \""+hash+"\"\n"), 0o600); err != nil {
		t.Fatalf("准备配置失败: %v", err)
	}
	const stale = "stale-one-line-secret"
	if err := os.WriteFile(cred, []byte(stale+"\n"), 0o600); err != nil {
		t.Fatalf("准备老凭据失败: %v", err)
	}

	var stderr bytes.Buffer
	ensureInitialAdminCredential(cfg, filepath.Join(root, "state"), &stderr)
	backup := cred + ".legacy"
	data, err := os.ReadFile(backup)
	if err != nil {
		t.Fatalf("不一致老凭据应备份: %v", err)
	}
	if string(data) != stale+"\n" {
		t.Fatalf("备份内容应为原文: %q", string(data))
	}
	if !strings.Contains(stderr.String(), "admin-password --set") {
		t.Fatalf("应提示用 CLI 重置: %q", stderr.String())
	}
	wrapped, _ := os.ReadFile(cred)
	if string(wrapped) != credentialFileContent(auth.DefaultAdminUsername, stale) {
		t.Fatalf("仍应包装成两行: %q", string(wrapped))
	}
}
