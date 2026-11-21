package store

import (
	"errors"
	"testing"
)

// TestPutRejectsOversizedValue 验证单值超过 1 MiB 被拒绝。
func TestPutRejectsOversizedValue(t *testing.T) {
	s, err := Open(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer s.Close()
	err = s.Update(func(tx *Tx) error {
		return tx.Put(bucketPlugins, "big", make([]byte, MaxValueSize+1))
	})
	if !errors.Is(err, ErrValueTooLarge) {
		t.Fatalf("期望 ErrValueTooLarge，实际: %v", err)
	}
}

// TestCloseIdempotent 验证 Close 可重复调用。
func TestCloseIdempotent(t *testing.T) {
	s, err := Open(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("首次关闭失败: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("二次关闭应幂等，实际: %v", err)
	}
}

// TestPutGetDelete 验证基本读写删与 ErrNotFound 语义。
func TestPutGetDelete(t *testing.T) {
	s, err := Open(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer s.Close()
	if err := s.Update(func(tx *Tx) error {
		return tx.Put(bucketSessions, "k", []byte("v"))
	}); err != nil {
		t.Fatalf("写失败: %v", err)
	}
	err = s.View(func(tx *Tx) error {
		value, err := tx.Get(bucketSessions, "k")
		if err != nil {
			return err
		}
		if string(value) != "v" {
			t.Fatalf("读回值不匹配: %q", value)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("读失败: %v", err)
	}
	if err := s.Update(func(tx *Tx) error {
		return tx.Delete(bucketSessions, "k")
	}); err != nil {
		t.Fatalf("删失败: %v", err)
	}
	err = s.View(func(tx *Tx) error {
		_, err := tx.Get(bucketSessions, "k")
		return err
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("期望 ErrNotFound，实际: %v", err)
	}
}
