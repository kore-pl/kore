package config

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// addrError 校验 MVP 只允许 127.0.0.1:<port>。
func addrError(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "必须是 127.0.0.1:<port>，实际为 " + addr
	}
	if host != "127.0.0.1" {
		return "MVP 只允许回环地址 127.0.0.1，实际为 " + host
	}
	value, err := strconv.Atoi(port)
	if err != nil || value < 1 || value > 65535 {
		return "端口必须是 1–65535，实际为 " + port
	}
	return ""
}

// cpuQuotaError 校验 "10%"–"100%" 形式的 CPU 配额。
func cpuQuotaError(quota string) string {
	if !strings.HasSuffix(quota, "%") {
		return `必须是 "10%"–"100%"，实际为 ` + quota
	}
	value, err := strconv.Atoi(strings.TrimSuffix(quota, "%"))
	if err != nil || value < 10 || value > 100 {
		return `必须是 "10%"–"100%"，实际为 ` + quota
	}
	return ""
}

// hashError 校验 PBKDF2 存储串的结构（算法前缀 + 三段参数）。
func hashError(hash string) string {
	parts := strings.Split(hash, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return "必须是 pbkdf2-sha256$<iterations>$<salt>$<hash> 格式"
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations <= 0 {
		return "迭代次数必须是正整数"
	}
	if parts[2] == "" || parts[3] == "" {
		return "salt 与 hash 不能为空"
	}
	return ""
}

// intRange 返回越界说明；在区间内返回空串。
func intRange(value, minValue, maxValue int) string {
	if value < minValue || value > maxValue {
		return fmt.Sprintf("必须在 %d–%d 之间，实际为 %d", minValue, maxValue, value)
	}
	return ""
}

// durationRange 返回越界说明；在区间内返回空串。
func durationRange(value, minValue, maxValue time.Duration) string {
	if value < minValue || value > maxValue {
		return fmt.Sprintf("必须在 %s–%s 之间，实际为 %s", minValue, maxValue, value)
	}
	return ""
}
