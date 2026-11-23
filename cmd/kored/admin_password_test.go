package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/auth"
	coreconfig "github.com/pengtang1024/kore/internal/core/config"
)

// withAdminFakes 替换终端/管道/rename 依赖，测试结束自动还原（避免全局泄漏）。
func withAdminFakes(t *testing.T, tty bool, answers ...string) {
	t.Helper()
	oldTTY, oldPrompt, oldStdin, oldRename := adminTTY, adminPrompt, adminStdin, adminRenameFile
	queue := append([]string(nil), answers...)
	adminTTY = func() bool { return tty }
	adminPrompt = func(_ string, _ io.Writer) (string, error) {
		if len(queue) == 0 {
			return "", errors.New("测试没有更多预置口令")
		}
		answer := queue[0]
		queue = queue[1:]
		return answer, nil
	}
	t.Cleanup(func() {
		adminTTY, adminPrompt, adminStdin, adminRenameFile = oldTTY, oldPrompt, oldStdin, oldRename
	})
}

// generatedPassword 从 stdout 里取出唯一一次打印的口令。
func generatedPassword(t *testing.T, stdout string) string {
	t.Helper()
	const marker = "请立即保存）："
	idx := strings.Index(stdout, marker)
	if idx < 0 {
		t.Fatalf("stdout 未包含口令打印行:\n%s", stdout)
	}
	rest := stdout[idx+len(marker):]
	end := strings.Index(rest, "\n")
	if end < 0 {
		end = len(rest)
	}
	plain := strings.TrimSpace(rest[:end])
	if plain == "" {
		t.Fatal("打印的口令为空")
	}
	return plain
}

// loadAdminHash 从配置文件里读出 auth.admin_password_hash。
func loadAdminHash(t *testing.T, path string) string {
	t.Helper()
	snap, _, err := coreconfig.Load(coreconfig.Options{FlagPath: path})
	if err != nil {
		t.Fatalf("写入后的配置无法加载: %v", err)
	}
	return snap.Auth.AdminPasswordHash
}

// TestAdminPasswordGenerateWrites0600AndVerifies 覆盖 P0：--generate 写 0600 配置且口令可校验。
func TestAdminPasswordGenerateWrites0600AndVerifies(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := "server:\n  addr: \"127.0.0.1:8787\"\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatalf("准备配置失败: %v", err)
	}
	withAdminFakes(t, false)

	var stdout, stderr bytes.Buffer
	code := runAdminPassword([]string{"--generate", "--config", path}, &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("--generate 应退出 0，实际 %d，stderr=%s", code, stderr.String())
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("配置文件不存在: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("配置权限必须 0600，实际 %04o", perm)
	}
	plain := generatedPassword(t, stdout.String())
	if got := strings.Count(stdout.String(), plain); got != 1 {
		t.Fatalf("口令应只打印一次，实际 %d 次", got)
	}
	if strings.Contains(stderr.String(), plain) {
		t.Fatal("stderr 出现了口令明文")
	}
	hash := loadAdminHash(t, path)
	ok, err := auth.VerifyPassword(hash, plain)
	if err != nil || !ok {
		t.Fatalf("生成的口令未通过 auth.VerifyPassword: ok=%v err=%v", ok, err)
	}
	snap, _, err := coreconfig.Load(coreconfig.Options{FlagPath: path})
	if err != nil {
		t.Fatalf("配置加载失败: %v", err)
	}
	if snap.Server.Addr != "127.0.0.1:8787" {
		t.Fatalf("原有键丢失: server.addr=%q", snap.Server.Addr)
	}
}

// TestAdminPasswordSetMismatchErrors 覆盖 --set 两次输入不一致必须报错且不写配置。
func TestAdminPasswordSetMismatchErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	withAdminFakes(t, true, "first-secret", "second-secret")

	var stdout, stderr bytes.Buffer
	code := runAdminPassword([]string{"--set", "--config", path}, &stdout, &stderr)
	if code == exitOK {
		t.Fatal("两次输入不一致时不应退出 0")
	}
	if !strings.Contains(stderr.String(), "不一致") {
		t.Fatalf("stderr 未提示两次输入不一致:\n%s", stderr.String())
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("校验失败时不应写配置，stat err=%v", err)
	}
	combined := stdout.String() + stderr.String()
	for _, secret := range []string{"first-secret", "second-secret"} {
		if strings.Contains(combined, secret) {
			t.Fatalf("输出泄露了口令明文 %q", secret)
		}
	}
}

// TestAdminPasswordSetNonTTYNeedsStdin 覆盖非 TTY 无 --stdin 报错并给 hint。
func TestAdminPasswordSetNonTTYNeedsStdin(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	withAdminFakes(t, false)

	var stdout, stderr bytes.Buffer
	code := runAdminPassword([]string{"--set", "--config", path}, &stdout, &stderr)
	if code == exitOK {
		t.Fatal("非 TTY 且无 --stdin 应报错退出")
	}
	if !strings.Contains(stderr.String(), "--stdin") {
		t.Fatalf("错误信息必须给出 --stdin 提示:\n%s", stderr.String())
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("报错时不应写配置，stat err=%v", err)
	}
}

// TestAdminPasswordSetStdinWritesConfigAndNoLeak 覆盖 --stdin 路径且输出不含口令明文。
func TestAdminPasswordSetStdinWritesConfigAndNoLeak(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	withAdminFakes(t, false)
	const secret = "stdin-secret-pass"
	adminStdin = strings.NewReader(secret + "\n")

	var stdout, stderr bytes.Buffer
	code := runAdminPassword([]string{"--set", "--stdin", "--config", path}, &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("--set --stdin 应退出 0，实际 %d，stderr=%s", code, stderr.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), secret) {
		t.Fatal("stdout/stderr 泄露了口令明文")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("配置文件不存在: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("配置权限必须 0600，实际 %04o", perm)
	}
	ok, err := auth.VerifyPassword(loadAdminHash(t, path), secret)
	if err != nil || !ok {
		t.Fatalf("--stdin 写入的口令未通过校验: ok=%v err=%v", ok, err)
	}
}

// TestAdminPasswordAtomicRenameFailureKeepsOriginal 覆盖原子写：rename 失败不留坏文件、不打印口令。
func TestAdminPasswordAtomicRenameFailureKeepsOriginal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := "auth:\n  session_ttl: \"12h\"\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatalf("准备配置失败: %v", err)
	}
	withAdminFakes(t, false)
	adminRenameFile = func(_, _ string) error { return errors.New("注入的 rename 失败") }

	var stdout, stderr bytes.Buffer
	code := runAdminPassword([]string{"--generate", "--config", path}, &stdout, &stderr)
	if code == exitOK {
		t.Fatal("rename 失败时应返回非 0")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("原配置应保留: %v", err)
	}
	if string(data) != original {
		t.Fatalf("原配置被破坏: %q", string(data))
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读目录失败: %v", err)
	}
	if len(entries) != 1 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("失败后不应残留临时文件，实际 %v", names)
	}
	if strings.Contains(stdout.String(), "只显示这一次") {
		t.Fatal("写入失败时不应打印口令")
	}
}

// TestAdminPasswordHashWritesGivenString 覆盖 --hash 兼容手工/自动化路径。
func TestAdminPasswordHashWritesGivenString(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	hash, err := auth.HashPassword("given-pass")
	if err != nil {
		t.Fatalf("生成哈希失败: %v", err)
	}
	withAdminFakes(t, false)

	var stdout, stderr bytes.Buffer
	code := runAdminPassword([]string{"--hash", hash, "--config", path}, &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("--hash 应退出 0，实际 %d，stderr=%s", code, stderr.String())
	}
	if got := loadAdminHash(t, path); got != hash {
		t.Fatalf("写入的哈希不一致: %q", got)
	}
	ok, err := auth.VerifyPassword(loadAdminHash(t, path), "given-pass")
	if err != nil || !ok {
		t.Fatalf("--hash 写入后校验失败: ok=%v err=%v", ok, err)
	}
}

// TestAdminPasswordRequiresExactlyOneMode 覆盖参数互斥校验。
func TestAdminPasswordRequiresExactlyOneMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	withAdminFakes(t, false)
	cases := [][]string{
		{"--config", path},
		{"--generate", "--set", "--config", path},
		{"--hash", "not-a-hash", "--config", path},
	}
	for _, args := range cases {
		var stdout, stderr bytes.Buffer
		if code := runAdminPassword(args, &stdout, &stderr); code == exitOK {
			t.Fatalf("参数 %v 应被拒绝", args)
		}
	}
}

// TestUpsertAdminHashKeepsCommentsAndOtherKeys 覆盖就地改写不重排用户文件。
func TestUpsertAdminHashKeepsCommentsAndOtherKeys(t *testing.T) {
	doc := "server:\n  addr: \"127.0.0.1:8787\"\n\nauth:\n  # 这是用户的注释\n  session_ttl: \"12h\"\n  admin_password_hash: \"old-value\"\n"
	got := upsertAdminHash(doc, "pbkdf2-sha256$600000$YQ==$Yg==")
	for _, want := range []string{"127.0.0.1:8787", "# 这是用户的注释", "session_ttl", "pbkdf2-sha256$600000$YQ==$Yg=="} {
		if !strings.Contains(got, want) {
			t.Fatalf("改写后丢失 %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "old-value") {
		t.Fatalf("旧哈希未被替换:\n%s", got)
	}
}

// TestFirstRunAuthGuideNonTTYPrintsHint 覆盖首启引导：非 TTY 只提示、不阻塞、不建配置。
func TestFirstRunAuthGuideNonTTYPrintsHint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.yaml")
	snap, _, err := coreconfig.Load(coreconfig.Options{FlagPath: path})
	if err != nil {
		t.Fatalf("加载默认配置失败: %v", err)
	}
	cfg := buildConfig(snap, serveOptions{config: path})
	withAdminFakes(t, false)

	var stderr bytes.Buffer
	firstRunAuthGuide(&cfg, &stderr)
	out := stderr.String()
	if !strings.Contains(out, "admin-password --generate") || !strings.Contains(out, "非交互") {
		t.Fatalf("首启提示不可操作:\n%s", out)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("非 TTY 引导不应写配置，stat err=%v", err)
	}
}

// TestFirstRunAuthGuideTTYSetsPassword 覆盖首启引导：TTY 下交互设置并落盘 0600。
func TestFirstRunAuthGuideTTYSetsPassword(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	snap, _, err := coreconfig.Load(coreconfig.Options{FlagPath: path})
	if err != nil {
		t.Fatalf("加载默认配置失败: %v", err)
	}
	cfg := buildConfig(snap, serveOptions{config: path})
	withAdminFakes(t, true, "first-run-pass", "first-run-pass")

	var stderr bytes.Buffer
	firstRunAuthGuide(&cfg, &stderr)
	if strings.Contains(stderr.String(), "first-run-pass") {
		t.Fatal("首启引导输出泄露了口令明文")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("首启引导应写出配置: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("配置权限必须 0600，实际 %04o", perm)
	}
	if cfg.snapshot.Auth.AdminPasswordHash == "" {
		t.Fatal("重载后快照里没有哈希")
	}
	ok, err := auth.VerifyPassword(cfg.snapshot.Auth.AdminPasswordHash, "first-run-pass")
	if err != nil || !ok {
		t.Fatalf("首启设置的口令未通过校验: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(stderr.String(), "已写入") {
		t.Fatalf("首启引导未给出写入成功提示:\n%s", stderr.String())
	}
}
