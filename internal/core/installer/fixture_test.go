package installer_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
)

// discardLogger 返回丢弃输出的 logger，避免测试刷屏。
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fixture 是隔离的测试环境：临时状态目录 + 已打开状态库 + 安装器。
type fixture struct {
	inst     *installer.Installer
	store    *store.Store
	stateDir string
}

// newFixture 在 t.TempDir() 下建状态库并构造安装器（不碰真实 /var/lib）。
func newFixture(t *testing.T, limits installer.Limits) *fixture {
	t.Helper()
	return newFixtureWith(t, limits, nil)
}

// newFixtureWith 同 newFixture，但可注入下载客户端（download 测试要信任 httptest 的 TLS 证书）。
func newFixtureWith(t *testing.T, limits installer.Limits, client *http.Client) *fixture {
	t.Helper()
	stateDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Open(stateDir, logger)
	if err != nil {
		t.Fatalf("打开测试状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	inst, err := installer.New(installer.Options{
		StateDir: stateDir, KoreVersion: "0.1.0", Limits: limits, Logger: logger, Store: st,
		HTTPClient: client,
	})
	if err != nil {
		t.Fatalf("构造安装器失败: %v", err)
	}
	return &fixture{inst: inst, store: st, stateDir: stateDir}
}

// pluginRoot 返回测试状态目录下的插件根。
func (f *fixture) pluginRoot() string {
	return filepath.Join(f.stateDir, "plugins")
}

// assertNoResidue 断言目标版本目录不存在、.staging 为空。
func (f *fixture) assertNoResidue(t *testing.T, id, version string) {
	t.Helper()
	final := filepath.Join(f.pluginRoot(), id, version)
	if _, err := os.Lstat(final); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("失败安装不应留下目标目录，Lstat=%v", err)
	}
	assertEmptyDir(t, filepath.Join(f.pluginRoot(), ".staging"))
}

// pluginRecord 读取并解码 plugins bucket 中的记录。
func (f *fixture) pluginRecord(t *testing.T, id string) map[string]any {
	t.Helper()
	return decodeObject(t, f.getKey(t, "plugins", id))
}

// pluginState 读取并解码 plugin_state bucket 中的记录。
func (f *fixture) pluginState(t *testing.T, id string) map[string]any {
	t.Helper()
	return decodeObject(t, f.getKey(t, "plugin_state", id))
}

// getKey 读取一个键的原始值。
func (f *fixture) getKey(t *testing.T, bucket, key string) []byte {
	t.Helper()
	var raw []byte
	err := f.store.View(func(tx *store.Tx) error {
		value, err := tx.Get(bucket, key)
		if err != nil {
			return err
		}
		raw = value
		return nil
	})
	if err != nil {
		t.Fatalf("读取 %s/%s 失败: %v", bucket, key, err)
	}
	return raw
}

// requireNoKey 断言键不存在。
func (f *fixture) requireNoKey(t *testing.T, bucket, key string) {
	t.Helper()
	err := f.store.View(func(tx *store.Tx) error {
		_, getErr := tx.Get(bucket, key)
		return getErr
	})
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("%s/%s 不应存在，实际错误: %v", bucket, key, err)
	}
}

// assertEmptyDir 断言目录为空；目录不存在也视为空。
func assertEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatalf("读取目录 %s 失败: %v", dir, err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("目录 %s 应为空，实际: %v", dir, names)
	}
}

// decodeObject 把 JSON 对象解码为 map。
func decodeObject(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("解码 JSON 失败: %v", err)
	}
	return out
}

// fileHash 计算文件 sha256（小写 hex）。
func fileHash(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取文件失败: %v", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
