package config

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testLogger 返回丢弃输出的 logger，避免单测刷屏。
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// writeConfig 在临时目录写配置文件并返回路径。
func writeConfig(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}
	return path
}

// loadFile 用显式路径加载配置，并清空环境变量干扰。
func loadFile(t *testing.T, path string) (*Snapshot, []Warning, error) {
	t.Helper()
	t.Setenv(EnvConfigPath, "")
	t.Setenv(EnvStateDir, "")
	t.Setenv(EnvPluginDir, "")
	return Load(Options{FlagPath: path, Logger: testLogger()})
}

// TestMissingFileUsesDefaults 验证文件不存在时内置默认值 + WARN。
func TestMissingFileUsesDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.yaml")
	snap, warnings, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("文件缺失应继续启动，实际错误: %v", err)
	}
	if snap.Paths.StateDir != "/var/lib/kore" || snap.Paths.PluginDir != "/var/lib/kore/plugins" {
		t.Fatalf("默认目录不匹配: state_dir=%q plugin_dir=%q", snap.Paths.StateDir, snap.Paths.PluginDir)
	}
	if snap.Auth.SessionTTL != 12*time.Hour {
		t.Fatalf("默认 TTL 不匹配: %s", snap.Auth.SessionTTL)
	}
	if len(warnings) == 0 || !strings.Contains(warnings[0].String(), "不存在") {
		t.Fatalf("期望文件缺失 WARN，实际: %v", warnings)
	}
}

// TestUnknownFieldWarnsWithSuggestion 验证未知字段只 WARN 且给拼写建议。
func TestUnknownFieldWarnsWithSuggestion(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "plugins:\n  autostrat: []\n")
	snap, warnings, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("未知字段不应阻断启动: %v", err)
	}
	if snap == nil {
		t.Fatal("未知字段场景应返回快照")
	}
	if len(warnings) == 0 {
		t.Fatal("期望未知字段 WARN")
	}
	found := false
	for _, w := range warnings {
		if w.Key == "plugins.autostrat" {
			found = true
			if w.Suggestion != "plugins.autostart" {
				t.Fatalf("拼写建议应为 plugins.autostart，实际 %q", w.Suggestion)
			}
			if !strings.Contains(w.String(), "是否想写") {
				t.Fatalf("告警文本缺少建议: %s", w.String())
			}
		}
	}
	if !found {
		t.Fatalf("未找到 plugins.autostrat 告警: %v", warnings)
	}
}

// TestTypeErrorHasLineNumber 验证类型错误带文件行号。
func TestTypeErrorHasLineNumber(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "auth:\n  session_ttl: 12\n")
	_, _, err := loadFile(t, path)
	if err == nil {
		t.Fatal("整数写成 duration 应报错")
	}
	text := err.Error()
	if !strings.Contains(text, "auth.session_ttl") || !strings.Contains(text, "duration") {
		t.Fatalf("错误文本缺少字段或期望类型: %s", text)
	}
	if !strings.Contains(text, ":2:") {
		t.Fatalf("错误文本缺少行号 2: %s", text)
	}
}

// TestOutOfRangeAndAddrRejected 验证越界与非回环地址一次报出。
func TestOutOfRangeAndAddrRejected(t *testing.T) {
	body := "server:\n  addr: \"0.0.0.0:8787\"\nauth:\n  session_ttl: \"1s\"\n"
	path := writeConfig(t, t.TempDir(), body)
	_, _, err := loadFile(t, path)
	if err == nil {
		t.Fatal("越界配置应报错")
	}
	text := err.Error()
	for _, want := range []string{"server.addr", ":2:", "auth.session_ttl", ":4:"} {
		if !strings.Contains(text, want) {
			t.Fatalf("错误文本缺少 %q: %s", want, text)
		}
	}
}

// TestInitializedWithoutHashRejected 验证首启状态不一致直接拒绝。
func TestInitializedWithoutHashRejected(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "auth:\n  initialized: true\n")
	_, _, err := loadFile(t, path)
	if err == nil || !strings.Contains(err.Error(), "auth.admin_password_hash") {
		t.Fatalf("期望 initialized 不一致错误，实际: %v", err)
	}
}

// TestPluginDirFollowsStateDir 验证只设 KORE_STATE_DIR 时 plugin_dir 跟随派生。
func TestPluginDirFollowsStateDir(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "paths:\n  state_dir: /tmp/from-file\n")
	t.Setenv(EnvConfigPath, "")
	t.Setenv(EnvPluginDir, "")
	t.Setenv(EnvStateDir, "/tmp/x")
	snap, _, err := Load(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if snap.Paths.StateDir != "/tmp/x" {
		t.Fatalf("state_dir 应为 /tmp/x，实际 %q", snap.Paths.StateDir)
	}
	if snap.Paths.PluginDir != "/tmp/x/plugins" {
		t.Fatalf("plugin_dir 应派生为 /tmp/x/plugins，实际 %q", snap.Paths.PluginDir)
	}
}

// TestPluginDirEnvWins 验证 KORE_PLUGIN_DIR 优先于配置文件。
func TestPluginDirEnvWins(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "paths:\n  plugin_dir: /tmp/from-file-plugins\n")
	t.Setenv(EnvConfigPath, "")
	t.Setenv(EnvStateDir, "")
	t.Setenv(EnvPluginDir, "/tmp/from-env-plugins")
	snap, _, err := Load(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if snap.Paths.PluginDir != "/tmp/from-env-plugins" {
		t.Fatalf("KORE_PLUGIN_DIR 应优先，实际 %q", snap.Paths.PluginDir)
	}
}

// TestPluginDirFromConfig 验证无环境变量时使用配置文件里的 plugin_dir。
func TestPluginDirFromConfig(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "paths:\n  plugin_dir: /tmp/explicit-plugins\n")
	t.Setenv(EnvConfigPath, "")
	t.Setenv(EnvStateDir, "")
	t.Setenv(EnvPluginDir, "")
	snap, _, err := Load(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if snap.Paths.PluginDir != "/tmp/explicit-plugins" {
		t.Fatalf("应使用配置项，实际 %q", snap.Paths.PluginDir)
	}
}
