package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/pengtang1024/kore/internal/core/auth"
)

// credentialFormat 是 ADR-0057 T2 的两行凭据格式：纯文本 key-value，
// 不含哈希、不含副本、不含其它账号；口令占位只出现在文档，不在代码里落明文模板。
const (
	credentialUsernamePrefix = "username: "
	credentialPasswordPrefix = "password: "
)

// credentialFileContent 生成两行凭据内容（username 在前，password 在后）。
func credentialFileContent(username, plain string) string {
	return credentialUsernamePrefix + username + "\n" + credentialPasswordPrefix + plain + "\n"
}

// migrateInitialAdminCredential 把老单行明文凭据文件升级为两行格式（ADR-0057 §3.3.2）。
// 已是两行格式则幂等不动；读到单行且无 username:/password: 结构时包装成新格式，
// 原子 0600 覆写。不因明文与配置哈希不一致阻断迁移：若配置已有哈希且校验失败，
// 先把原文件原子备份为 <path>.legacy（0600、gitignore）再包装，提示用 CLI 重置，
// 不删数据、不猜口令（§3.3.3）。
//
// 更新安装（三判据任一命中）在调用方已 return，这里只服务凭据文件存在但格式老的路径。
func migrateInitialAdminCredential(stateDir, configPath string, stderr io.Writer) {
	path := initialAdminCredentialPath(stateDir)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	text := string(data)
	if isTwoLineCredential(text) {
		return
	}
	plain := strings.TrimSpace(text)
	if plain == "" {
		return
	}
	// 哈希不一致的历史情形：先备份原文，再包装；校验失败不是迁移失败。
	if hash := hashFromConfigText(configPath); hash != "" {
		ok, verifyErr := auth.VerifyPassword(hash, plain)
		if verifyErr != nil || !ok {
			backup := path + ".legacy"
			if _, statErr := os.Stat(backup); errors.Is(statErr, os.ErrNotExist) {
				if writeErr := atomicWrite0600(backup, text); writeErr == nil {
					fmt.Fprintf(stderr, "注意：初始凭据与现有口令不一致，原文已备份到 %s（仅你能读）；若登录不上，请用 kored admin-password --set 重置。\n", backup)
				}
			}
		}
	}
	if err := atomicWrite0600(path, credentialFileContent(auth.DefaultAdminUsername, plain)); err != nil {
		fmt.Fprintf(stderr, "警告：初始凭据文件格式升级失败: %v\n", err)
	}
}

// hashFromConfigText 从配置原文粗读 auth.admin_password_hash（只用于迁移期的一致性提示，
// 不参与启用判定：解析权威仍是 config.Load）。
func hashFromConfigText(configPath string) string {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return ""
	}
	quoteTrim := "\"'"
	for _, line := range strings.Split(string(data), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, adminPasswordConfigKey+":") {
			return strings.Trim(strings.TrimSpace(strings.TrimPrefix(t, adminPasswordConfigKey+":")), quoteTrim)
		}
	}
	return ""
}

// isTwoLineCredential 判断是否已是 ADR-0057 两行格式（允许首行 # 注释）。
func isTwoLineCredential(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		return strings.HasPrefix(t, "username:") || strings.HasPrefix(t, "password:")
	}
	return false
}
