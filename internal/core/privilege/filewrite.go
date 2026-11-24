package privilege

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/pengtang1024/kore/internal/core/filewrite"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// FileWriteOptions 是 file_write 动作执行面的装配参数。
//
// nil 表示未装配：所有 file_write 动作一律 E_UNSUPPORTED（fail-closed），
// 绝不退化成「走 exec 假装写」——两条执行语义混在一起会让审计/confirm/账本口径失效。
type FileWriteOptions struct {
	// CopyRoot 是写前备份根目录（<install>/data/backups），purge_op: file.restore 从这里回滚。
	CopyRoot string
	// Policy 是内容策略的运行时参数：证书/口令文件目录白名单由装配层注入，
	// 缺省为空 → 校验器拒绝相关指令（不猜安装路径，ADR-0052 §3.1.3.2）。
	Policy pluginapi.FileWriteOptions
	// DirOverrides 按 prefix_class 覆盖类别目录（仅测试与本机非 root e2e）。
	DirOverrides map[string]string
	// OwnerCheck 在写入后复核属主/权限位（internal/platform 实现），nil → 拒绝写入。
	OwnerCheck func(path string, mode os.FileMode) error
	// Now 可注入时钟（备份目录名）。
	Now func() time.Time
}

// executeFileWrite 执行 file_write 动作：**不走 os/exec**（ADR-0049 / ADR-0052）。
//
// 顺序与 exec 分支同构：schema → 协议内容策略 → confirm → root → 账本可用 →
// 审计 begin（fail-closed）→ 写（备份/原子替换/属主复核）→ 审计 end → changes.jsonl。
func (s *Service) executeFileWrite(ctx context.Context, req Request) (Result, error) {
	argvText := fileWriteArgvText(req)
	if s.opts.FileWrite == nil {
		return Result{}, s.deny(ctx, req, argvText, "file_write_unavailable",
			errCode(pluginapi.E_UNSUPPORTED, "受控文件写执行面未装配",
				"以系统服务形态运行内核（systemd unit 内 User=root）后重试；插件进程自身永不提权"))
	}
	// schema 复核：插件 id、动作声明、请求形状（单层文件名 + 正文）。
	if perr := s.validateFileWriteRequest(req); perr != nil {
		return Result{}, s.deny(ctx, req, argvText, "schema: "+perr.Message, perr)
	}
	if NeedsConfirm(req.Action) {
		if err := s.confirm.Consume(req.Confirm, req.PluginID, req.Action.ID); err != nil {
			return Result{}, s.deny(ctx, req, argvText, "confirm 校验失败", asProtocolError(err))
		}
	}
	if !s.opts.Root() {
		return Result{}, s.deny(ctx, req, argvText, "not_root", errCode(pluginapi.E_NEED_ROOT,
			"需要 root 权限：内核需以系统服务形态运行",
			"按 ADR-0042 以系统服务形态运行内核（systemd unit 内 User=root）后重试；插件进程自身永不提权"))
	}
	// 写宿主必须能落账：账本未装配时拒绝（不能「改了宿主但查无此事」）。
	if s.opts.ChangeRecorder == nil {
		return Result{}, s.deny(ctx, req, argvText, "change_ledger_unavailable", errCode(pluginapi.E_INTERNAL,
			"宿主变更账本未装配，写宿主动作已拒绝",
			"按 ADR-0023 以系统服务形态运行内核（装配 changes.jsonl 账本）后重试"))
	}

	unit := unitName(req.PluginID, req.Action.ID)
	start := time.Now()
	// 审计 begin：由 filewrite 的审计回调在**写盘前**落库（fail-closed），
	// 不额外补一条 begin——两条 begin 会让审计里的「一次动作」看起来像两次。
	// began 用于只在真的落过 begin 之后补 end（校验期失败不应该出现「有结果没开始」）。
	began := false
	auditSink := func(ev filewrite.AuditEvent) error {
		err := s.record(ctx, Event{
			Actor: req.Actor, PluginID: req.PluginID, ActionID: req.Action.ID,
			Argv: argvText, Unit: unit, Decision: DecisionAllow, Phase: PhaseBegin, ExitCode: -1,
			FileWrite: &FileWriteAudit{
				Path: ev.Path, SHA256: ev.SHA256, Size: ev.Size,
				Mode: ev.Mode, CopyPath: ev.CopyPath,
			},
		})
		if err != nil {
			return err
		}
		began = true
		return nil
	}
	written, ferr := filewrite.WriteDeclared(filewrite.DeclaredOptions{
		PluginID:    req.PluginID,
		Actor:       req.Actor,
		Action:      req.Action,
		Name:        req.Args[0],
		Content:     []byte(req.Content),
		CopyRoot:    s.opts.FileWrite.CopyRoot,
		Auditor:     auditSink,
		Policy:      s.opts.FileWrite.Policy,
		DirOverride: s.opts.FileWrite.DirOverrides[req.Action.FileWrite.PrefixClass],
		OwnerCheck:  s.opts.FileWrite.OwnerCheck,
		Now:         s.opts.FileWrite.Now,
	})
	durMS := time.Since(start).Milliseconds()
	if ferr != nil {
		// begin 已落（auditSink 成功过）就必须补 end：不能只有「开始」没有「结果」。
		// 校验期就失败（begin 未落）则不造 end——那条路径由上面的 deny 审计覆盖。
		if began {
			s.recordFileWriteEnd(ctx, req, argvText, unit, -1, durMS, nil)
		}
		return Result{}, fileWriteProtocolError(ferr)
	}

	result := Result{
		Executed: true, ExitCode: 0, Unit: unit, DurMS: durMS,
		FileWrite: &FileWriteResult{
			Path: written.Path, Size: written.Size, Mode: written.Mode,
			SHA256: written.SHA256, CopyPath: written.CopyPath,
		},
	}
	s.recordFileWriteEnd(ctx, req, argvText, unit, 0, durMS, result.FileWrite)

	// 写宿主动作成功 → 追加用户可见、可回滚的变更账本。
	// purge_op 是**运行时**得到的：有备份 → file.restore（备份, 目标）；新文件 → file.remove（目标）。
	change := HostChange{
		PluginID: req.PluginID, ActionID: req.Action.ID,
		Summary: req.Action.Description, Target: req.Action.Target,
		PurgeOp: fileWritePurgeOp(written),
	}
	if err := s.opts.ChangeRecorder.RecordHostChange(ctx, change); err != nil {
		s.logger.Warn("宿主变更账本写入失败（文件已写入）", "plugin_id", req.PluginID,
			"action_id", req.Action.ID, "target", written.Path, "err", err)
	} else {
		result.HostChangeRecorded = true
	}
	return result, nil
}

// validateFileWriteRequest 复核 file_write 请求：插件 id、动作声明、文件名与正文。
func (s *Service) validateFileWriteRequest(req Request) *pluginapi.Error {
	if !pluginIDPattern.MatchString(req.PluginID) {
		return errCode(pluginapi.E_INVALID, "plugin_id 不合法： "+req.PluginID, "")
	}
	if err := ValidateAction(req.Action); err != nil {
		return errCode(pluginapi.E_INVALID, "root_action schema 非法："+err.Error(), "")
	}
	if len(req.Args) != 1 {
		return errCode(pluginapi.E_INVALID,
			fmt.Sprintf("file_write 动作必须且只能提供 args[0]（单层文件名），当前 %d 个", len(req.Args)), "")
	}
	// 协议层是文件名与正文的唯一校验入口（K2 的 ValidateFileWriteRequest）。
	if err := pluginapi.ValidateFileWriteRequest(req.PluginID, req.Action, req.Args[0], []byte(req.Content), s.opts.FileWrite.Policy); err != nil {
		return errCode(pluginapi.E_INVALID, "受控写请求非法："+err.Error(),
			"文件名必须是 kore-<插件>-<标识>.conf（≤128 字符），正文 ≤256 KiB 且不含禁用指令")
	}
	return nil
}

// recordFileWriteEnd 补一条 end 审计（带真实结果）。end 写失败只 WARN：
// 动作已经落盘，不能因为第二条审计失败就谎称「没写」——begin 已保证事前可追溯。
func (s *Service) recordFileWriteEnd(ctx context.Context, req Request, argv, unit string,
	exitCode int, durMS int64, outcome *FileWriteResult) {
	ev := Event{
		Actor: req.Actor, PluginID: req.PluginID, ActionID: req.Action.ID,
		Argv: argv, Unit: unit, Decision: DecisionAllow, Phase: PhaseEnd,
		ExitCode: exitCode, DurMS: durMS,
	}
	if outcome != nil {
		ev.FileWrite = &FileWriteAudit{
			Path: outcome.Path, SHA256: outcome.SHA256, Size: outcome.Size,
			Mode: outcome.Mode, CopyPath: outcome.CopyPath,
		}
	}
	if err := s.record(ctx, ev); err != nil {
		s.logger.Warn("受控写结果审计写入失败（文件已处理）", "plugin_id", req.PluginID,
			"action_id", req.Action.ID, "path", argv, "err", err)
	}
}

// fileWriteArgvText 是审计里的动作描述（含文件名的单层名字，不含正文）。
func fileWriteArgvText(req Request) string {
	if len(req.Args) > 0 {
		return "file_write " + req.Args[0]
	}
	return "file_write"
}

// fileWritePurgeOp 把写结果映射为**结构化**回滚操作（账本永不存 shell 字符串）。
func fileWritePurgeOp(result filewrite.Result) *pluginapi.PurgeOp {
	if result.CopyPath != "" {
		return &pluginapi.PurgeOp{
			Kind: pluginapi.PurgeKindFileRestore,
			Args: []string{result.CopyPath, result.Path},
		}
	}
	return &pluginapi.PurgeOp{
		Kind: pluginapi.PurgeKindFileRemove,
		Args: []string{result.Path},
	}
}

// fileWriteProtocolError 把受控写错误映射成协议错误码。
//
// 输入类问题（路径/名字/正文/权限位/软链接）→ E_INVALID；系统类问题（备份/审计/IO/
// 属主复核）→ E_INTERNAL（不是插件的错，不能伪装成用户输入非法）。
func fileWriteProtocolError(err *filewrite.Error) *pluginapi.Error {
	switch err.Code {
	case filewrite.CodeDeniedPath, filewrite.CodeTooLarge, filewrite.CodeBadContent,
		filewrite.CodeBadMode, filewrite.CodeSymlink, filewrite.CodeUnsafeTarget, filewrite.CodeBadDecl:
		return errCode(pluginapi.E_INVALID, "受控写被拒绝："+err.Message,
			"检查文件名（kore-<插件>-<标识>.conf）与正文（≤256 KiB、无禁用指令）后重试")
	default:
		return errCode(pluginapi.E_INTERNAL, "受控写失败："+err.Message,
			"检查目标目录权限与磁盘、以及状态库（state.db）可写后重试")
	}
}
