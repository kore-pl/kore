// Package auth 提供单管理员口令校验与会话签发/校验/吊销。
//
// 不建用户表：口令哈希来自配置 auth.admin_password_hash，会话落在 store 的
// sessions bucket（key 为 token 的 sha256 hex，明文 token 永不落库、不进日志）。
package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// auth 相关错误分类。
var (
	// ErrBadHash 表示存储的口令哈希格式或参数非法。
	ErrBadHash = errors.New("口令哈希非法")
	// ErrNoSession 表示会话不存在或已过期。
	ErrNoSession = errors.New("会话不存在或已过期")
)

// PBKDF2 参数（security §3.3 唯一定义；改这里必须同步 docs/SECURITY.md）。
const (
	// HashAlgorithm 是存储串的算法前缀。
	HashAlgorithm = "pbkdf2-sha256"
	// HashIterations 是派生迭代次数（600000，与 docs/SECURITY §3.3 一致）。
	HashIterations = 600000
	// HashSaltBytes 是盐长度（16 字节 → 24 字符 base64）。
	HashSaltBytes = 16
	// HashKeyBytes 是派生密钥长度（32 字节 → 44 字符 base64）。
	HashKeyBytes = 32
)

// HashParams 是解析后的 PBKDF2 存储参数。
type HashParams struct {
	// Iterations 是迭代次数。
	Iterations int
	// Salt 是解码后的盐。
	Salt []byte
	// Key 是解码后的派生密钥。
	Key []byte
}

// parseHash 解析 pbkdf2-sha256$<iter>$<salt>$<hash>；格式非法返回 ErrBadHash。
func parseHash(encoded string) (HashParams, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != HashAlgorithm {
		return HashParams{}, fmt.Errorf("%w: 格式非法", ErrBadHash)
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return HashParams{}, fmt.Errorf("%w: 迭代次数非法", ErrBadHash)
	}
	salt, err := decodeB64(parts[2])
	if err != nil {
		return HashParams{}, fmt.Errorf("%w: salt: %v", ErrBadHash, err)
	}
	key, err := decodeB64(parts[3])
	if err != nil || len(key) == 0 {
		return HashParams{}, fmt.Errorf("%w: hash: %v", ErrBadHash, err)
	}
	return HashParams{Iterations: iter, Salt: salt, Key: key}, nil
}

// ValidateHash 只校验存储串结构，不做派生（写配置前后的守门用）。
func ValidateHash(encoded string) error {
	_, err := parseHash(encoded)
	return err
}

// HashPassword 按存储格式生成口令哈希：pbkdf2-sha256$600000$<salt>$<hash>。
//
// 盐走 crypto/rand；生成的串可直接交给 VerifyPassword 校验，也可写进
// auth.admin_password_hash。
func HashPassword(password string) (string, error) {
	salt := make([]byte, HashSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("生成口令盐失败: %w", err)
	}
	return hashWithSalt(password, salt)
}

// hashWithSalt 用指定盐派生存储串（供 HashPassword 与测试复用）。
func hashWithSalt(password string, salt []byte) (string, error) {
	key, err := pbkdf2.Key(sha256.New, password, salt, HashIterations, HashKeyBytes)
	if err != nil {
		return "", fmt.Errorf("派生口令哈希失败: %w", err)
	}
	return fmt.Sprintf("%s$%d$%s$%s", HashAlgorithm, HashIterations,
		base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(key)), nil
}

// VerifyPassword 校验明文口令是否匹配 PBKDF2 存储串。
//
// 存储格式：pbkdf2-sha256$<iterations>$<base64(salt)>$<base64(hash)>（docs/SECURITY §3.3）。
// 比较走 subtle.ConstantTimeCompare，防止时序侧信道。
func VerifyPassword(encoded, password string) (bool, error) {
	p, err := parseHash(encoded)
	if err != nil {
		return false, err
	}
	got, err := pbkdf2.Key(sha256.New, password, p.Salt, p.Iterations, len(p.Key))
	if err != nil {
		return false, fmt.Errorf("%w: 派生失败: %v", ErrBadHash, err)
	}
	return subtle.ConstantTimeCompare(got, p.Key) == 1, nil
}

// decodeB64 兼容带/不带 padding 的标准 base64。
func decodeB64(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}
