package supervisor_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// lazyEnv 持有多个插件共享的 catalog / manager，供 lazy 场景断言进程与槽位。
type lazyEnv struct {
	catalog *registry.Catalog
	manager *supervisor.Manager
	runDir  string
}

// newLazyEnv 在 t.TempDir() 下装配 N 个指定 lifecycle 的插件；mutate 可覆盖 Options。
func newLazyEnv(t *testing.T, ids []string, lifecycle string, idle time.Duration, mutate ...func(*supervisor.Options)) *lazyEnv {
	t.Helper()
	root := t.TempDir()
	catalog := registry.NewCatalog()
	for _, id := range ids {
		dir := registry.PluginDir(root, id, pluginVersion)
		binDir := filepath.Join(dir, "bin")
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			t.Fatalf("建插件目录失败: %v", err)
		}
		if err := os.Symlink(fakePluginPath, filepath.Join(binDir, id)); err != nil {
			t.Fatalf("链接假插件失败: %v", err)
		}
		writeLazyManifest(t, dir, id, lifecycle)
		manifest, err := registry.Load(dir)
		if err != nil {
			t.Fatalf("加载清单失败: %v", err)
		}
		if err := catalog.Add(manifest); err != nil {
			t.Fatalf("登记清单失败: %v", err)
		}
		if err := catalog.Enable(id); err != nil {
			t.Fatalf("enable 失败: %v", err)
		}
	}
	runDir := filepath.Join(root, "run")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatalf("建运行目录失败: %v", err)
	}
	plat, err := platform.New(platform.Config{
		ConfigDir: filepath.Join(root, "etc"), StateDir: filepath.Join(root, "var"),
		RunDir: runDir, LogDir: filepath.Join(root, "log"),
	})
	if err != nil {
		t.Skipf("当前平台无运行期实现: %v", err)
	}
	opts := supervisor.Options{
		Transport: plat.Transport, Manifests: catalog, RunDir: runDir,
		Version: "0.1.0", IdleTimeout: idle,
	}
	for _, fn := range mutate {
		fn(&opts)
	}
	manager, err := supervisor.New(opts)
	if err != nil {
		t.Fatalf("构造 supervisor 失败: %v", err)
	}
	env := &lazyEnv{catalog: catalog, manager: manager, runDir: runDir}
	t.Cleanup(func() {
		for _, id := range ids {
			_ = manager.Stop(context.Background(), id)
		}
	})
	return env
}

// writeLazyManifest 写一份指定 lifecycle 的 info.json（idle_timeout_s 不声明，用 Options 覆盖）。
func writeLazyManifest(t *testing.T, dir, id, lifecycle string) {
	t.Helper()
	manifest := map[string]any{
		"id": id, "name": "测试插件", "version": pluginVersion,
		"protocol": pluginapi.Protocol, "lifecycle": lifecycle,
		"entry": "bin/" + id, "capabilities": []string{"system:read"},
		"resources":     map[string]any{"memory_mb": 8, "cpu_quota": "50%", "pids_max": 64},
		"requires_kore": ">=0.1.0 <0.2.0", "triggers": []string{},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("序列化清单失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "info.json"), data, 0o644); err != nil {
		t.Fatalf("写 info.json 失败: %v", err)
	}
}

// TestLazyEnableNoProcess：用例① lazy enable 不起进程（只标记 desired=enabled）。
func TestLazyEnableNoProcess(t *testing.T) {
	env := newLazyEnv(t, []string{"lazya"}, "lazy", time.Minute)
	if err := env.manager.Start(context.Background(), "lazya"); err != nil {
		t.Fatalf("lazy Start（enable 阶段）应成功: %v", err)
	}
	view, ok := env.manager.Snapshot("lazya")
	if !ok {
		t.Fatalf("lazy enable 后应登记运行态")
	}
	if view.State != supervisor.StateStopped || view.PID != 0 {
		t.Fatalf("lazy enable 不应拉起进程，实际 %+v", view)
	}
}

// TestLazyFirstInvokeStarts：用例② 首次 invoke 按需冷启。
func TestLazyFirstInvokeStarts(t *testing.T) {
	env := newLazyEnv(t, []string{"lazyb"}, "lazy", time.Minute)
	// Ensure 返回的 UDS 连接由 bus 长期持有，测试不关闭（关闭会让假插件 EOF 退出）。
	if _, err := env.manager.Ensure(context.Background(), "lazyb"); err != nil {
		t.Fatalf("首次 invoke 应冷启成功: %v", err)
	}
	view, _ := env.manager.Snapshot("lazyb")
	if view.State != supervisor.StateReady || view.PID <= 0 || !processAlive(view.PID) {
		t.Fatalf("首次 invoke 后应 ready 且进程存活，实际 %+v", view)
	}
}

// TestLazySecondInvokeReuses：用例③ 二次 invoke 复用同一进程。
func TestLazySecondInvokeReuses(t *testing.T) {
	env := newLazyEnv(t, []string{"lazyc"}, "lazy", time.Minute)
	first, err := env.manager.Ensure(context.Background(), "lazyc")
	if err != nil {
		t.Fatalf("首次 invoke 失败: %v", err)
	}
	_ = first // bus 持有连接，测试不关闭
	pid1, _ := env.manager.Snapshot("lazyc")
	second, err := env.manager.Ensure(context.Background(), "lazyc")
	if err != nil {
		t.Fatalf("二次 invoke 失败: %v", err)
	}
	_ = second // 同上，不关闭
	pid2, _ := env.manager.Snapshot("lazyc")
	if pid1.PID != pid2.PID {
		t.Fatalf("二次 invoke 应复用进程：%d → %d", pid1.PID, pid2.PID)
	}
}

// TestLazyIdleExitsAndRespawns：用例⑤ 空闲退出后再次 invoke 重新拉起。
func TestLazyIdleExitsAndRespawns(t *testing.T) {
	env := newLazyEnv(t, []string{"lazye"}, "lazy", 120*time.Millisecond)
	first, err := env.manager.Ensure(context.Background(), "lazye")
	if err != nil {
		t.Fatalf("首次 invoke 失败: %v", err)
	}
	_ = first // 不关闭共享连接
	before, _ := env.manager.Snapshot("lazye")
	waitStopped(t, env.manager, "lazye", 3*time.Second)
	if processAlive(before.PID) {
		t.Fatalf("空闲到期后进程 %d 应退出", before.PID)
	}
	second, err := env.manager.Ensure(context.Background(), "lazye")
	if err != nil {
		t.Fatalf("空闲退出后再次 invoke 应重拉: %v", err)
	}
	_ = second // 不关闭共享连接
	after, _ := env.manager.Snapshot("lazye")
	if after.PID <= 0 || after.PID == before.PID || !processAlive(after.PID) {
		t.Fatalf("重拉应换一个新进程：%d → %d", before.PID, after.PID)
	}
}

// waitStopped 轮询等待插件进入 stopped（测试辅助，非生产 ticker）。
func waitStopped(t *testing.T, m *supervisor.Manager, id string, limit time.Duration) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		view, _ := m.Snapshot(id)
		if view.State == supervisor.StateStopped {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	view, _ := m.Snapshot(id)
	t.Fatalf("等待空闲退出超时，当前状态 %s", view.State)
}
