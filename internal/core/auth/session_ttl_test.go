package auth

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// openStore 打开临时状态库（package auth 内部测试用）。
func openStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// TestSessionTTLSevenDaysAndSlide 覆盖 ADR-0041：默认 7 天、剩余 <24h 滑动、
// 绝对上限 30 天不可越过。
func TestSessionTTLSevenDaysAndSlide(t *testing.T) {
	if DefaultTTL != 7*24*time.Hour {
		t.Fatalf("DefaultTTL 应为 7 天，实际 %s", DefaultTTL)
	}
	db := openStore(t)
	m := NewManager(db, "hash", 0, false)
	if m.TTL() != DefaultTTL {
		t.Fatalf("未配置时应取 DefaultTTL，实际 %s", m.TTL())
	}
	token, sess, err := m.Issue()
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	if got := sess.ExpiresAt.Sub(sess.CreatedAt); got != DefaultTTL {
		t.Fatalf("会话寿命应为 7 天，实际 %s", got)
	}
	// 剩余 7 天 > 24h 阈值：不续期、不写库。
	if _, renewed, err := m.Slide(sess); err != nil || renewed {
		t.Fatalf("新会话不应续期: renewed=%v err=%v", renewed, err)
	}

	// 模拟"已用 29 天、剩余 30 分钟"：应滑动，但不得越过 created+30d。
	now := time.Now().UTC()
	created := now.Add(-29 * 24 * time.Hour)
	if err := m.writeExpiry(tokenHash(token), now.Add(30*time.Minute), created); err != nil {
		t.Fatalf("改写会话失败: %v", err)
	}
	got, err := m.Validate(token)
	if err != nil {
		t.Fatalf("会话应仍有效: %v", err)
	}
	next, renewed, err := m.Slide(got)
	if err != nil || !renewed {
		t.Fatalf("剩余 <24h 应续期: renewed=%v err=%v", renewed, err)
	}
	if !next.CreatedAt.Equal(created) {
		t.Fatalf("续期不得改 CreatedAt: %s != %s", next.CreatedAt, created)
	}
	if next.ExpiresAt.After(created.Add(AbsoluteTTL)) {
		t.Fatalf("续期越过绝对上限: %s > %s", next.ExpiresAt, created.Add(AbsoluteTTL))
	}

	// 越过绝对上限（签发已 31 天）：即使 expiry 还在未来也必须失效。
	if err := m.writeExpiry(tokenHash(token), now.Add(time.Hour), now.Add(-31*24*time.Hour)); err != nil {
		t.Fatalf("改写会话失败: %v", err)
	}
	if _, err := m.Validate(token); err != ErrNoSession {
		t.Fatalf("越过绝对上限应失效，实际 err=%v", err)
	}
}

// TestRevokeAllAndPasswordRotation 覆盖 ADR-0041：改口令 → 全局吊销。
func TestRevokeAllAndPasswordRotation(t *testing.T) {
	db := openStore(t)
	m := NewManager(db, "hash-a", 0, false)
	token, _, err := m.Issue()
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	// 首次启动：无历史指纹 → 不吊销，只落指纹。
	if revoked, err := m.ReconcilePasswordFingerprint(); err != nil || revoked {
		t.Fatalf("首次启动不应吊销: revoked=%v err=%v", revoked, err)
	}
	// 口令未变：会话继续有效，不吊销。
	same := NewManager(db, "hash-a", 0, false)
	if revoked, err := same.ReconcilePasswordFingerprint(); err != nil || revoked {
		t.Fatalf("口令未变不应吊销: revoked=%v err=%v", revoked, err)
	}
	if _, err := same.Validate(token); err != nil {
		t.Fatalf("旧会话应仍有效: %v", err)
	}
	// 口令变更：全部旧会话立即失效。
	rotated := NewManager(db, "hash-b", 0, false)
	revoked, err := rotated.ReconcilePasswordFingerprint()
	if err != nil || !revoked {
		t.Fatalf("改口令应触发全局吊销: revoked=%v err=%v", revoked, err)
	}
	if _, err := rotated.Validate(token); err != ErrNoSession {
		t.Fatalf("改口令后旧会话应失效，实际 err=%v", err)
	}
}
