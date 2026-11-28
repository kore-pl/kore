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
	"sync"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// MaxContentBytes 是单次写入的内容上限（ADR-0028 §2 表）。
	MaxContentBytes = 256 * 1024
	// AllowedModes 是允许的权限位（ADR-0028 §2 表）。
	Mode0644 os.FileMode = 0o644
	Mode0600 os.FileMode = 0o600
	Mode0640 os.FileMode = 0o640
)

// CopyRootDirName 是写前备份根目录名（<install>/data/backups）——由本原语自己定义，
// 装配层只拼 <stateDir>/CopyRootDirName，不在别处再抄一份目录名。
const CopyRootDirName = "backups"

// AllowedPrefixesV1 是 ADR-0028 一期白名单（只允许 drop-in 片段目录）。
var AllowedPrefixesV1 = []string{
	"/etc/ssh/sshd_config.d/",
	"/etc/sysctl.d/",
	"/etc/security/limits.d/",
	"/etc/logrotate.d/",
}

// AllowedPrefixes 是默认白名单 = ADR-0028 一期目录 + ADR-0052 受控写类别目录。
//
// 类别目录**从协议类别派生**（`pluginapi.FileWritePrefixClasses`），不在内核里抄第二份
// 目录清单——否则新增/调整类别时内核白名单会与协议静默漂移，而白名单本身是安全边界。
// 目录字面量留在协议层（与 RootCommandPolicies 同层），内核只消费。
var AllowedPrefixes = buildAllowedPrefixes()

// buildAllowedPrefixes 组装默认白名单（V1 + 协议类别目录，去重保序）。
func buildAllowedPrefixes() []string {
	prefixes := make([]string, 0, len(AllowedPrefixesV1)+len(pluginapi.FileWritePrefixClasses))
	seen := make(map[string]struct{}, cap(prefixes))
	add := func(prefix string) {
		if prefix == "" {
			return
		}
		if _, dup := seen[prefix]; dup {
			return
		}
		seen[prefix] = struct{}{}
		prefixes = append(prefixes, prefix)
	}
	for _, prefix := range AllowedPrefixesV1 {
		add(prefix)
	}
	for _, class := range pluginapi.FileWritePrefixClasses {
		add(class.Dir)
	}
	return prefixes
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
	CodeOwnerDenied  = "E_OWNER_MISMATCH"
	CodeBadDecl      = "E_BAD_DECL"
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
	AllowedPrefixes []string // 默认 AllowedPrefixes；测试可注入临时前缀
	// OwnerCheck 在原子替换后复核属主/属组/权限位（K3 的 root:root 0644）。
	// nil 表示调用方未装配：本原语不做属主校验（ADR-0028 一期口径保持兼容），
	// 但按协议声明的写入口 WriteDeclared 强制要求非 nil（fail-closed）。
	OwnerCheck func(path string, mode os.FileMode) error
	Now        func() time.Time
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
		prefixes = AllowedPrefixes
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
	// 同一路径的并发写必须串行：否则两次「备份 → 原子替换」交错时，
	// 后一次可能备份到前一次的中间态，回滚链与审计的 previous_sha256 都会错。
	// 锁在 checkNoSymlink 之前获取，把「检查 → 写」整段纳入同一临界区（TOCTOU）。
	unlock := lockPath(clean)
	defer unlock()
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
	var previousMode os.FileMode
	if info, err := os.Lstat(clean); err == nil {
		previousMode = info.Mode().Perm()
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
	// 写入后属主/权限复核：setgid 目录、umask、挂载选项都可能让实际落盘属性偏离声明。
	// 复核失败必须回滚——把一份属性不对的 root 配置文件留在宿主上比不写更危险。
	if opts.OwnerCheck != nil {
		if err := opts.OwnerCheck(clean, opts.Mode); err != nil {
			rollbackErr := revertWrite(clean, copyPath, previousMode)
			if rollbackErr != nil {
				return Result{}, newErr(CodeOwnerDenied, "写入后属主/权限复核失败（%v），且回滚失败：%v", err, rollbackErr)
			}
			return Result{}, newErr(CodeOwnerDenied, "写入后属主/权限复核失败，已回滚：%v", err)
		}
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

// copyFile 复制原文件到备份路径，并把源文件的权限位带到副本上（失败即返回错误）。
//
// 副本携带原 mode 是账本回滚能「逐属性还原」的前提：`purge_op: file.restore` 的 args
// 只有（备份路径, 目标路径），没有独立的 mode 字段——备份自身就是原 mode 的唯一载体。
// 副本创建时仍是 0600（内容写入期间不暴露），内容落盘后才 Chmod 成源文件 mode；
// 备份目录本身是 0700，故把副本调成 0644 不会扩大其它用户对该全文的可读性。
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
	if err := out.Chmod(mode); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// pathLocks 是进程内按绝对路径的互斥表（引用计数，无人使用即回收）。
//
// 为什么不是文件锁：kored 是单进程多 goroutine 模型，同一路径的并发写只可能来自
// 同一进程；进程退出锁自然消失，不会留 .lock 文件污染 conf.d。
var pathLocks = struct {
	sync.Mutex
	entries map[string]*pathLock
}{entries: map[string]*pathLock{}}

// pathLock 是一条路径的互斥量 + 使用者计数。
type pathLock struct {
	mu   sync.Mutex
	refs int
}

// lockPath 获取路径锁并返回解锁函数；调用方必须 defer 调用返回值。
func lockPath(path string) func() {
	pathLocks.Lock()
	entry, ok := pathLocks.entries[path]
	if !ok {
		entry = &pathLock{}
		pathLocks.entries[path] = entry
	}
	entry.refs++
	pathLocks.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		pathLocks.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(pathLocks.entries, path)
		}
		pathLocks.Unlock()
	}
}

// revertWrite 在属主复核失败后把目标恢复原状：有备份则覆盖回去，新文件则删除。
//
// 回滚本身也可能失败（只读挂载、磁盘满），错误必须向上抛——不能把「回滚失败」
// 吞成「写入被拒绝」，否则宿主上会留一份属性不对的文件而调用方以为已撤销。
func revertWrite(target, copyPath string, mode os.FileMode) error {
	if copyPath == "" {
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("删除新写入的文件失败：%w", err)
		}
		return syncDir(filepath.Dir(target))
	}
	content, err := os.ReadFile(copyPath)
	if err != nil {
		return fmt.Errorf("读取备份失败：%w", err)
	}
	if mode == 0 {
		mode = Mode0644
	}
	if err := atomicWrite(target, content, mode); err != nil {
		return fmt.Errorf("用备份覆盖目标失败：%w", err)
	}
	return nil
}

// Restore 用备份覆盖目标，并还原备份文件携带的原权限位。
//
// 这是账本 `purge_op: file.restore` 的执行体（cmd/kored/changes.go 调用），
// 语义与包内 revertWrite 完全一致：读备份内容 → atomicWrite(target, content, mode)。
// 之所以不直接用 os.Rename(备份, 目标)：rename 会把**副本自身**的 mode 带给目标，
// 而旧版备份固定是 0600，导致原本 0644 的 drop-in / vhost 回滚后变成 0600
// （内容逐字节一致，权限却退化）。修法分两半：copyFile 备份时把源 mode 写到副本，
// 这里再把副本 mode 读回显式交给 atomicWrite——两半合起来才是「逐属性还原」。
//
// mode 来自备份而非 purge_op 参数：账本 purge_op 的 args 只有（备份, 目标），
// 不新增字段、不改协议形状（G-24 / 既有账本登记语义不变）。mode 必须落在允许集
// 内才执行（fail-closed），防止被篡改的备份把目标恢复成 0777 等宽权限。
// 备份读后保留不消费：重复回滚幂等（旧 rename 语义下第二次会因源不存在报错）。
func Restore(target, copyPath string) error {
	if strings.TrimSpace(copyPath) == "" {
		return fmt.Errorf("用备份还原目标失败：备份路径为空")
	}
	info, err := os.Stat(copyPath)
	if err != nil {
		return fmt.Errorf("读取备份属性失败：%w", err)
	}
	mode := info.Mode().Perm()
	if perr := ValidateMode(mode); perr != nil {
		return fmt.Errorf("备份权限 %#o 不在允许集，拒绝还原：%w", mode, perr)
	}
	if err := revertWrite(target, copyPath, mode); err != nil {
		return fmt.Errorf("用备份还原目标失败：%w", err)
	}
	return nil
}

// syncDir 对目录做一次 fsync（rename/remove 之后落盘顺序的保证）。
func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return err
	}
	return nil
}
