package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// sha256HexLen 是 sha256 十六进制串长度。
const sha256HexLen = 64

// fileSHA256 流式计算文件 sha256，返回小写十六进制。
func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// parseSHA256Hex 归一化 64 位十六进制串；非法时返回 ok=false。
func parseSHA256Hex(raw string) (string, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if len(value) != sha256HexLen {
		return "", false
	}
	if _, err := hex.DecodeString(value); err != nil {
		return "", false
	}
	return value, true
}

// declaredSHA256 取调用方期望值；为空时回退到包旁同名 .sha256 文件（校验 step 2）。
//
// 两种旁路命名都接受：<包>.sha256 与 <包去 .tar.gz>.sha256；取首字段作哈希。
func declaredSHA256(path, expected string) (string, error) {
	if strings.TrimSpace(expected) != "" {
		sum, ok := parseSHA256Hex(expected)
		if !ok {
			return "", wrap(ErrInvalid, "调用方给出的 sha256 形态非法")
		}
		return sum, nil
	}
	candidates := []string{path + ".sha256", strings.TrimSuffix(path, packageSuffix) + ".sha256"}
	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", wrap(ErrInvalid, "读取 %s 失败：%v", candidate, err)
		}
		fields := strings.Fields(string(data))
		if len(fields) == 0 {
			return "", wrap(ErrInvalid, "%s 为空，无法校验", candidate)
		}
		sum, ok := parseSHA256Hex(fields[0])
		if !ok {
			return "", wrap(ErrInvalid, "%s 首字段不是 sha256", candidate)
		}
		return sum, nil
	}
	return "", nil
}

// checkExpectedSHA256 比对声明值与自算值；无任何声明时跳过（不采信包内哈希）。
func checkExpectedSHA256(path, actual, expected string) error {
	want, err := declaredSHA256(path, expected)
	if err != nil {
		return err
	}
	if want == "" {
		return nil
	}
	if want != actual {
		return wrap(ErrChecksum, "包 sha256 不符：声明 %s，实际 %s", want, actual)
	}
	return nil
}

// verifySHA256SUMS 校验包内可选 SHA256SUMS 清单（每行 `<hash> <path>`）。
//
// 清单缺失视为未声明；清单存在则逐条校验，任一条不符即整体拒绝。
func verifySHA256SUMS(root string) error {
	data, err := os.ReadFile(filepath.Join(root, "SHA256SUMS"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return wrap(ErrInvalid, "读取 SHA256SUMS 失败：%v", err)
	}
	for index, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return wrap(ErrInvalid, "SHA256SUMS 第 %d 行格式非法", index+1)
		}
		want, ok := parseSHA256Hex(fields[0])
		if !ok {
			return wrap(ErrInvalid, "SHA256SUMS 第 %d 行哈希非法", index+1)
		}
		name := strings.TrimPrefix(fields[1], "*")
		if name == "SHA256SUMS" {
			continue
		}
		target, err := safePath(root, name)
		if err != nil {
			return err
		}
		got, err := fileSHA256(target)
		if err != nil {
			return wrap(ErrChecksum, "SHA256SUMS 列出的 %s 不可读：%v", name, err)
		}
		if got != want {
			return wrap(ErrChecksum, "SHA256SUMS 中 %s 的哈希不符", name)
		}
	}
	return nil
}
