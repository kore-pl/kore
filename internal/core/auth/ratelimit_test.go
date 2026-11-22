package auth_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/httpapi"
)

// rateKey 是单管理员体系下的限速 key（全局桶）。
const rateKey = "admin"

// TestLoginRateLimitBlocksAfterFiveFailures 验证 5 次失败后第 6 次 Allow=false
// 且 retryAfter > 0，并且锁定期间不会因为继续失败而把锁定期无限延长。
func TestLoginRateLimitBlocksAfterFiveFailures(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, 5*time.Minute)
	for i := 1; i <= 5; i++ {
		if ok, _ := limiter.Allow(rateKey); !ok {
			t.Fatalf("第 %d 次尝试应放行，实际被拒", i)
		}
		limiter.RecordFailure(rateKey)
	}
	ok, retryAfter := limiter.Allow(rateKey)
	if ok {
		t.Fatal("5 次失败后第 6 次应被拒绝")
	}
	if retryAfter <= 0 {
		t.Fatalf("拒绝时应返回正数 retryAfter，实际 %v", retryAfter)
	}
	if retryAfter > 5*time.Minute {
		t.Fatalf("retryAfter = %v 超过锁定上限 5m", retryAfter)
	}
	// 锁定期内继续失败不得累加，解锁时间不得被推后。
	limiter.RecordFailure(rateKey)
	if _, again := limiter.Allow(rateKey); again > retryAfter {
		t.Fatalf("锁定期内继续失败把锁定延长了：%v > %v", again, retryAfter)
	}
}

// TestLoginRateLimitSuccessResets 验证成功登录清零计数：4 次失败 + 成功清零后，
// 再失败 4 次仍应放行（若未清零会在第 5 次就触发锁定）。
func TestLoginRateLimitSuccessResets(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, 5*time.Minute)
	for i := 0; i < 4; i++ {
		limiter.RecordFailure(rateKey)
	}
	limiter.RecordSuccess(rateKey)
	for i := 0; i < 4; i++ {
		if ok, retry := limiter.Allow(rateKey); !ok {
			t.Fatalf("清零后再失败第 %d 次应放行，实际被拒 retry=%v", i+1, retry)
		}
		limiter.RecordFailure(rateKey)
	}
	if ok, _ := limiter.Allow(rateKey); !ok {
		t.Fatal("成功清零后累计 4 次失败不应触发锁定")
	}
}

// TestLoginLockoutExpires 验证锁定期满后恢复放行，且计数从零重新累计：
// 解锁后一次失败不应立刻再次锁定。
func TestLoginLockoutExpires(t *testing.T) {
	limiter := auth.NewLoginLimiter(2, 80*time.Millisecond, 100*time.Millisecond)
	limiter.RecordFailure(rateKey)
	limiter.RecordFailure(rateKey)
	if ok, retry := limiter.Allow(rateKey); ok || retry <= 0 {
		t.Fatalf("第 3 次应在锁定期内被拒，实际 ok=%v retry=%v", ok, retry)
	}
	time.Sleep(150 * time.Millisecond)
	if ok, retry := limiter.Allow(rateKey); !ok {
		t.Fatalf("锁定期满应恢复放行，实际被拒 retry=%v", retry)
	}
	limiter.RecordFailure(rateKey)
	if ok, _ := limiter.Allow(rateKey); !ok {
		t.Fatal("解锁后单次失败不应立刻再次锁定（计数应从零重新累计）")
	}
}

// TestLoginRateLimitConcurrent 验证并发 Allow/RecordFailure/RecordSuccess 无数据竞争
// 且计数不丢失（配合 -race）。
func TestLoginRateLimitConcurrent(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, time.Minute)
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := rateKey
			if i%8 == 0 {
				key = "other"
			}
			_, _ = limiter.Allow(key)
			limiter.RecordFailure(key)
			if i%16 == 0 {
				limiter.RecordSuccess(key)
			}
		}(i)
	}
	wg.Wait()
	if ok, _ := limiter.Allow(rateKey); ok {
		t.Fatal("64 次并发失败后应处于锁定态")
	}
}

// TestLoginLockoutHTTP 验证 handler 层：前 5 次错误口令 401，第 6 次 429
// E_RATELIMIT + Retry-After，且正确口令在限速下也被拒（先限速后校验）。
func TestLoginLockoutHTTP(t *testing.T) {
	db := newStore(t)
	s := httpapi.New(httpapi.Options{
		Auth:         auth.NewManager(db, makeHash(t, testPassword), 0, false),
		LoginLimiter: auth.NewLoginLimiter(5, time.Minute, 5*time.Minute),
	}, nil)
	handler := s.Handler()
	post := func(password string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
			strings.NewReader(`{"password":"`+password+`"}`)))
		return rec
	}
	for i := 1; i <= 5; i++ {
		if code := post("wrong-password").Code; code != http.StatusUnauthorized {
			t.Fatalf("第 %d 次错误口令状态码 = %d，期望 401", i, code)
		}
	}
	rec := post("wrong-password")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第 6 次状态码 = %d，期望 429；body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "E_RATELIMIT") {
		t.Fatalf("429 响应体缺少 E_RATELIMIT: %s", rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got == "" || got == "0" {
		t.Fatalf("429 响应缺少有效 Retry-After 头，实际 %q", got)
	}
	if code := post(testPassword).Code; code != http.StatusTooManyRequests {
		t.Fatalf("锁定期间正确口令也应被限速拒（429），实际 %d", code)
	}
}

// TestLoginLimiterSetPolicy 验证 SIGHUP 热更口径（CORE §6 白名单）：
// 阈值调小后对之后的判定立即生效，已累计计数与进行中的锁定不变。
func TestLoginLimiterSetPolicy(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, time.Minute)
	limiter.RecordFailure(rateKey)
	limiter.RecordFailure(rateKey)
	if ok, _ := limiter.Allow(rateKey); !ok {
		t.Fatal("阈值 5 下 2 次失败应放行")
	}
	limiter.SetPolicy(2, time.Minute, time.Minute)
	if ok, retry := limiter.Allow(rateKey); ok || retry <= 0 {
		t.Fatalf("阈值调小到 2 后应立即拒绝并给 retry，实际 ok=%v retry=%v", ok, retry)
	}
	// 调大阈值不得解除已发生的锁定。
	limiter.SetPolicy(10, time.Minute, time.Minute)
	if ok, _ := limiter.Allow(rateKey); ok {
		t.Fatal("调大阈值不应解除已经生效的锁定")
	}
}
