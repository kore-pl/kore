package supervisor_test

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// oneshotEnv 是 oneshot 测试脚手架：共享 catalog / manager，可混入多个不同 lifecycle 插件。
type oneshotEnv struct {
	catalog *registry.Catalog
	manager *supervisor.Manager
	runDir  string
}

// newOneshotEnv 在 t.TempDir() 下装配 N 个插件，每个可独立指定 lifecycle。
func newOneshotEnv(t *testing.T, specs map[string]string) *oneshotEnv {
	t.Helper()
	root := t.TempDir()
	catalog := registry.NewCatalog()
	for id, lifecycle := range specs {
		dir := registry.PluginDir(root, id, pluginVersion)
		binDir := filepath.Join(dir, "bin")
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			t.Fatalf("建插件目录失败: %v", err)
		}
		if err := os.Symlink(fakePluginPath, filepath.Join(binDir, id)); err != nil {
			t.Fatalf("链接假插件失败: %v", err)
		}
		writeOneshotManifest(t, dir, id, lifecycle)
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
		Transport: plat.Transport, Manifests: catalog, RunDir: runDir, Version: "0.1.0",
	})
	if err != nil {
		t.Fatalf("构造 supervisor 失败: %v", err)
	}
	env := &oneshotEnv{catalog: catalog, manager: manager, runDir: runDir}
	t.Cleanup(func() {
		for id := range specs {
			_ = manager.Stop(context.Background(), id)
		}
	})
	return env
}

// writeOneshotManifest 写一份指定 lifecycle 的 info.json。
func writeOneshotManifest(t *testing.T, dir, id, lifecycle string) {
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

// invokeOnce 模拟一次完整调用：写 request 帧、读 response 帧（bus.Call 的等价最小动作）。
func invokeOnce(t *testing.T, conn net.Conn) {
	t.Helper()
	request := &pluginapi.Request{
		Type: pluginapi.TypeRequest, ID: "00000000000000000000000000000002",
		Method: "echo.run", Params: json.RawMessage(`{}`),
	}
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("设置调用超时失败: %v", err)
	}
	if err := pluginapi.WriteJSON(conn, request); err != nil {
		t.Fatalf("写请求帧失败: %v", err)
	}
	payload, err := pluginapi.ReadFrame(conn, pluginapi.MaxFrameSize)
	if err != nil {
		t.Fatalf("读响应帧失败: %v", err)
	}
	env, err := pluginapi.DecodeFrame(payload)
	if err != nil {
		t.Fatalf("解码响应帧失败: %v", err)
	}
	if _, ok := env.(*pluginapi.Response); !ok {
		t.Fatalf("响应帧类型应为 response，实际 %T", env)
	}
}
