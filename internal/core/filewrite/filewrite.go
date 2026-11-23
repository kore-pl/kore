// Package filewrite 是 ADR-0028 一期的「受控文件写原语」。
//
// 定位：这不是「任意路径写」，而是「往白名单目录下的某文件写受控内容」。
// 调用方（插件方法经内核装配）提供 path/content/mode；本包负责：
//   - 路径规范化 + 白名单前缀校验（拒绝 `..`、非规范路径、软链接目标与父目录）
//   - 内容 ≤256 KiB、禁 NUL；mode ∈ {0644,0600,0640}
//   - 写前备份到 <copyRoot>/<plugin>/<timestamp>/（失败即中止）
//   - 审计 fail-closed：审计写不进去就不写文件（只记 sha256/size/mode/备份路径，不记全文）
//   - 原子替换：同目录 O_CREAT|O_EXCL 临时文件 → chmod → fsync → rename → fsync(dir)
//
// 边界：不做内容语义校验（内核不认识 sshd/nginx 语法，G-01）；不做整文件替换以外的
// 变更集（ADR §7 复审条件 3）；白名单只允许 drop-in 片段目录。
package filewrite

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// MaxContentBytes 是单次写入的内容上限（ADR-0028 §2 表）。
	MaxContentBytes = 256 * 1024
	// AllowedModes 是允许的权限位（ADR-0028 §2 表）。
	Mode0644 os.FileMode = 0o644
	Mode0600 os.FileMode = 0o600
	Mode0640 os.FileMode = 0o640
)

// AllowedPrefixesV1 是 ADR-0028 一期白名单（只允许 drop-in 片段目录）。
var AllowedPrefixesV1 = []string{
	"/etc/ssh/sshd_config.d/",
	"/etc/sysctl.d/",
	"/etc/security/limits.d/",
	"/etc/logrotate.d/",
}

// 错误码（与 ADR-0028 §2 失败模式一致，HTTP 层可原样映射）。
const (
	CodeDeniedPath   = "E_DENIED_PATH"
	CodeTooLarge     = "E_TOO_LARGE"
	CodeSymlink      = "E_SYMLINK"
	CodeUnsafeTarget = "E_UNSAFE_TARGET"
	CodeBadMode      = "E_BAD_MODE"
	CodeBadContent   = "E_BAD_CONTENT"
	CodeCopyFailed   = "E_BACKUP_FAILED"
	CodeAuditDenied  = "E_AUDIT_DENIED"
	CodeIO           = "E_IO"
)

// Error 是受控写的结构化错误。
type Error struct {
	Code    string
	Message string
}

// Error 实现 error 接口。
func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newErr(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AuditEvent 是审计事件：只记哈希与元数据，**不记全文**（ADR-0028 §4）。
type AuditEvent struct {
	Plugin         string `json:"plugin"`
	Actor          string `json:"actor"`
	Path           string `json:"path"`
	Size           int    `json:"size"`
	Mode           uint32 `json:"mode"`
	SHA256         string `json:"sha256"`
	PreviousSHA256 string `json:"previous_sha256,omitempty"`
	CopyPath       string `json:"backup_path,omitempty"`
	Decision       string `json:"decision"` // allow | deny
	Result         string `json:"result"`   // written | failed
}

// Auditor 由装配层注入（写 store 的审计）；nil 视为审计不可用 → 拒绝写入。
type Auditor func(AuditEvent) error

// Options 是一次受控写的输入。
type Options struct {
	Plugin          string
	Actor           string
	Path            string
	Content         []byte
	Mode            os.FileMode
	CopyRoot        string
	Auditor         Auditor
	AllowedPrefixes []string // 默认 AllowedPrefixesV1；测试可注入临时前缀
	Now             func() time.Time
}

// Result 是成功写入的观测结果。
type Result struct {
	Path     string `json:"path"`
	Size     int    `json:"size"`
	Mode     uint32 `json:"mode"`
	SHA256   string `json:"sha256"`
	CopyPath string `json:"backup_path,omitempty"`
}

// ValidatePath 校验路径是否落在允许前缀内且形状安全。
func ValidatePath(path string, prefixes []string) (string, *Error) {
	if !filepath.IsAbs(path) {
		return "", newErr(CodeDeniedPath, "路径必须是绝对路径：%q", path)
	}
	clean := filepath.Clean(path)
	if clean != path {
		return "", newErr(CodeDeniedPath, "路径不是规范形式（拒绝 `..`/`//`/尾部 `/`）：%q", path)
	}
	if strings.ContainsAny(path, "\x00\n\r") {
		return "", newErr(CodeDeniedPath, "路径含控制字符：%q", path)
	}
	base := filepath.Base(clean)
	if base == "." || base == "/" || base == "" {
		return "", newErr(CodeDeniedPath, "路径缺少文件名：%q", path)
	}
	ext := strings.ToLower(filepath.Ext(base))
	if ext != ".conf" {
		return "", newErr(CodeDeniedPath, "只允许写 .conf 片段，拒绝扩展名 %q（如 .sh 可执行脚本）", ext)
	}
	if len(prefixes) == 0 {
		prefixes = AllowedPrefixesV1
	}
	matched := false
	for _, prefix := range prefixes {
		if strings.HasSuffix(path, "/") {
			continue
		}
		if strings.HasPrefix(path, prefix) && len(path) > len(prefix) {
			// 前缀内的相对部分不得含分隔符以外的越界：Clean 已消除 `..`，
			// 这里再确认相对部分不是绝对路径（双保险）。
			relative := strings.TrimPrefix(path, prefix)
			if relative != "" && !strings.HasPrefix(relative, "/") && filepath.IsLocal(relative) {
				matched = true
				break
			}
		}
	}
	if !matched {
		return "", newErr(CodeDeniedPath, "路径不在白名单前缀内：%q（允许：%s）", path, strings.Join(prefixes, "、"))
	}
	return clean, nil
}

// ValidateContent 校验内容上限与 NUL。
func ValidateContent(content []byte) *Error {
	if len(content) > MaxContentBytes {
		return newErr(CodeTooLarge, "内容 %d 字节超过上限 %d", len(content), MaxContentBytes)
	}
	for _, b := range content {
		if b == 0 {
			return newErr(CodeBadContent, "内容含 NUL 字节")
		}
	}
	return nil
}

// ValidateMode 校验权限白名单。
func ValidateMode(mode os.FileMode) *Error {
	switch mode {
	case Mode0644, Mode0600, Mode0640:
		return nil
	}
	return newErr(CodeBadMode, "权限 %#o 不在允许集 {0644,0600,0640}", mode)
}

// ValidatePlugin 校验插件名（用作备份目录与审计字段）。
func ValidatePlugin(plugin string) *Error {
	if plugin == "" || len(plugin) > 32 {
		return newErr(CodeDeniedPath, "插件名长度非法：%q", plugin)
	}
	for index, r := range plugin {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
		if !ok {
			return newErr(CodeDeniedPath, "插件名第 %d 个字符 %q 非法（只允许小写字母/数字/-）", index+1, r)
		}
	}
	return nil
}

// checkNoSymlink 沿路径校验父目录与目标：任一为符号链接即拒绝（ADR-0028 §5.3）。
func checkNoSymlink(clean string) *Error {
	dir := filepath.Dir(clean)
	parts := strings.Split(strings.TrimPrefix(dir, "/"), "/")
	current := "/"
	for _, part := range parts {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return newErr(CodeUnsafeTarget, "父目录不存在：%s", current)
			}
			return newErr(CodeIO, "Lstat %s 失败：%v", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return newErr(CodeSymlink, "父目录是符号链接：%s", current)
		}
		if !info.IsDir() {
			return newErr(CodeUnsafeTarget, "父路径不是目录：%s", current)
		}
	}
	if info, err := os.Lstat(clean); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return newErr(CodeSymlink, "目标是符号链接：%s", clean)
		}
		if !info.Mode().IsRegular() {
			return newErr(CodeUnsafeTarget, "目标不是常规文件：%s", clean)
		}
		if ValidateMode(info.Mode().Perm()) != nil {
			return newErr(CodeUnsafeTarget, "目标已有权限 %#o 不在允许集", info.Mode().Perm())
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return newErr(CodeIO, "Lstat %s 失败：%v", clean, err)
	}
	return nil
}

// Write 执行一次受控写：校验 → 备份 → 审计（fail-closed）→ 原子替换。
func Write(opts Options) (Result, *Error) {
	if perr := ValidatePlugin(opts.Plugin); perr != nil {
		return Result{}, perr
	}
	clean, perr := ValidatePath(opts.Path, opts.AllowedPrefixes)
	if perr != nil {
		return Result{}, perr
	}
	if perr := ValidateContent(opts.Content); perr != nil {
		return Result{}, perr
	}
	if perr := ValidateMode(opts.Mode); perr != nil {
		return Result{}, perr
	}
	if perr := checkNoSymlink(clean); perr != nil {
		return Result{}, perr
	}
	if opts.CopyRoot == "" {
		return Result{}, newErr(CodeCopyFailed, "缺少副本根目录（<install>/data/backups）")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	sum := sha256.Sum256(opts.Content)
	digest := hex.EncodeToString(sum[:])

	// 写前备份（失败即中止）。
	copyPath := ""
	previousSHA := ""
	if info, err := os.Lstat(clean); err == nil {
		previousSHA, perr = fileSHA256(clean)
		if perr != nil {
			return Result{}, perr
		}
		stamp := opts.Now().UTC().Format("20060102T150405Z")
		dir := filepath.Join(opts.CopyRoot, opts.Plugin, stamp)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return Result{}, newErr(CodeCopyFailed, "建备份目录失败：%v", err)
		}
		copyPath = filepath.Join(dir, filepath.Base(clean))
		if err := copyFile(clean, copyPath, info.Mode().Perm()); err != nil {
			return Result{}, newErr(CodeCopyFailed, "备份原文件失败（已中止）：%v", err)
		}
	}

	// 审计 fail-closed：审计不可用或写失败 → 不写文件。
	event := AuditEvent{
		Plugin: opts.Plugin, Actor: opts.Actor, Path: clean,
		Size: len(opts.Content), Mode: uint32(opts.Mode), SHA256: digest,
		PreviousSHA256: previousSHA, CopyPath: copyPath,
		Decision: "allow", Result: "written",
	}
	if opts.Auditor != nil {
		if err := opts.Auditor(event); err != nil {
			return Result{}, newErr(CodeAuditDenied, "审计写入失败（fail-closed，拒绝写文件）：%v", err)
		}
	} else {
		return Result{}, newErr(CodeAuditDenied, "审计未注入（fail-closed，拒绝写文件）")
	}

	if err := atomicWrite(clean, opts.Content, opts.Mode); err != nil {
		return Result{}, newErr(CodeIO, "原子写失败：%v", err)
	}
	return Result{Path: clean, Size: len(opts.Content), Mode: uint32(opts.Mode), SHA256: digest, CopyPath: copyPath}, nil
}

// atomicWrite 用同目录临时文件 + rename 完成原子替换。
func atomicWrite(target string, content []byte, mode os.FileMode) error {
	dir := filepath.Dir(target)
	temp, err := os.CreateTemp(dir, ".kore-write-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	cleanup := func() { _ = os.Remove(tempName) }
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		cleanup()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		cleanup()
		return err
	}
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tempName, target); err != nil {
		cleanup()
		return err
	}
	dirHandle, err := os.Open(dir)
	if err == nil {
		_ = dirHandle.Sync()
		_ = dirHandle.Close()
	}
	return nil
}

// fileSHA256 计算已有文件内容哈希（只读，不记全文）。
func fileSHA256(path string) (string, *Error) {
	handle, err := os.Open(path)
	if err != nil {
		return "", newErr(CodeIO, "读取原文件失败：%v", err)
	}
	defer handle.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, handle); err != nil {
		return "", newErr(CodeIO, "计算原文件哈希失败：%v", err)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// copyFile 复制原文件到备份路径（0600，失败即返回错误）。
func copyFile(source, target string, mode os.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
