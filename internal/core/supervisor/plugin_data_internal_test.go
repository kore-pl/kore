package supervisor

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/platform"
)

// dataTestAccess 记录 Own 调用并收紧 mode（测试不切 uid）。
type dataTestAccess struct {
	mu    sync.Mutex
	owned []string
}

func (f *dataTestAccess) Own(path string, _ platform.Account, mode os.FileMode) error {
	f.mu.Lock()
	f.owned = append(f.owned, path)
	f.mu.Unlock()
	return os.Chmod(path, mode)
}

func (f *dataTestAccess) Traversable(string) error { return nil }

// TestPreparePluginDataCreates0700 验证数据根创建为 0700 且 env 注入两项。
func TestPreparePluginDataCreates0700(t *testing.T) {
	root := t.TempDir()
	m := &Manager{opts: Options{PluginDataRoot: root, InstallDir: "/opt/kore"}, access: &dataTestAccess{}}
	inst := &instance{manifest: &registry.Manifest{ID: "site"}}
	dir, err := m.preparePluginData(inst, platform.Account{})
	if err != nil {
		t.Fatalf("preparePluginData 失败: %v", err)
	}
	if want := filepath.Join(root, "site"); dir != want {
		t.Fatalf("数据根 = %q，期望 %q", dir, want)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("数据根不存在: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("数据根权限 = %04o，期望 0700", got)
	}
	env := strings.Join(m.pluginEnv(inst, "/state/site", dir, "tok"), "\n")
	for _, want := range []string{"KORE_PLUGIN_DATA=" + dir, "KORE_INSTALL_DIR=/opt/kore"} {
		if !strings.Contains(env, want) {
			t.Fatalf("env 缺少 %q：\n%s", want, env)
		}
	}
}

// TestPreparePluginDataChownsToPluginUser 验证降权时数据根交给 kore-<id>（0700）。
func TestPreparePluginDataChownsToPluginUser(t *testing.T) {
	root := t.TempDir()
	access := &dataTestAccess{}
	m := &Manager{opts: Options{PluginDataRoot: root}, access: access}
	inst := &instance{manifest: &registry.Manifest{ID: "site"}}
	dir, err := m.preparePluginData(inst, platform.Account{Name: "kore-site", UID: 1234, GID: 1234})
	if err != nil {
		t.Fatalf("preparePluginData 失败: %v", err)
	}
	access.mu.Lock()
	owned := append([]string(nil), access.owned...)
	access.mu.Unlock()
	if len(owned) != 1 || owned[0] != dir {
		t.Fatalf("应把数据根 chown 给插件用户，实际 own=%v dir=%s", owned, dir)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("数据根不存在: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("数据根权限 = %04o，期望 0700", got)
	}
}
