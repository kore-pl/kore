package config

import (
	"os"
	"strings"
	"testing"
	"time"
)

// TestReloadWhitelist 验证可热更字段生效、不可热更字段保留旧值并 WARN。
func TestReloadWhitelist(t *testing.T) {
	dir := t.TempDir()
	first := "log:\n  level: info\nserver:\n  addr: \"\"\nauth:\n  session_ttl: \"12h\"\n"
	path := writeConfig(t, dir, first)
	old, _, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("初始加载失败: %v", err)
	}
	second := "log:\n  level: debug\nserver:\n  addr: \"127.0.0.1:8787\"\nauth:\n  session_ttl: \"24h\"\n"
	if err := os.WriteFile(path, []byte(second), 0o600); err != nil {
		t.Fatalf("改写配置失败: %v", err)
	}
	next, warnings, err := old.Reload(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	if next.Log.Level != "debug" {
		t.Fatalf("log.level 未热更: %q", next.Log.Level)
	}
	if next.Auth.SessionTTL != 24*time.Hour {
		t.Fatalf("auth.session_ttl 应热更为 24h，实际 %s", next.Auth.SessionTTL)
	}
	if next.Server.Addr != "" {
		t.Fatalf("server.addr 不可热更，旧值应保留，实际 %q", next.Server.Addr)
	}
	if old.Log.Level != "info" || old.Auth.SessionTTL != 12*time.Hour {
		t.Fatalf("旧快照被原地修改: level=%q ttl=%s", old.Log.Level, old.Auth.SessionTTL)
	}
	foundAddr := false
	for _, w := range warnings {
		if w.Key == "auth.session_ttl" && strings.Contains(w.Message, "不可热更") {
			t.Fatalf("auth.session_ttl 已属热更，不应出现不可热更 WARN: %s", w.String())
		}
		if w.Key == "server.addr" && strings.Contains(w.Message, "不可热更") {
			foundAddr = true
		}
	}
	if !foundAddr {
		t.Fatalf("缺少 server.addr 的不可热更 WARN: %v", warnings)
	}
}

// TestReloadPasswordHashWarns 验证密码哈希热更生效并给出会话不吊销提示。
func TestReloadPasswordHashWarns(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "auth:\n  session_ttl: \"12h\"\n")
	old, _, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("初始加载失败: %v", err)
	}
	newHash := "pbkdf2-sha256$600000$c2FsdA$aGFzaA"
	body := "auth:\n  session_ttl: \"12h\"\n  admin_password_hash: \"" + newHash + "\"\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("改写配置失败: %v", err)
	}
	next, warnings, err := old.Reload(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	if next.Auth.AdminPasswordHash != newHash {
		t.Fatalf("auth.admin_password_hash 未热更: %q", next.Auth.AdminPasswordHash)
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w.String(), "密码已更新") && strings.Contains(w.String(), "SIGHUP") {
			found = true
		}
	}
	if !found {
		t.Fatalf("缺少密码更新 WARN: %v", warnings)
	}
}

// TestReloadFailureKeepsOldSnapshot 验证坏 YAML 重载失败不修改旧快照。
func TestReloadFailureKeepsOldSnapshot(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "log:\n  level: info\n")
	old, _, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("初始加载失败: %v", err)
	}
	if err := os.WriteFile(path, []byte("auth: [\n"), 0o600); err != nil {
		t.Fatalf("改写配置失败: %v", err)
	}
	next, _, err := old.Reload(Options{FlagPath: path, Logger: testLogger()})
	if err == nil {
		t.Fatal("坏 YAML 重载应失败")
	}
	if next != nil {
		t.Fatal("重载失败时不应返回新快照")
	}
	if old.Log.Level != "info" {
		t.Fatalf("旧快照被修改: %q", old.Log.Level)
	}
}

// TestResolvePathPrefersEnv 验证 KORE_CONFIG 优先于 --config。
func TestResolvePathPrefersEnv(t *testing.T) {
	t.Setenv(EnvConfigPath, "/tmp/from-env.yaml")
	if got := ResolvePath("/tmp/from-flag.yaml"); got != "/tmp/from-env.yaml" {
		t.Fatalf("KORE_CONFIG 应优先，实际 %q", got)
	}
}

// TestStateDirEnvOverride 验证 KORE_STATE_DIR 覆盖 paths.state_dir 并告警。
func TestStateDirEnvOverride(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "paths:\n  state_dir: /tmp/from-file\n")
	t.Setenv(EnvConfigPath, "")
	t.Setenv(EnvStateDir, "/tmp/from-env")
	snap, warnings, err := Load(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if snap.Paths.StateDir != "/tmp/from-env" {
		t.Fatalf("环境变量未覆盖: %q", snap.Paths.StateDir)
	}
	if len(warnings) == 0 {
		t.Fatal("环境变量覆盖应产生 WARN")
	}
}
