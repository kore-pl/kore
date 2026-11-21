package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/kore-project/kore/internal/core/store"
)

// TestLoadConfigMapsBadYAMLToExit2 验证坏 YAML 映射退出码 2。
func TestLoadConfigMapsBadYAMLToExit2(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("auth: [\n"), 0o600); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}
	t.Setenv("KORE_CONFIG", "")
	t.Setenv("KORE_STATE_DIR", "")
	_, code := loadConfig(serveOptions{config: path}, io.Discard)
	if code != exitConfig {
		t.Fatalf("坏 YAML 应映射 exit 2，实际 %d", code)
	}
}

// TestRunServeConfigErrorExit2 验证 serve 分派层返回 exit 2。
func TestRunServeConfigErrorExit2(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  addr: \"0.0.0.0:8787\"\n"), 0o600); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}
	t.Setenv("KORE_CONFIG", "")
	t.Setenv("KORE_STATE_DIR", "")
	if code := run([]string{"serve", "--config", path}, io.Discard, io.Discard); code != exitConfig {
		t.Fatalf("serve 配置错误应返回 2，实际 %d", code)
	}
}

// TestOpenStoreLockMapsToExit3 验证锁冲突映射退出码 3。
func TestOpenStoreLockMapsToExit3(t *testing.T) {
	dir := t.TempDir()
	first, err := store.Open(dir, nil)
	if err != nil {
		t.Fatalf("首次打开失败: %v", err)
	}
	defer first.Close()
	st, code := openStore(config{StateDir: dir}, io.Discard)
	if code != exitState {
		t.Fatalf("锁冲突应映射 exit 3，实际 %d", code)
	}
	if st != nil {
		t.Fatal("失败时不应返回句柄")
	}
}

// TestOpenStoreCorruptMapsToExit4 验证损坏映射退出码 4。
func TestOpenStoreCorruptMapsToExit4(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, store.DBName), make([]byte, 8192), 0o600); err != nil {
		t.Fatalf("写损坏文件失败: %v", err)
	}
	_, code := openStore(config{StateDir: dir}, io.Discard)
	if code != exitStore {
		t.Fatalf("损坏应映射 exit 4，实际 %d", code)
	}
}

// TestOpenStoreSchemaTooNewMapsToExit4 验证 schema 过新映射退出码 4。
func TestOpenStoreSchemaTooNewMapsToExit4(t *testing.T) {
	dir := t.TempDir()
	first, err := store.Open(dir, nil)
	if err != nil {
		t.Fatalf("首次打开失败: %v", err)
	}
	if err := first.Update(func(tx *store.Tx) error {
		return tx.Put("meta", "schema_version", []byte(`{"schema_version":2}`))
	}); err != nil {
		t.Fatalf("写 schema 失败: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("关闭失败: %v", err)
	}
	_, code := openStore(config{StateDir: dir}, io.Discard)
	if code != exitStore {
		t.Fatalf("schema 过新应映射 exit 4，实际 %d", code)
	}
}

// TestOpenStoreUnwritableDirMapsToExit3 验证状态目录不可写映射退出码 3。
func TestOpenStoreUnwritableDirMapsToExit3(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root 不受目录权限限制")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("改权限失败: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	_, code := openStore(config{StateDir: dir}, io.Discard)
	if code != exitState {
		t.Fatalf("不可写目录应映射 exit 3，实际 %d", code)
	}
}
