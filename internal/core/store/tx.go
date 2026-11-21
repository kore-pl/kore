package store

import (
	"fmt"
	"log/slog"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Tx 是 bbolt 事务的受限视图；事务内只做内存计算与读写字，禁止 IO / IPC。
type Tx struct {
	tx *bolt.Tx
}

// View 执行只读事务；回调内禁止写库。
func (s *Store) View(fn func(*Tx) error) error {
	start := time.Now()
	err := s.db.View(func(tx *bolt.Tx) error {
		return fn(&Tx{tx: tx})
	})
	warnLongTx("view", start)
	return err
}

// Update 执行写事务；超过 500ms 记 WARN（长事务是设计味道）。
func (s *Store) Update(fn func(*Tx) error) error {
	start := time.Now()
	err := s.db.Update(func(tx *bolt.Tx) error {
		return fn(&Tx{tx: tx})
	})
	warnLongTx("update", start)
	return err
}

// warnLongTx 对超阈值事务告警；耗时来自本函数计时，无副作用。
func warnLongTx(op string, start time.Time) {
	elapsed := time.Since(start)
	if elapsed > longTxWarn {
		slog.Warn("store 长事务", "op", op, "dur_ms", elapsed.Milliseconds())
	}
}

// Get 读取一个键并返回副本（bbolt 的切片只在事务内有效）。
func (t *Tx) Get(bucket, key string) ([]byte, error) {
	b, err := t.bucket(bucket)
	if err != nil {
		return nil, err
	}
	value := b.Get([]byte(key))
	if value == nil {
		return nil, fmt.Errorf("%w: %s/%s", ErrNotFound, bucket, key)
	}
	out := make([]byte, len(value))
	copy(out, value)
	return out, nil
}

// Put 写入一个键；单值超过 1 MiB 直接拒绝。
func (t *Tx) Put(bucket, key string, value []byte) error {
	if len(value) > MaxValueSize {
		return fmt.Errorf("%w: %s/%s 为 %d 字节", ErrValueTooLarge, bucket, key, len(value))
	}
	b, err := t.bucket(bucket)
	if err != nil {
		return err
	}
	return b.Put([]byte(key), value)
}

// Delete 删除一个键；键不存在不报错（幂等）。
func (t *Tx) Delete(bucket, key string) error {
	b, err := t.bucket(bucket)
	if err != nil {
		return err
	}
	return b.Delete([]byte(key))
}

// ForEach 按字典序遍历 bucket；回调内的 key/value 只在事务内有效。
func (t *Tx) ForEach(bucket string, fn func(key, value []byte) error) error {
	b, err := t.bucket(bucket)
	if err != nil {
		return err
	}
	return b.ForEach(fn)
}

// bucket 取一个已存在的 bucket；不存在即报错，不隐式创建。
func (t *Tx) bucket(name string) (*bolt.Bucket, error) {
	b := t.tx.Bucket([]byte(name))
	if b == nil {
		return nil, fmt.Errorf("%w: %s", ErrBucket, name)
	}
	return b, nil
}
