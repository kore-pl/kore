package privilege

import (
	"context"
	"strconv"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 审计常量（DATA-MODEL §9 / SECURITY §11）。
const (
	// AuditAction 是提权审计的事件名。
	AuditAction = "root.action"
	// DecisionAllow / DecisionDeny 是 root.action 的裁决取值。
	DecisionAllow = "allow"
	DecisionDeny  = "deny"
	// PhaseBegin / PhaseEnd 区分"执行前落账"与"执行后结果"两条记录：
	// fail-closed 靠 begin 记录保证（写不进去就不执行），end 记录补 exit_code/dur_ms。
	PhaseBegin = "begin"
	PhaseEnd   = "end"
	// detail 字段上限沿用 store（键 ≤32 / 值 ≤256 字符），这里再留余量。
	auditValueMax = 200
)

// Event 是一条 root.action 审计事件；装配层负责映射到 store.AuditRecord。
type Event struct {
	// Actor 是调用方主体（admin / 插件 id / 来源标识）。
	Actor string
	// PluginID / ActionID 是动作归属。
	PluginID string
	ActionID string
	// Argv 是脱敏后的完整命令（含追加参数），为空表示未构造。
	Argv string
	// Unit 是 transient unit 名；拒绝路径可能为空。
	Unit string
	// Decision 是 allow / deny。
	Decision string
	// DenyReason 是拒绝原因（仅 deny）。
	DenyReason string
	// ExitCode / DurMS 是执行结果（仅 end 记录有意义）。
	ExitCode int
	DurMS    int64
	// Phase 是 begin / end；deny 记录固定 deny。
	Phase string
	// FileWrite 是受控写的附加审计字段（仅 file_write 动作非 nil）。
	FileWrite *FileWriteAudit
}

// FileWriteAudit 是受控写审计的元数据：只记哈希与属性，**不记正文**（ADR-0028 §4）。
type FileWriteAudit struct {
	// Path 是实际落盘路径。
	Path string
	// SHA256 是写入内容哈希。
	SHA256 string
	// Size 是写入字节数。
	Size int
	// Mode 是落盘权限位。
	Mode uint32
	// CopyPath 是写前备份路径（新文件为空）。
	CopyPath string
}

// Result 把事件映射为 store 的三值结果（ok / denied / error）。
func (e Event) Result() string {
	if e.Decision == DecisionDeny {
		return "denied"
	}
	if e.Phase == PhaseBegin {
		return "ok"
	}
	if e.ExitCode != 0 {
		return "error"
	}
	return "ok"
}

// Detail 返回受控 detail（≤7 键，值统一截断到 auditValueMax 字符）。
func (e Event) Detail() map[string]string {
	detail := map[string]string{
		"decision":  e.Decision,
		"phase":     e.Phase,
		"exit_code": strconv.Itoa(e.ExitCode),
		"dur_ms":    strconv.FormatInt(e.DurMS, 10),
	}
	if e.Argv != "" {
		detail["argv"] = trimAudit(e.Argv)
	}
	if e.Unit != "" {
		detail["unit"] = trimAudit(e.Unit)
	}
	if e.DenyReason != "" {
		detail["deny_reason"] = trimAudit(e.DenyReason)
	}
	if e.FileWrite != nil {
		detail["path"] = trimAudit(e.FileWrite.Path)
		detail["sha256"] = e.FileWrite.SHA256
		detail["size"] = strconv.Itoa(e.FileWrite.Size)
		detail["mode"] = strconv.FormatUint(uint64(e.FileWrite.Mode), 8)
		if e.FileWrite.CopyPath != "" {
			detail["copy_path"] = trimAudit(e.FileWrite.CopyPath)
		}
	}
	return detail
}

// trimAudit 按字符截断 detail 值（store 上限 256，留余量到 200）。
func trimAudit(value string) string {
	runes := []rune(value)
	if len(runes) <= auditValueMax {
		return value
	}
	return string(runes[:auditValueMax]) + "…"
}

// record 写一条审计；未注入 Auditor 时返回错误——提权通道强制要求审计
// （与 supervisor 的"nil 表示不记录"不同：这里 nil 必须 fail-closed）。
func (s *Service) record(ctx context.Context, ev Event) error {
	if s.opts.Auditor == nil {
		return errCode(pluginapi.E_INTERNAL, "提权审计未装配，动作已拒绝", "")
	}
	return s.opts.Auditor.Record(ctx, ev)
}

// deny 先落拒绝审计，再返回调用方应看到的拒绝错误（denyErr）。
// 审计写失败时返回 E_INTERNAL——拒绝本身仍成立（动作没有执行），
// 但"无法留痕"必须显式暴露，不能吞成普通的权限错误。
func (s *Service) deny(ctx context.Context, req Request, argv, reason string, denyErr *pluginapi.Error) *pluginapi.Error {
	ev := Event{
		Actor: req.Actor, PluginID: req.PluginID, ActionID: req.Action.ID,
		Argv: argv, Decision: DecisionDeny, DenyReason: reason, Phase: "deny", ExitCode: -1,
	}
	if err := s.record(ctx, ev); err != nil {
		return errCode(pluginapi.E_INTERNAL,
			"提权审计写入失败，动作已拒绝："+err.Error(), "检查状态库（state.db）可写后重试")
	}
	return denyErr
}
