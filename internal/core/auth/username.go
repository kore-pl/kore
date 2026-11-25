package auth

import (
	"crypto/subtle"
	"strings"
)

// DefaultAdminUsername 是单管理员账号的固定标识符（ADR-0057）。
// 账号是标识符不是秘密，安全性由口令与登录限速承担；不做用户表、不做账号枚举。
const DefaultAdminUsername = "admin"

// CheckAdminUsername 常量时间比对登录输入账号与配置账号。
//
// configured 为空（老配置未写 auth.admin_username）时归一为 DefaultAdminUsername，
// 这样老实例升级后不用写盘即可用 admin 登录；输入两侧空白按无关紧要处理。
// 不做大小写折叠：账号是显式标识符，避免把大小写差异悄悄当成同一个账号。
func CheckAdminUsername(username, configured string) bool {
	if strings.TrimSpace(configured) == "" {
		configured = DefaultAdminUsername
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimSpace(username)), []byte(configured)) == 1
}
