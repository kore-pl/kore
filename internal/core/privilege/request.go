package privilege

import (
	"context"
	"encoding/json"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// Action 是经 schema 校验后的 root 动作（协议类型别名，便于调用方少写包名）。
type Action = pluginapi.RootAction

// Request 是一次提权请求：用户只能选 action id（固定 argv 来自清单），
// args 只作为**追加参数**附在声明 argv 之后，永远不能替换 argv[0]。
type Request struct {
	// Actor 是调用方主体（admin / 插件 id），写进审计。
	Actor string
	// PluginID 是声明该动作的插件 id。
	PluginID string
	// Action 是清单里的动作（argv 固定）。
	Action Action
	// Args 是追加参数（可为空）；长度与字符集在 Execute 内校验。
	// file_write 动作只允许一个元素：单层文件名（目录由类别定义，插件不能给）。
	Args []string
	// Content 是 file_write 动作的正文（UTF-8；exec 动作必须为空）。
	Content string
	// Confirm 是不可回滚动作的一次性令牌。
	Confirm string
}

// Result 是一次执行的观测结果；字段名即 HTTP 响应契约。
type Result struct {
	// Executed 表示动作是否真的被拉起执行。
	Executed bool `json:"executed"`
	// ExitCode 是被调命令**真实**退出码（exec.ExitError.ExitCode()）；
	// -1 表示未执行、超时被 kill（整棵进程树）或平台不支持进程组回收。
	ExitCode int `json:"exit_code"`
	// Stdout / Stderr 是命令输出（各截断到 1 MiB）。
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	// DurMS 是墙钟耗时（毫秒）。
	DurMS int64 `json:"dur_ms"`
	// Unit 是本次执行的审计标识 `kore-root-<plugin>-<action>-<rand>`：把 begin/end
	// 两条审计串起来（ADR-0049 后不再是 transient unit 名，字段保留做协议兼容）。
	Unit string `json:"unit"`
	// Truncated 表示输出超过上限被截断。
	Truncated bool `json:"truncated,omitempty"`
	// HostChangeRecorded 表示写宿主动作已追加到 changes.jsonl（仅 writes_host 成功时可能为 true）。
	HostChangeRecorded bool `json:"host_change_recorded,omitempty"`
	// FileWrite 是受控写的观测结果（仅 file_write 动作非 nil）。
	FileWrite *FileWriteResult `json:"file_write,omitempty"`
}

// FileWriteResult 是一次受控写的观测结果（不记全文，只记哈希与元数据）。
type FileWriteResult struct {
	// Path 是实际落盘的绝对路径。
	Path string `json:"path"`
	// Size 是写入字节数。
	Size int `json:"size"`
	// Mode 是落盘权限位（0644 的十进制值）。
	Mode uint32 `json:"mode"`
	// SHA256 是写入内容的哈希。
	SHA256 string `json:"sha256"`
	// CopyPath 是写前备份路径；新文件为空。
	CopyPath string `json:"copy_path,omitempty"`
}

// Auditor 是审计出口，由装配层注入（写 store.PutAudit）；nil 表示不审计，
// 但生产装配必须注入——没有审计的提权通道不可上线。
type Auditor interface {
	Record(ctx context.Context, ev Event) error
}

// hintDetail 是错误 detail 里的可操作提示（与 requires_restart 同形）。
type hintDetail struct {
	// Hint 面向用户，必须给出可执行的下一步。
	Hint string `json:"hint"`
}

// errCode 构造带 hint 的协议错误：hint 放 detail.hint，HTTP 层原样透出。
func errCode(code, message, hint string) *pluginapi.Error {
	protocolErr := &pluginapi.Error{Code: code, Message: message}
	if hint == "" {
		return protocolErr
	}
	raw, err := json.Marshal(hintDetail{Hint: hint})
	if err != nil {
		return protocolErr
	}
	protocolErr.Detail = raw
	return protocolErr
}
