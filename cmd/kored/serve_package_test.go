package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// buildPackage 把 testdata/echoplugin 打成一个可被 installer 接受的最小插件包。
// spec.Web 为真时额外声明 web 段并落 web/ 资产（供桥字段端到端断言）。
func buildPackage(t *testing.T, spec pluginSpec) string {
	t.Helper()
	stage := t.TempDir()
	binDir := filepath.Join(stage, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("创建 bin 目录失败: %v", err)
	}
	build := exec.Command("go", "build", "-o", filepath.Join(binDir, spec.ID), "./cmd/kored/testdata/echoplugin")
	build.Dir = repoRoot(t)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("构建测试插件失败: %v\n%s", err, output)
	}
	info := map[string]any{
		"id": spec.ID, "name": "测试插件 " + spec.ID, "version": testVersion,
		"protocol": "kore.plugin.v1", "lifecycle": spec.Lifecycle, "depth_level": "basic",
		"entry": "bin/" + spec.ID, "capabilities": []string{"system:read"},
		"resources":     map[string]any{"memory_mb": 6, "cpu_quota": "20%", "pids_max": 32},
		"requires_kore": testRequiresKore, "triggers": []string{},
		"depends_on": []string{}, "conflicts": []string{},
		"scenario_tags": []string{"ops"}, "size_bytes": 0,
	}
	if spec.Web {
		info["web"] = map[string]any{
			"entry": "web/index.js", "styles": []string{"web/index.css"},
		}
		webDir := filepath.Join(stage, "web")
		if err := os.MkdirAll(webDir, 0o755); err != nil {
			t.Fatalf("创建 web 目录失败: %v", err)
		}
		if err := os.WriteFile(filepath.Join(webDir, "index.js"), []byte("export {};\n"), 0o644); err != nil {
			t.Fatalf("写 web/index.js 失败: %v", err)
		}
		if err := os.WriteFile(filepath.Join(webDir, "index.css"), []byte("/* test */\n"), 0o644); err != nil {
			t.Fatalf("写 web/index.css 失败: %v", err)
		}
	}
	data, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("序列化 info.json 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stage, "info.json"), data, 0o644); err != nil {
		t.Fatalf("写 info.json 失败: %v", err)
	}
	pkg := filepath.Join(t.TempDir(), spec.ID+"-"+testVersion+".tar.gz")
	writePackage(t, pkg, stage)
	return pkg
}

// writePackage 把目录打成 tar.gz（普通文件，模式沿用源文件）。
func writePackage(t *testing.T, dst, srcDir string) {
	t.Helper()
	file, err := os.Create(dst)
	if err != nil {
		t.Fatalf("创建包失败: %v", err)
	}
	defer func() { _ = file.Close() }()
	gz := gzip.NewWriter(file)
	tw := tar.NewWriter(gz)
	walkErr := filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		header := &tar.Header{
			Name: filepath.ToSlash(rel), Mode: int64(info.Mode().Perm()),
			Size: info.Size(), Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	})
	closeErr := tw.Close()
	gzErr := gz.Close()
	if walkErr != nil || closeErr != nil || gzErr != nil {
		t.Fatalf("打包失败: walk=%v tar=%v gzip=%v", walkErr, closeErr, gzErr)
	}
}

// repoRoot 由本测试文件位置回推仓库根（cmd/kored → cmd → root）。
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件路径")
	}
	dir := filepath.Dir(file)
	for i := 0; i < 2; i++ {
		dir = filepath.Dir(dir)
	}
	return dir
}
