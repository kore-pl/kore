package installer_test

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kore-project/kore/pkg/pluginapi"
)

// tarEntry 描述动态夹具中的一个 tar 条目。
type tarEntry struct {
	name     string
	body     []byte
	mode     int64
	typeflag byte
	linkname string
}

// fileEntry 构造一个普通文件条目。
func fileEntry(name, body string) tarEntry {
	return tarEntry{name: name, body: []byte(body), mode: 0o644, typeflag: tar.TypeReg}
}

// execEntry 构造一个带执行位的普通文件条目。
func execEntry(name, body string) tarEntry {
	return tarEntry{name: name, body: []byte(body), mode: 0o755, typeflag: tar.TypeReg}
}

// symlinkEntry 构造一个符号链接条目（用于验证被拒绝）。
func symlinkEntry(name, target string) tarEntry {
	return tarEntry{name: name, typeflag: tar.TypeSymlink, linkname: target}
}

// writePackage 在 dir 下生成 name 指定的 tar.gz 并返回完整路径。
func writePackage(t *testing.T, dir, name string, entries []tarEntry) string {
	t.Helper()
	pkgPath := filepath.Join(dir, name)
	file, err := os.Create(pkgPath)
	if err != nil {
		t.Fatalf("建立包文件失败: %v", err)
	}
	gz := gzip.NewWriter(file)
	writer := tar.NewWriter(gz)
	for _, entry := range entries {
		header := &tar.Header{
			Name: entry.name, Mode: entry.mode, Typeflag: entry.typeflag,
			Linkname: entry.linkname, ModTime: time.Now(),
		}
		if entry.typeflag == tar.TypeReg {
			header.Size = int64(len(entry.body))
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatalf("写 tar 头失败: %v", err)
		}
		if header.Size > 0 {
			if _, err := writer.Write(entry.body); err != nil {
				t.Fatalf("写 tar 体失败: %v", err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 tar 失败: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("关闭 gzip 失败: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("关闭包文件失败: %v", err)
	}
	return pkgPath
}

// baseManifest 返回 12 个必填字段齐全的 info.json 对象。
func baseManifest() map[string]any {
	return map[string]any{
		"id":           "site",
		"name":         "测试插件",
		"version":      "0.1.0",
		"protocol":     pluginapi.Protocol,
		"lifecycle":    "resident",
		"entry":        "bin/site",
		"capabilities": []string{"site:read"},
		"triggers":     []string{"event:cert.renew_due"},
		"resources": map[string]any{
			"memory_mb": 8, "cpu_quota": "50%", "pids_max": 128,
		},
		"requires_kore": ">=0.1.0 <0.2.0",
	}
}

// manifestJSON 生成 info.json 字节；overrides 中值为 nil 表示删除该字段。
func manifestJSON(t *testing.T, overrides map[string]any) []byte {
	t.Helper()
	manifest := baseManifest()
	for key, value := range overrides {
		if value == nil {
			delete(manifest, key)
			continue
		}
		manifest[key] = value
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatalf("序列化清单失败: %v", err)
	}
	return data
}

// validEntries 返回一份可正常安装的包内容（info.json + 可执行 + 前端资产）。
func validEntries(t *testing.T, overrides map[string]any) []tarEntry {
	t.Helper()
	return []tarEntry{
		fileEntry("info.json", string(manifestJSON(t, overrides))),
		execEntry("bin/site", "#!/bin/sh\nexit 0\n"),
		fileEntry("web/index.js", "console.log(1)\n"),
	}
}
