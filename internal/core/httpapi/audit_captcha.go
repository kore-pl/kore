package httpapi

// ADR-0057 T4 验证码相关审计：captcha.issued / captcha.failed / captcha.passed。
// 只记 challenge id 前缀与原因；答案、图片、口令一律不进审计（G-30）。
import "net/http"

// captchaIDPrefixLen 是 challenge id 在审计里保留的字符数（hex 32 字符截断后不可还原）。
const captchaIDPrefixLen = 8

// captchaIDPrefix 取 challenge id 前 8 字符；超短 id 原样（不足 8 只能是异常路径）。
func captchaIDPrefix(id string) string {
	if len(id) <= captchaIDPrefixLen {
		return id
	}
	return id[:captchaIDPrefixLen]
}

// recordCaptchaIssued 记录一次验证码签发：只记 id 前缀，不记答案。
func (s *Server) recordCaptchaIssued(id string) {
	s.recordAudit(AuditEvent{
		Subject: loginRateKey,
		Action:  "captcha.issued",
		Result:  auditResultOK,
		Detail:  map[string]string{"captcha_id_prefix": captchaIDPrefix(id)},
	})
}

// recordCaptchaFailed 记录一次验证码失败：reason ∈ missing / captcha_expired / captcha_invalid。
func (s *Server) recordCaptchaFailed(r *http.Request, reason string) {
	s.recordAudit(AuditEvent{
		Subject: loginRateKey,
		Action:  "captcha.failed",
		Result:  auditResultDenied,
		Detail: map[string]string{
			"ip": maskedClientIP(r), "user_agent": truncateUserAgent(r.UserAgent()), "reason": reason,
		},
	})
}

// recordCaptchaPassed 记录一次验证码通过（答案正确，仍须口令正确才能登录）。
func (s *Server) recordCaptchaPassed(r *http.Request) {
	s.recordAudit(AuditEvent{
		Subject: loginRateKey,
		Action:  "captcha.passed",
		Result:  auditResultOK,
		Detail: map[string]string{
			"ip": maskedClientIP(r), "user_agent": truncateUserAgent(r.UserAgent()),
		},
	})
}
