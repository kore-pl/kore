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

// TestLazyEvictsLeastRecentlyUsed：用例④ 超 3 槽驱逐最久未用的 lazy。
//
// 场景：4 个 lazy 依次唤醒 p1→p2→p3 占满 3 槽，再唤醒 p4；
// 断言最久未用的 lazy1 被驱逐（stopped），其余仍 ready，在跑数恒 ≤3。
func TestLazyEvictsLeastRecentlyUsed(t *testing.T) {
	env := newMixedEnv(t, []string{"lazy1", "lazy2", "lazy3", "lazy4"}, time.Minute)
	ctx := context.Background()
	pids := make(map[string]int, 3)
	for _, id := range []string{"lazy1", "lazy2", "lazy3"} {
		// 共享连接由 bus 持有，测试不关闭（关闭会让假插件 EOF 退出）。
		_, err := env.manager.Ensure(ctx, id)
		if err != nil {
			t.Fatalf("invoke %s 失败: %v", id, err)
		}
		view, _ := env.manager.Snapshot(id)
		pids[id] = view.PID
	}
	// 第 4 个唤醒时槽位已满，应驱逐最久未用（lazy1）。
	if _, err := env.manager.Ensure(ctx, "lazy4"); err != nil {
		t.Fatalf("invoke lazy4 应驱逐最久未用 lazy，实际: %v", err)
	}
	evicted, _ := env.manager.Snapshot("lazy1")
	if evicted.State != supervisor.StateStopped {
		t.Fatalf("最久未用的 lazy1 应被驱逐为 stopped，实际 %s", evicted.State)
	}
	if processAlive(pids["lazy1"]) {
		t.Fatalf("被驱逐的 lazy1 进程 %d 应退出", pids["lazy1"])
	}
	for _, id := range []string{"lazy2", "lazy3", "lazy4"} {
		view, _ := env.manager.Snapshot(id)
		if view.State != supervisor.StateReady || view.PID <= 0 {
			t.Fatalf("%s 应保持 ready，实际 %+v", id, view)
		}
	}
	assertRunningSlots(t, env.manager,
		[]string{"lazy1", "lazy2", "lazy3", "lazy4"}, 3)
}

// TestLazyResidentNotEvicted：resident 占槽但永不被驱逐；满槽时驱逐的是最久未用 lazy。
func TestLazyResidentNotEvicted(t *testing.T) {
	env := newMixedEnv(t, []string{"res0", "lazy1", "lazy2", "lazy3"}, time.Minute)
	ctx := context.Background()
	if err := env.manager.Start(ctx, "res0"); err != nil {
		t.Fatalf("resident 启动失败: %v", err)
	}
	for _, id := range []string{"lazy1", "lazy2"} {
		if _, err := env.manager.Ensure(ctx, id); err != nil {
			t.Fatalf("invoke %s 失败: %v", id, err)
		}
	}
	// 此时 res0 + lazy1 + lazy2 = 3 槽满，唤醒 lazy3 应驱逐 lazy1（非 resident）。
	if _, err := env.manager.Ensure(ctx, "lazy3"); err != nil {
		t.Fatalf("invoke lazy3 失败: %v", err)
	}
	resView, _ := env.manager.Snapshot("res0")
	if resView.State != supervisor.StateReady {
		t.Fatalf("resident 不应被驱逐，实际 %s", resView.State)
	}
	lazy1, _ := env.manager.Snapshot("lazy1")
	if lazy1.State != supervisor.StateStopped {
		t.Fatalf("应驱逐最久未用 lazy1，实际 %s", lazy1.State)
	}
	assertRunningSlots(t, env.manager,
		[]string{"res0", "lazy1", "lazy2", "lazy3"}, 3)
}

// newMixedEnv 造一批插件：id 以 "res" 开头为 resident，其余为 lazy，共享一个 manager。
func newMixedEnv(t *testing.T, ids []string, idle time.Duration) *lazyEnv {
	t.Helper()
	root := t.TempDir()
	catalog := registry.NewCatalog()
	for _, id := range ids {
		lifecycle := registry.LifecycleLazy
		if len(id) >= 3 && id[:3] == "res" {
			lifecycle = registry.LifecycleResident
		}
		dir := registry.PluginDir(root, id, pluginVersion)
		binDir := filepath.Join(dir, "bin")
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			t.Fatalf("建插件目录失败: %v", err)
		}
		if err := os.Symlink(fakePluginPath, filepath.Join(binDir, id)); err != nil {
			t.Fatalf("链接假插件失败: %v", err)
		}
		writeLifecycleManifest(t, dir, id, lifecycle)
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
	manager, err := supervisor.New(supervisor.Options{
		Transport: plat.Transport, Manifests: catalog, RunDir: runDir,
		Version: "0.1.0", IdleTimeout: idle,
	})
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

// writeLifecycleManifest 写一份指定 Lifecycle 的 info.json。
func writeLifecycleManifest(t *testing.T, dir, id string, lifecycle registry.Lifecycle) {
	t.Helper()
	manifest := map[string]any{
		"id": id, "name": "测试插件", "version": pluginVersion,
		"protocol": pluginapi.Protocol, "lifecycle": string(lifecycle),
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

// assertRunningSlots 统计在跑实例数；用例口径要求 ≤ limit。
func assertRunningSlots(t *testing.T, m *supervisor.Manager, ids []string, limit int) {
	t.Helper()
	running := 0
	for _, id := range ids {
		view, _ := m.Snapshot(id)
		switch view.State {
		case supervisor.StateReady, supervisor.StateStarting, supervisor.StateDraining:
			running++
		}
	}
	if running > limit {
		t.Fatalf("同时常驻 %d > 上限 %d", running, limit)
	}
}
