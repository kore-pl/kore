package auth_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/internal/core/httpapi"
)

// rateKey 是单管理员体系下的限速 key（全局桶）。
const rateKey = "admin"

// postLogin 发一次登录请求并返回响应；body 固定走 loginRequest 的 JSON 形状。
func postLogin(handler http.Handler, password string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"username":"admin","password":"`+password+`"}`)))
	return rec
}

// TestLoginPenaltyEscalationNumbers 钉死递增延迟的数字表：前 5 次失败免费，
// 第 6 次 1s，之后 2s/4s/8s/16s，第 11 次起封顶 30s（与 docs/SECURITY §3.5 一致）。
func TestLoginPenaltyEscalationNumbers(t *testing.T) {
	want := []time.Duration{
		0, 0, 0, 0, 0, // 1..5 次：容忍手误
		1 * time.Second,  // 6
		2 * time.Second,  // 7
		4 * time.Second,  // 8
		8 * time.Second,  // 9
		16 * time.Second, // 10
		30 * time.Second, // 11
		30 * time.Second, // 12：封顶
	}
	for i, w := range want {
		if got := auth.PenaltyFor(5, i+1); got != w {
			t.Fatalf("连续失败 %d 次的延迟 = %v，期望 %v", i+1, got, w)
		}
	}
	limiter := auth.NewLoginLimiter(5, time.Minute, 5*time.Minute)
	for i, w := range want {
		if got := limiter.RecordFailure(rateKey); got != w {
			t.Fatalf("RecordFailure 第 %d 次返回 %v，期望 %v", i+1, got, w)
		}
	}
	// 封顶后不再增长，避免延迟无限膨胀影响可用性。
	for i := 0; i < 5; i++ {
		if got := limiter.RecordFailure(rateKey); got != auth.PenaltyCap {
			t.Fatalf("封顶后第 %d 次延迟 = %v，期望 %v", i+1, got, auth.PenaltyCap)
		}
	}
}

// TestLoginPenaltySuccessAndIdleReset 钉死两个清零条件：登录成功清零；
// 连续失败后静默超过 lockout（默认 300s，测试用 80ms）后惩罚等级归零。
func TestLoginPenaltySuccessAndIdleReset(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, 5*time.Minute)
	for i := 0; i < 6; i++ {
		limiter.RecordFailure(rateKey)
	}
	if got := limiter.RecordFailure(rateKey); got != 2*time.Second {
		t.Fatalf("6 次失败后第 7 次延迟 = %v，期望 2s", got)
	}
	limiter.RecordSuccess(rateKey)
	if got := limiter.RecordFailure(rateKey); got != 0 {
		t.Fatalf("成功清零后下一次失败延迟 = %v，期望 0", got)
	}

	idle := auth.NewLoginLimiter(5, time.Minute, 80*time.Millisecond)
	for i := 0; i < 6; i++ {
		idle.RecordFailure(rateKey)
	}
	time.Sleep(120 * time.Millisecond)
	if got := idle.RecordFailure(rateKey); got != 0 {
		t.Fatalf("静默超过 lock 后惩罚等级应归零，实际延迟 %v", got)
	}
}

// TestLoginCorrectPasswordDuringPenaltyHTTP 是 P1 DoS 的核心回归用例：
// ADR-0057 T4 后宽容次数 1：第 1 次错口令 0s（触发验证码），第 2 次起 1s 惩罚。
// 正确口令即使处于惩罚期也立即登录成功，攻击者无法把管理员锁死。
func TestLoginCorrectPasswordDuringPenaltyHTTP(t *testing.T) {
	db := newStore(t)
	caps := auth.NewCaptchaStore()
	s := httpapi.New(httpapi.Options{
		Auth:         auth.NewManager(db, makeHash(t, testPassword), 0, false),
		LoginLimiter: auth.NewLoginLimiter(1, time.Minute, 5*time.Minute),
		Captchas:     caps,
	}, nil)
	handler := s.Handler()

	// 首次错口令：401 + 触发挑战态，0s。
	if rec := postLogin(handler, "wrong-password"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("第 1 次错口令状态码 = %d，期望 401", rec.Code)
	}
	// 辅助：从公开端点取验证码，用文本加法题答案过挑战（一次性）。
	answerWrongWithCaptcha := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/captcha", nil))
		var body struct {
			ID       string `json:"captcha_id"`
			Question string `json:"text_question"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		var a, b int
		if _, err := fmt.Sscanf(body.Question, "%d + %d = ?", &a, &b); err != nil {
			t.Fatal(err)
		}
		payload := fmt.Sprintf(`{"username":"admin","password":"wrong-password","captcha_id":%q,"captcha_answer":"%d"}`, body.ID, a+b)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(payload)))
		return out
	}
	// 第 2 次错口令（带验证码）进入惩罚：1s 后 429 + Retry-After（下一次 2s）。
	start := time.Now()
	rec := answerWrongWithCaptcha()
	elapsed := time.Since(start)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第 2 次错口令状态码 = %d，期望 429；body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "E_RATELIMIT") {
		t.Fatalf("429 响应体缺少 E_RATELIMIT: %s", rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "2" {
		t.Fatalf("Retry-After = %q，期望下一次惩罚 2 秒", got)
	}
	if elapsed < 900*time.Millisecond {
		t.Fatalf("第 2 次错口令只耗时 %v，递增延迟未生效（爆破未被限制）", elapsed)
	}

	// 关键断言：惩罚期间正确口令立刻通过（也需带验证码），且不等待惩罚延迟。
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/captcha", nil))
	var ch struct {
		ID       string `json:"captcha_id"`
		Question string `json:"text_question"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ch); err != nil {
		t.Fatal(err)
	}
	var a, b int
	if _, err := fmt.Sscanf(ch.Question, "%d + %d = ?", &a, &b); err != nil {
		t.Fatal(err)
	}
	goodPayload := fmt.Sprintf(`{"username":"admin","password":%q,"captcha_id":%q,"captcha_answer":"%d"}`, testPassword, ch.ID, a+b)
	start = time.Now()
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(goodPayload)))
	elapsed = time.Since(start)
	if rec.Code != http.StatusOK {
		t.Fatalf("惩罚期间正确口令状态码 = %d，期望 200（管理员被锁死）；body=%s",
			rec.Code, rec.Body.String())
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("正确口令耗时 %v，惩罚延迟不应施加在正确口令上", elapsed)
	}
	// 成功清零后，再次错误从 0 延迟重新累计（不会被上一轮永久压制）。
	if rec := postLogin(handler, "wrong-password"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("成功清零后下一次错口令状态码 = %d，期望 401", rec.Code)
	}
}

// TestLoginBruteforceStillThrottled 断言修 DoS 没有放宽爆破防护：
// 惩罚模式下错误口令被递增延迟，且并发猜测被单飞串行化（吞吐不随并发放大）。
func TestLoginBruteforceStillThrottled(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, 5*time.Minute)
	for i := 0; i < 5; i++ {
		limiter.RecordFailure(rateKey)
	}
	if got := limiter.NextPenalty(rateKey); got != 1*time.Second {
		t.Fatalf("第 6 次错误前 NextPenalty = %v，期望 1s", got)
	}

	// 单飞：8 个并发校验，任一时刻最多 1 个在 PBKDF2 中。
	var inFlight, maxInFlight int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, ok := limiter.BeginVerify(t.Context())
			if !ok {
				t.Error("BeginVerify 未取得名额")
				return
			}
			n := atomic.AddInt32(&inFlight, 1)
			for {
				old := atomic.LoadInt32(&maxInFlight)
				if n <= old || atomic.CompareAndSwapInt32(&maxInFlight, old, n) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			atomic.AddInt32(&inFlight, -1)
			release()
		}()
	}
	wg.Wait()
	if maxInFlight != 1 {
		t.Fatalf("并发校验在飞数 = %d，期望单飞串行 1", maxInFlight)
	}
}

// TestLoginLimiterConcurrent 验证并发 RecordFailure/RecordSuccess/NextPenalty/
// BeginVerify 无数据竞争且不 panic（配合 -race）。
func TestLoginLimiterConcurrent(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, time.Minute)
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if release, ok := limiter.BeginVerify(t.Context()); ok {
				release()
			}
			_ = limiter.RecordFailure(rateKey)
			_ = limiter.NextPenalty(rateKey)
			if i%16 == 0 {
				limiter.RecordSuccess(rateKey)
			}
		}(i)
	}
	wg.Wait()
}

// TestLoginLimiterSetPolicy 验证 SIGHUP 热更口径：阈值调小后对之后的判定立即生效，
// 已累计的连续失败与惩罚等级不变。
func TestLoginLimiterSetPolicy(t *testing.T) {
	limiter := auth.NewLoginLimiter(5, time.Minute, time.Minute)
	for i := 0; i < 5; i++ {
		if got := limiter.RecordFailure(rateKey); got != 0 {
			t.Fatalf("阈值 5 下第 %d 次失败延迟 = %v，期望 0", i+1, got)
		}
	}
	limiter.SetPolicy(2, time.Minute, time.Minute)
	if got := limiter.NextPenalty(rateKey); got <= 0 {
		t.Fatalf("阈值调小到 2 后应进入惩罚，NextPenalty = %v", got)
	}
}
