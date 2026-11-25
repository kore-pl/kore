package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// 会话 cookie 与存储常量。
const (
	// CookieName 是会话 cookie 名。
	CookieName = "kore_session"
	// sessionsBucket 是 sessions bucket 名（与 store 包约定一致）。
	sessionsBucket = "sessions"
	// DefaultTTL 是默认会话时长：7 天（ADR-0041）。面板是运维工具，不是网银——
	// 12h 固定过期会让运维每天重登一次，这正是"每次都要输密码"的直接来源之一。
	DefaultTTL = 7 * 24 * time.Hour
	// AbsoluteTTL 是会话绝对上限：30 天。滑动只能在这个窗口内往后推，
	// 到点必须重新登录，不允许"只要一直用就永不过期"。
	AbsoluteTTL = 30 * 24 * time.Hour
	// slideRenewCap 是滑动续期阈值的历史上限：24h。剩余寿命 < 阈值时写回 expiry
	// 并重发 cookie；每次续期都写一次 bbolt（一次 fsync），所以阈值不能是 0，
	// 否则退化成每个请求都写盘。
	slideRenewCap = 24 * time.Hour
	// passwordFingerprintKey 是口令指纹在 sessions bucket 内的保留键
	// （不是 token：token 键恒为 64 位 sha256 hex）。用于启动时判断"口令是否被改过"。
	passwordFingerprintKey = "password-fingerprint"
	// sessionTouchInterval 是"最后活跃"写库阈值：同一会话最多每 5 分钟写一次
	// lastSeen，避免每个请求都 fsync（G-19 空闲/写放大）。界面按"约 5 分钟内"
	// 粒度展示最后活跃时间。
	sessionTouchInterval = 5 * time.Minute
	// sessionUserAgentMax 是会话来源 UA 的保留字符数（按 rune 截断，与审计口径一致）。
	sessionUserAgentMax = 100
	// sessionIDLen 是对外暴露的会话 id 长度（tokenHash 前缀，64 位 hex 截取）。
	// 16 个 hex = 64 bit，碰撞概率可忽略；截断值无法反推完整 hash，更无法反推 token。
	sessionIDLen = 16
)

// Session 是一次已签发会话的只读视图（不含明文 token）。
type Session struct {
	// TokenHash 是 token 的 sha256 hex，即 store key。
	TokenHash string
	// ExpiresAt 是会话过期时刻（UTC），已按绝对上限收敛。
	ExpiresAt time.Time
	// CreatedAt 是首次签发时刻（UTC）；滑动续期不改它，绝对上限由它算。
	CreatedAt time.Time
	// LastSeenAt 是最后一次观察到该会话活跃的时刻（约 5 分钟粒度，UTC）。
	LastSeenAt time.Time
	// IP 是签发/最近活跃时的来源 IP（会话列表展示用；不落日志、不进审计）。
	IP string
	// UserAgent 是签发时的来源 UA 摘要（按 rune 截断到 sessionUserAgentMax）。
	UserAgent string
}

// SessionMeta 是签发会话时记录的环境信息（来源 IP 与 UA 摘要）。
type SessionMeta struct {
	// IP 是来源 IP（可空；空表示未知，不覆盖已有值）。
	IP string
	// UserAgent 是来源 UA（可空；按 rune 截断）。
	UserAgent string
}

// ID 返回会话的对外标识：tokenHash 的前 sessionIDLen 个 hex。
// 只用于列表展示与"踢下线"定位，不是凭据——无法反推 token 或 hash。
func (s Session) ID() string {
	if len(s.TokenHash) <= sessionIDLen {
		return s.TokenHash
	}
	return s.TokenHash[:sessionIDLen]
}

// sessionRecord 是 sessions bucket 中的存储视图（一个 token 一行）。
type sessionRecord struct {
	Expiry     time.Time
	Created    time.Time
	LastSeen   time.Time
	IP         string
	UserAgent  string
}

// Manager 负责口令校验与会话签发、校验、滑动续期、吊销，只依赖 store。
type Manager struct {
	store *store.Store
	// security 是登录安全增强（TOTP / IP 白名单 / API token）的存储门面。
	// 与 store 同源；nil 表示未装配（骨架/测试），三项增强均按"未开启"处理。
	security *Security
	// hashMu 保护 passwordHash 的运行期改写：改口令端点写、登录 Verify 读，
	// 二者并发时不产生数据竞争（G-19/-race 门禁）。
	hashMu       sync.RWMutex
	passwordHash string
	// mustChange 是单管理员一次性状态机（ADR-0055）：true 表示当前口令是
	// 安装期/CLI 重置生成的初始口令，首登后必须改密才能用其它管理端点。
	// 与 passwordHash 同锁保护，SetPasswordHash / SetMustChange / ApplyCredentialSnapshot
	// 并发写不产生数据竞争（G-19 / -race 门禁）。
	mustChange bool
	ttl        time.Duration
	// cookiePolicy 取 auto / true / false（auth.cookie_secure 原值）。
	// auto 需要请求上下文（TLS 或反代声明的 X-Forwarded-Proto），因此
	// 不在构造期把"是否 Secure"固化成一个 bool——那正是 P1 的根因。
	cookiePolicy string
	// slideWrites 记录 Slide 实际写库次数；仅供测试观测写放大，生产路径不读。
	slideWrites atomic.Int64
}

// auth.cookie_secure 的三个取值（文档见 docs/DATA-MODEL.md §3）。
const (
	// CookiePolicyAuto 按每个请求的传输方式判定是否加 Secure（默认）。
	CookiePolicyAuto = "auto"
	// CookiePolicyTrue 恒加 Secure（经纯 HTTP 访问会登不上，属显式选择）。
	CookiePolicyTrue = "true"
	// CookiePolicyFalse 恒不加 Secure（显式退出保护）。
	CookiePolicyFalse = "false"
)

// NewManager 构造会话管理器；ttl<=0 时取 DefaultTTL。
// passwordHash 为空时 Verify 一律失败（拒绝空口令登录）。
// secure 只表达"恒加 / 恒不加"；需要按传输自动判定的生产路径用 NewManagerWithPolicy。
func NewManager(s *store.Store, passwordHash string, ttl time.Duration, secure bool) *Manager {
	policy := CookiePolicyFalse
	if secure {
		policy = CookiePolicyTrue
	}
	return NewManagerWithPolicy(s, passwordHash, ttl, policy)
}

// NewManagerWithPolicy 构造会话管理器，按 auth.cookie_secure 三值语义下发 cookie。
// policy 非法时退回 auto（默认值，且不会静默关掉保护）。
func NewManagerWithPolicy(s *store.Store, passwordHash string, ttl time.Duration, policy string) *Manager {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	switch policy {
	case CookiePolicyAuto, CookiePolicyTrue, CookiePolicyFalse:
	default:
		policy = CookiePolicyAuto
	}
	return &Manager{store: s, security: NewSecurity(s), passwordHash: passwordHash, ttl: ttl, cookiePolicy: policy}
}

// CookieSecure 返回本次请求的 cookie 是否应带 Secure 属性。
//
// auto 的判据（按可信度从强到弱）：
//  1. r.TLS != nil：直连 TLS。当前 server.tls 被配置层拒绝（固定由反代终结），
//     保留该分支是为了将来内核自己终结 TLS 时不用改这里。
//  2. 对端是本机通道（UDS / loopback TCP）且 X-Forwarded-Proto 声明 https：
//     内核只监听 UDS 与 127.0.0.1，HTTPS 必然由同机反向代理终结并把 scheme
//     透传进来；非本机对端的转发头不采信（攻破 socket 权限的本地进程本来就能
//     直接读 state.db，不构成新的信任边界）。
//
// 注意 X-Forwarded-Proto 只能**加**Secure 不能**减**：请求本身是 TLS 时，
// 伪造 "http" 也不会把 Secure 拿掉（见 cookie_secure_test.go 的反例用例）。
// 伪造 "https" 的最坏后果是浏览器拒绝在纯 HTTP 回传 cookie → 自己登不上，
// 属 fail-secure 方向，不会泄漏会话。
func (m *Manager) CookieSecure(r *http.Request) bool {
	switch m.cookiePolicy {
	case CookiePolicyTrue:
		return true
	case CookiePolicyFalse:
		return false
	}
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	if !isLocalPeer(r.RemoteAddr) {
		return false
	}
	return forwardedHTTPS(r)
}

// isLocalPeer 判定对端是否本机通道：UDS 的 RemoteAddr 为 "@"（Linux 抽象命名
// 空间）或空；TCP 则要求源地址是回环。
func isLocalPeer(remoteAddr string) bool {
	if remoteAddr == "" || strings.HasPrefix(remoteAddr, "@") {
		return true
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// forwardedHTTPS 读取 X-Forwarded-Proto 的第一个值（反代链最左端是客户端侧
// 的原始 scheme），大小写不敏感。
func forwardedHTTPS(r *http.Request) bool {
	raw := r.Header.Get("X-Forwarded-Proto")
	if raw == "" {
		return false
	}
	first, _, _ := strings.Cut(raw, ",")
	return strings.EqualFold(strings.TrimSpace(first), "https")
}

// TTL 返回当前生效的会话时长（配置显式值或默认 7 天）。
func (m *Manager) TTL() time.Duration { return m.ttl }

// Verify 校验明文口令是否匹配配置的 PBKDF2 哈希；hash 为空直接拒绝。
func (m *Manager) Verify(password string) (bool, error) {
	m.hashMu.RLock()
	hash := m.passwordHash
	m.hashMu.RUnlock()
	if hash == "" {
		return false, nil
	}
	return VerifyPassword(hash, password)
}

// SetPasswordHash 在运行期替换口令哈希（在线改口令端点写回成功后调用）。
//
// 只更新内存中的校验基准；持久化 auth.admin_password_hash 由调用方（cmd 装配层
// 注入的 PasswordWriter）负责，本包不 import config / cmd（G-01 薄壳）。
// 调用方须先确认 hash 合法（auth.ValidateHash），避免把 Manager 锁进无法登录的状态。
func (m *Manager) SetPasswordHash(hash string) {
	m.hashMu.Lock()
	m.passwordHash = hash
	m.hashMu.Unlock()
}

// MustChange 报告当前是否处于首登改密提示状态（ADR-0055）。
// must_change 为非阻断提示标记，登录后全部功能可用；改密为可选，不是访问闸门。
func (m *Manager) MustChange() bool {
	m.hashMu.RLock()
	defer m.hashMu.RUnlock()
	return m.mustChange
}

// SetMustChange 设置一次性改密标志（在线改密成功后清标志用）。
func (m *Manager) SetMustChange(v bool) {
	m.hashMu.Lock()
	m.mustChange = v
	m.hashMu.Unlock()
}

// ApplyCredentialSnapshot 原子应用配置快照里的新哈希与 must_change 标志。
// 只有任一字段真的变化时才返回 true，调用方据此决定是否吊销会话——
// SIGHUP 每次都会调用它，不能因为一次「无变化」的热更把全员踢下线。
//
// 这里只改内存；持久化由调用方（cmd 装配层）负责（G-01 薄壳不 import config）。
func (m *Manager) ApplyCredentialSnapshot(hash string, mustChange bool) bool {
	m.hashMu.Lock()
	defer m.hashMu.Unlock()
	changed := m.passwordHash != hash || m.mustChange != mustChange
	if changed {
		m.passwordHash = hash
		m.mustChange = mustChange
	}
	return changed
}

// Issue 生成 32 字节随机 token（base64url），把 sha256(token) 与过期时刻写入 sessions。
// 不带来源信息的签发（测试 / 内部装配）；登录路径用 IssueWithMeta 记录 IP 与 UA。
func (m *Manager) Issue() (string, Session, error) {
	return m.IssueWithMeta(SessionMeta{})
}

// IssueWithMeta 与 Issue 相同，但把来源 IP 与 UA 摘要一并落库，供「账户与安全中心」
// 的会话列表展示（登录时间 / 来源 IP / UA 摘要 / 最后活跃）。
//
// 存储值形如 "<expiryNano> <createdNano> <lastSeenNano> <b64ip> <b64ua>"；
// 旧格式（单个整数或两个整数）仍可读——解析时按 ttl 反推 created、meta 置空，
// 不破坏升级前的会话，也不因新增字段把老用户踢下线。
func (m *Manager) IssueWithMeta(meta SessionMeta) (string, Session, error) {
	token, err := newToken()
	if err != nil {
		return "", Session{}, err
	}
	hash := tokenHash(token)
	now := time.Now().UTC()
	created := now
	expiry := now.Add(m.ttl)
	if hard := created.Add(AbsoluteTTL); expiry.After(hard) {
		expiry = hard
	}
	rec := sessionRecord{
		Expiry: expiry, Created: created, LastSeen: now,
		IP: strings.TrimSpace(meta.IP), UserAgent: truncateSessionUA(meta.UserAgent),
	}
	if err := m.writeSession(hash, rec); err != nil {
		return "", Session{}, fmt.Errorf("写入会话失败: %w", err)
	}
	return token, rec.session(hash), nil
}

// writeSession 把整条会话记录写回 sessions。
func (m *Manager) writeSession(hash string, rec sessionRecord) error {
	return m.store.Update(func(tx *store.Tx) error {
		return tx.Put(sessionsBucket, hash, encodeSessionRecord(rec))
	})
}

// writeExpiry 只改写过期时刻与创建时刻，保留已有的来源 IP / UA / 最后活跃
// （滑动续期路径用；meta 缺失时按零值写回，不伪造来源）。
func (m *Manager) writeExpiry(hash string, expiry, created time.Time) error {
	rec := sessionRecord{Expiry: expiry, Created: created}
	if existing, ok := m.readSession(hash); ok {
		rec.LastSeen = existing.LastSeen
		rec.IP = existing.IP
		rec.UserAgent = existing.UserAgent
	}
	return m.writeSession(hash, rec)
}

// readSession 读取单条会话记录的原始形态；不存在或格式非法时 ok=false。
func (m *Manager) readSession(hash string) (sessionRecord, bool) {
	var raw []byte
	if err := m.store.View(func(tx *store.Tx) error {
		var err error
		raw, err = tx.Get(sessionsBucket, hash)
		return err
	}); err != nil {
		return sessionRecord{}, false
	}
	return parseSessionRecord(string(raw), m.ttl)
}

// Validate 校验 token：命中 sessions、未过期、且未越过绝对上限才返回会话。
func (m *Manager) Validate(token string) (Session, error) {
	if token == "" {
		return Session{}, ErrNoSession
	}
	hash := tokenHash(token)
	rec, ok := m.readSession(hash)
	if !ok {
		return Session{}, ErrNoSession
	}
	now := time.Now().UTC()
	hard := rec.Created.Add(AbsoluteTTL)
	if !now.Before(rec.Expiry) || !now.Before(hard) {
		return Session{}, ErrNoSession
	}
	if hard.Before(rec.Expiry) {
		rec.Expiry = hard
	}
	return rec.session(hash), nil
}

// session 把存储记录转成只读视图。
func (rec sessionRecord) session(hash string) Session {
	return Session{
		TokenHash: hash, ExpiresAt: rec.Expiry, CreatedAt: rec.Created,
		LastSeenAt: rec.LastSeen, IP: rec.IP, UserAgent: rec.UserAgent,
	}
}

// encodeSessionRecord 把记录编码成存储值：五个空格分隔字段，IP/UA 走 base64url
// （不会含空格，也不引入新的转义规则）。
func encodeSessionRecord(rec sessionRecord) []byte {
	parts := []string{
		strconv.FormatInt(rec.Expiry.UnixNano(), 10),
		strconv.FormatInt(rec.Created.UnixNano(), 10),
		strconv.FormatInt(rec.LastSeen.UnixNano(), 10),
		encodeSessionField(rec.IP),
		encodeSessionField(rec.UserAgent),
	}
	return []byte(strings.Join(parts, " "))
}

// parseSessionRecord 解析存储值，兼容三种历史形态：
//   - "<expiry>"：最旧格式，无 created / meta；
//   - "<expiry> <created>"：R? 之后格式，无 meta；
//   - "<expiry> <created> <lastSeen> <b64ip> <b64ua>"：当前格式。
func parseSessionRecord(raw string, ttl time.Duration) (sessionRecord, bool) {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return sessionRecord{}, false
	}
	expNano, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return sessionRecord{}, false
	}
	rec := sessionRecord{Expiry: time.Unix(0, expNano).UTC()}
	if len(fields) == 1 {
		// 旧格式：没有 created，按 ttl 反推（绝对上限从旧会话签发时起算）。
		rec.Created = rec.Expiry.Add(-ttl)
		rec.LastSeen = rec.Created
		return rec, true
	}
	createdNano, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return sessionRecord{}, false
	}
	rec.Created = time.Unix(0, createdNano).UTC()
	rec.LastSeen = rec.Created
	// 当前格式从第 3 个字段起是 lastSeen / IP / UA；UA 可能缺（老记录），
	// 所以按"有就读、没有就空"处理，而不是要求恰好 5 个字段。
	if len(fields) >= 4 {
		if seenNano, err := strconv.ParseInt(fields[2], 10, 64); err == nil && seenNano > 0 {
			rec.LastSeen = time.Unix(0, seenNano).UTC()
		}
		rec.IP = decodeSessionField(fields[3])
		if len(fields) >= 5 {
			rec.UserAgent = decodeSessionField(fields[4])
		}
	}
	return rec, true
}

// sessionFieldEmpty 是空字段的占位符：base64 编码空串也是空串，会与分隔空格一起
// 被 strings.Fields 吃掉，导致后面的字段错位——所以空值必须写成非空占位。
const sessionFieldEmpty = "-"

// encodeSessionField 编码单个会话字段；空串写成占位符 "-"（不是合法 base64）。
func encodeSessionField(raw string) string {
	if raw == "" {
		return sessionFieldEmpty
	}
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// decodeSessionField 解码 base64url 字段；占位符与非法值都按空串处理
// （不因坏字段拒绝会话，最坏只是会话列表少显示一个来源信息）。
func decodeSessionField(raw string) string {
	if raw == "" || raw == sessionFieldEmpty {
		return ""
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return ""
	}
	return string(decoded)
}

// truncateSessionUA 按 rune 截断 UA 到 sessionUserAgentMax，避免单条记录撑大状态库。
func truncateSessionUA(ua string) string {
	ua = strings.TrimSpace(ua)
	runes := []rune(ua)
	if len(runes) > sessionUserAgentMax {
		runes = runes[:sessionUserAgentMax]
	}
	return string(runes)
}

// Slide 做滑动续期：剩余寿命 < slideThresholdFor(TTL) 时把过期时刻推到
// now+TTL（不超过绝对上限），返回续期后的会话与是否发生续期；调用方据此后
// 重发 Set-Cookie。已到绝对上限、或续期后并不更晚（ttl 很短）时返回
// renewed=false，不写库。
func (m *Manager) Slide(sess Session) (Session, bool, error) {
	now := time.Now().UTC()
	hard := sess.CreatedAt.Add(AbsoluteTTL)
	if !now.Before(hard) {
		return sess, false, nil
	}
	threshold := slideThresholdFor(m.ttl)
	if sess.ExpiresAt.Sub(now) >= threshold {
		return sess, false, nil
	}
	next := now.Add(m.ttl)
	if hard.Before(next) {
		next = hard
	}
	if !next.After(sess.ExpiresAt) {
		return sess, false, nil
	}
	if err := m.writeExpiry(sess.TokenHash, next, sess.CreatedAt); err != nil {
		return sess, false, fmt.Errorf("会话续期写库失败: %w", err)
	}
	m.slideWrites.Add(1)
	return Session{TokenHash: sess.TokenHash, ExpiresAt: next, CreatedAt: sess.CreatedAt}, true, nil
}

// slideThresholdFor 返回给定 TTL 下的滑动续期阈值：min(24h, ttl/2)。
//
// 固定 24h 只在 TTL >= 48h 时成立（默认 7d 仍保持"每天最多写一次"，与 ADR-0041
// 一致）。一旦 TTL 被配置得比 48h 更短（例如面板推荐的 12h），"剩余寿命 < 24h"
// 永远为真，阈值退化成"每次鉴权都写一次 bbolt"——每次请求一次 fsync 的写放大。
// 取 ttl/2 后，同一会话相邻两次续期至少间隔 ttl/2：
//
//	ttl=7d  → 24h（与旧固定阈值行为一致）
//	ttl=12h → 6h（每天最多 2 次写盘）
//	ttl=1h  → 30m
//
// 到期失效与 created+30d 绝对上限都不受阈值影响（Validate 独立判定）。
func slideThresholdFor(ttl time.Duration) time.Duration {
	half := ttl / 2
	if half <= 0 || half > slideRenewCap {
		return slideRenewCap
	}
	return half
}

// slideWriteCount 返回 Slide 实际写库次数（测试观测写放大用）。
func (m *Manager) slideWriteCount() int64 { return m.slideWrites.Load() }

// Touch 记录会话的"最后活跃"与来源 IP / UA，写库按 sessionTouchInterval 节流：
// 同一会话 5 分钟内只写一次，避免每个请求一次 fsync（G-19 写放大）。
//
// 传空 IP/UA 时保留旧值（内部调用 / 无来源信息的场景不覆盖已有值）；
// 已过期或越过绝对上限的会话不写（下一次 Validate 自会失效）。
// 返回更新后的会话视图与是否发生写库。
func (m *Manager) Touch(sess Session, ip, ua string) (Session, bool, error) {
	if sess.TokenHash == "" {
		return sess, false, nil
	}
	now := time.Now().UTC()
	if !now.Before(sess.CreatedAt.Add(AbsoluteTTL)) || !now.Before(sess.ExpiresAt) {
		return sess, false, nil
	}
	nextIP, nextUA := strings.TrimSpace(ip), truncateSessionUA(ua)
	if nextIP == "" {
		nextIP = sess.IP
	}
	if nextUA == "" {
		nextUA = sess.UserAgent
	}
	sameMeta := nextIP == sess.IP && nextUA == sess.UserAgent
	if sameMeta && !sess.LastSeenAt.IsZero() && now.Sub(sess.LastSeenAt) < sessionTouchInterval {
		return sess, false, nil
	}
	rec := sessionRecord{
		Expiry: sess.ExpiresAt, Created: sess.CreatedAt, LastSeen: now,
		IP: nextIP, UserAgent: nextUA,
	}
	if err := m.writeSession(sess.TokenHash, rec); err != nil {
		return sess, false, fmt.Errorf("更新会话活跃时间失败: %w", err)
	}
	sess.LastSeenAt = now
	sess.IP, sess.UserAgent = nextIP, nextUA
	return sess, true, nil
}

// ListSessions 列出全部仍然有效的会话（按签发时间倒序），供「账户与安全中心」的
// 会话管理表使用。已过期或越过绝对上限的会话不返回（它们下一次请求就会失效）。
//
// 返回不含明文 token，也不含完整 token hash——只给 Session.ID() 前缀。
func (m *Manager) ListSessions() ([]Session, error) {
	var out []Session
	now := time.Now().UTC()
	if err := m.store.View(func(tx *store.Tx) error {
		return tx.ForEach(sessionsBucket, func(k, v []byte) error {
			key := string(k)
			if key == passwordFingerprintKey {
				return nil
			}
			rec, ok := parseSessionRecord(string(v), m.ttl)
			if !ok {
				return nil
			}
			if !now.Before(rec.Expiry) || !now.Before(rec.Created.Add(AbsoluteTTL)) {
				return nil
			}
			out = append(out, rec.session(key))
			return nil
		})
	}); err != nil {
		return nil, fmt.Errorf("列会话失败: %w", err)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// RevokeByID 按会话 id（Session.ID() 前缀）吊销单个会话；返回是否命中并删除。
// 前缀至少 8 个 hex（32 bit）才接受，避免过短前缀误删多个会话。
func (m *Manager) RevokeByID(id string) (bool, error) {
	id = strings.ToLower(strings.TrimSpace(id))
	if len(id) < 8 || len(id) > 64 || !isHex(id) {
		return false, fmt.Errorf("会话标识非法：需要 8-64 位十六进制字符")
	}
	keys, err := m.sessionKeys()
	if err != nil {
		return false, err
	}
	hit := ""
	for _, key := range keys {
		if key == id || strings.HasPrefix(key, id) {
			if hit != "" {
				return false, fmt.Errorf("会话标识不唯一，请刷新页面后重试")
			}
			hit = key
		}
	}
	if hit == "" {
		return false, nil
	}
	if err := m.store.Update(func(tx *store.Tx) error {
		return tx.Delete(sessionsBucket, hit)
	}); err != nil {
		return false, fmt.Errorf("吊销会话失败: %w", err)
	}
	return true, nil
}

// RevokeOthers 吊销除当前会话（keepToken）以外的全部会话，返回被踢掉的数量。
// 「一键全踢（踢自己除外）」用它——永远不会把正在操作的管理员自己踢下线。
func (m *Manager) RevokeOthers(keepToken string) (int, error) {
	keep := tokenHash(keepToken)
	keys, err := m.sessionKeys()
	if err != nil {
		return 0, err
	}
	targets := make([]string, 0, len(keys))
	for _, key := range keys {
		if key == keep {
			continue
		}
		targets = append(targets, key)
	}
	if len(targets) == 0 {
		return 0, nil
	}
	if err := m.store.Update(func(tx *store.Tx) error {
		for _, k := range targets {
			if err := tx.Delete(sessionsBucket, k); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return 0, fmt.Errorf("吊销其他会话失败: %w", err)
	}
	return len(targets), nil
}

// sessionKeys 列出 sessions bucket 中的全部会话键（排除口令指纹保留键）。
func (m *Manager) sessionKeys() ([]string, error) {
	var keys []string
	if err := m.store.View(func(tx *store.Tx) error {
		return tx.ForEach(sessionsBucket, func(k, _ []byte) error {
			key := string(k)
			if key == passwordFingerprintKey {
				return nil
			}
			keys = append(keys, key)
			return nil
		})
	}); err != nil {
		return nil, fmt.Errorf("列会话失败: %w", err)
	}
	return keys, nil
}

// isHex 判定字符串是否只含十六进制字符（会话 id 形态校验）。
func isHex(s string) bool {
	for _, ch := range s {
		switch {
		case ch >= '0' && ch <= '9', ch >= 'a' && ch <= 'f', ch >= 'A' && ch <= 'F':
		default:
			return false
		}
	}
	return true
}

// Revoke 删除会话；key 不存在时幂等成功。
func (m *Manager) Revoke(token string) error {
	if token == "" {
		return nil
	}
	return m.store.Update(func(tx *store.Tx) error {
		return tx.Delete(sessionsBucket, tokenHash(token))
	})
}

// RevokeAll 删除全部会话（改口令 / 显式"踢下线"用）：任何已签发 token 立即失效。
// 口令指纹键（passwordFingerprintKey）保留，否则下次启动会误判"口令被改过"。
func (m *Manager) RevokeAll() (int, error) {
	var keys []string
	if err := m.store.View(func(tx *store.Tx) error {
		return tx.ForEach(sessionsBucket, func(k, _ []byte) error {
			if string(k) == passwordFingerprintKey {
				return nil
			}
			keys = append(keys, string(k))
			return nil
		})
	}); err != nil {
		return 0, fmt.Errorf("列会话失败: %w", err)
	}
	if len(keys) == 0 {
		return 0, nil
	}
	if err := m.store.Update(func(tx *store.Tx) error {
		for _, k := range keys {
			if err := tx.Delete(sessionsBucket, k); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return 0, fmt.Errorf("吊销会话失败: %w", err)
	}
	return len(keys), nil
}

// ReconcilePasswordFingerprint 在启动时比对口令指纹：变了就吊销全部会话，返回是否吊销。
//
// 这让"改口令 → 全局失效"不依赖某个 CLI 记得调 RevokeAll：`kored admin-password set`
// 写的是配置里的哈希，进程（含重启后）第一次装配会话管理器时即可发现差异。
// 口令从未设置（hash 为空）时不写指纹、不吊销，避免首启 bootstrap 误杀。
func (m *Manager) ReconcilePasswordFingerprint() (bool, error) {
	if m.passwordHash == "" {
		return false, nil
	}
	sum := sha256.Sum256([]byte(m.passwordHash))
	fp := hex.EncodeToString(sum[:])
	var prev []byte
	// 键不存在是正常首启（不是错误）：store 用哨兵错误表达"没有这条"，
	// 这里按空指纹处理，真有 IO 故障会在下面的写入里暴露。
	if err := m.store.View(func(tx *store.Tx) error {
		var err error
		prev, err = tx.Get(sessionsBucket, passwordFingerprintKey)
		return err
	}); err != nil {
		prev = nil
	}
	if string(prev) == fp {
		return false, nil
	}
	revoked := false
	if len(prev) != 0 {
		if _, err := m.RevokeAll(); err != nil {
			return false, err
		}
		revoked = true
	}
	if err := m.store.Update(func(tx *store.Tx) error {
		return tx.Put(sessionsBucket, passwordFingerprintKey, []byte(fp))
	}); err != nil {
		return revoked, fmt.Errorf("写入口令指纹失败: %w", err)
	}
	if revoked {
		// 口令被面板以外的方式改过（CLI / 手改配置）：记"改过但强度未知"，
		// 供账户与安全中心如实展示。写失败不阻断启动（只是缺一条展示信息）。
		if metaErr := m.security.NotePasswordChangedExternally(time.Now().UTC()); metaErr != nil {
			return revoked, nil
		}
	}
	return revoked, nil
}

// SetCookie 把 token 写入 HttpOnly 会话 cookie（Max-Age 与 Expires 同步）。
// Secure 按本次请求的传输方式解析（cookie_secure=auto 时逐请求判定）。
func (m *Manager) SetCookie(w http.ResponseWriter, r *http.Request, token string) {
	now := time.Now()
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: token, Path: "/",
		HttpOnly: true, Secure: m.CookieSecure(r), SameSite: http.SameSiteStrictMode,
		MaxAge: int(m.ttl.Seconds()), Expires: now.Add(m.ttl),
	})
}

// ClearCookie 清除会话 cookie（MaxAge=-1）；Secure 与下发时使用同一判据，
// 否则浏览器可能留下一个清不掉的 cookie。
func (m *Manager) ClearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: "", Path: "/",
		HttpOnly: true, Secure: m.CookieSecure(r), SameSite: http.SameSiteStrictMode,
		MaxAge: -1,
	})
}

// newToken 生成 32 字节随机 token 并以 base64url（无 padding）编码。
func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成会话 token 失败: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// tokenHash 返回 token 的 sha256 hex（小写），明文 token 不落库。
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
