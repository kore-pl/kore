package privilege

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// DefaultConfirmTTL 是不可回滚动作确认令牌的有效期（ADR-0018：5 分钟）。
const DefaultConfirmTTL = 5 * time.Minute

// ConfirmGrant 是签发结果；ExpiresAt 用 UTC 秒级 RFC3339 供 HTTP 层直接序列化。
type ConfirmGrant struct {
	// Token 是一次性令牌。
	Token string `json:"token"`
	// PluginID / ActionID 是绑定关系（令牌只能用于这一对）。
	PluginID string `json:"plugin_id"`
	ActionID string `json:"action_id"`
	// Reason 是绑定的动作理由（ADR-0056：system.restart 令牌必须绑 reason）。
	// 普通 root-action 令牌为空；只在 IssueWithReason 时填充。
	Reason string `json:"reason,omitempty"`
	// ExpiresAt 是过期时间（RFC3339，UTC）。
	ExpiresAt time.Time `json:"-"`
}

type confirmEntry struct {
	pluginID  string
	actionID  string
	reasonSum string
	expiresAt time.Time
}

// ConfirmStore 是内存态一次性令牌表：进程重启即失效（不可回滚动作重新确认，
// 比持久化更安全；不落盘、不写 bbolt）。
type ConfirmStore struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time
	entries map[string]confirmEntry
}

// NewConfirmStore 构造令牌表；ttl<=0 时用 5 分钟默认值。
func NewConfirmStore(ttl time.Duration) *ConfirmStore {
	if ttl <= 0 {
		ttl = DefaultConfirmTTL
	}
	return &ConfirmStore{ttl: ttl, now: time.Now, entries: make(map[string]confirmEntry)}
}

// Issue 为 plugin+action 签发一次性令牌（32 字节随机 hex）。
func (c *ConfirmStore) Issue(pluginID, actionID string) (ConfirmGrant, error) {
	return c.issue(pluginID, actionID, "")
}

// IssueWithReason 签发额外绑定 reason 的一次性令牌（ADR-0056 system.restart）。
// reason 参与令牌校验：签发时的文本与消费时不一致即视为绑定失败，防止令牌被挪用于别的动作。
func (c *ConfirmStore) IssueWithReason(pluginID, actionID, reason string) (ConfirmGrant, error) {
	return c.issue(pluginID, actionID, reason)
}

// issue 是 Issue / IssueWithReason 的共用内核（reason 为空即普通 root-action 令牌）。
func (c *ConfirmStore) issue(pluginID, actionID, reason string) (ConfirmGrant, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return ConfirmGrant{}, errCode(pluginapi.E_INTERNAL, "生成确认令牌失败："+err.Error(), "")
	}
	token := hex.EncodeToString(buf[:])
	expires := c.now().Add(c.ttl)
	reasonSum := reasonDigest(reason)
	c.mu.Lock()
	c.entries[token] = confirmEntry{pluginID: pluginID, actionID: actionID, reasonSum: reasonSum, expiresAt: expires}
	c.sweepLocked()
	c.mu.Unlock()
	return ConfirmGrant{Token: token, PluginID: pluginID, ActionID: actionID, Reason: reason, ExpiresAt: expires}, nil
}

// Consume 校验并核销令牌：缺失 / 过期 / 绑定不匹配一律拒绝；成功即删除（用完即废）。
func (c *ConfirmStore) Consume(token, pluginID, actionID string) error {
	return c.consume(token, pluginID, actionID, "")
}

// ConsumeWithReason 额外校验 reason 绑定（ADR-0056 system.restart）。
func (c *ConfirmStore) ConsumeWithReason(token, pluginID, actionID, reason string) error {
	return c.consume(token, pluginID, actionID, reason)
}

// consume 是 Consume / ConsumeWithReason 的共用内核。
func (c *ConfirmStore) consume(token, pluginID, actionID, reason string) error {
	if token == "" {
		return errCode(pluginapi.E_UNAUTHORIZED, "不可回滚动作需要 confirm 令牌", "先调用 confirm-token 端点获取令牌，再带 confirm 执行")
	}
	c.mu.Lock()
	entry, ok := c.entries[token]
	if !ok {
		c.mu.Unlock()
		return errCode(pluginapi.E_UNAUTHORIZED, "confirm 令牌无效或已被使用", "重新获取一次性令牌")
	}
	if !c.now().Before(entry.expiresAt) {
		delete(c.entries, token)
		c.mu.Unlock()
		return errCode(pluginapi.E_UNAUTHORIZED, "confirm 令牌已过期", "重新获取一次性令牌（有效期 5 分钟）")
	}
	if entry.pluginID != pluginID || entry.actionID != actionID || entry.reasonSum != reasonDigest(reason) {
		c.mu.Unlock()
		return errCode(pluginapi.E_UNAUTHORIZED, "confirm 令牌与动作绑定不匹配", "令牌只能用于签发时的动作与理由")
	}
	delete(c.entries, token)
	c.mu.Unlock()
	return nil
}

// sweepLocked 清理过期条目，防止长期运行内存增长（调用方已持锁）。
func (c *ConfirmStore) sweepLocked() {
	now := c.now()
	for token, entry := range c.entries {
		if !now.Before(entry.expiresAt) {
			delete(c.entries, token)
		}
	}
}

// reasonDigest 把 reason 折成固定长度摘要，避免令牌表存任意长文本。
// 只用于内存绑定校验，不是安全哈希（令牌本身 32 字节随机）。
func reasonDigest(reason string) string {
	if reason == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(reason))
	return hex.EncodeToString(sum[:])
}
