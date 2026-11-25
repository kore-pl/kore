package httpapi

// ADR-0057 T4：本地图形验证码端点（公开可读，登录前可用，不泄漏答案）。
import (
	"errors"
	"net/http"
	"strconv"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// captchaPath 是公开验证码端点路径；与前端 ENDPOINTS 契约逐字对齐。
const captchaPath = "/api/v1/auth/captcha"

// 登录失败防护错误码（前端按 code 分支显示白话文案）。
const (
	codeCaptchaRequired = "E_CAPTCHA_REQUIRED"
	codeCaptchaInvalid  = "E_CAPTCHA_INVALID"
)

// captchaBody 是 GET /api/v1/auth/captcha 的响应体：显式字段，只回传图片与题面，
// 绝不回传答案 / 摘要 / 内存状态（G-24 / G-30）。
type captchaBody struct {
	// ID 是 challenge 标识，登录请求原样回传。
	ID string `json:"captcha_id"`
	// Image 是 data:image/png;base64,... 形式的图形验证码。
	Image string `json:"image"`
	// TextQuestion 是同一 challenge 的文本加法替代（无图形能力场景用）。
	TextQuestion string `json:"text_question"`
	// ExpiresIn 是 challenge 剩余有效秒数（默认 120）。
	ExpiresIn int `json:"expires_in"`
}

// handleCaptcha 生成一个新 challenge。未登录可读；answer 只在 auth.CaptchaStore
// 的内存里以 sha256 形式存在，2 分钟 TTL，一次性。端点另受 10 次/分钟轻量限流，
// 不与口令失败桶共用计数（攻击者刷验证码不能推高管理员的登录延时）。
func (s *Server) handleCaptcha(w http.ResponseWriter, r *http.Request) {
	if s.captchas == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前实例未启用验证码挑战", "")
		return
	}
	ch, err := s.captchas.Issue()
	if err != nil {
		if errors.Is(err, auth.ErrCaptchaRateLimited) {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, pluginapi.E_RATELIMIT,
				"换得太快了，请 60 秒后再试", "")
			return
		}
		// fail-closed：签发失败（rand / png 编码错误）不伪造图片，按 500 拒绝。
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL,
			"验证码生成失败，请刷新页面后重试", "")
		return
	}
	s.recordCaptchaIssued(ch.ID)
	writeJSON(w, http.StatusOK, captchaBody{
		ID: ch.ID, Image: ch.Image, TextQuestion: ch.TextQuestion, ExpiresIn: ch.ExpiresIn,
	})
}

// writeCaptchaRequired 写"需要先过验证码"的 428；文案给"怎么办"（USABILITY §4）。
func writeCaptchaRequired(w http.ResponseWriter, detail string) {
	writeError(w, http.StatusPreconditionRequired, codeCaptchaRequired,
		"密码错误，请输入右侧验证码", detail)
}

// writeCaptchaInvalid 写验证码错 / 过期 / 用过的 401；不回显答案、不区分具体原因给前端文案，
// reason 只在 detail 里供排障（审计另记 captcha.failed）。
func writeCaptchaInvalid(w http.ResponseWriter, detail string) {
	writeError(w, http.StatusUnauthorized, codeCaptchaInvalid,
		"验证码不对或已过期，请点『换一张』后再输入一次", detail)
}

// captchaDetailReason 把 auth.CaptchaVerifyResult 映射为审计 detail.reason。
func captchaDetailReason(result auth.CaptchaVerifyResult) string {
	switch result {
	case auth.CaptchaExpired:
		return "captcha_expired"
	case auth.CaptchaInvalid:
		return "captcha_invalid"
	default:
		return "captcha_required"
	}
}

// retryAfterHeader 给应答写 Retry-After（秒，向上取整，最小 1）。
func retryAfterHeader(w http.ResponseWriter, seconds int64) {
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
}
