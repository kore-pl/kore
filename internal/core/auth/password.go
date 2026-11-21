// Package auth 提供单管理员口令校验与会话签发/校验/吊销。
//
// 不建用户表：口令哈希来自配置 auth.admin_password_hash，会话落在 store 的
// sessions bucket（key 为 token 的 sha256 hex，明文 token 永不落库、不进日志）。
package auth

import (
	"crypto/pbkdf2"
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

// VerifyPassword 校验明文口令是否匹配 PBKDF2 存储串。
//
// 存储格式：pbkdf2-sha256$<iterations>$<base64(salt)>$<base64(hash)>（docs/SECURITY §3.3）。
// 比较走 subtle.ConstantTimeCompare，防止时序侧信道。
func VerifyPassword(encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false, fmt.Errorf("%w: 格式非法", ErrBadHash)
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false, fmt.Errorf("%w: 迭代次数非法", ErrBadHash)
	}
	salt, err := decodeB64(parts[2])
	if err != nil {
		return false, fmt.Errorf("%w: salt: %v", ErrBadHash, err)
	}
	want, err := decodeB64(parts[3])
	if err != nil || len(want) == 0 {
		return false, fmt.Errorf("%w: hash: %v", ErrBadHash, err)
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	if err != nil {
		return false, fmt.Errorf("%w: 派生失败: %v", ErrBadHash, err)
	}
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// decodeB64 兼容带/不带 padding 的标准 base64。
func decodeB64(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}
