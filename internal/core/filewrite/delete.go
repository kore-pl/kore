package filewrite

import (
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 本文件是 ADR-0053 受控删除原语（ADR-0028/ADR-0052 受控写的对称面）。
//
// 与写**同构但顺序相反**：
//
//	写： 校验 → 锁 → 备份原文件 → 审计(fail-closed) → 原子替换 → 属主复核
//	删： 校验 → 锁 → 属主复核 → 备份原文件 → 审计(fail-closed) → unlink → fsync(dir)
//
// 三条不可让步的判据：
//  1. **备份失败即中止**。删除的不可逆性由「先备份」消解，账本 purge_op 恒为
//     file.restore(备份, 目标)。没有备份路径的删除不允许发生——这不是可配置项，
//     因为一旦允许「无备份删除」，就退化成不可恢复的销毁，只能靠人工确认兜底。
//  2. **审计 fail-closed**。审计写不进去就不删（与写同口径），否则会出现
//     「文件没了但查无此事」。
//  3. **删除不存在 → 报错，不静默成功**。静默成功会让「我删了」与「本来就没有」
//     不可区分，账本会记一条没发生过的删除（审计说谎）。幂等由**插件层**做
//     （site 插件已按清单幂等返回），内核保持严格。

// CodeNotFound 表示待删除目标不存在（内核侧不静默成功；幂等由插件层负责）。
const CodeNotFound = "E_NOT_FOUND"

// DeleteOptions 是一次受控删除的执行参数（全部由装配层注入，插件不可给目录）。
type DeleteOptions struct {
	Plugin          string
	Actor           string
	Path            string
	CopyRoot        string
	Auditor         Auditor
	AllowedPrefixes []string
	// OwnerCheck 在**删除前**复核属主/权限位；nil → 拒绝删除（fail-closed）。
	OwnerCheck func(path string, mode os.FileMode) error
	Now        func() time.Time
}

// DeleteResult 是删除结果：备份路径是回滚链的唯一抓手（账本 purge_op 用它）。
type DeleteResult struct {
	Path     string
	Size     int
	Mode     uint32
	SHA256   string
	CopyPath string
}

// Delete 删除单个受控文件：备份 → 审计 → unlink。
func Delete(opts DeleteOptions) (DeleteResult, *Error) {
	if perr := ValidatePlugin(opts.Plugin); perr != nil {
		return DeleteResult{}, perr
	}
	clean, perr := ValidatePath(opts.Path, opts.AllowedPrefixes)
	if perr != nil {
		return DeleteResult{}, perr
	}
	// 与写同一把路径锁：删除与写入必须串行，否则一方可能备份到另一方的中间态。
	unlock := lockPath(clean)
	defer unlock()
	if perr := checkNoSymlink(clean); perr != nil {
		return DeleteResult{}, perr
	}
	if opts.CopyRoot == "" {
		return DeleteResult{}, newErr(CodeCopyFailed, "缺少副本根目录（<install>/data/backups）")
	}
	if opts.OwnerCheck == nil {
		return DeleteResult{}, newErr(CodeOwnerDenied, "属主复核未装配（fail-closed，拒绝删除）")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	info, err := os.Lstat(clean)
	if errors.Is(err, os.ErrNotExist) {
		return DeleteResult{}, newErr(CodeNotFound, "目标文件不存在：%s", clean)
	}
	if err != nil {
		return DeleteResult{}, newErr(CodeIO, "读取目标文件属性失败：%v", err)
	}
	if info.IsDir() {
		return DeleteResult{}, newErr(CodeDeniedPath, "目标是目录，受控删除只删单个文件：%s", clean)
	}
	// 删前属主/权限复核：防「别人替换同名文件后被我们删掉」。失败即拒，不降级。
	if err := opts.OwnerCheck(clean, info.Mode().Perm()); err != nil {
		return DeleteResult{}, newErr(CodeOwnerDenied, "删除前属主/权限复核失败（拒绝删除）：%v", err)
	}
	digest, perr := fileSHA256(clean)
	if perr != nil {
		return DeleteResult{}, perr
	}
	// 删除前备份（失败即中止）：这是把「不可逆」转成「可回滚」的唯一机制。
	stamp := opts.Now().UTC().Format("20060102T150405Z")
	dir := filepath.Join(opts.CopyRoot, opts.Plugin, stamp)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return DeleteResult{}, newErr(CodeCopyFailed, "建备份目录失败（已中止删除）：%v", err)
	}
	copyPath := filepath.Join(dir, filepath.Base(clean))
	if err := copyFile(clean, copyPath, info.Mode().Perm()); err != nil {
		return DeleteResult{}, newErr(CodeCopyFailed, "备份待删文件失败（已中止删除）：%v", err)
	}

	// 审计 fail-closed：审计不可用 → 不删。
	event := AuditEvent{
		Plugin: opts.Plugin, Actor: opts.Actor, Path: clean,
		Size: int(info.Size()), Mode: uint32(info.Mode().Perm()), SHA256: digest,
		CopyPath: copyPath, Decision: "allow", Result: "deleted",
	}
	if opts.Auditor == nil {
		return DeleteResult{}, newErr(CodeAuditDenied, "审计未注入（fail-closed，拒绝删除）")
	}
	if err := opts.Auditor(event); err != nil {
		return DeleteResult{}, newErr(CodeAuditDenied, "审计写入失败（fail-closed，拒绝删除）：%v", err)
	}
	if err := os.Remove(clean); err != nil {
		// 备份已落盘，这里失败不丢数据：直接报错，账本不会记（调用方不落账）。
		return DeleteResult{}, newErr(CodeIO, "删除失败（备份仍在 %s）：%v", copyPath, err)
	}
	// fsync 目录：unlink 是目录项变更，不 sync 时崩溃可能复活该文件。
	if err := syncDir(filepath.Dir(clean)); err != nil {
		return DeleteResult{}, newErr(CodeIO, "同步目录失败（文件已删除）：%v", err)
	}
	return DeleteResult{
		Path: clean, Size: int(info.Size()), Mode: uint32(info.Mode().Perm()),
		SHA256: digest, CopyPath: copyPath,
	}, nil
}

// DeleteDeclaredOptions 是 file_delete 动作的执行参数（声明已在协议层校验过）。
type DeleteDeclaredOptions struct {
	PluginID    string
	Actor       string
	Action      pluginapi.RootAction
	Name        string
	CopyRoot    string
	Auditor     Auditor
	DirOverride string
	OwnerCheck  func(path string, mode os.FileMode) error
	Now         func() time.Time
}

// DeleteDeclared 执行 file_delete 声明：协议层校验 → 类别目录 → Delete。
//
// 顺序与 WriteDeclared 一致：所有校验在**任何副作用之前**完成，避免
// 「备份了一半才发现文件名非法」。
func DeleteDeclared(opts DeleteDeclaredOptions) (DeleteResult, *Error) {
	if opts.Action.FileDelete == nil {
		return DeleteResult{}, newErr(CodeBadDecl, "动作 %q 没有 file_delete 声明", opts.Action.ID)
	}
	if perr := ValidatePlugin(opts.PluginID); perr != nil {
		return DeleteResult{}, perr
	}
	decl := opts.Action.FileDelete
	if err := pluginapi.ValidateFileDelete(decl); err != nil {
		return DeleteResult{}, newErr(CodeBadDecl, "file_delete 声明非法：%v", err)
	}
	class, ok := pluginapi.FileWritePrefixClasses[decl.PrefixClass]
	if !ok {
		return DeleteResult{}, newErr(CodeBadDecl, "prefix_class=%q 不在协议类别的唯一真源内", decl.PrefixClass)
	}
	// 归属当场复核（`kore-<plugin>-*.conf` 是 K3 硬约束，不依赖上层调用顺序）。
	if err := pluginapi.ValidateFileWriteName(opts.PluginID,
		&pluginapi.FileWrite{PrefixClass: decl.PrefixClass}, opts.Name); err != nil {
		return DeleteResult{}, newErr(CodeDeniedPath, "文件名不合规：%v", err)
	}
	if class.PluginNamePrefix && !strings.HasPrefix(opts.Name, "kore-"+opts.PluginID+"-") {
		return DeleteResult{}, newErr(CodeDeniedPath,
			"文件名必须以 %q 开头（防止删除其它插件的片段）：%q", "kore-"+opts.PluginID+"-", opts.Name)
	}
	dir, perr := effectiveDir(class, opts.DirOverride)
	if perr != nil {
		return DeleteResult{}, perr
	}
	full := dir + opts.Name
	if path.Clean(full) != full || !strings.HasPrefix(full, dir) || len(full) == len(dir) {
		return DeleteResult{}, newErr(CodeDeniedPath, "拼出的路径不是类别目录下的规范路径：%q", full)
	}
	return Delete(DeleteOptions{
		Plugin:          opts.PluginID,
		Actor:           opts.Actor,
		Path:            full,
		CopyRoot:        opts.CopyRoot,
		Auditor:         opts.Auditor,
		AllowedPrefixes: []string{dir},
		OwnerCheck:      opts.OwnerCheck,
		Now:             opts.Now,
	})
}
