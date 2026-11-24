package privilege

import (
	"context"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// HostChange 是一条「软件替用户改了什么」的宿主变更（ADR-0023 §3.5 #3）。
//
// 它把 root.action 从「只记 argv 的内部台账」变成「用户能看懂、能回滚的产品记录」：
// Summary 是人话摘要、Target 是影响对象、PurgeOp 是**结构化**回滚方式（永不是 shell 字符串）。
type HostChange struct {
	// PluginID / ActionID 是动作归属。
	PluginID string
	ActionID string
	// Summary 是人话摘要（取 action.description）；为空时装配层可回退到动作 id。
	Summary string
	// Target 是影响对象（action.target，writes_host 动作必填）。
	Target string
	// PurgeOp 是结构化回滚操作；nil 表示不可回滚。
	PurgeOp *pluginapi.PurgeOp
}

// ChangeRecorder 是宿主变更账本出口，由装配层注入（写 changes.jsonl）。
//
// nil 表示未装配：声明 writes_host 的动作在未装配时 **fail-closed**（拒绝执行），
// 否则会出现「改了宿主但账本里查无此事」——这比不执行更糟。
type ChangeRecorder interface {
	RecordHostChange(ctx context.Context, change HostChange) error
}

// NeedsConfirm 报告动作执行前是否必须核销一次性 confirm 令牌。
//
// 两条来源：① 插件显式声明 irreversible；② **写宿主但没有结构化回滚信息**——
// 后者是降级规则：拿不出回滚方式的写宿主动作，不得被当成普通可重复动作执行。
func NeedsConfirm(action Action) bool {
	if action.Irreversible {
		return true
	}
	return action.WritesHost && action.PurgeOp == nil
}

// HostChangeOf 把动作声明映射为账本条目（执行成功后由 Execute 调用）。
func HostChangeOf(pluginID string, action Action) HostChange {
	return HostChange{
		PluginID: pluginID,
		ActionID: action.ID,
		Summary:  action.Description,
		Target:   action.Target,
		PurgeOp:  action.PurgeOp,
	}
}
