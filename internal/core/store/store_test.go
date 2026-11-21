package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// testLogger 返回丢弃输出的 logger。
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestOpenCreatesSixBuckets 验证首次打开建齐 6 个 bucket 与 schema v1。
func TestOpenCreatesSixBuckets(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	s, err := Open(dir, testLogger())
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer s.Close()

	names := BucketNames()
	if len(names) != 6 {
		t.Fatalf("bucket 数量应为 6，实际 %d: %v", len(names), names)
	}
	err = s.View(func(tx *Tx) error {
		for _, name := range names {
			if _, err := tx.bucket(name); err != nil {
				t.Errorf("bucket %s 不存在: %v", name, err)
			}
		}
		raw, err := tx.Get(bucketMeta, schemaKey)
		if err != nil {
			return err
		}
		var doc struct {
			SchemaVersion int `json:"schema_version"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return err
		}
		if doc.SchemaVersion != SchemaVersion {
			t.Errorf("schema_version=%d，期望 %d", doc.SchemaVersion, SchemaVersion)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("读 schema 失败: %v", err)
	}
}

// TestOpenSetsPermissions 验证状态库文件 0600、新建状态目录 0700。
func TestOpenSetsPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	s, err := Open(dir, testLogger())
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer s.Close()

	dbInfo, err := os.Stat(filepath.Join(dir, DBName))
	if err != nil {
		t.Fatalf("stat 状态库失败: %v", err)
	}
	if dbInfo.Mode().Perm() != 0o600 {
		t.Fatalf("状态库权限应为 0600，实际 %o", dbInfo.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat 目录失败: %v", err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("状态目录权限应为 0700，实际 %o", dirInfo.Mode().Perm())
	}
}

// TestSchemaTooNewRejected 验证 schema 高于内核时返回 ErrSchemaTooNew。
func TestSchemaTooNewRejected(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, testLogger())
	if err != nil {
		t.Fatalf("首次打开失败: %v", err)
	}
	if err := s.Update(func(tx *Tx) error {
		return tx.Put(bucketMeta, schemaKey, []byte(`{"schema_version":2}`))
	}); err != nil {
		t.Fatalf("写 schema 失败: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("关闭失败: %v", err)
	}
	_, err = Open(dir, testLogger())
	if !errors.Is(err, ErrSchemaTooNew) {
		t.Fatalf("期望 ErrSchemaTooNew，实际: %v", err)
	}
}

// TestSecondOpenReportsLockedWithPID 验证二次打开报锁冲突并回显 pid。
func TestSecondOpenReportsLockedWithPID(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir, testLogger())
	if err != nil {
		t.Fatalf("首次打开失败: %v", err)
	}
	defer first.Close()

	_, err = Open(dir, testLogger())
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("期望 ErrLocked，实际: %v", err)
	}
	var locked *LockedError
	if !errors.As(err, &locked) {
		t.Fatalf("期望 *LockedError，实际: %T", err)
	}
	if locked.PID != os.Getpid() {
		t.Fatalf("持有者 pid 应为 %d，实际 %d", os.Getpid(), locked.PID)
	}
}

// TestCorruptFileRejected 验证垃圾文件返回 ErrCorrupt。
func TestCorruptFileRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, DBName)
	if err := os.WriteFile(path, bytes.Repeat([]byte{0x7f}, 8192), 0o600); err != nil {
		t.Fatalf("写损坏文件失败: %v", err)
	}
	_, err := Open(dir, testLogger())
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("期望 ErrCorrupt，实际: %v", err)
	}
}
