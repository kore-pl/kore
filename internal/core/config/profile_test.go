package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPortableDefaultLayout 验证 KORE_HOME 下四类目录都在安装目录内（ADR-0023）。
func TestPortableDefaultLayout(t *testing.T) {
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	t.Setenv(EnvProfile, "")
	snap := Default()
	if snap.Profile != ProfilePortable {
		t.Fatalf("默认 profile 应为 portable，实际 %q", snap.Profile)
	}
	for _, item := range []struct{ name, got, want string }{
		{"state_dir", snap.Paths.StateDir, filepath.Join(home, "data")},
		{"log_dir", snap.Paths.LogDir, filepath.Join(home, "logs")},
		{"run_dir", snap.Paths.RunDir, filepath.Join(home, "run")},
		{"index_dir", snap.Paths.IndexDir, filepath.Join(home, "data", "index")},
		{"socket", snap.Server.Socket, filepath.Join(home, "run", "kore.sock")},
	} {
		if item.got != item.want {
			t.Fatalf("%s 默认值应为 %q，实际 %q", item.name, item.want, item.got)
		}
	}
	if !strings.HasPrefix(snap.Paths.StateDir, home) {
		t.Fatalf("state_dir 必须落在安装目录内: %q", snap.Paths.StateDir)
	}
}

// TestDefaultConfigPathFollowsProfile 验证配置路径随 profile 变化。
func TestDefaultConfigPathFollowsProfile(t *testing.T) {
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	t.Setenv(EnvConfigPath, "")
	t.Setenv(EnvProfile, "")
	if got, want := DefaultConfigPath(), filepath.Join(home, "config", "config.yaml"); got != want {
		t.Fatalf("portable 配置路径应为 %q，实际 %q", want, got)
	}
	t.Setenv(EnvProfile, ProfileFHS)
	if got := DefaultConfigPath(); got != DefaultPath {
		t.Fatalf("fhs 配置路径应为 %q，实际 %q", DefaultPath, got)
	}
}

// TestProfileFHSFromConfig 验证配置文件里的 profile=fhs 生效并给出非零侵入 WARN。
func TestProfileFHSFromConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	t.Setenv(EnvProfile, "")
	path := writeConfig(t, t.TempDir(), "profile: fhs\n")
	snap, warnings, err := Load(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("profile=fhs 应可加载: %v", err)
	}
	if snap.Profile != ProfileFHS {
		t.Fatalf("profile 应为 fhs，实际 %q", snap.Profile)
	}
	if snap.Paths.StateDir != "/var/lib/kore" || snap.Paths.RunDir != "/run/kore" {
		t.Fatalf("fhs 路径未生效: %+v", snap.Paths)
	}
	found := false
	for _, w := range warnings {
		if w.Key == "profile" && strings.Contains(w.String(), "非零侵入") {
			found = true
		}
	}
	if !found {
		t.Fatalf("fhs 应给出非零侵入 WARN，实际: %v", warnings)
	}
}

// TestEnvProfileWinsOverConfig 验证 KORE_PROFILE 优先于配置文件。
func TestEnvProfileWinsOverConfig(t *testing.T) {
	t.Setenv(EnvHome, t.TempDir())
	t.Setenv(EnvProfile, ProfileFHS)
	path := writeConfig(t, t.TempDir(), "profile: portable\n")
	snap, warnings, err := Load(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if snap.Profile != ProfileFHS {
		t.Fatalf("环境变量应覆盖为 fhs，实际 %q", snap.Profile)
	}
	if snap.Paths.StateDir != "/var/lib/kore" {
		t.Fatalf("fhs 路径未生效: %q", snap.Paths.StateDir)
	}
	found := false
	for _, w := range warnings {
		if w.Key == "profile" && strings.Contains(w.String(), EnvProfile) {
			found = true
		}
	}
	if !found {
		t.Fatalf("应给被环境变量覆盖的 WARN，实际: %v", warnings)
	}
}

// TestInvalidProfileRejected 验证非法 profile 是致命错误（不是静默降级）。
func TestInvalidProfileRejected(t *testing.T) {
	t.Setenv(EnvHome, t.TempDir())
	t.Setenv(EnvProfile, "")
	path := writeConfig(t, t.TempDir(), "profile: weird\n")
	if _, _, err := Load(Options{FlagPath: path, Logger: testLogger()}); err == nil {
		t.Fatal("非法 profile 应报错")
	}
}

// TestExplicitPathsBeatProfileSwitch 验证显式路径不被 profile 覆盖。
func TestExplicitPathsBeatProfileSwitch(t *testing.T) {
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	t.Setenv(EnvProfile, "")
	state := filepath.Join(t.TempDir(), "my-state")
	body := "profile: fhs\npaths:\n  state_dir: " + state + "\n  log_dir: /tmp/my-log\n  run_dir: /tmp/my-run\n  index_dir: /tmp/my-index\n"
	path := writeConfig(t, t.TempDir(), body)
	snap, _, err := Load(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if snap.Paths.StateDir != state {
		t.Fatalf("显式 state_dir 不应被覆盖，实际 %q", snap.Paths.StateDir)
	}
	if snap.Paths.LogDir != "/tmp/my-log" {
		t.Fatalf("显式 log_dir 不应被覆盖，实际 %q", snap.Paths.LogDir)
	}
	// 未显式设置的 socket 按 profile 取默认。
	if snap.Server.Socket != "/run/kore/kore.sock" {
		t.Fatalf("socket 应按 fhs 默认，实际 %q", snap.Server.Socket)
	}
}

// TestInstallRootEnv 验证 KORE_HOME 优先且被归一为绝对路径。
func TestInstallRootEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvHome, dir)
	if got := InstallRoot(); got != dir {
		t.Fatalf("InstallRoot 应为 %q，实际 %q", dir, got)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("测试目录应存在: %v", err)
	}
}
