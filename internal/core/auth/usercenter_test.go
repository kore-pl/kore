package auth

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestIssueWithMetaRoundTrip 覆盖会话元信息落库与读回（账户与安全中心的会话列表依赖它）。
func TestIssueWithMetaRoundTrip(t *testing.T) {
	db := openStore(t)
	m := NewManager(db, "hash", 0, false)
	token, sess, err := m.IssueWithMeta(SessionMeta{IP: "203.0.113.9", UserAgent: "Mozilla/5.0 TestAgent"})
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	if sess.IP != "203.0.113.9" || sess.UserAgent != "Mozilla/5.0 TestAgent" {
		t.Fatalf("签发返回的元信息不对: %+v", sess)
	}
	if sess.LastSeenAt.IsZero() {
		t.Fatal("签发时应记录最后活跃时刻")
	}
	got, err := m.Validate(token)
	if err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	if got.IP != "203.0.113.9" || got.UserAgent != "Mozilla/5.0 TestAgent" {
		t.Fatalf("读回的元信息不对: %+v", got)
	}
	if len(got.ID()) != sessionIDLen {
		t.Fatalf("会话 id 应是 %d 位前缀，实际 %q", sessionIDLen, got.ID())
	}
}

// TestTouchThrottle 锁定"最后活跃"写库节流：同元信息 5 分钟内只写一次。
func TestTouchThrottle(t *testing.T) {
	db := openStore(t)
	m := NewManager(db, "hash", 0, false)
	_, sess, err := m.IssueWithMeta(SessionMeta{IP: "10.0.0.5", UserAgent: "UA-A"})
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	if _, wrote, err := m.Touch(sess, "10.0.0.5", "UA-A"); err != nil || wrote {
		t.Fatalf("5 分钟内同元信息不应写库: wrote=%v err=%v", wrote, err)
	}
	// UA 变化必须写（否则会话列表显示的还是旧设备）。
	updated, wrote, err := m.Touch(sess, "10.0.0.5", "UA-B")
	if err != nil || !wrote {
		t.Fatalf("UA 变化应写库: wrote=%v err=%v", wrote, err)
	}
	if updated.UserAgent != "UA-B" {
		t.Fatalf("UA 未更新: %q", updated.UserAgent)
	}
}

// TestListSessionsRevokeByIDAndOthers 覆盖会话列表、按 id 吊销、保留当前一键全踢。
func TestListSessionsRevokeByIDAndOthers(t *testing.T) {
	db := openStore(t)
	m := NewManager(db, "hash", 0, false)
	keepToken, _, err := m.IssueWithMeta(SessionMeta{IP: "10.0.0.1"})
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	var others []Session
	for i := 0; i < 2; i++ {
		_, sess, err := m.IssueWithMeta(SessionMeta{IP: "10.0.0.2"})
		if err != nil {
			t.Fatalf("签发失败: %v", err)
		}
		others = append(others, sess)
	}
	list, err := m.ListSessions()
	if err != nil {
		t.Fatalf("列会话失败: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("应有 3 个会话，实际 %d", len(list))
	}
	if list[0].CreatedAt.Before(list[1].CreatedAt) {
		t.Fatal("会话列表应按签发时间倒序")
	}
	ok, err := m.RevokeByID(others[0].ID())
	if err != nil || !ok {
		t.Fatalf("按 id 吊销失败: ok=%v err=%v", ok, err)
	}
	if list, _ = m.ListSessions(); len(list) != 2 {
		t.Fatalf("吊销一个后应剩 2 个，实际 %d", len(list))
	}
	// 非法 id：过短 / 非十六进制都要报错，不能误删。
	if _, err := m.RevokeByID("abc"); err == nil {
		t.Fatal("过短 id 应报错")
	}
	if _, err := m.RevokeByID("zzzzzzzz"); err == nil {
		t.Fatal("非十六进制 id 应报错")
	}
	count, err := m.RevokeOthers(keepToken)
	if err != nil {
		t.Fatalf("一键全踢失败: %v", err)
	}
	if count != 1 {
		t.Fatalf("应踢掉 1 个会话，实际 %d", count)
	}
	if list, _ = m.ListSessions(); len(list) != 1 {
		t.Fatalf("应只剩当前会话，实际 %d", len(list))
	}
	if _, err := m.Validate(keepToken); err != nil {
		t.Fatalf("当前会话必须仍然有效: %v", err)
	}
}

// TestSessionValueBackwardCompatible 锁定旧格式可读：升级不能把已登录用户踢下线。
func TestSessionValueBackwardCompatible(t *testing.T) {
	expiry := time.Now().UTC().Add(30 * time.Minute)
	created := expiry.Add(-30 * time.Minute)
	// 旧格式 1：只有 expiry。
	if rec, ok := parseSessionRecord(nanoText(expiry), time.Hour); !ok || !rec.Expiry.Equal(expiry) {
		t.Fatalf("旧格式（单字段）应可解析: ok=%v rec=%+v", ok, rec)
	}
	// 旧格式 2：expiry + created。
	if rec, ok := parseSessionRecord(nanoText(expiry)+" "+nanoText(created), time.Hour); !ok || !rec.Created.Equal(created) {
		t.Fatalf("旧格式（两字段）应可解析: ok=%v rec=%+v", ok, rec)
	}
	// 当前格式：五字段，IP/UA 走 base64url。
	rec := sessionRecord{Expiry: expiry, Created: created, LastSeen: created, IP: "192.0.2.10", UserAgent: "UA-X"}
	parsed, ok := parseSessionRecord(string(encodeSessionRecord(rec)), time.Hour)
	if !ok || parsed.IP != "192.0.2.10" || parsed.UserAgent != "UA-X" {
		t.Fatalf("当前格式应可解析: ok=%v rec=%+v", ok, parsed)
	}
}

// TestPasswordStrengthScoring 锁定强度评分口径（前端提示与后端落库共用）。
func TestPasswordStrengthScoring(t *testing.T) {
	cases := []struct {
		pw   string
		want int
	}{
		{"short", 0},
		{"password", 0},
		{"aaaaaaaaaaaaaa", 0},
		{"abcdefghijkl", 1},
		{"Abcdefghij12", 2},
		{"Abcdefghij12345", 3},
		{"Abcdefghij12345!xyz", 4},
	}
	for _, c := range cases {
		got, label := PasswordStrength(c.pw)
		if got != c.want {
			t.Fatalf("PasswordStrength(%q) = %d，期望 %d", c.pw, got, c.want)
		}
		if strings.TrimSpace(label) == "" {
			t.Fatalf("PasswordStrength(%q) 标签为空", c.pw)
		}
	}
	if score, _ := PasswordStrength(""); score != PasswordScoreUnknown {
		t.Fatalf("空口令应记未评估，实际 %d", score)
	}
}

// TestRecordPasswordChangeMeta 覆盖口令元信息落库与读回（总览页展示依赖它）。
func TestRecordPasswordChangeMeta(t *testing.T) {
	db := openStore(t)
	sec := NewSecurity(db)
	before, err := sec.PasswordMeta()
	if err != nil {
		t.Fatalf("读口令元信息失败: %v", err)
	}
	if before.Score != PasswordScoreUnknown || before.ChangedAt != "" {
		t.Fatalf("初始应为未评估: %+v", before)
	}
	if err := sec.RecordPasswordChange("Abcdefghij12345!xyz"); err != nil {
		t.Fatalf("记录口令元信息失败: %v", err)
	}
	after, err := sec.PasswordMeta()
	if err != nil {
		t.Fatalf("读口令元信息失败: %v", err)
	}
	if after.Score != 4 || after.Label != "很强" || after.ChangedAt == "" || after.Source != "ui" {
		t.Fatalf("元信息不符合预期: %+v", after)
	}
	if after.HashAlgorithm == "" || after.HashIterations <= 0 {
		t.Fatalf("应回带哈希算法与迭代次数: %+v", after)
	}
}

// nanoText 把时刻转成纳秒字符串（与存储格式同口径）。
func nanoText(t time.Time) string {
	return strconv.FormatInt(t.UnixNano(), 10)
}
