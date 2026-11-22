package store

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// auditEnv 是四类事件端到端脚手架：真实 supervisor 进程事件 + 真实 store 落库。
// store 测试 import supervisor 只发生在 _test.go（生产代码零依赖）；supervisor 侧
// 只见 Auditor 接口，不 import store（G-01）。
type auditEnv struct {
	manager *supervisor.Manager
	db      *Store
	id      string
	pidFile string
}

// putAuditAdapter 与 cmd/kored/serve_audit.go 的 storeAuditor 同构：
// 事件字段一一透传，detail 校验由 PutAudit 完成。
type putAuditAdapter struct {
	db *Store
}

// Record 实现 supervisor.Auditor。
func (a *putAuditAdapter) Record(_ context.Context, ev supervisor.AuditEvent) error {
	return a.db.PutAudit(AuditRecord{
		Subject: ev.Subject,
		Action:  ev.Action,
		Plugin:  ev.Plugin,
		Target:  ev.Target,
		Result:  ev.Result,
		Detail:  ev.Detail,
	})
}

// newAuditEnv 构造真实 supervisor + 真实状态库，Auditor 注入 store.PutAudit。
func newAuditEnv(t *testing.T) *auditEnv {
	t.Helper()
	root := t.TempDir()
	id := "echo"
	bin := buildAuditFakePlugin(t)
	pluginDir, pidFile := writeAuditFixture(t, root, id, bin)
	catalog := registry.NewCatalog()
	manifest, err := registry.Load(pluginDir)
	if err != nil {
		t.Fatalf("加载清单失败: %v", err)
	}
	if err := catalog.Add(manifest); err != nil {
		t.Fatalf("登记清单失败: %v", err)
	}
	if err := catalog.Enable(id); err != nil {
		t.Fatalf("enable 失败: %v", err)
	}
	runDir := filepath.Join(root, "run")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatalf("创建运行目录失败: %v", err)
	}
	plat, err := platform.New(platform.Config{
		ConfigDir: filepath.Join(root, "etc"),
		StateDir:  filepath.Join(root, "var"),
		RunDir:    runDir,
		LogDir:    filepath.Join(root, "log"),
	})
	if err != nil {
		t.Skipf("当前平台无运行期实现，跳过: %v", err)
	}
	db, err := Open(filepath.Join(root, "state"), testLogger())
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	// 先注册关闭、后注册 Stop：清理按 LIFO 执行，保证 Stop 仍能写审计。
	t.Cleanup(func() { _ = db.Close() })
	manager, err := supervisor.New(supervisor.Options{
		Transport: plat.Transport, Manifests: catalog, RunDir: runDir,
		Version: "0.1.0", Auditor: &putAuditAdapter{db: db},
	})
	if err != nil {
		t.Fatalf("构造 supervisor 失败: %v", err)
	}
	t.Cleanup(func() { _ = manager.Stop(context.Background(), id) })
	return &auditEnv{manager: manager, db: db, id: id, pidFile: pidFile}
}

// waitAuditAction 轮询直到指定 action 的审计记录落库（reaper 是异步的）。
func waitAuditAction(t *testing.T, s *Store, action string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got, err := s.ListAudit(AuditFilter{Action: action})
		if err != nil {
			t.Fatalf("ListAudit(%s) 失败: %v", action, err)
		}
		if len(got) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("等待 %s 审计落库超时（5s）", action)
}

// readAuditPid 读假插件写下的 pid 文件。
func readAuditPid(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 pid 文件失败: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		t.Fatalf("pid 文件内容非法: %q", data)
	}
	return pid
}

// buildAuditFakePlugin 构建 supervisor testdata 的假插件二进制。
func buildAuditFakePlugin(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件路径")
	}
	// file=internal/core/store/<本文件> → 上溯 4 级到仓库根。
	root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(file))))
	out := filepath.Join(t.TempDir(), "fake-plugin")
	build := exec.Command("go", "build", "-o", out, "./internal/core/supervisor/testdata/fakeplugin")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("构建假插件失败: %v\n%s", err, output)
	}
	return out
}

// writeAuditFixture 造 <root>/echo/<version>/info.json + bin/echo 与 pid_file 配置。
func writeAuditFixture(t *testing.T, root, id, bin string) (pluginDir, pidFile string) {
	t.Helper()
	pluginDir = registry.PluginDir(root, id, "0.1.0")
	binDir := filepath.Join(pluginDir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("创建插件目录失败: %v", err)
	}
	if err := os.Symlink(bin, filepath.Join(binDir, id)); err != nil {
		t.Fatalf("链接假插件失败: %v", err)
	}
	manifest := map[string]any{
		"id": id, "name": "测试插件", "version": "0.1.0",
		"protocol": pluginapi.Protocol, "lifecycle": "resident",
		"entry": "bin/" + id, "capabilities": []string{"system:read"},
		"resources":     map[string]any{"memory_mb": 8, "cpu_quota": "50%", "pids_max": 64},
		"requires_kore": ">=0.1.0 <0.2.0",
		"triggers":      []string{}, "depends_on": []string{},
		"scenario_tags": []string{"web"}, "size_bytes": 1024,
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("序列化清单失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "info.json"), data, 0o644); err != nil {
		t.Fatalf("写 info.json 失败: %v", err)
	}
	pidFile = filepath.Join(root, "plugin.pid")
	stateDir := filepath.Join(root, id)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("创建状态目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "fake.conf"),
		[]byte("pid_file="+pidFile+"\n"), 0o600); err != nil {
		t.Fatalf("写 fake.conf 失败: %v", err)
	}
	return pluginDir, pidFile
}
