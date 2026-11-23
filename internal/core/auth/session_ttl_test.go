package auth

import (
	"io"
	"log/slog"
	"net/http/httptest"
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

// TestSlideThresholdForTTL 锁定阈值公式 min(24h, ttl/2) 的关键取值。
// 固定 24h 只在 TTL >= 48h 时成立；短 TTL 必须随 TTL 收缩，否则
// "剩余寿命 < 24h" 恒真 → 每次鉴权都写盘。
func TestSlideThresholdForTTL(t *testing.T) {
	cases := []struct {
		ttl  time.Duration
		want time.Duration
	}{
		{DefaultTTL, 24 * time.Hour},      // 7d → 24h（与旧行为一致）
		{12 * time.Hour, 6 * time.Hour},   // 主实例配置 → 6h
		{time.Hour, 30 * time.Minute},     // 1h → 30m
		{48 * time.Hour, 24 * time.Hour},  // 边界：恰好封顶
		{720 * time.Hour, 24 * time.Hour}, // 30d → 24h
	}
	for _, c := range cases {
		if got := slideThresholdFor(c.ttl); got != c.want {
			t.Fatalf("slideThresholdFor(%s) = %s，期望 %s", c.ttl, got, c.want)
		}
	}
}

// TestShortTTLNoSlideWriteAmplification 回归"短 TTL 实例每次鉴权都写 bbolt"：
// ttl=12h 时阈值是 6h，连续鉴权不得产生任何写盘；剩余跌破 6h 后只续期写一次；
// 到期仍然失效；cookie 仍按 TTL 下发（Max-Age=12h）。
func TestShortTTLNoSlideWriteAmplification(t *testing.T) {
	const ttl = 12 * time.Hour
	db := openStore(t)
	m := NewManager(db, "hash", ttl, true)

	token, sess, err := m.Issue()
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	if got := sess.ExpiresAt.Sub(sess.CreatedAt); got != ttl {
		t.Fatalf("会话寿命应为 %s，实际 %s", ttl, got)
	}
	// cookie 语义不变：Max-Age / Expires 仍按配置的 TTL。
	rec := httptest.NewRecorder()
	m.SetCookie(rec, token)
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("应下发 1 个 cookie，实际 %d", len(cookies))
	}
	if cookies[0].MaxAge != int(ttl.Seconds()) {
		t.Fatalf("cookie Max-Age 应为 %d，实际 %d", int(ttl.Seconds()), cookies[0].MaxAge)
	}
	if !cookies[0].HttpOnly || !cookies[0].Secure {
		t.Fatalf("cookie 应 HttpOnly + Secure: %+v", cookies[0])
	}

	// 连续 20 次"鉴权 + 滑动"：剩余 ~12h 始终 >= 6h 阈值 → 一次都不写库。
	base := m.slideWriteCount()
	for i := 0; i < 20; i++ {
		got, err := m.Validate(token)
		if err != nil {
			t.Fatalf("第 %d 次鉴权失败: %v", i, err)
		}
		if _, renewed, err := m.Slide(got); err != nil || renewed {
			t.Fatalf("第 %d 次鉴权不应续期（剩余 %s >= 阈值 %s）: renewed=%v err=%v",
				i, got.ExpiresAt.Sub(time.Now().UTC()), slideThresholdFor(ttl), renewed, err)
		}
	}
	if wrote := m.slideWriteCount() - base; wrote != 0 {
		t.Fatalf("连续鉴权产生了 %d 次写盘，写放大未消除", wrote)
	}

	// 剩余 5h < 6h：必须续期且只写一次；紧接着的第二次鉴权不再写。
	if err := m.writeExpiry(tokenHash(token), time.Now().UTC().Add(5*time.Hour), sess.CreatedAt); err != nil {
		t.Fatalf("改写会话失败: %v", err)
	}
	aged, err := m.Validate(token)
	if err != nil {
		t.Fatalf("剩余 5h 的会话应仍有效: %v", err)
	}
	next, renewed, err := m.Slide(aged)
	if err != nil || !renewed {
		t.Fatalf("剩余 <6h 应续期: renewed=%v err=%v", renewed, err)
	}
	if !next.CreatedAt.Equal(sess.CreatedAt) {
		t.Fatalf("续期不得改 CreatedAt: %s != %s", next.CreatedAt, sess.CreatedAt)
	}
	if remain := next.ExpiresAt.Sub(time.Now().UTC()); remain < ttl-time.Minute {
		t.Fatalf("续期后剩余寿命应约 %s，实际 %s", ttl, remain)
	}
	if wrote := m.slideWriteCount() - base; wrote != 1 {
		t.Fatalf("跌破阈值后应恰好写 1 次，实际 %d", wrote)
	}
	refreshed, err := m.Validate(token)
	if err != nil {
		t.Fatalf("续期后会话应有效: %v", err)
	}
	if _, renewed, err := m.Slide(refreshed); err != nil || renewed {
		t.Fatalf("刚续期完不应再次写库: renewed=%v err=%v", renewed, err)
	}
	if wrote := m.slideWriteCount() - base; wrote != 1 {
		t.Fatalf("续期后连续鉴权又写了库，累计写盘 %d 次", wrote)
	}

	// 到期必须失效：阈值改变不影响过期判定。
	if err := m.writeExpiry(tokenHash(token), time.Now().UTC().Add(-time.Second), sess.CreatedAt); err != nil {
		t.Fatalf("改写会话失败: %v", err)
	}
	if _, err := m.Validate(token); err != ErrNoSession {
		t.Fatalf("到期会话应失效，实际 err=%v", err)
	}
}
