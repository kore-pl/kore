package auth

// 本文件提供单管理员的登录安全增强：TOTP 两步验证、登录来源 IP 白名单、
// 可撤销的 API token。三者默认全部关闭，只有用户在面板主动开启才生效（兼容现有登录）。
//
// 持久化复用 state.db 的 meta bucket，用 "security.*" 命名空间键，不新增 bucket、
// 不新增第三方依赖（G-02）、不改 store / config / cmd（G-01 薄壳）。明文密钥只返回一次：
// TOTP 密钥在开启流程展示、API token 在创建时展示；库里只存哈希或一次性恢复码哈希。
import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// 安全设置在 meta bucket 中的键前缀（与 schema_version / onboarding 标记不冲突）。
const (
	securityBucket        = "meta"
	totpStateKey          = "security.totp"
	totpPendingKey        = "security.totp.pending"
	ipAllowKey            = "security.ipallow"
	tokenKeyPrefix        = "security.token."
	tokenValuePrefix      = "kore_"
	totpPeriodSeconds     = 30
	totpSkewSteps         = 1
	totpDigits            = 6
	recoveryCodeCount     = 10
	recoveryCodeBytes     = 5
	maxIPAllowEntries     = 50
	tokenIDBytes          = 16
	tokenSecretBytes      = 32
	tokenNameMax          = 64
	tokenMaxTTL           = 365 * 24 * time.Hour
	tokenDefaultTTL       = 90 * 24 * time.Hour
	tokenLastUsedThrottle = 24 * time.Hour
	// tokenCIDRMaxEntries / tokenCIDRMaxBytes 是 API token 来源绑定的外部输入上限：
	// 每请求 O(n) 匹配，记录来自 API，必须防 DoS 与胀库（16 条覆盖内网+办公出口+回环）。
	tokenCIDRMaxEntries = 16
	tokenCIDRMaxBytes   = 64
)

// 安全设置的错误分类（handler 按分类映射用户能看懂的文案与退出码）。
var (
	ErrSecurityUnavailable = errors.New("安全设置暂不可用：状态库未装配")
	ErrTOTPNotPending      = errors.New("没有待确认的两步验证设置，请先重新生成密钥")
	ErrTOTPInvalid         = errors.New("验证码或恢复码不正确")
	ErrIPAllowEmpty        = errors.New("允许列表至少填一条网段，否则开启后谁都登录不了")
	ErrIPAllowAll          = errors.New("不能把允许范围设为全部网络，这样等于没有限制")
)

// TOTPState 是已开启的两步验证状态。Secret 是 base32 密钥（只在设置时返回前端一次），
// RecoveryHashes 是恢复码的 sha256 hex（明文只在设置时展示一次，用完即删）。
type TOTPState struct {
	Enabled        bool     `json:"enabled"`
	Secret         string   `json:"secret"`
	RecoveryHashes []string `json:"recoveryHashes"`
	CreatedAt      string   `json:"createdAt"`
}

// TOTPEnrollment 是开启两步验证时一次性返回给用户的材料。
type TOTPEnrollment struct {
	Secret        string   `json:"secret"`
	OTPAuthURI    string   `json:"otpauthURI"`
	RecoveryCodes []string `json:"recoveryCodes"`
}

// IPAllowState 是登录来源白名单。Enabled=false 时不参与登录校验。
type IPAllowState struct {
	Enabled bool     `json:"enabled"`
	CIDRs   []string `json:"cidrs"`
}

// APITokenRecord 是 API token 的元数据，Hash 是明文 token 的 sha256 hex，永不对外返回。
type APITokenRecord struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Hash       string `json:"hash"`
	Scope      string `json:"scope"`
	CreatedAt  string `json:"createdAt"`
	ExpiresAt  string `json:"expiresAt"`
	LastUsedAt string `json:"lastUsedAt"`
	// AllowedCIDRs 是可选来源绑定（omitempty 兼容存量记录）：nil/缺字段 = 不限制。
	// 必须挂在整条记录上——ValidateToken 的 LastUsedAt 节流会把整条记录重新写回，
	// 字段若挂别处会在一次「更新最后使用时间」后被静默抹掉。
	AllowedCIDRs []string `json:"allowed_cidrs,omitempty"`
}

// TokenView 是 GET /api/v1/security/tokens 的对外视图（显式字段，绝不带 hash/明文）。
type TokenView struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Scope        string   `json:"scope"`
	CreatedAt    string   `json:"createdAt"`
	ExpiresAt    string   `json:"expiresAt"`
	LastUsedAt   string   `json:"lastUsedAt"`
	AllowedCIDRs []string `json:"allowed_cidrs,omitempty"`
}

// Security 是安全设置的存储门面，只依赖 store（与 Manager 同源）。
type Security struct {
	store *store.Store
}

// NewSecurity 构造安全设置门面；store 为 nil 时返回 nil（骨架/测试按"未开启"处理）。
func NewSecurity(s *store.Store) *Security {
	if s == nil {
		return nil
	}
	return &Security{store: s}
}

// Security 返回 Manager 持有的安全设置门面；未装配状态库时返回 nil。
func (m *Manager) Security() *Security { return m.security }

// ClientIP 返回登录请求的来源 IP：本机通道（UDS/回环）且带 X-Forwarded-For 时
// 采信转发链最左端的第一个 IP（反代终结在同机为既定部署模型，与 CookieSecure 同源）；
// 远端直连携带的 XFF 一律忽略，避免伪造头绕过白名单。
func ClientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	host := strings.Trim(r.RemoteAddr, "[]")
	if parsedHost, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = parsedHost
	}
	if isLocalPeer(r.RemoteAddr) {
		if raw := r.Header.Get("X-Forwarded-For"); raw != "" {
			first, _, _ := strings.Cut(raw, ",")
			if candidate := net.ParseIP(strings.TrimSpace(first)); candidate != nil {
				return candidate.String()
			}
		}
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}

// --- TOTP ---

// BeginTOTP 生成待确认的 TOTP 密钥与恢复码，写入 pending（不覆盖已开启的状态）。
// 明文密钥与恢复码只在此方法返回一次，之后任何读接口都不再返回。
func (sec *Security) BeginTOTP() (TOTPEnrollment, error) {
	if sec == nil {
		return TOTPEnrollment{}, ErrSecurityUnavailable
	}
	if enabled, err := sec.TOTPEnabled(); err != nil {
		return TOTPEnrollment{}, err
	} else if enabled {
		return TOTPEnrollment{}, errors.New("两步验证已开启，请先关闭再重新设置")
	}
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return TOTPEnrollment{}, fmt.Errorf("生成两步验证密钥失败: %w", err)
	}
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	codes, hashes, err := generateRecoveryCodes()
	if err != nil {
		return TOTPEnrollment{}, err
	}
	pending := TOTPState{Secret: secret, RecoveryHashes: hashes, CreatedAt: nowRFC3339()}
	data, err := json.Marshal(pending)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	if err := sec.store.Update(func(tx *store.Tx) error {
		return tx.Put(securityBucket, totpPendingKey, data)
	}); err != nil {
		return TOTPEnrollment{}, fmt.Errorf("保存待确认密钥失败: %w", err)
	}
	label := url.QueryEscape("Kore:admin")
	uri := "otpauth://totp/" + label + "?secret=" + secret +
		"&issuer=Kore&algorithm=SHA1&digits=" + strconv.Itoa(totpDigits) +
		"&period=" + strconv.Itoa(totpPeriodSeconds)
	return TOTPEnrollment{Secret: secret, OTPAuthURI: uri, RecoveryCodes: codes}, nil
}

// EnableTOTP 用动态验证码确认密钥可用后正式开启两步验证；pending 不存在或码错误一律失败。
func (sec *Security) EnableTOTP(code string) error {
	if sec == nil {
		return ErrSecurityUnavailable
	}
	var pending TOTPState
	if err := sec.loadKey(totpPendingKey, &pending); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ErrTOTPNotPending
		}
		return err
	}
	if pending.Secret == "" || !verifyTOTPCode(pending.Secret, code, time.Now()) {
		return ErrTOTPInvalid
	}
	pending.Enabled = true
	pending.CreatedAt = nowRFC3339()
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return sec.store.Update(func(tx *store.Tx) error {
		if err := tx.Put(securityBucket, totpStateKey, data); err != nil {
			return err
		}
		return tx.Delete(securityBucket, totpPendingKey)
	})
}

// DisableTOTP 关闭两步验证，同时删除恢复码；调用方须先校验口令与当前验证码。
func (sec *Security) DisableTOTP() error {
	if sec == nil {
		return ErrSecurityUnavailable
	}
	return sec.store.Update(func(tx *store.Tx) error {
		if err := tx.Delete(securityBucket, totpStateKey); err != nil {
			return err
		}
		return tx.Delete(securityBucket, totpPendingKey)
	})
}

// TOTPEnabled 报告两步验证是否已开启；未装配/未设置时按关闭处理。
func (sec *Security) TOTPEnabled() (bool, error) {
	if sec == nil {
		return false, nil
	}
	st, err := sec.loadTOTP()
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return st.Enabled, nil
}

// VerifyTOTP 校验动态验证码或一次性恢复码；恢复码命中后即从库中删除（单次有效）。
func (sec *Security) VerifyTOTP(code string) (bool, error) {
	if sec == nil {
		return false, nil
	}
	st, err := sec.loadTOTP()
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil || !st.Enabled {
		return false, err
	}
	code = strings.TrimSpace(code)
	if verifyTOTPCode(st.Secret, code, time.Now()) {
		return true, nil
	}
	hash := sha256Hex(normalizeRecoveryCode(code))
	for i, stored := range st.RecoveryHashes {
		if subtle.ConstantTimeCompare([]byte(stored), []byte(hash)) != 1 {
			continue
		}
		st.RecoveryHashes = append(st.RecoveryHashes[:i], st.RecoveryHashes[i+1:]...)
		data, err := json.Marshal(st)
		if err != nil {
			return false, err
		}
		if err := sec.store.Update(func(tx *store.Tx) error {
			return tx.Put(securityBucket, totpStateKey, data)
		}); err != nil {
			return false, fmt.Errorf("核销恢复码失败: %w", err)
		}
		return true, nil
	}
	return false, nil
}

// verifyTOTPCode 实现 RFC 6238（HMAC-SHA1 / 6 位 / 30 秒），允许 ±1 个时间步偏差。
func verifyTOTPCode(secret, code string, now time.Time) bool {
	if code == "" || len(code) != totpDigits {
		return false
	}
	for _, ch := range code {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil || len(key) == 0 {
		return false
	}
	counter := uint64(now.Unix() / totpPeriodSeconds)
	for diff := -totpSkewSteps; diff <= totpSkewSteps; diff++ {
		c := counter
		if diff < 0 {
			c -= uint64(-diff)
		} else {
			c += uint64(diff)
		}
		var buf [8]byte
		binaryPutUint64(buf[:], c)
		mac := hmac.New(sha1.New, key)
		_, _ = mac.Write(buf[:])
		sum := mac.Sum(nil)
		offset := sum[len(sum)-1] & 0x0f
		value := binaryBigEndianUint32(sum[offset:offset+4]) & 0x7fffffff
		want := fmt.Sprintf("%0*d", totpDigits, value%1000000)
		if subtle.ConstantTimeCompare([]byte(code), []byte(want)) == 1 {
			return true
		}
	}
	return false
}

// generateRecoveryCodes 生成一次性恢复码：明文形如 XXXXX-XXXXX，库里只存规范化后的哈希。
func generateRecoveryCodes() ([]string, []string, error) {
	codes := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)
	for i := 0; i < recoveryCodeCount; i++ {
		buf := make([]byte, recoveryCodeBytes)
		if _, err := rand.Read(buf); err != nil {
			return nil, nil, fmt.Errorf("生成恢复码失败: %w", err)
		}
		raw := hex.EncodeToString(buf)
		plain := raw[:5] + "-" + raw[5:]
		codes = append(codes, plain)
		hashes = append(hashes, sha256Hex(normalizeRecoveryCode(plain)))
	}
	return codes, hashes, nil
}

func normalizeRecoveryCode(code string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
}

// TOTPStatusView 是「账户与安全中心」用的两步验证状态视图（显式字段，G-24）。
type TOTPStatusView struct {
	// Enabled 表示两步验证是否已开启。
	Enabled bool `json:"enabled"`
	// RecoveryCodesLeft 是尚未使用的恢复码数量（明文恢复码只在设置时展示一次）。
	RecoveryCodesLeft int `json:"recoveryCodesLeft"`
	// CreatedAt 是开启时刻（RFC3339；未开启为空）。
	CreatedAt string `json:"createdAt"`
}

// TOTPStatus 读取两步验证状态与剩余恢复码数量；未开启/未装配时返回零值。
func (sec *Security) TOTPStatus() (TOTPStatusView, error) {
	if sec == nil {
		return TOTPStatusView{}, nil
	}
	st, err := sec.loadTOTP()
	if errors.Is(err, store.ErrNotFound) {
		return TOTPStatusView{}, nil
	}
	if err != nil {
		return TOTPStatusView{}, err
	}
	left := 0
	if st.Enabled {
		left = len(st.RecoveryHashes)
	}
	return TOTPStatusView{Enabled: st.Enabled, RecoveryCodesLeft: left, CreatedAt: st.CreatedAt}, nil
}

// --- 登录来源 IP 白名单 ---

// IPAllow 读取白名单配置（未设置时返回开启=false 的空列表）。
func (sec *Security) IPAllow() (IPAllowState, error) {
	if sec == nil {
		return IPAllowState{}, nil
	}
	var st IPAllowState
	err := sec.loadKey(ipAllowKey, &st)
	if errors.Is(err, store.ErrNotFound) {
		return IPAllowState{}, nil
	}
	return st, err
}

// SetIPAllow 校验并持久化白名单：网段规范化、去重、排序；开启时列表不得为空或全网段。
func (sec *Security) SetIPAllow(st IPAllowState) error {
	if sec == nil {
		return ErrSecurityUnavailable
	}
	cidrs, err := normalizeCIDRs(st.CIDRs)
	if err != nil {
		return err
	}
	if st.Enabled && len(cidrs) == 0 {
		return ErrIPAllowEmpty
	}
	out := IPAllowState{Enabled: st.Enabled, CIDRs: cidrs}
	data, err := json.Marshal(out)
	if err != nil {
		return err
	}
	return sec.store.Update(func(tx *store.Tx) error {
		return tx.Put(securityBucket, ipAllowKey, data)
	})
}

// IPAllowed 判断来源 IP 是否允许登录。开启白名单后解析失败/空列表/未命中一律拒绝（fail-closed）。
func (sec *Security) IPAllowed(ip string) (bool, error) {
	if sec == nil {
		return true, nil
	}
	st, err := sec.IPAllow()
	if err != nil {
		return false, err
	}
	if !st.Enabled {
		return true, nil
	}
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil || len(st.CIDRs) == 0 {
		return false, nil
	}
	for _, cidr := range st.CIDRs {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(parsed) {
			return true, nil
		}
	}
	return false, nil
}

func normalizeCIDRs(input []string) ([]string, error) {
	if len(input) > maxIPAllowEntries {
		return nil, fmt.Errorf("最多允许 %d 条网段，请合并后重试", maxIPAllowEntries)
	}
	seen := make(map[string]bool, len(input))
	out := make([]string, 0, len(input))
	for _, raw := range input {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		ip, network, err := net.ParseCIDR(s)
		if err != nil {
			return nil, fmt.Errorf("%q 不是合法网段，请写成 192.168.1.0/24 这样的形式", raw)
		}
		ones, _ := network.Mask.Size()
		if ones == 0 && (ip.To4() != nil || ip.To16() != nil) {
			return nil, ErrIPAllowAll
		}
		canonical := network.String()
		if !seen[canonical] {
			seen[canonical] = true
			out = append(out, canonical)
		}
	}
	sort.Strings(out)
	return out, nil
}

// normalizeTokenCIDRs 归一化 API token 的可选来源绑定（创建与更新共用此唯一收口）。
//
// 与上面的登录白名单 normalizeCIDRs 刻意分开：后者是既有登录口径（最多 50 条、
// 跳过空元素、单 IP 必须写成 /mask、全网段用 ErrIPAllowAll），token 绑定是新语义，
// 不得反向改变登录行为。规则（DESIGN-TOKEN-IP-BIND §2.2）：
//   - nil / 空表 → 返回 nil（不限制，兼容存量 token）
//   - 含 / → netip.ParsePrefix + Masked 归一；裸 IP → 补 /32（IPv4）或 /128（IPv6）
//   - 拒 zone、拒 /0、单条 trim 后 ≤64 字节、总数 ≤16；拒空元素（不静默放行）
//   - IPv4-mapped IPv6 用 Unmap 归一，使映射形式能匹配普通 IPv4 规则
//   - 去重 + sort.Strings，写入幂等、列表稳定
//
// 错误统一是人话，由 handler 映射为 400 E_INVALID；不回显 token 内容。
func normalizeTokenCIDRs(input []string) ([]string, error) {
	if len(input) == 0 {
		return nil, nil
	}
	if len(input) > tokenCIDRMaxEntries {
		return nil, fmt.Errorf("来源网段最多 %d 条，请合并后重试", tokenCIDRMaxEntries)
	}
	const formatHint = "请写成 192.168.1.0/24 或 203.0.113.7 这样的形式，最多 16 条"
	seen := make(map[string]bool, len(input))
	out := make([]string, 0, len(input))
	for _, raw := range input {
		s := strings.TrimSpace(raw)
		if s == "" {
			return nil, fmt.Errorf("来源网段不能留空；不需要限制就不要填写（%s）", formatHint)
		}
		if len(s) > tokenCIDRMaxBytes {
			return nil, fmt.Errorf("单条来源网段不能超过 %d 字节（%s）", tokenCIDRMaxBytes, formatHint)
		}
		// zone 必须在 PrefixFrom 之前查：PrefixFrom 会丢掉 Addr 的 zone，
		// 之后再看 prefix.Addr().Zone() 就永远为空，fe80::1%eth0 会被静默收下。
		zoneErr := func() error {
			return fmt.Errorf("来源网段不能带网卡区域（如 fe80::1%%eth0），请去掉 %% 后面的部分（%s）", formatHint)
		}
		var prefix netip.Prefix
		if strings.Contains(s, "/") {
			parsed, err := netip.ParsePrefix(s)
			if err != nil {
				return nil, fmt.Errorf("来源网段格式不对，%s", formatHint)
			}
			if parsed.Addr().Zone() != "" {
				return nil, zoneErr()
			}
			prefix = parsed.Masked()
		} else {
			addr, err := netip.ParseAddr(s)
			if err != nil {
				return nil, fmt.Errorf("来源网段格式不对，%s", formatHint)
			}
			if addr.Zone() != "" {
				return nil, zoneErr()
			}
			bits := addr.BitLen()
			prefix = netip.PrefixFrom(addr, bits)
		}
		if prefix.Bits() == 0 {
			return nil, errors.New("不能把来源网段设为全部网络，这样等于没有限制")
		}
		if prefix.Addr().Is4In6() {
			// ::ffff:192.0.2.0/120 → 192.0.2.0/24；掩码位数同步减 96。
			bits := prefix.Bits() - 96
			if bits < 0 {
				return nil, fmt.Errorf("来源网段格式不对，%s", formatHint)
			}
			prefix = netip.PrefixFrom(prefix.Addr().Unmap(), bits).Masked()
		}
		canonical := prefix.String()
		if !seen[canonical] {
			seen[canonical] = true
			out = append(out, canonical)
		}
	}
	sort.Strings(out)
	return out, nil
}

// --- API token ---

// CreateToken 生成无来源绑定的 API token（既有调用方零改动）。
func (sec *Security) CreateToken(name, scope string, ttl time.Duration) (string, APITokenRecord, error) {
	return sec.CreateTokenWithCIDRs(name, scope, ttl, nil)
}

// CreateTokenWithCIDRs 生成可撤销的 API token：明文（kore_ 前缀 + base64url）只返回一次，
// 库中只存 sha256。scope 取 read（只读请求）或 admin（全部请求）；allowedCIDRs 为空
// 表示不限制（与存量 token 兼容），非空经 normalizeTokenCIDRs 归一后随记录落库。
func (sec *Security) CreateTokenWithCIDRs(name, scope string, ttl time.Duration, allowedCIDRs []string) (string, APITokenRecord, error) {
	if sec == nil {
		return "", APITokenRecord{}, ErrSecurityUnavailable
	}
	cidrs, err := normalizeTokenCIDRs(allowedCIDRs)
	if err != nil {
		return "", APITokenRecord{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > tokenNameMax {
		return "", APITokenRecord{}, fmt.Errorf("名称需 1–%d 个字符", tokenNameMax)
	}
	if scope != "read" && scope != "admin" {
		return "", APITokenRecord{}, errors.New("权限范围只能是 read 或 admin")
	}
	if ttl <= 0 {
		ttl = tokenDefaultTTL
	}
	if ttl > tokenMaxTTL {
		ttl = tokenMaxTTL
	}
	raw := make([]byte, tokenSecretBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", APITokenRecord{}, fmt.Errorf("生成令牌失败: %w", err)
	}
	plain := tokenValuePrefix + base64.RawURLEncoding.EncodeToString(raw)
	idRaw := make([]byte, tokenIDBytes)
	if _, err := rand.Read(idRaw); err != nil {
		return "", APITokenRecord{}, fmt.Errorf("生成令牌编号失败: %w", err)
	}
	now := time.Now().UTC()
	record := APITokenRecord{
		ID:           hex.EncodeToString(idRaw),
		Name:         name,
		Hash:         sha256Hex(plain),
		Scope:        scope,
		CreatedAt:    now.Format(time.RFC3339),
		ExpiresAt:    now.Add(ttl).Format(time.RFC3339),
		AllowedCIDRs: cidrs,
	}
	data, err := json.Marshal(record)
	if err != nil {
		return "", APITokenRecord{}, err
	}
	if err := sec.store.Update(func(tx *store.Tx) error {
		return tx.Put(securityBucket, tokenKeyPrefix+record.ID, data)
	}); err != nil {
		return "", APITokenRecord{}, fmt.Errorf("保存令牌失败: %w", err)
	}
	return plain, record, nil
}

// ListTokens 返回令牌元数据（按创建时间排序，永远不带 hash/明文）。
func (sec *Security) ListTokens() ([]TokenView, error) {
	if sec == nil {
		return nil, ErrSecurityUnavailable
	}
	out := []TokenView{}
	err := sec.store.View(func(tx *store.Tx) error {
		return tx.ForEach(securityBucket, func(k, v []byte) error {
			if !strings.HasPrefix(string(k), tokenKeyPrefix) {
				return nil
			}
			var rec APITokenRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				return fmt.Errorf("令牌记录损坏: %w", err)
			}
			out = append(out, TokenView{ID: rec.ID, Name: rec.Name, Scope: rec.Scope,
				CreatedAt: rec.CreatedAt, ExpiresAt: rec.ExpiresAt, LastUsedAt: rec.LastUsedAt,
				AllowedCIDRs: rec.AllowedCIDRs})
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

// RevokeToken 按 id 吊销令牌；不存在的 id 幂等成功。
func (sec *Security) RevokeToken(id string) error {
	if sec == nil {
		return ErrSecurityUnavailable
	}
	if id == "" || strings.ContainsAny(id, "/\\.") || len(id) > 64 {
		return errors.New("令牌编号不合法")
	}
	return sec.store.Update(func(tx *store.Tx) error {
		return tx.Delete(securityBucket, tokenKeyPrefix+id)
	})
}

// UpdateTokenCIDRs 就地改一个 token 的来源绑定，三态由调用方表达：
// cidrs == nil（请求体缺省）→ 不改；*cidrs 为空切片 → 清除绑定；非空 → 归一后替换。
// 在一个事务内读改写整条记录（ValidateToken 的 LastUsedAt 写回同形），无缓存，
// 下一次 Bearer 请求即可见。id 不存在、id 不合法、CIDR 非法均返回错误。
func (sec *Security) UpdateTokenCIDRs(id string, cidrs *[]string) (TokenView, error) {
	if sec == nil {
		return TokenView{}, ErrSecurityUnavailable
	}
	if id == "" || strings.ContainsAny(id, "/\\.") || len(id) > 64 {
		return TokenView{}, errors.New("令牌编号不合法")
	}
	var normalized []string
	if cidrs != nil {
		var err error
		normalized, err = normalizeTokenCIDRs(*cidrs)
		if err != nil {
			return TokenView{}, err
		}
	}
	var view TokenView
	err := sec.store.Update(func(tx *store.Tx) error {
		key := tokenKeyPrefix + id
		raw, err := tx.Get(securityBucket, key)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return errors.New("令牌不存在")
			}
			return err
		}
		var rec APITokenRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			return fmt.Errorf("令牌记录损坏: %w", err)
		}
		if cidrs != nil {
			rec.AllowedCIDRs = normalized
		}
		data, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		if err := tx.Put(securityBucket, key, data); err != nil {
			return err
		}
		view = TokenView{ID: rec.ID, Name: rec.Name, Scope: rec.Scope,
			CreatedAt: rec.CreatedAt, ExpiresAt: rec.ExpiresAt, LastUsedAt: rec.LastUsedAt,
			AllowedCIDRs: rec.AllowedCIDRs}
		return nil
	})
	return view, err
}

// ValidateToken 校验 API token：哈希比对走常量时间，过期/不存在一律无效。
// last_used 每 24 小时最多写一次盘，避免每个请求一次 fsync（G-03 性能）。
func (sec *Security) ValidateToken(plain string) (APITokenRecord, bool, error) {
	if sec == nil || !strings.HasPrefix(plain, tokenValuePrefix) {
		return APITokenRecord{}, false, nil
	}
	hash := sha256Hex(plain)
	var found APITokenRecord
	err := sec.store.View(func(tx *store.Tx) error {
		return tx.ForEach(securityBucket, func(k, v []byte) error {
			if !strings.HasPrefix(string(k), tokenKeyPrefix) {
				return nil
			}
			var rec APITokenRecord
			if err := json.Unmarshal(v, &rec); err != nil {
				return nil
			}
			if subtle.ConstantTimeCompare([]byte(rec.Hash), []byte(hash)) == 1 {
				found = rec
			}
			return nil
		})
	})
	if err != nil || found.ID == "" {
		return APITokenRecord{}, false, err
	}
	if expiry, err := time.Parse(time.RFC3339, found.ExpiresAt); err == nil && !time.Now().UTC().Before(expiry) {
		return APITokenRecord{}, false, nil
	}
	now := time.Now().UTC()
	stale := true
	if last, err := time.Parse(time.RFC3339, found.LastUsedAt); err == nil {
		stale = now.Sub(last) >= tokenLastUsedThrottle
	}
	if stale {
		found.LastUsedAt = now.Format(time.RFC3339)
		data, err := json.Marshal(found)
		if err != nil {
			return found, true, nil
		}
		_ = sec.store.Update(func(tx *store.Tx) error {
			return tx.Put(securityBucket, tokenKeyPrefix+found.ID, data)
		})
	}
	return found, true, nil
}

// --- 内部工具 ---

func (sec *Security) loadKey(key string, target any) error {
	var raw []byte
	if err := sec.store.View(func(tx *store.Tx) error {
		var err error
		raw, err = tx.Get(securityBucket, key)
		return err
	}); err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}

func (sec *Security) loadTOTP() (TOTPState, error) {
	var st TOTPState
	err := sec.loadKey(totpStateKey, &st)
	return st, err
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// binaryPutUint64 / binaryBigEndianUint32 用本地位运算，语义与 binary.BigEndian 一致（TOTP 计数器大端）。
func binaryPutUint64(dst []byte, v uint64) {
	for i := 7; i >= 0; i-- {
		dst[i] = byte(v)
		v >>= 8
	}
}

func binaryBigEndianUint32(b []byte) uint32 {
	return uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
}
