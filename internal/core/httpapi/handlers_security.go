package httpapi

// 安全设置端点：两步验证（TOTP）、登录来源 IP 白名单、API token。
// 全部要求有效会话（withAuth）+ CSRF 双提交（withCSRF）；改配置类操作额外要求当前口令。
// 明文密钥/令牌只在创建响应中出现一次，库里只存哈希；所有响应字段显式（G-24）。
import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/auth"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 端点路径常量（settings.js / security.js 与此处逐字对齐）。
const (
	securityPath       = "/api/v1/security"
	securityStatusPath = securityPath + "/status"
	totpBeginPath      = securityPath + "/totp/begin"
	totpEnablePath     = securityPath + "/totp/enable"
	totpDisablePath    = securityPath + "/totp/disable"
	ipAllowPath        = securityPath + "/ipallow"
	tokensPath         = securityPath + "/tokens"
	tokenItemPath      = tokensPath + "/{id}"
)

// 两步验证 / IP 白名单的错误码：前端按 code 分支显示「怎么办」。
const (
	code2FARequired = "E_2FA_REQUIRED"
	code2FAInvalid  = "E_2FA_INVALID"
	codeIPDenied    = "E_IP_DENIED"
)

// 统一请求体（显式字段，snake_case 与前端逐字对齐）。
type totpBeginRequest struct {
	Password string `json:"password"`
}
type totpEnableRequest struct {
	Code string `json:"code"`
}
type totpDisableRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}
type ipAllowRequest struct {
	Password string   `json:"password"`
	Enabled  bool     `json:"enabled"`
	CIDRs    []string `json:"cidrs"`
}
type tokenCreateRequest struct {
	Password     string   `json:"password"`
	Name         string   `json:"name"`
	Scope        string   `json:"scope"`
	TTLDays      int      `json:"ttl_days"`
	AllowedCIDRs []string `json:"allowed_cidrs,omitempty"`
}

// tokenUpdateRequest 的 allowed_cidrs 用指针表达三态：
// 缺省（nil）= 不改；空数组 = 清除绑定；非空 = 规范化后替换。
type tokenUpdateRequest struct {
	Password     string    `json:"password"`
	AllowedCIDRs *[]string `json:"allowed_cidrs,omitempty"`
}

// 统一响应体（显式字段，绝不回显口令/密钥/哈希）。
type securityStatusBody struct {
	TOTPEnabled bool              `json:"totpEnabled"`
	IPAllow     auth.IPAllowState `json:"ipAllow"`
	TokenCount  int               `json:"tokenCount"`
}
type totpBeginBody struct {
	Secret        string   `json:"secret"`
	OTPAuthURI    string   `json:"otpauthURI"`
	RecoveryCodes []string `json:"recoveryCodes"`
}
type tokenCreatedBody struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Token        string   `json:"token"`
	Scope        string   `json:"scope"`
	AllowedCIDRs []string `json:"allowed_cidrs,omitempty"`
}
type tokenListBody struct {
	Tokens []auth.TokenView `json:"tokens"`
}

// s.security 返回安全设置门面；auth 未装配时统一回 501，不伪造成功。
func (s *Server) security(w http.ResponseWriter) (*auth.Security, bool) {
	if s.auth == nil || s.auth.Security() == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前实例未启用鉴权或状态库，无法配置安全选项", "")
		return nil, false
	}
	return s.auth.Security(), true
}

// verifyPasswordOrDeny 对配置变更类操作要求当前口令；口令错误按 401 固定文案返回。
func (s *Server) verifyPasswordOrDeny(w http.ResponseWriter, password string) bool {
	ok, err := s.auth.Verify(password)
	if err != nil || !ok {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "当前管理员口令不正确", "")
		return false
	}
	return true
}

// decodeSecurityBody 读取有上限的请求体；非法体统一 400（不回显内容）。
func decodeSecurityBody(w http.ResponseWriter, r *http.Request, target any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "请求体格式不对，请检查后重试", "")
		return false
	}
	return true
}

// handleSecurityStatus 返回安全选项当前状态（只读，任何有效会话可读）。
func (s *Server) handleSecurityStatus(w http.ResponseWriter, _ *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	totp, err := sec.TOTPEnabled()
	if err != nil {
		writeFailure(w, err)
		return
	}
	ip, err := sec.IPAllow()
	if err != nil {
		writeFailure(w, err)
		return
	}
	tokens, err := sec.ListTokens()
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, securityStatusBody{TOTPEnabled: totp, IPAllow: ip, TokenCount: len(tokens)})
}

// handleTOTPBegin 生成待确认密钥与恢复码（需当前口令）。明文只在本次响应出现。
func (s *Server) handleTOTPBegin(w http.ResponseWriter, r *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	var req totpBeginRequest
	if !decodeSecurityBody(w, r, &req) || !s.verifyPasswordOrDeny(w, req.Password) {
		return
	}
	enroll, err := sec.BeginTOTP()
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, totpBeginBody{Secret: enroll.Secret, OTPAuthURI: enroll.OTPAuthURI, RecoveryCodes: enroll.RecoveryCodes})
}

// handleTOTPEnable 用 6 位验证码确认密钥并开启（需会话，pending 存在即可）。
func (s *Server) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	var req totpEnableRequest
	if !decodeSecurityBody(w, r, &req) {
		return
	}
	if err := sec.EnableTOTP(strings.TrimSpace(req.Code)); err != nil {
		if errors.Is(err, auth.ErrTOTPInvalid) {
			writeError(w, http.StatusUnauthorized, code2FAInvalid, "验证码不对，请确认手机上的 6 位数字（每 30 秒变一次）", "")
			return
		}
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, securityStatusBody{TOTPEnabled: true})
}

// handleTOTPDisable 关闭两步验证（需口令 + 当前验证码或恢复码）。
func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	var req totpDisableRequest
	if !decodeSecurityBody(w, r, &req) || !s.verifyPasswordOrDeny(w, req.Password) {
		return
	}
	valid, err := sec.VerifyTOTP(req.Code)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !valid {
		writeError(w, http.StatusUnauthorized, code2FAInvalid,
			"验证码或恢复码不对；请输入手机上的 6 位数字，或用备用恢复码", "")
		return
	}
	if err := sec.DisableTOTP(); err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, securityStatusBody{TOTPEnabled: false})
}

// handleIPAllowGet 读取登录来源白名单（只读）。
func (s *Server) handleIPAllowGet(w http.ResponseWriter, _ *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	st, err := sec.IPAllow()
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleIPAllowSet 设置登录来源白名单（需当前口令）。开启时列表不能为空或全网段。
func (s *Server) handleIPAllowSet(w http.ResponseWriter, r *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	var req ipAllowRequest
	if !decodeSecurityBody(w, r, &req) || !s.verifyPasswordOrDeny(w, req.Password) {
		return
	}
	if err := sec.SetIPAllow(auth.IPAllowState{Enabled: req.Enabled, CIDRs: req.CIDRs}); err != nil {
		if errors.Is(err, auth.ErrIPAllowAll) || errors.Is(err, auth.ErrIPAllowEmpty) {
			writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
			return
		}
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	st, _ := sec.IPAllow()
	writeJSON(w, http.StatusOK, st)
}

// handleTokenList 列出 API token 元数据（不含明文与哈希）。
func (s *Server) handleTokenList(w http.ResponseWriter, _ *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	tokens, err := sec.ListTokens()
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tokenListBody{Tokens: tokens})
}

// handleTokenCreate 生成 API token（需当前口令）。明文只返回一次。
func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	var req tokenCreateRequest
	if !decodeSecurityBody(w, r, &req) || !s.verifyPasswordOrDeny(w, req.Password) {
		return
	}
	ttl := time.Duration(req.TTLDays) * 24 * time.Hour
	if req.TTLDays <= 0 {
		ttl = 0 // 交给 auth 包取默认值
	}
	plain, rec, err := sec.CreateTokenWithCIDRs(req.Name, req.Scope, ttl, req.AllowedCIDRs)
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, tokenCreatedBody{ID: rec.ID, Name: rec.Name, Token: plain,
		Scope: rec.Scope, AllowedCIDRs: rec.AllowedCIDRs})
}

// handleTokenUpdate 就地改 token 的来源绑定（需当前口令 + 会话 + CSRF）。
// allowed_cidrs 三态：缺省不改 / 空数组清除 / 非空替换；非法 CIDR 与未知 id 均 400 E_INVALID。
func (s *Server) handleTokenUpdate(w http.ResponseWriter, r *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	var req tokenUpdateRequest
	if !decodeSecurityBody(w, r, &req) || !s.verifyPasswordOrDeny(w, req.Password) {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	view, err := sec.UpdateTokenCIDRs(id, req.AllowedCIDRs)
	if err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handleTokenRevoke 吊销 API token（需当前口令通过 query? 不——DELETE 带 body 不可靠；
// 这里仅要求会话 + CSRF，且在审计中留痕；口令确认已在创建时完成）。
func (s *Server) handleTokenRevoke(w http.ResponseWriter, r *http.Request) {
	sec, ok := s.security(w)
	if !ok {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if err := sec.RevokeToken(id); err != nil {
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

// loginIPDenied 写登录被白名单拒绝的响应（固定文案，不泄露白名单内容）。
func writeLoginDenied(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, codeIPDenied,
		"当前网络地址不在允许登录的范围内，请联系管理员把你的网络加入允许列表", "")
}

// login2FARequired 写"需要二次验证"的响应（前端据此展开验证码输入框）。
func write2FARequired(w http.ResponseWriter) {
	writeError(w, http.StatusPreconditionRequired, code2FARequired,
		"请输入认证器上的 6 位验证码，或使用备用恢复码", "")
}

// login2FAInvalid 写二次验证失败的响应。
func write2FAInvalid(w http.ResponseWriter) {
	writeError(w, http.StatusUnauthorized, code2FAInvalid,
		"验证码或恢复码不正确，请重新输入（每 30 秒会更新一次）", "")
}

// parseTTLDays 供测试与前端校验复用（保留 strconv 引用，避免魔法数散落）。
func parseTTLDays(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	return strconv.Atoi(strings.TrimSpace(raw))
}
