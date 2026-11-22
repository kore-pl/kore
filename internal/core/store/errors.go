package store

import (
	"errors"
	"fmt"
)

// 持久层错误分类；调用方用 errors.Is 映射退出码。
var (
	// ErrLocked 表示状态库已被其它进程持有（映射退出码 3）。
	ErrLocked = errors.New("store: 状态库已被占用")
	// ErrStateDir 表示状态目录不可创建或不可写（映射退出码 3）。
	ErrStateDir = errors.New("store: 状态目录不可用")
	// ErrCorrupt 表示状态库打不开或内容损坏（映射退出码 4）。
	ErrCorrupt = errors.New("store: 状态库损坏")
	// ErrSchemaTooNew 表示 schema 高于当前内核（映射退出码 4）。
	ErrSchemaTooNew = errors.New("store: schema 高于当前内核")
	// ErrNotFound 表示键不存在。
	ErrNotFound = errors.New("store: 键不存在")
	// ErrConflict 表示状态冲突。
	ErrConflict = errors.New("store: 状态冲突")
	// ErrBucket 表示 bucket 不存在。
	ErrBucket = errors.New("store: bucket 不存在")
	// ErrValueTooLarge 表示单值超过 1 MiB。
	ErrValueTooLarge = errors.New("store: 值超过 1 MiB 上限")
	// ErrAuditInvalid 表示审计记录不满足 DATA-MODEL §9 约束（result/detail 非法）。
	ErrAuditInvalid = errors.New("store: 审计记录非法")
)

// LockedError 携带锁持有者 pid，便于二次启动直接回显。
type LockedError struct {
	// Path 是状态库文件路径。
	Path string
	// PID 是持有者进程号；0 表示读不到。
	PID int
}

// Error 返回带 pid 的可读错误。
func (e *LockedError) Error() string {
	if e.PID > 0 {
		return fmt.Sprintf("%s: %s（持有者 pid=%d）", ErrLocked, e.Path, e.PID)
	}
	return fmt.Sprintf("%s: %s（无法读取持有者 pid）", ErrLocked, e.Path)
}

// Is 让 errors.Is(err, ErrLocked) 成立。
func (e *LockedError) Is(target error) bool { return target == ErrLocked }
