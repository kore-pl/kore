package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
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
	// slideThreshold 是滑动续期阈值：剩余寿命 < 24h 时写回 expiry 并重发 cookie。
	// 不在每个请求都写 bbolt（一次请求一次 fsync 是写放大），阈值内最多写一次。
	slideThreshold = 24 * time.Hour
	// passwordFingerprintKey 是口令指纹在 sessions bucket 内的保留键
	// （不是 token：token 键恒为 64 位 sha256 hex）。用于启动时判断"口令是否被改过"。
	passwordFingerprintKey = "password-fingerprint"
)

// Session 是一次已签发会话的只读视图（不含明文 token）。
type Session struct {
	// TokenHash 是 token 的 sha256 hex，即 store key。
	TokenHash string
	// ExpiresAt 是会话过期时刻（UTC），已按绝对上限收敛。
	ExpiresAt time.Time
	// CreatedAt 是首次签发时刻（UTC）；滑动续期不改它，绝对上限由它算。
	CreatedAt time.Time
}

// Manager 负责口令校验与会话签发、校验、滑动续期、吊销，只依赖 store。
type Manager struct {
	store        *store.Store
	passwordHash string
	ttl          time.Duration
	secure       bool
}

// NewManager 构造会话管理器；ttl<=0 时取 DefaultTTL。
// passwordHash 为空时 Verify 一律失败（拒绝空口令登录）。
func NewManager(s *store.Store, passwordHash string, ttl time.Duration, secure bool) *Manager {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Manager{store: s, passwordHash: passwordHash, ttl: ttl, secure: secure}
}

// TTL 返回当前生效的会话时长（配置显式值或默认 7 天）。
func (m *Manager) TTL() time.Duration { return m.ttl }

// Verify 校验明文口令是否匹配配置的 PBKDF2 哈希；hash 为空直接拒绝。
func (m *Manager) Verify(password string) (bool, error) {
	if m.passwordHash == "" {
		return false, nil
	}
	return VerifyPassword(m.passwordHash, password)
}

// Issue 生成 32 字节随机 token（base64url），把 sha256(token) 与过期时刻写入 sessions。
//
// value 形如 "<expiryUnixNano> <createdUnixNano>"；旧格式（单个整数，无 created）
// 仍可读——Validate 会按 ttl 反推 created，不破坏升级前的会话。
func (m *Manager) Issue() (string, Session, error) {
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
	if err := m.writeExpiry(hash, expiry, created); err != nil {
		return "", Session{}, fmt.Errorf("写入会话失败: %w", err)
	}
	return token, Session{TokenHash: hash, ExpiresAt: expiry, CreatedAt: created}, nil
}

// writeExpiry 把过期时刻与创建时刻写回 sessions。
func (m *Manager) writeExpiry(hash string, expiry, created time.Time) error {
	value := []byte(strconv.FormatInt(expiry.UnixNano(), 10) + " " + strconv.FormatInt(created.UnixNano(), 10))
	return m.store.Update(func(tx *store.Tx) error {
		return tx.Put(sessionsBucket, hash, value)
	})
}

// Validate 校验 token：命中 sessions、未过期、且未越过绝对上限才返回会话。
func (m *Manager) Validate(token string) (Session, error) {
	if token == "" {
		return Session{}, ErrNoSession
	}
	hash := tokenHash(token)
	var raw []byte
	if err := m.store.View(func(tx *store.Tx) error {
		var err error
		raw, err = tx.Get(sessionsBucket, hash)
		return err
	}); err != nil {
		return Session{}, ErrNoSession
	}
	expiry, created, ok := parseSessionValue(string(raw), m.ttl)
	if !ok {
		return Session{}, ErrNoSession
	}
	now := time.Now().UTC()
	hard := created.Add(AbsoluteTTL)
	if !now.Before(expiry) || !now.Before(hard) {
		return Session{}, ErrNoSession
	}
	if hard.Before(expiry) {
		expiry = hard
	}
	return Session{TokenHash: hash, ExpiresAt: expiry, CreatedAt: created}, nil
}

// parseSessionValue 解析存储值；兼容旧格式（单个 expiry 纳秒）。
func parseSessionValue(raw string, ttl time.Duration) (time.Time, time.Time, bool) {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return time.Time{}, time.Time{}, false
	}
	expNano, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	expiry := time.Unix(0, expNano).UTC()
	if len(fields) == 1 {
		// 旧格式：没有 created，按 ttl 反推（绝对上限从旧会话签发时起算）。
		return expiry, expiry.Add(-ttl), true
	}
	createdNano, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	return expiry, time.Unix(0, createdNano).UTC(), true
}

// Slide 做滑动续期：剩余寿命 < 24h 时把过期时刻推到 now+TTL（不超过绝对上限）。
// 返回续期后的会话与是否发生续期；调用方据此后重发 Set-Cookie。
// 已到绝对上限、或续期后并不更晚（ttl 很短）时返回 renewed=false，不写库。
func (m *Manager) Slide(sess Session) (Session, bool, error) {
	now := time.Now().UTC()
	hard := sess.CreatedAt.Add(AbsoluteTTL)
	if !now.Before(hard) {
		return sess, false, nil
	}
	if sess.ExpiresAt.Sub(now) >= slideThreshold {
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
	return Session{TokenHash: sess.TokenHash, ExpiresAt: next, CreatedAt: sess.CreatedAt}, true, nil
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
	return revoked, nil
}

// SetCookie 把 token 写入 HttpOnly 会话 cookie（Max-Age 与 Expires 同步）。
func (m *Manager) SetCookie(w http.ResponseWriter, token string) {
	now := time.Now()
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: token, Path: "/",
		HttpOnly: true, Secure: m.secure, SameSite: http.SameSiteStrictMode,
		MaxAge: int(m.ttl.Seconds()), Expires: now.Add(m.ttl),
	})
}

// ClearCookie 清除会话 cookie（MaxAge=-1）。
func (m *Manager) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: "", Path: "/",
		HttpOnly: true, Secure: m.secure, SameSite: http.SameSiteStrictMode,
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
