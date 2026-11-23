package store

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// putAuditAt 直接写入一条指定时刻的审计记录（绕过 PutAudit 的 time.Now，
// 用于构造过期/未过期数据）；返回键。
func putAuditAt(t *testing.T, s *Store, at time.Time, seq int, action string) string {
	t.Helper()
	key := fmt.Sprintf("%020d-%06d", at.UnixNano(), seq)
	value, err := json.Marshal(AuditRecord{Subject: "admin", Action: action, Result: AuditResultOK})
	if err != nil {
		t.Fatalf("序列化审计记录失败: %v", err)
	}
	if err := s.Update(func(tx *Tx) error { return tx.Put(bucketAudit, key, value) }); err != nil {
		t.Fatalf("写入审计记录失败: %v", err)
	}
	return key
}

// auditKeysOf 返回当前审计桶的全部键（升序），用于断言"只删了过期的"。
func auditKeysOf(t *testing.T, s *Store) []string {
	t.Helper()
	var keys []string
	if err := s.View(func(tx *Tx) error {
		return tx.ForEach(bucketAudit, func(k, _ []byte) error {
			keys = append(keys, string(k))
			return nil
		})
	}); err != nil {
		t.Fatalf("读取审计键失败: %v", err)
	}
	return keys
}

// TestCleanAuditDeletesOnlyExpired 验收：造 N 条过期 + M 条未过期，只删过期的。
func TestCleanAuditDeletesOnlyExpired(t *testing.T) {
	s := openAuditStore(t)
	now := time.Now()
	var expired []string
	for i := 0; i < 3; i++ {
		expired = append(expired, putAuditAt(t, s, now.Add(-91*24*time.Hour), i, "login.success"))
	}
	var fresh []string
	for i := 0; i < 2; i++ {
		fresh = append(fresh, putAuditAt(t, s, now.Add(-24*time.Hour), i, "invoke.echo.ping"))
	}
	cutoff := now.Add(-90 * 24 * time.Hour)
	report, err := s.CleanAudit(cutoff, 100)
	if err != nil {
		t.Fatalf("按龄清理失败: %v", err)
	}
	if report.Deleted != len(expired) || report.More {
		t.Fatalf("应删除 %d 条且无剩余，实际 deleted=%d more=%v", len(expired), report.Deleted, report.More)
	}
	if !report.Cutoff.Equal(cutoff) {
		t.Fatalf("报告的截止时刻应为 %v，实际 %v", cutoff, report.Cutoff)
	}
	keys := auditKeysOf(t, s)
	if len(keys) != len(fresh) {
		t.Fatalf("应只剩 %d 条未过期记录，实际 %d 条: %v", len(fresh), len(keys), keys)
	}
	for i, key := range keys {
		if key != fresh[i] {
			t.Fatalf("保留的应全部是未过期键，第 %d 条为 %q（期望 %q）", i, key, fresh[i])
		}
	}
	if recs, err := s.ListAudit(AuditFilter{}); err != nil || len(recs) != len(fresh) {
		t.Fatalf("清理后读取应仍可用且只剩 %d 条，实际 %d 条（err=%v）", len(fresh), len(recs), err)
	}
}

// TestCleanAuditBatchLimitAndIdempotent 验收：单次上限生效、重复执行幂等。
func TestCleanAuditBatchLimitAndIdempotent(t *testing.T) {
	s := openAuditStore(t)
	now := time.Now()
	for i := 0; i < 5; i++ {
		putAuditAt(t, s, now.Add(-100*24*time.Hour), i, "login.failed")
	}
	cutoff := now.Add(-90 * 24 * time.Hour)
	steps := []struct {
		deleted int
		more    bool
	}{{2, true}, {2, true}, {1, false}, {0, false}}
	for i, want := range steps {
		report, err := s.CleanAudit(cutoff, 2)
		if err != nil {
			t.Fatalf("第 %d 次清理失败: %v", i+1, err)
		}
		if report.Deleted != want.deleted || report.More != want.more {
			t.Fatalf("第 %d 次清理应为 deleted=%d more=%v，实际 deleted=%d more=%v",
				i+1, want.deleted, want.more, report.Deleted, report.More)
		}
	}
	if keys := auditKeysOf(t, s); len(keys) != 0 {
		t.Fatalf("重复清理后过期记录应全部消失，实际仍剩 %d 条: %v", len(keys), keys)
	}
}

// TestCleanAuditKeepsUnparsableKeys 坏键不猜年龄：不删、也不阻断读取。
func TestCleanAuditKeepsUnparsableKeys(t *testing.T) {
	s := openAuditStore(t)
	now := time.Now()
	putAuditAt(t, s, now.Add(-100*24*time.Hour), 0, "login.failed")
	broken := "not-a-timestamp-key"
	value, _ := json.Marshal(AuditRecord{Subject: "admin", Action: "broken", Result: AuditResultOK})
	if err := s.Update(func(tx *Tx) error { return tx.Put(bucketAudit, broken, value) }); err != nil {
		t.Fatalf("写入坏键失败: %v", err)
	}
	report, err := s.CleanAudit(now.Add(-90*24*time.Hour), 10)
	if err != nil {
		t.Fatalf("按龄清理失败: %v", err)
	}
	if report.Deleted != 1 {
		t.Fatalf("应只删 1 条过期记录，实际 %d", report.Deleted)
	}
	keys := auditKeysOf(t, s)
	if len(keys) != 1 || keys[0] != broken {
		t.Fatalf("无法判定年龄的键必须保留，实际键: %v", keys)
	}
}

// TestCleanAuditRejectsNonPositiveLimit 上限缺失是调用方错误，不静默当成无限。
func TestCleanAuditRejectsNonPositiveLimit(t *testing.T) {
	s := openAuditStore(t)
	putAuditAt(t, s, time.Now().Add(-100*24*time.Hour), 0, "login.failed")
	if _, err := s.CleanAudit(time.Now().Add(-90*24*time.Hour), 0); err == nil {
		t.Fatal("limit=0 应返回错误")
	}
	if keys := auditKeysOf(t, s); len(keys) != 1 {
		t.Fatalf("参数非法时不得删除任何记录，实际剩 %d 条", len(keys))
	}
}
