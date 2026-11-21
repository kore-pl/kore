package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// 会话 cookie 与存储常量。
const (
	// CookieName 是会话 cookie 名。
	CookieName = "kore_session"
	// sessionsBucket 是 sessions bucket 名（与 store 包约定一致）。
	sessionsBucket = "sessions"
	// DefaultTTL 是默认会话时长。
	DefaultTTL = 12 * time.Hour
)

// Session 是一次已签发会话的只读视图（不含明文 token）。
type Session struct {
	// TokenHash 是 token 的 sha256 hex，即 store key。
	TokenHash string
	// ExpiresAt 是会话过期时刻（UTC）。
	ExpiresAt time.Time
}

// Manager 负责口令校验与会话签发、校验、吊销，只依赖 store。
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

// Verify 校验明文口令是否匹配配置的 PBKDF2 哈希；hash 为空直接拒绝。
func (m *Manager) Verify(password string) (bool, error) {
	if m.passwordHash == "" {
		return false, nil
	}
	return VerifyPassword(m.passwordHash, password)
}

// Issue 生成 32 字节随机 token（base64url），把 sha256(token) 与过期时刻写入 sessions。
func (m *Manager) Issue() (string, Session, error) {
	token, err := newToken()
	if err != nil {
		return "", Session{}, err
	}
	hash := tokenHash(token)
	expiry := time.Now().UTC().Add(m.ttl)
	value := []byte(strconv.FormatInt(expiry.UnixNano(), 10))
	if err := m.store.Update(func(tx *store.Tx) error {
		return tx.Put(sessionsBucket, hash, value)
	}); err != nil {
		return "", Session{}, fmt.Errorf("写入会话失败: %w", err)
	}
	return token, Session{TokenHash: hash, ExpiresAt: expiry}, nil
}

// Validate 校验 token：命中 sessions 且未过期才返回会话。
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
	nano, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		return Session{}, ErrNoSession
	}
	expiry := time.Unix(0, nano).UTC()
	if !time.Now().Before(expiry) {
		return Session{}, ErrNoSession
	}
	return Session{TokenHash: hash, ExpiresAt: expiry}, nil
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

// SetCookie 把 token 写入 HttpOnly 会话 cookie。
func (m *Manager) SetCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: token, Path: "/",
		HttpOnly: true, Secure: m.secure, SameSite: http.SameSiteStrictMode,
		MaxAge: int(m.ttl.Seconds()),
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
