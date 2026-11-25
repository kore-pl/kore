package scheduler

import (
	"encoding/json"
	"errors"
	"regexp"
	"time"
)

// 错误分类：HTTP 层按这三类映射状态码，不解析错误文本。
var (
	// ErrInvalid 表示任务定义或表达式非法（400）。
	ErrInvalid = errors.New("定时任务参数非法")
	// ErrNotFound 表示任务不存在（404）。
	ErrNotFound = errors.New("定时任务不存在")
	// ErrBusy 表示同一任务上一次仍在执行（409）。
	ErrBusy = errors.New("定时任务正在执行")
	// ErrDisabled 表示任务已禁用但被要求立即执行（409）。
	ErrDisabled = errors.New("定时任务已禁用")
)

// 执行结果状态（落 scheduler_runs.status，也回填 task.last_result）。
const (
	// StatusOK 执行成功。
	StatusOK = "ok"
	// StatusFailed 执行返回错误。
	StatusFailed = "failed"
	// StatusTimeout 超过 task.timeout_s 被取消。
	StatusTimeout = "timeout"
	// StatusSkipped 上一次未完成，本次跳过。
	StatusSkipped = "skipped"
	// StatusMissed 停机期间错过，不补跑。
	StatusMissed = "missed"
)

// 任务默认值与边界。
const (
	// DefaultTimeoutS 是单任务默认超时（5 分钟，ADR-0019）。
	DefaultTimeoutS = 300
	// maxTimeoutS 是超时上限（1 小时），避免任务永久占槽。
	maxTimeoutS = 3600
	// minIntervalS / maxIntervalS 是 interval 型任务的周期边界（30s–1 年）。
	minIntervalS = 30
	maxIntervalS = 366 * 24 * 3600
	// maxRuns 是执行记录保留条数（ADR-0019）。
	maxRuns = 100
	// defaultRunLimit 是执行历史查询的缺省条数（GET /scheduler/tasks/{id}/runs）。
	defaultRunLimit = 20
	// builtinCertRenewID 是迁移进来的内置任务 id（原 cert_renew 定时器）。
	builtinCertRenewID = "builtin-cert-renew"
	// builtinAuditCleanID 是审计按龄清理的内置任务 id（ADR-0044）。
	builtinAuditCleanID = "builtin-audit-clean"
	// BuiltinPlugin 是内置任务使用的伪插件名（由装配层注入的处理函数接管）。
	BuiltinPlugin = "kore"
	// CertRenewMethod 是内置任务到点执行的方法名。
	CertRenewMethod = "cert.renew_due"
	// AuditCleanMethod 是审计按龄清理内置任务的方法名（由 scheduler 直接执行，
	// 不经插件调用面；DATA-MODEL §11）。
	AuditCleanMethod = "audit.clean"
)

// 任务字段校验用的语法：插件 id 与插件方法名（与 PLUGIN-PROTOCOL §7.2 同口径）。
var (
	pluginIDPattern   = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	methodNamePattern = regexp.MustCompile(`^[a-z][A-Za-z0-9_-]*(\.[a-z][A-Za-z0-9_-]*)*$`)
)

// Task 是一条定时任务；表达式与周期二选一。
//
// 字段全部显式类型（G-24）；Params 是插件方法参数的原始 JSON，
// 属于受控例外（内核不解析业务参数）。
type Task struct {
	// ID 任务 id（创建时由内核生成；内置任务用固定 id）。
	ID string `json:"id"`
	// Name 人类可读名称。
	Name string `json:"name"`
	// Plugin 目标插件 id；内置任务为 "kore"。
	Plugin string `json:"plugin"`
	// Method 目标方法名（插件内完整方法名，如 echo.ping）。
	Method string `json:"method"`
	// Params 方法参数原始 JSON（必须是对象）。
	Params json.RawMessage `json:"params"`
	// Schedule 5 段表达式（与 interval_s 二选一）。
	Schedule string `json:"schedule,omitempty"`
	// IntervalS 固定周期秒数（与 cron 二选一，30–31536000）。
	IntervalS int `json:"interval_s,omitempty"`
	// Enabled 是否启用；禁用后不参与调度。
	Enabled bool `json:"enabled"`
	// TimeoutS 单次执行超时秒数（默认 300）。
	TimeoutS int `json:"timeout_s"`
	// NextRunAt 下次执行时刻（UTC 存储，按进程本地时区计算）。
	NextRunAt time.Time `json:"next_run_at"`
	// LastRunAt 最近一次执行开始时刻；从未执行为 nil。
	LastRunAt *time.Time `json:"last_run_at,omitempty"`
	// LastResult 最近一次执行结果（ok/failed/timeout/skipped/missed）。
	LastResult string `json:"last_result,omitempty"`
	// MissedCount 累计错过次数（停机不补跑）。
	MissedCount int `json:"missed_count"`
	// CreatedAt 创建时刻。
	CreatedAt time.Time `json:"created_at"`
}

// Run 是一条执行记录（scheduler_runs，保留最近 100 条）。
type Run struct {
	// TaskID 关联任务 id。
	TaskID string `json:"task_id"`
	// StartedAt 开始时刻；missed 记录用原定时刻。
	StartedAt time.Time `json:"started_at"`
	// FinishedAt 结束时刻。
	FinishedAt time.Time `json:"finished_at"`
	// Status 执行结果（见 Status* 常量）。
	Status string `json:"status"`
	// Error 失败原因；成功时为空。
	Error string `json:"error,omitempty"`
	// DurMS 耗时毫秒。
	DurMS int64 `json:"dur_ms"`
}
