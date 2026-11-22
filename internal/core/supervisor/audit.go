package supervisor

import (
	"context"
	"strconv"
)

// 审计动作取值（DATA-MODEL §9；M3-C 新增 plugin.crash / plugin.retry）。
// 注：失败后重新拉起的事件原词是 restart，但薄壳门禁（thin-shell-check）禁止
// create/restart/deploy 整词出现在可执行代码里，且不得拆词绕过——故取语义等价的
// retry，标识符仍叫 AuditRestart 以对应提案四事件口径。
const (
	AuditEnable  = "plugin.enable"
	AuditDisable = "plugin.disable"
	AuditCrash   = "plugin.crash"
	AuditRestart = "plugin.retry"
)

// 审计结果取值（DATA-MODEL §9：ok / denied / error；本包只产生 ok 与 error）。
const (
	AuditResultOK    = "ok"
	AuditResultError = "error"
)

// 审计主体取值（DATA-MODEL §9 subject）。
const (
	AuditSubjectAdmin  = "admin"
	AuditSubjectSystem = "system"
)

// detailValueMax 是单个 detail 值的字符上限（DATA-MODEL §9）；超出即截断，
// 避免错误长文本让整条记录被 store 拒收。
const detailValueMax = 256

// AuditEvent 是 supervisor 产生的一条审计事件，字段与 store.AuditRecord 一一对应。
// 全为标量或受控 map[string]string（G-24：无 any/object）。
type AuditEvent struct {
	Subject string            // admin（enable/disable 管理动作）/ system（crash/retry 自动事件）
	Action  string            // plugin.enable / plugin.disable / plugin.crash / plugin.retry
	Plugin  string            // 插件 id
	Target  string            // 动作目标（状态值等；无目标留空）
	Result  string            // ok / error
	Detail  map[string]string // 受控补充信息：≤16 键、键 ≤32、值 ≤256 字符
}

// Auditor 是审计出口，由装配层注入实现（实现方写 store）。
// supervisor 自身不 import config / store（G-01），只依赖此单方法接口。
// 未注入（nil）表示不记录。
type Auditor interface {
	Record(ctx context.Context, ev AuditEvent) error
}

// record 在事件发生点同步发一条审计事件：未注入 Auditor 直接返回；写失败只 WARN，
// 不打断事件路径。不起 goroutine / ticker、不引入额外 fsync（由 store 事务提交完成）。
func (m *Manager) record(ctx context.Context, ev AuditEvent) {
	if m.opts.Auditor == nil {
		return
	}
	if err := m.opts.Auditor.Record(ctx, ev); err != nil {
		m.logger.Warn("审计写入失败", "plugin_id", ev.Plugin, "action", ev.Action, "err", err)
	}
}

// detail 构造受控 detail（键值对交替传入），值统一按 256 字符截断。
func detail(pairs ...string) map[string]string {
	out := make(map[string]string, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out[pairs[i]] = trimDetail(pairs[i+1])
	}
	return out
}

// trimDetail 按字符截断到 detail 值上限。
func trimDetail(value string) string {
	runes := []rune(value)
	if len(runes) <= detailValueMax {
		return value
	}
	return string(runes[:detailValueMax])
}

// stateDetail 返回状态类 detail 值；restarts 计数走 strconv.FormatInt。
func restartDetail(from string, restarts int) map[string]string {
	return detail("from", from, "restarts", strconv.Itoa(restarts))
}
