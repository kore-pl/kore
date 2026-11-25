package auth

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

func newTestSecurity(t *testing.T) *Security {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "state"), nil)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return NewSecurity(st)
}

// TOTP 端到端：生成 → 用正确动态码开启 → 状态开启 → 用动态码/恢复码校验。
func TestTOTPEnrollAndVerify(t *testing.T) {
	sec := newTestSecurity(t)
	enroll, err := sec.BeginTOTP()
	if err != nil {
		t.Fatalf("BeginTOTP: %v", err)
	}
	if enroll.Secret == "" || len(enroll.RecoveryCodes) != recoveryCodeCount {
		t.Fatalf("enroll 不完整: %+v", enroll)
	}
	// 用当前时间的正确 TOTP 开启。
	code := currentTOTP(t, enroll.Secret)
	if err := sec.EnableTOTP(code); err != nil {
		t.Fatalf("EnableTOTP: %v", err)
	}
	enabled, _ := sec.TOTPEnabled()
	if !enabled {
		t.Fatal("开启后 TOTPEnabled 应为 true")
	}
	// 动态码校验。
	ok, err := sec.VerifyTOTP(currentTOTP(t, enroll.Secret))
	if err != nil || !ok {
		t.Fatalf("VerifyTOTP 动态码 = %v,%v", ok, err)
	}
	// 恢复码校验：第一次成功，第二次失败（一次性）。
	rc := enroll.RecoveryCodes[0]
	ok, err = sec.VerifyTOTP(rc)
	if err != nil || !ok {
		t.Fatalf("恢复码首次校验 = %v,%v", ok, err)
	}
	ok, err = sec.VerifyTOTP(rc)
	if err != nil || ok {
		t.Fatalf("恢复码二次使用应失败: %v,%v", ok, err)
	}
	// 错误码拒绝。
	ok, _ = sec.VerifyTOTP("000000")
	if ok {
		t.Fatal("错误的 6 位码应被拒绝")
	}
}

// currentTOTP 用标准库按 RFC 6238 算出当前时间步的 6 位码（测试独立实现，不复用被测函数）。
func currentTOTP(t *testing.T, secret string) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatalf("decode secret: %v", err)
	}
	var counter [8]byte
	v := uint64(time.Now().Unix() / 30)
	for i := 7; i >= 0; i-- {
		counter[i] = byte(v)
		v >>= 8
	}
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counter[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	val := uint32(sum[off])<<24 | uint32(sum[off+1])<<16 | uint32(sum[off+2])<<8 | uint32(sum[off+3])
	val &= 0x7fffffff
	return fmt.Sprintf("%06d", val%1000000)
}

// IP 白名单：默认全放行；开启后仅命中网段放行；空列表/全网段拒绝保存。
func TestIPAllowlistFailClosed(t *testing.T) {
	sec := newTestSecurity(t)
	allowed, err := sec.IPAllowed("203.0.113.5")
	if err != nil || !allowed {
		t.Fatalf("默认应放行: %v,%v", allowed, err)
	}
	if err := sec.SetIPAllow(IPAllowState{Enabled: true, CIDRs: []string{"192.168.1.0/24"}}); err != nil {
		t.Fatalf("SetIPAllow: %v", err)
	}
	for _, tc := range []struct {
		ip   string
		want bool
	}{
		{"192.168.1.10", true},
		{"192.168.2.10", false},
		{"not-an-ip", false},
		{"", false},
	} {
		got, err := sec.IPAllowed(tc.ip)
		if err != nil || got != tc.want {
			t.Errorf("IPAllowed(%q)=%v,%v want %v", tc.ip, got, err, tc.want)
		}
	}
	if err := sec.SetIPAllow(IPAllowState{Enabled: true, CIDRs: []string{"0.0.0.0/0"}}); err == nil {
		t.Error("全网段应被拒绝")
	}
	if err := sec.SetIPAllow(IPAllowState{Enabled: true, CIDRs: nil}); err == nil {
		t.Error("开启但空列表应被拒绝")
	}
}

// API token：生成 → 校验 → 元数据无 hash → 吊销后失效。
func TestAPITokenLifecycle(t *testing.T) {
	sec := newTestSecurity(t)
	plain, rec, err := sec.CreateToken("automation", "read", 24*time.Hour)
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	if len(plain) < 40 || rec.Hash == plain {
		t.Fatal("明文与哈希不应相同")
	}
	found, ok, err := sec.ValidateToken(plain)
	if err != nil || !ok || found.ID != rec.ID {
		t.Fatalf("ValidateToken = %+v,%v,%v", found, ok, err)
	}
	views, err := sec.ListTokens()
	if err != nil || len(views) != 1 {
		t.Fatalf("ListTokens = %+v,%v", views, err)
	}
	if err := sec.RevokeToken(rec.ID); err != nil {
		t.Fatalf("RevokeToken: %v", err)
	}
	_, ok, err = sec.ValidateToken(plain)
	if err != nil || ok {
		t.Fatalf("吊销后仍可用: %v,%v", ok, err)
	}
}

// ClientIP：本机 channel 采信 XFF 首值；远端忽略伪造 XFF。
func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := ClientIP(r); got != "203.0.113.9" {
		t.Errorf("本机 XFF = %q", got)
	}
	r2 := httptest.NewRequest("GET", "/", nil)
	r2.RemoteAddr = "198.51.100.7:5678"
	r2.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := ClientIP(r2); got != "198.51.100.7" {
		t.Errorf("远端 XFF 应忽略，got %q", got)
	}
}
