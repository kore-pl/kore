package filewrite

import (
	"os"
	"path"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// DeclaredOptions 是一次「按协议声明执行」的受控写（K3：root-action 的 file_write 分支）。
//
// 与 Write 的差别：Write 只认「路径 + 正文」（ADR-0028 一期原语）；本入口多一层
// **协议声明**——类别目录、强制后缀、`kore-<plugin>-` 文件名、内容策略全部来自
// `pluginapi` 的唯一真源，内核不抄业务规则（G-01）。
type DeclaredOptions struct {
	// PluginID 是声明动作的插件 id（同时用于文件名归属与审计）。
	PluginID string
	// Actor 是调用方主体（admin / 插件 id）。
	Actor string
	// Action 是已通过 schema 校验的动作声明；FileWrite 必须非 nil。
	Action pluginapi.RootAction
	// Name 是请求里的单层文件名（args[0]）。
	Name string
	// Content 是请求正文（未解码前已由 HTTP 层按 2 MiB 限流，这里按协议硬顶 256 KiB 判）。
	Content []byte
	// CopyRoot 是写前备份根目录（<install>/data/backups）。
	CopyRoot string
	// Auditor 是审计出口；nil → 拒绝写入（fail-closed）。
	Auditor Auditor
	// Policy 是内容策略的运行时参数（证书/口令目录由装配层注入；空即拒绝）。
	Policy pluginapi.FileWriteOptions
	// DirOverride 覆盖类别目录，仅用于测试与本机非 root e2e；生产留空。
	// 覆盖值必须是**绝对、规范、带尾斜杠**的目录，否则拒绝。
	DirOverride string
	// OwnerCheck 在写入后复核属主/权限位；nil → 拒绝（K3 硬约束，fail-closed）。
	OwnerCheck func(path string, mode os.FileMode) error
	// Now 可注入时钟（备份目录名）；nil 用 time.Now。
	Now func() time.Time
}

// WriteDeclared 执行一次按协议声明的受控写。
//
// 校验顺序：插件名 → 声明 → 文件名（单层/后缀/`kore-<plugin>-` 归属）→
// 类别目录定位 → 正文（大小 + 内容策略）→ 属主复核装配 → 原语 Write
// （路径白名单 → 写前备份 → 审计 fail-closed → 原子替换 → 属主复核 → 回滚）。
func WriteDeclared(opts DeclaredOptions) (Result, *Error) {
	if opts.Action.FileWrite == nil {
		return Result{}, newErr(CodeBadDecl, "动作 %q 没有 file_write 声明", opts.Action.ID)
	}
	if perr := ValidatePlugin(opts.PluginID); perr != nil {
		return Result{}, perr
	}
	decl := opts.Action.FileWrite
	if err := pluginapi.ValidateFileWrite(decl); err != nil {
		return Result{}, newErr(CodeBadDecl, "file_write 声明非法：%v", err)
	}
	class, ok := pluginapi.FileWritePrefixClasses[decl.PrefixClass]
	if !ok {
		return Result{}, newErr(CodeBadDecl, "prefix_class=%q 不在协议类别的唯一真源内", decl.PrefixClass)
	}
	// 文件名：协议层是单一校验入口（形状/后缀/归属），这里再把「归属」当场复核一遍——
	// `kore-<plugin>-*.conf` 是 K3 硬约束，不能只依赖上层调用顺序。
	if err := pluginapi.ValidateFileWriteName(opts.PluginID, decl, opts.Name); err != nil {
		return Result{}, newErr(CodeDeniedPath, "文件名不合规：%v", err)
	}
	if class.PluginNamePrefix {
		prefix := "kore-" + opts.PluginID + "-"
		if !strings.HasPrefix(opts.Name, prefix) {
			return Result{}, newErr(CodeDeniedPath,
				"文件名必须以 %q 开头（防止横向覆盖其它插件的片段）：%q", prefix, opts.Name)
		}
	}
	dir, perr := effectiveDir(class, opts.DirOverride)
	if perr != nil {
		return Result{}, perr
	}
	full := dir + opts.Name
	if path.Clean(full) != full || !strings.HasPrefix(full, dir) || len(full) == len(dir) {
		return Result{}, newErr(CodeDeniedPath, "拼出的路径不是类别目录下的规范路径：%q", full)
	}
	// 正文上限取「类别上限」与「动作自我收紧」的较小值（协议口径：只能收紧）。
	limit := class.MaxBytes
	if decl.MaxBytes > 0 && decl.MaxBytes < limit {
		limit = decl.MaxBytes
	}
	if len(opts.Content) > limit {
		return Result{}, newErr(CodeTooLarge, "正文 %d 字节超过本动作上限 %d", len(opts.Content), limit)
	}
	if len(opts.Content) > MaxContentBytes {
		return Result{}, newErr(CodeTooLarge, "正文 %d 字节超过协议硬顶 %d", len(opts.Content), MaxContentBytes)
	}
	if err := pluginapi.ValidateFileWriteContent(decl, opts.Content, opts.Policy); err != nil {
		return Result{}, newErr(CodeBadContent, "正文未通过内容策略 %q：%v", decl.ContentPolicy, err)
	}
	if opts.OwnerCheck == nil {
		return Result{}, newErr(CodeOwnerDenied, "属主复核未装配（fail-closed，拒绝写文件）")
	}
	return Write(Options{
		Plugin:          opts.PluginID,
		Actor:           opts.Actor,
		Path:            full,
		Content:         opts.Content,
		Mode:            Mode0644,
		CopyRoot:        opts.CopyRoot,
		Auditor:         opts.Auditor,
		AllowedPrefixes: []string{dir},
		OwnerCheck:      opts.OwnerCheck,
		Now:             opts.Now,
	})
}

// effectiveDir 返回实际写入目录：测试/本机 e2e 可用覆盖值，生产用类别目录。
func effectiveDir(class pluginapi.FileWriteClass, override string) (string, *Error) {
	if override == "" {
		return class.Dir, nil
	}
	if !path.IsAbs(override) {
		return "", newErr(CodeDeniedPath, "类别目录覆盖值必须是绝对路径：%q", override)
	}
	if !strings.HasSuffix(override, "/") || path.Clean(override) != strings.TrimSuffix(override, "/") {
		return "", newErr(CodeDeniedPath, "类别目录覆盖值必须是规范形式且带尾斜杠：%q", override)
	}
	return override, nil
}
