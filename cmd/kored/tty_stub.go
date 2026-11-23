//go:build !linux

package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// readPasswordNoEcho 在非 Linux（Tier B）上退化为回显读取，并明确告警。
//
// 平台判定走构建标签，降级不静默（G-16）：用户会看到 WARN，知道输入会
// 出现在屏幕上。
func readPasswordNoEcho(f *os.File) (string, error) {
	fmt.Fprintln(os.Stderr, "WARN 当前平台未实现关闭回显（Tier B 降级），输入口令时会显示在屏幕上。")
	line, err := bufio.NewReader(f).ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
