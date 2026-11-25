package auth

// 白盒测试：用包内可见的 now 时间源推进 TTL，不 sleep 2 分钟；不依赖反射/unsafe。
import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestCaptchaIssueAndOneTimeVerify 覆盖签发形状、挑战态、一次性答案校验。
func TestCaptchaIssueAndOneTimeVerify(t *testing.T) {
	s := NewCaptchaStore()
	ch, err := s.Issue()
	if err != nil {
		t.Fatal(err)
	}
	if len(ch.ID) != 32 || !strings.HasPrefix(ch.Image, "data:image/png;base64,") {
		t.Fatalf("challenge 形状不对: id=%q image prefix=%q", ch.ID, ch.Image[:min(24, len(ch.Image))])
	}
	if ch.ExpiresIn != 120 || !strings.Contains(ch.TextQuestion, " + ") {
		t.Fatalf("challenge TTL/题面不对: %+v", ch)
	}
	if s.Required() {
		t.Fatal("新 store 不应处于挑战态")
	}
	s.Require()
	if !s.Required() {
		t.Fatal("Require 后应处于挑战态")
	}
	var a, b int
	if _, err := fmt.Sscanf(ch.TextQuestion, "%d + %d = ?", &a, &b); err != nil {
		t.Fatalf("解析题面失败: %v", err)
	}
	answer := strconv.Itoa(a + b)
	if got := s.Verify(ch.ID, answer); got != CaptchaOK {
		t.Fatalf("文本题答案校验 = %v，期望 CaptchaOK", got)
	}
	if got := s.Verify(ch.ID, answer); got != CaptchaMissing {
		t.Fatalf("一次性 challenge 再校验 = %v，期望 CaptchaMissing", got)
	}
}

// TestCaptchaWrongExpiredAndClear 覆盖错答案、TTL 过期、Clear 清挑战态。
func TestCaptchaWrongExpiredAndClear(t *testing.T) {
	base := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	s := NewCaptchaStore()
	s.now = func() time.Time { return base }
	ch, err := s.Issue()
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Verify(ch.ID, "ZZZZZ"); got != CaptchaInvalid {
		t.Fatalf("错答案校验 = %v，期望 CaptchaInvalid", got)
	}
	if got := s.Verify(ch.ID, "whatever"); got != CaptchaMissing {
		t.Fatalf("一次性 challenge 再校验 = %v，期望 CaptchaMissing", got)
	}
	expired, err := s.Issue()
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return base.Add(CaptchaTTL + time.Second) }
	if got := s.Verify(expired.ID, "1"); got != CaptchaExpired {
		t.Fatalf("过期校验 = %v，期望 CaptchaExpired", got)
	}
	s.Require()
	s.Clear()
	if s.Required() {
		t.Fatal("Clear 后不应处于挑战态")
	}
}

// TestCaptchaImageIsPNG 确认 PNG 可解码、尺寸正确（stdlib image/png，无第三方依赖）。
func TestCaptchaImageIsPNG(t *testing.T) {
	s := NewCaptchaStore()
	ch, err := s.Issue()
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "data:image/png;base64,"
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(ch.Image, prefix))
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("PNG 解码失败: %v", err)
	}
	if img.Bounds().Dx() != captchaImageWidth || img.Bounds().Dy() != captchaImageHeight {
		t.Fatalf("PNG 尺寸 = %v，期望 %dx%d", img.Bounds(), captchaImageWidth, captchaImageHeight)
	}
}

// TestCaptchaIssueRateLimit 钉死 10 次/分钟的轻量限流。
func TestCaptchaIssueRateLimit(t *testing.T) {
	s := NewCaptchaStore()
	for i := 0; i < CaptchaIssueLimit; i++ {
		if _, err := s.Issue(); err != nil {
			t.Fatalf("第 %d 次签发应成功: %v", i+1, err)
		}
	}
	if _, err := s.Issue(); !errors.Is(err, ErrCaptchaRateLimited) {
		t.Fatalf("第 11 次签发 err=%v，期望 ErrCaptchaRateLimited", err)
	}
}

// TestCaptchaStateIsMemoryOnly 明确 challenge 表不落盘：只存摘要，明文不会出现在 JSON 序列化中。
// 用 go vet 检查字段类型即可；这里确认 CaptchaChallenge 显式字段不含答案。
func TestCaptchaChallengeBodyHasNoAnswer(t *testing.T) {
	b, err := json.Marshal(CaptchaChallenge{ID: "id", Image: "img", TextQuestion: "q", ExpiresIn: 120})
	if err != nil {
		t.Fatal(err)
	}
	var view map[string]json.RawMessage
	if err := json.Unmarshal(b, &view); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"answer", "answer_hash", "image_hash", "text_hash"} {
		if _, ok := view[key]; ok {
			t.Fatalf("challenge 视图泄漏答案字段 %q", key)
		}
	}
}
