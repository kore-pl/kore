// Package credential 是 ADR-0026 方案 A 的内核托管凭据库：凭据只落
// <install>/data/credentials/（目录 0700），元数据 index.json（0600，显式字段），
// 每条密钥 <id>.secret（0600，原子写）。读取只对 owner 或显式 grantee 放行，
// 越权返回 E_NEED_GRANT（ADR-0026 §3）；授权先写审计，审计失败则授权不生效。
//
// G-30：本包不写日志、不回显 secret；G-24：结构体字段全部显式。
package credential

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 错误码（ADR-0026 §3；E_AUDIT / E_NEED_GRANT 为本通道新增，不进插件 SDK 协议）。
const (
	// CodeNeedGrant 表示调用方既不是 owner 也没有显式授权。
	CodeNeedGrant = "E_NEED_GRANT"
	// CodeAudit 表示审计写入失败，操作按 fail-closed 拒绝。
	CodeAudit = "E_AUDIT"
)

// 审计事件名（camelCase，ADR-0026 §2）。
const (
	ActionGrant  = "credential.grant"
	ActionRevoke = "credential.revoke"
	ActionDelete = "credential.delete"
)

// ACL 上限（防清单膨胀）。
const (
	maxEntries    = 128
	maxGrantees   = 32
	maxSecretSize = 8 << 10
)

var (
	idPattern      = regexp.MustCompile(`^cred-[a-f0-9]{8}$`)
	ownerPattern   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}[a-z0-9]$`)
	namePattern    = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9.]{0,63}$`)
	envVarPattern  = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	errNeedGrant   = &pluginapi.Error{Code: CodeNeedGrant, Message: "该插件未获凭据授权（E_NEED_GRANT）"}
	errAuditFailed = &pluginapi.Error{Code: CodeAudit, Message: "审计不可用，授权未生效（fail-closed）"}
)

// Entry 是 index.json 中的一条凭据元数据；永不含 secret 值。
type Entry struct {
	ID        string    `json:"id"`
	Owner     string    `json:"owner"`
	Name      string    `json:"name"`
	EnvVar    string    `json:"envVar"`
	GrantedTo []string  `json:"grantedTo,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AuditEvent 是一条 credential.grant / credential.revoke 审计事件；不含 secret。
type AuditEvent struct {
	Actor        string `json:"actor"`
	Action       string `json:"action"`
	CredentialID string `json:"credentialId"`
	Owner        string `json:"owner"`
	Grantee      string `json:"grantee"`
	Decision     string `json:"decision"`
}

// Auditor 是审计出口（与 privilege.Auditor 同形）；nil 表示未装配——按 fail-closed 拒绝授权。
type Auditor interface {
	Record(ctx context.Context, ev AuditEvent) error
}

// Options 是 Service 的构造参数。
type Options struct {
	// Dir 是凭据目录（<install>/data/credentials）；不存在时以 0700 创建。
	Dir string
	// Auditor 是授权/撤销的审计出口；nil 时 Grant/Revoke 一律失败（fail-closed）。
	Auditor Auditor
}

// Service 是凭据库；所有读写串行化（目录内文件少，锁竞争可忽略）。
type Service struct {
	dir     string
	auditor Auditor
	mu      sync.Mutex
}

// New 打开（或初始化）凭据库。
func New(opts Options) (*Service, error) {
	if strings.TrimSpace(opts.Dir) == "" {
		return nil, errors.New("credential: 凭据目录不能为空")
	}
	if err := os.MkdirAll(opts.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("credential: 创建凭据目录: %w", err)
	}
	if err := os.Chmod(opts.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("credential: 设置凭据目录权限: %w", err)
	}
	s := &Service{dir: opts.Dir, auditor: opts.Auditor}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.loadLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

// index 是 index.json 的顶层结构（显式字段，禁 any/object）。
type index struct {
	Credentials []Entry `json:"credentials"`
}

func (s *Service) indexPath() string { return filepath.Join(s.dir, "index.json") }

func (s *Service) secretPath(id string) string { return filepath.Join(s.dir, id+".secret") }

// loadLocked 读取 index.json；不存在时返回空索引。调用方须持有 s.mu。
func (s *Service) loadLocked() (index, error) {
	data, err := os.ReadFile(s.indexPath())
	if errors.Is(err, os.ErrNotExist) {
		return index{}, nil
	}
	if err != nil {
		return index{}, fmt.Errorf("credential: 读取 index.json: %w", err)
	}
	var idx index
	if err := json.Unmarshal(data, &idx); err != nil {
		return index{}, fmt.Errorf("credential: 解析 index.json: %w", err)
	}
	return idx, nil
}

// saveLocked 原子写 index.json（临时文件 0600 + rename）。调用方须持有 s.mu。
func (s *Service) saveLocked(idx index) error {
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return fmt.Errorf("credential: 序列化 index.json: %w", err)
	}
	return writeAtomic(s.indexPath(), data)
}

// writeAtomic 同目录临时文件写入 + fsync + rename，权限固定 0600。
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("credential: 创建临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("credential: 设置临时文件权限: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("credential: 写临时文件: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("credential: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("credential: 关闭临时文件: %w", err)
	}
	return os.Rename(tmpName, path)
}

func findEntry(idx *index, id string) (int, bool) {
	for i := range idx.Credentials {
		if idx.Credentials[i].ID == id {
			return i, true
		}
	}
	return -1, false
}

func granted(entry Entry, pluginID string) bool {
	if entry.Owner == pluginID {
		return true
	}
	for _, grantee := range entry.GrantedTo {
		if grantee == pluginID {
			return true
		}
	}
	return false
}

// Set 创建或更新一条凭据；owner 只能写自己的条目（actor 必须等于 owner）。
func (s *Service) Set(ctx context.Context, actor, owner, name, envVar string, secret []byte) (Entry, error) {
	_ = ctx
	if actor != owner {
		return Entry{}, &pluginapi.Error{Code: pluginapi.E_UNAUTHORIZED,
			Message: "只能写入 owner 与调用方一致的凭据"}
	}
	if !ownerPattern.MatchString(owner) {
		return Entry{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "owner 必须是合法插件 id"}
	}
	if !namePattern.MatchString(name) {
		return Entry{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "name 必须是 1–64 个字母/数字/点"}
	}
	if !envVarPattern.MatchString(envVar) {
		return Entry{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "envVar 必须匹配 ^[A-Z][A-Z0-9_]*$"}
	}
	if len(secret) == 0 {
		return Entry{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "secret 不能为空"}
	}
	if len(secret) > maxSecretSize {
		return Entry{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "secret 超过 8 KiB 上限"}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return Entry{}, err
	}
	now := time.Now()
	if i, ok := findEntry(&idx, ""); ok { // 占位，永不命中；保持 findEntry 使用
		_ = i
	}
	// 同 (owner,name) 视为更新同一条目，避免同凭据多副本漂移。
	position := -1
	for i := range idx.Credentials {
		entry := &idx.Credentials[i]
		if entry.Owner == owner && entry.Name == name {
			position = i
			entry.EnvVar = envVar
			entry.UpdatedAt = now
			break
		}
	}
	if position < 0 {
		if len(idx.Credentials) >= maxEntries {
			return Entry{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "凭据条目已达上限"}
		}
		id, err := newID()
		if err != nil {
			return Entry{}, err
		}
		idx.Credentials = append(idx.Credentials, Entry{
			ID: id, Owner: owner, Name: name, EnvVar: envVar,
			CreatedAt: now, UpdatedAt: now,
		})
		position = len(idx.Credentials) - 1
	}
	entry := idx.Credentials[position]
	if err := writeAtomic(s.secretPath(entry.ID), secret); err != nil {
		return Entry{}, err
	}
	if err := s.saveLocked(idx); err != nil {
		return Entry{}, err
	}
	return entry, nil
}

// Get 返回凭据明文；只有 owner 或显式 grantee 可读，否则 E_NEED_GRANT。
func (s *Service) Get(ctx context.Context, actor, id string) ([]byte, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	i, ok := findEntry(&idx, id)
	if !ok {
		return nil, &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "凭据 " + id + " 不存在"}
	}
	entry := idx.Credentials[i]
	if !granted(entry, actor) {
		return nil, errNeedGrant
	}
	secret, err := os.ReadFile(s.secretPath(id))
	if err != nil {
		return nil, &pluginapi.Error{Code: pluginapi.E_INTERNAL, Message: "读取凭据密文失败"}
	}
	return secret, nil
}

// Grant 给 grantee 授权；先写审计，审计失败则授权不生效（ADR-0026 fail-closed）。
func (s *Service) Grant(ctx context.Context, actor, id, grantee string) (time.Time, error) {
	if !ownerPattern.MatchString(grantee) {
		return time.Time{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "grantee 必须是合法插件 id"}
	}
	return s.mutateGrant(ctx, actor, id, grantee, true)
}

// Revoke 撤销授权；同样先写审计，审计失败则撤销不生效。
func (s *Service) Revoke(ctx context.Context, actor, id, grantee string) error {
	_, err := s.mutateGrant(ctx, actor, id, grantee, false)
	return err
}

func (s *Service) mutateGrant(ctx context.Context, actor, id, grantee string, add bool) (time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return time.Time{}, err
	}
	i, ok := findEntry(&idx, id)
	if !ok {
		return time.Time{}, &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "凭据 " + id + " 不存在"}
	}
	entry := &idx.Credentials[i]
	// fail-closed：先落审计；nil/失败一律拒绝，且不修改索引。
	action := ActionRevoke
	if add {
		action = ActionGrant
	}
	if s.auditor == nil {
		return time.Time{}, errAuditFailed
	}
	if err := s.auditor.Record(ctx, AuditEvent{Actor: actor, Action: action,
		CredentialID: id, Owner: entry.Owner, Grantee: grantee, Decision: "allow"}); err != nil {
		return time.Time{}, errAuditFailed
	}
	now := time.Now()
	if add {
		if len(entry.GrantedTo) >= maxGrantees {
			return time.Time{}, &pluginapi.Error{Code: pluginapi.E_INVALID, Message: "授权数已达上限"}
		}
		for _, existing := range entry.GrantedTo {
			if existing == grantee {
				return now, nil
			}
		}
		entry.GrantedTo = append(entry.GrantedTo, grantee)
	} else {
		kept := entry.GrantedTo[:0]
		for _, existing := range entry.GrantedTo {
			if existing != grantee {
				kept = append(kept, existing)
			}
		}
		entry.GrantedTo = kept
	}
	entry.UpdatedAt = now
	sort.Strings(entry.GrantedTo)
	if err := s.saveLocked(idx); err != nil {
		return time.Time{}, err
	}
	return now, nil
}

// List 返回元数据（永不含明文）；actor=admin 时可按 owner 过滤并看到授权列表，
// 普通插件只看到自己 owner 或已获授权的条目。
func (s *Service) List(ctx context.Context, actor, owner string) ([]Entry, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	result := make([]Entry, 0, len(idx.Credentials))
	for _, entry := range idx.Credentials {
		if owner != "" && entry.Owner != owner {
			continue
		}
		if actor != "admin" && !granted(entry, actor) {
			continue
		}
		copyEntry := entry
		copyEntry.GrantedTo = append([]string(nil), entry.GrantedTo...)
		result = append(result, copyEntry)
	}
	return result, nil
}

// Delete 删除凭据与其密文；只有 owner 或 admin 可删。
func (s *Service) Delete(ctx context.Context, actor, id string) error {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return err
	}
	i, ok := findEntry(&idx, id)
	if !ok {
		return &pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "凭据 " + id + " 不存在"}
	}
	if actor != "admin" && idx.Credentials[i].Owner != actor {
		return &pluginapi.Error{Code: pluginapi.E_UNAUTHORIZED, Message: "只有 owner 或管理员可删除凭据"}
	}
	entry := idx.Credentials[i]
	// fail-closed：先落审计；nil/失败一律拒绝，且不修改索引（与 Grant/Revoke 同口径）。
	if s.auditor == nil {
		return errAuditFailed
	}
	if err := s.auditor.Record(ctx, AuditEvent{Actor: actor, Action: ActionDelete,
		CredentialID: id, Owner: entry.Owner, Grantee: entry.Owner, Decision: "allow"}); err != nil {
		return errAuditFailed
	}
	idx.Credentials = append(idx.Credentials[:i], idx.Credentials[i+1:]...)
	if err := s.saveLocked(idx); err != nil {
		return err
	}
	if err := os.Remove(s.secretPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		// 回滚索引：避免"索引已删、密文残留"的半删状态（保持与删除前一致）。
		idx.Credentials = append(idx.Credentials, Entry{})
		copy(idx.Credentials[i+1:], idx.Credentials[i:])
		idx.Credentials[i] = entry
		_ = s.saveLocked(idx)
		return fmt.Errorf("credential: 删除密文: %w", err)
	}
	return nil
}

// EnvFor 返回该插件可见的凭据环境变量（owner 或 grantee）；未授权条目不注入。
// 返回值只含 env 字符串，调用方不得记录其内容（G-30）。
func (s *Service) EnvFor(ctx context.Context, pluginID string) ([]string, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	env := make([]string, 0, len(idx.Credentials))
	for _, entry := range idx.Credentials {
		if !granted(entry, pluginID) {
			continue
		}
		secret, err := os.ReadFile(s.secretPath(entry.ID))
		if err != nil {
			return nil, &pluginapi.Error{Code: pluginapi.E_INTERNAL, Message: "读取凭据密文失败"}
		}
		env = append(env, entry.EnvVar+"="+string(secret))
	}
	return env, nil
}

func newID() (string, error) {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("credential: 生成 id: %w", err)
	}
	return "cred-" + hex.EncodeToString(buf), nil
}
