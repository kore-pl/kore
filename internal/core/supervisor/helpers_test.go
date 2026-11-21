package supervisor_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pengtang1024/kore/internal/core/registry"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fakePluginPath 是 TestMain 构建出的假插件二进制（临时目录，测试结束即删）。
var fakePluginPath string

// pluginVersion 是所有测试清单共用的版本号。
const pluginVersion = "0.1.0"

// TestMain 构建一次假插件，跑完清理；测试进程本身不长期驻留任何 kored 实例。
func TestMain(m *testing.M) {
	root, err := locateRepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, "定位仓库根目录失败:", err)
		os.Exit(1)
	}
	tempDir, err := os.MkdirTemp("", "kore-fake-plugin-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "创建假插件目录失败:", err)
		os.Exit(1)
	}
	fakePluginPath = filepath.Join(tempDir, "fake-plugin")
	build := exec.Command("go", "build", "-o", fakePluginPath, "./internal/core/supervisor/testdata/fakeplugin")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "构建假插件失败: %v\n%s\n", err, output)
		os.RemoveAll(tempDir)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(tempDir)
	os.Exit(code)
}

// locateRepoRoot 由本测试文件位置回推仓库根（internal/core/supervisor → root）。
func locateRepoRoot() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("无法定位测试文件路径")
	}
	dir := filepath.Dir(file)
	for i := 0; i < 3; i++ {
		dir = filepath.Dir(dir)
	}
	return dir, nil
}

// testEnv 是一次测试的脚手架：独立 temp 目录 + 已 enable 的 resident 插件。
type testEnv struct {
	catalog *registry.Catalog
	manager *supervisor.Manager
	root    string
	runDir  string
}

// newTestEnv 在 t.TempDir() 下造清单、假插件与 supervisor；mutate 可覆盖 Options。
func newTestEnv(t *testing.T, id string, conf map[string]string, mutate func(*supervisor.Options)) *testEnv {
	t.Helper()
	root := t.TempDir()
	pluginDir := writePluginFixture(t, root, id, conf)
	catalog := enableCatalog(t, pluginDir, id)
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
	options := supervisor.Options{
		Transport: plat.Transport,
		Manifests: catalog,
		RunDir:    runDir,
		Version:   "0.1.0",
	}
	if mutate != nil {
		mutate(&options)
	}
	manager, err := supervisor.New(options)
	if err != nil {
		t.Fatalf("构造 supervisor 失败: %v", err)
	}
	env := &testEnv{catalog: catalog, manager: manager, root: root, runDir: runDir}
	t.Cleanup(func() { _ = manager.Stop(t.Context(), id) })
	return env
}

// writePluginFixture 造 <root>/<id>/<version>/bin/<id> 与 info.json、fake.conf。
func writePluginFixture(t *testing.T, root, id string, conf map[string]string) string {
	t.Helper()
	pluginDir := registry.PluginDir(root, id, pluginVersion)
	binDir := filepath.Join(pluginDir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("创建插件目录失败: %v", err)
	}
	if err := os.Symlink(fakePluginPath, filepath.Join(binDir, id)); err != nil {
		t.Fatalf("链接假插件失败: %v", err)
	}
	writeManifest(t, pluginDir, id)
	writeFakeConfig(t, filepath.Join(root, id), conf)
	return pluginDir
}

// enableCatalog 加载清单、登记并 enable，返回登记表。
func enableCatalog(t *testing.T, pluginDir, id string) *registry.Catalog {
	t.Helper()
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
	return catalog
}

// writeManifest 写一份 12 字段齐全的 resident info.json。
func writeManifest(t *testing.T, pluginDir, id string) {
	t.Helper()
	manifest := map[string]any{
		"id":            id,
		"name":          "测试插件",
		"version":       pluginVersion,
		"protocol":      pluginapi.Protocol,
		"lifecycle":     "resident",
		"entry":         "bin/" + id,
		"capabilities":  []string{"system:read"},
		"resources":     map[string]any{"memory_mb": 8, "cpu_quota": "50%", "pids_max": 64},
		"requires_kore": ">=0.1.0 <0.2.0",
		"triggers":      []string{},
		"depends_on":    []string{},
		"scenario_tags": []string{"web"},
		"size_bytes":    1024,
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("序列化清单失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "info.json"), data, 0o644); err != nil {
		t.Fatalf("写 info.json 失败: %v", err)
	}
}

// writeFakeConfig 把 key=value 写进假插件的 fake.conf（不存在则跳过）。
func writeFakeConfig(t *testing.T, stateDir string, conf map[string]string) {
	t.Helper()
	if len(conf) == 0 {
		return
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("创建状态目录失败: %v", err)
	}
	text := ""
	for key, value := range conf {
		text += key + "=" + value + "\n"
	}
	if err := os.WriteFile(filepath.Join(stateDir, "fake.conf"), []byte(text), 0o600); err != nil {
		t.Fatalf("写 fake.conf 失败: %v", err)
	}
}

// codeOf 取协议错误码；非协议错误直接失败。
func codeOf(t *testing.T, err error) string {
	t.Helper()
	var protocolErr *pluginapi.Error
	if !errors.As(err, &protocolErr) {
		t.Fatalf("错误不是 *pluginapi.Error: %v", err)
	}
	return protocolErr.Code
}
