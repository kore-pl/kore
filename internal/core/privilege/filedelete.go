package privilege

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/pengtang1024/kore/internal/core/filewrite"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// FileDeleteOptions 是 file_delete 动作执行面的装配参数（ADR-0053）。
//
// nil 表示未装配：所有 file_delete 动作一律 E_UNSUPPORTED（fail-closed）。
// 绝不退化成「走 exec 用 rm 假装删除」——那会把路径校验、备份、审计三条判据
// 一次性绕开，且 rm 的语义（可删目录/通配）远大于受控删除。
type FileDeleteOptions struct {
	// CopyRoot 是删除前备份根目录（<install>/data/backups）；purge_op: file.restore 从这里回滚。
	CopyRoot string
	// DirOverrides 按 prefix_class 覆盖类别目录（仅测试与本机非 root e2e）。
	DirOverrides map[string]string
	// OwnerCheck 在删除前复核属主/权限位（internal/platform 实现），nil → 拒绝删除。
	OwnerCheck func(path string, mode os.FileMode) error
	// Now 可注入时钟（备份目录名）。
	Now func() time.Time
}

// executeFileDelete 执行 file_delete 动作：**不走 os/exec**，也不复用写的路径。
//
// 顺序与 executeFileWrite 同构：schema → 协议校验 → confirm → root → 账本可用 →
// 审计 begin（fail-closed）→ 删除（属主复核/备份/unlink）→ 审计 end → changes.jsonl。
func (s *Service) executeFileDelete(ctx context.Context, req Request) (Result, error) {
	argvText := fileDeleteArgvText(req)
	if s.opts.FileDelete == nil {
		return Result{}, s.deny(ctx, req, argvText, "file_delete_unavailable",
			errCode(pluginapi.E_UNSUPPORTED, "受控删除执行面未装配",
				"以系统服务形态运行内核（systemd unit 内 User=root）后重试；插件进程自身永不提权"))
	}
	if perr := s.validateFileDeleteRequest(req); perr != nil {
		return Result{}, s.deny(ctx, req, argvText, "schema: "+perr.Message, perr)
	}
	// 删除是可回滚的（强制备份 → 账本 file.restore），故按通用判据应不需要 confirm：
	// 若声明了 irreversible=true（运维显式收紧），仍按声明核销令牌，不放宽。
	if NeedsConfirmFileWrite(req.Action) {
		if err := s.confirm.Consume(req.Confirm, req.PluginID, req.Action.ID); err != nil {
			return Result{}, s.deny(ctx, req, argvText, "confirm 校验失败", asProtocolError(err))
		}
	}
	if !s.opts.Root() {
		return Result{}, s.deny(ctx, req, argvText, "not_root", errCode(pluginapi.E_NEED_ROOT,
			"需要 root 权限：内核需以系统服务形态运行",
			"按 ADR-0042 以系统服务形态运行内核（systemd unit 内 User=root）后重试；插件进程自身永不提权"))
	}
	if s.opts.ChangeRecorder == nil {
		return Result{}, s.deny(ctx, req, argvText, "change_ledger_unavailable", errCode(pluginapi.E_INTERNAL,
			"宿主变更账本未装配，删宿主动作已拒绝",
			"按 ADR-0023 以系统服务形态运行内核（装配 changes.jsonl 账本）后重试"))
	}

	unit := unitName(req.PluginID, req.Action.ID)
	start := time.Now()
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
	deleted, ferr := filewrite.DeleteDeclared(filewrite.DeleteDeclaredOptions{
		PluginID:    req.PluginID,
		Actor:       req.Actor,
		Action:      req.Action,
		Name:        req.Args[0],
		CopyRoot:    s.opts.FileDelete.CopyRoot,
		Auditor:     auditSink,
		DirOverride: s.opts.FileDelete.DirOverrides[req.Action.FileDelete.PrefixClass],
		OwnerCheck:  s.opts.FileDelete.OwnerCheck,
		Now:         s.opts.FileDelete.Now,
	})
	durMS := time.Since(start).Milliseconds()
	if ferr != nil {
		if began {
			s.recordFileWriteEnd(ctx, req, argvText, unit, -1, durMS, nil)
		}
		return Result{}, fileDeleteProtocolError(ferr)
	}

	result := Result{
		Executed: true, ExitCode: 0, Unit: unit, DurMS: durMS,
		FileWrite: &FileWriteResult{
			Path: deleted.Path, Size: deleted.Size, Mode: deleted.Mode,
			SHA256: deleted.SHA256, CopyPath: deleted.CopyPath,
		},
	}
	s.recordFileWriteEnd(ctx, req, argvText, unit, 0, durMS, result.FileWrite)

	// 删除的账本条目：purge_op 恒为 file.restore(备份, 原路径)。
	// 无备份路径的删除不可能走到这里（filewrite.Delete 备份失败即中止），
	// 所以账本里不会出现「删了但回滚不了」的条目。
	change := HostChange{
		PluginID: req.PluginID, ActionID: req.Action.ID,
		Summary: req.Action.Description, Target: req.Action.Target,
		PurgeOp: &pluginapi.PurgeOp{
			Kind: pluginapi.PurgeKindFileRestore,
			Args: []string{deleted.CopyPath, deleted.Path},
		},
	}
	if err := s.opts.ChangeRecorder.RecordHostChange(ctx, change); err != nil {
		s.logger.Warn("宿主变更账本写入失败（文件已删除）", "plugin_id", req.PluginID,
			"action_id", req.Action.ID, "target", deleted.Path, "copy_path", deleted.CopyPath, "err", err)
	} else {
		result.HostChangeRecorded = true
	}
	return result, nil
}

// validateFileDeleteRequest 复核 file_delete 请求：插件 id、声明、单层文件名。
func (s *Service) validateFileDeleteRequest(req Request) *pluginapi.Error {
	if !pluginIDPattern.MatchString(req.PluginID) {
		return errCode(pluginapi.E_INVALID, "plugin_id 不合法： "+req.PluginID, "")
	}
	if err := ValidateAction(req.Action); err != nil {
		return errCode(pluginapi.E_INVALID, "root_action schema 非法："+err.Error(), "")
	}
	if len(req.Args) != 1 {
		return errCode(pluginapi.E_INVALID,
			fmt.Sprintf("file_delete 动作必须且只能提供 args[0]（单层文件名），当前 %d 个", len(req.Args)), "")
	}
	// 删除不接受正文：允许它会让「同名删除 + 顺便写点什么」两种语义混在一条请求里。
	if req.Content != "" {
		return errCode(pluginapi.E_INVALID, "file_delete 动作不得携带正文（content 仅用于 file_write）", "")
	}
	if err := pluginapi.ValidateFileDeleteRequest(req.PluginID, req.Action, req.Args[0]); err != nil {
		return errCode(pluginapi.E_INVALID, "受控删除请求非法："+err.Error(),
			"文件名必须是 kore-<插件>-<标识>.conf（≤128 字符），只能删本插件在该类别目录下的片段")
	}
	return nil
}

// fileDeleteArgvText 是审计里的动作描述（只有单层文件名）。
func fileDeleteArgvText(req Request) string {
	if len(req.Args) > 0 {
		return "file_delete " + req.Args[0]
	}
	return "file_delete"
}

// fileDeleteProtocolError 把受控删除错误映射成协议错误码。
//
// 不存在 → E_NOTFOUND（不是用户输入非法）；越权/形状问题 → E_INVALID；
// 备份/审计/IO/属主 → E_INTERNAL（系统类，不伪装成用户输入问题）。
func fileDeleteProtocolError(err *filewrite.Error) *pluginapi.Error {
	switch err.Code {
	case filewrite.CodeNotFound:
		return errCode(pluginapi.E_NOTFOUND, "受控删除目标不存在："+err.Message,
			"刷新站点列表后重试（内核不做静默幂等，避免账本记录未发生的删除）")
	case filewrite.CodeDeniedPath, filewrite.CodeSymlink, filewrite.CodeUnsafeTarget,
		filewrite.CodeBadDecl, filewrite.CodeBadMode, filewrite.CodeBadContent:
		return errCode(pluginapi.E_INVALID, "受控删除被拒绝："+err.Message,
			"检查文件名（kore-<插件>-<标识>.conf）与所属类别后重试")
	default:
		return errCode(pluginapi.E_INTERNAL, "受控删除失败："+err.Message,
			"检查目标目录权限与磁盘、副本目录（filewrite.CopyRootDirName）与状态库可写后重试")
	}
}
