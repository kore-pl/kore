package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const relativePathsYAML = `paths:
  state_dir: "./.kore-local-state"
  run_dir:   "./.kore-local-run"
  log_dir:   "./.kore-local-log"
  index_dir: "../kore-plugins/index"
`

// TestLoadNormalizesRelativePaths 验证相对路径在加载后一律变成绝对路径，
// 且 plugin_dir 派生值同样为绝对路径（supervisor 切 cmd.Dir 后不再失配）。
func TestLoadNormalizesRelativePaths(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(relativePathsYAML), 0o600); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}

	snap, warnings, err := Load(Options{FlagPath: path})
	if err != nil {
		t.Fatalf("Load 失败: %v", err)
	}
	want := map[string]string{
		"state_dir":  filepath.Join(dir, ".kore-local-state"),
		"run_dir":    filepath.Join(dir, ".kore-local-run"),
		"log_dir":    filepath.Join(dir, ".kore-local-log"),
		"index_dir":  filepath.Join(filepath.Dir(dir), "kore-plugins", "index"),
		"plugin_dir": filepath.Join(dir, ".kore-local-state", "plugins"),
	}
	got := map[string]string{
		"state_dir":  snap.Paths.StateDir,
		"run_dir":    snap.Paths.RunDir,
		"log_dir":    snap.Paths.LogDir,
		"index_dir":  snap.Paths.IndexDir,
		"plugin_dir": snap.Paths.PluginDir,
	}
	for key, expected := range want {
		if got[key] != expected {
			t.Errorf("%s = %q，期望 %q", key, got[key], expected)
		}
		if !filepath.IsAbs(got[key]) {
			t.Errorf("%s = %q 不是绝对路径", key, got[key])
		}
	}
	var normalized int
	for _, w := range warnings {
		if strings.Contains(w.Message, "已归一化为绝对路径") {
			normalized++
		}
	}
	if normalized < 4 {
		t.Errorf("归一化告警 %d 条，期望至少 4 条（便于日志排查）: %+v", normalized, warnings)
	}
}

// TestLoadRejectsTildePath 验证 `~` 不被静默当成普通相对目录，而是明确报错。
func TestLoadRejectsTildePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	body := "paths:\n  state_dir: \"~/.kore/state\"\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}
	if _, _, err := Load(Options{FlagPath: path}); err == nil {
		t.Fatal("~ 前缀应返回明确错误，实际为 nil")
	} else if !strings.Contains(err.Error(), "绝对路径") || !strings.Contains(err.Error(), "paths.state_dir") {
		t.Fatalf("错误信息应同时包含字段名与绝对路径提示，实际: %v", err)
	}
}

// TestLoadRelativePathsStableAcrossCwd 是本字段的事故回归：同一份配置在两个
// 不同进程 cwd 下加载，必须算出**同一个** state_dir 绝对路径。
//
// 事故形态：归一化曾用 filepath.Abs（基准 cwd），同一份 config 在不同目录启动
// kored 会算出不同状态库——第二个 state.db，不报错、结果错。
func TestLoadRelativePathsStableAcrossCwd(t *testing.T) {
	cfgDir := t.TempDir()
	path := filepath.Join(cfgDir, "config.yaml")
	if err := os.WriteFile(path, []byte(relativePathsYAML), 0o600); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}
	want := filepath.Join(cfgDir, ".kore-local-state")

	loadFrom := func(cwd string) string {
		t.Helper()
		t.Chdir(cwd)
		snap, _, err := Load(Options{FlagPath: path})
		if err != nil {
			t.Fatalf("cwd=%s 时 Load 失败: %v", cwd, err)
		}
		return snap.Paths.StateDir
	}

	first := loadFrom(t.TempDir())
	second := loadFrom(t.TempDir())
	if first != second {
		t.Fatalf("不同 cwd 算出不同 state_dir：%q vs %q（这正是要消灭的静默分叉）", first, second)
	}
	if first != want {
		t.Fatalf("state_dir = %q，期望按配置文件目录解析为 %q", first, want)
	}
}

// TestLoadSocketNormalized 验证 server.socket 这类路径字段同样按配置文件目录归一，
// 否则 UDS 落点也会随 cwd 漂移（同一类静默分叉）。
func TestLoadSocketNormalized(t *testing.T) {
	cfgDir := t.TempDir()
	path := filepath.Join(cfgDir, "config.yaml")
	body := "server:\n  socket: \"./run/kore.sock\"\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}
	snap, warnings, err := Load(Options{FlagPath: path})
	if err != nil {
		t.Fatalf("Load 失败: %v", err)
	}
	want := filepath.Join(cfgDir, "run", "kore.sock")
	if snap.Server.Socket != want {
		t.Fatalf("server.socket = %q，期望 %q", snap.Server.Socket, want)
	}
	var hit bool
	for _, w := range warnings {
		if w.Key == "server.socket" && strings.Contains(w.Message, want) {
			hit = true
		}
	}
	if !hit {
		t.Fatalf("缺少 server.socket 归一化告警（日志需可核对）: %+v", warnings)
	}
}

// TestLoadKeepsAbsolutePaths 验证已经是绝对路径的值不被改动。
func TestLoadKeepsAbsolutePaths(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	state := filepath.Join(dir, "state")
	body := "paths:\n  state_dir: \"" + state + "\"\n  run_dir: \"" + filepath.Join(dir, "run") + "\"\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}
	snap, _, err := Load(Options{FlagPath: path})
	if err != nil {
		t.Fatalf("Load 失败: %v", err)
	}
	if snap.Paths.StateDir != state {
		t.Fatalf("绝对路径被改写: got %q want %q", snap.Paths.StateDir, state)
	}
}
