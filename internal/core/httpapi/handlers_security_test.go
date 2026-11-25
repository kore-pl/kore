package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/store"
)

// currentTestTOTP 用标准库按 RFC 6238 算当前 6 位码（测试独立实现）。
func currentTestTOTP(t *testing.T, secret string) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatal(err)
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

// securityTestServer 构造带完整鉴权 + 安全设置的测试服务器（不启监听）。
func securityTestServer(t *testing.T) (*Server, *auth.Security) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "state"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	hash, err := auth.HashPassword("correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	mgr := auth.NewManager(st, hash, time.Hour, false)
	srv := New(Options{Auth: mgr}, nil)
	return srv, mgr.Security()
}

func securityJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// 默认流程兼容：未开 2FA/白名单时口令登录直接签发会话。
func TestSecurityLoginDefaultCompatible(t *testing.T) {
	srv, _ := securityTestServer(t)
	req := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(securityJSON(t, map[string]string{"password": "correct-horse-battery"})))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("默认登录应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// 2FA：口令正确但未带 OTP → 428 E_2FA_REQUIRED，不签发会话；带正确 OTP → 200。
func TestSecurityLogin2FA(t *testing.T) {
	srv, sec := securityTestServer(t)
	enroll, err := sec.BeginTOTP()
	if err != nil {
		t.Fatal(err)
	}
	// 用测试内同算法算当前码（与 auth 包测试同口径）。
	code := currentTestTOTP(t, enroll.Secret)
	if err := sec.EnableTOTP(code); err != nil {
		t.Fatal(err)
	}
	body := securityJSON(t, map[string]string{"password": "correct-horse-battery"})
	req := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusPreconditionRequired || !strings.Contains(rec.Body.String(), code2FARequired) {
		t.Fatalf("应 428 E_2FA_REQUIRED，实际 %d: %s", rec.Code, rec.Body.String())
	}
	body = securityJSON(t, map[string]string{"password": "correct-horse-battery", "otp": currentTestTOTP(t, enroll.Secret)})
	req = httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("带正确 OTP 应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// IP 白名单：开启后不在网段的来源被拒（403 E_IP_DENIED），口令正确也不放行。
func TestSecurityLoginIPDenied(t *testing.T) {
	srv, sec := securityTestServer(t)
	if err := sec.SetIPAllow(auth.IPAllowState{Enabled: true, CIDRs: []string{"192.168.1.0/24"}}); err != nil {
		t.Fatal(err)
	}
	body := securityJSON(t, map[string]string{"password": "correct-horse-battery"})
	req := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "203.0.113.9:1234"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), codeIPDenied) {
		t.Fatalf("应 403 E_IP_DENIED，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// API token：生成后可用 Bearer 调只读端点；read 令牌写操作被拒；吊销后 401。
func TestSecurityAPITokenAccess(t *testing.T) {
	srv, sec := securityTestServer(t)
	plain, _, err := sec.CreateToken("ci", "read", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// 只读端点：需装配 system/info handler（骨架有），带 token 应过鉴权。
	req := httptest.NewRequest("GET", "/api/v1/system/info", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code == http.StatusUnauthorized {
		t.Fatalf("API token 应通过鉴权，实际 401: %s", rec.Body.String())
	}
	// read 令牌写操作应 403（token 分支在 CSRF 之前拦截）。
	req2 := httptest.NewRequest("POST", "/api/v1/auth/password", bytes.NewReader([]byte("{}")))
	req2.Header.Set("Authorization", "Bearer "+plain)
	rec2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("read 令牌写操作应 403，实际 %d: %s", rec2.Code, rec2.Body.String())
	}
	views, err := sec.ListTokens()
	if err != nil || len(views) != 1 {
		t.Fatalf("ListTokens = %+v,%v", views, err)
	}
	if err := sec.RevokeToken(views[0].ID); err != nil {
		t.Fatal(err)
	}
	req3 := httptest.NewRequest("GET", "/api/v1/system/info", nil)
	req3.Header.Set("Authorization", "Bearer "+plain)
	rec3 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusUnauthorized {
		t.Fatalf("吊销后应 401，实际 %d", rec3.Code)
	}
}
