package scheduler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// CreateInput 是创建任务的输入；Enabled 为 nil 时默认启用。
type CreateInput struct {
	// Name 名称。
	Name string `json:"name"`
	// Plugin 目标插件 id。
	Plugin string `json:"plugin"`
	// Method 目标方法名。
	Method string `json:"method"`
	// Params 方法参数（缺省为 {}）。
	Params json.RawMessage `json:"params"`
	// Schedule 5 段表达式。
	Schedule string `json:"schedule"`
	// IntervalS 固定周期秒数。
	IntervalS int `json:"interval_s"`
	// TimeoutS 单次超时秒数（缺省 300）。
	TimeoutS int `json:"timeout_s"`
	// Enabled 是否启用；nil 视为 true。
	Enabled *bool `json:"enabled"`
}

// UpdateInput 是就地修改任务的输入（PUT /api/v1/scheduler/tasks/{id}）。
//
// 字段一律用指针表达"这次改不改"：缺省（nil）沿用原值，给了就按新值校验。
// 目标插件与方法不在可改范围内——改它们等于换成另一条任务，请删除后重建，
// 免得"改了计划却仍在调用旧动作"这种静默错位。
type UpdateInput struct {
	// Name 新名称（≤64 字符）。
	Name *string `json:"name"`
	// Params 新的方法参数（必须是 JSON 对象）。
	Params *json.RawMessage `json:"params"`
	// Schedule 新的 5 段表达式；给了就切到表达式模式（清空 interval_s）。
	Schedule *string `json:"schedule"`
	// IntervalS 新的固定周期秒数；给了就切到周期模式（清空 schedule）。
	IntervalS *int `json:"interval_s"`
	// TimeoutS 新的单次超时秒数（1–3600）。
	TimeoutS *int `json:"timeout_s"`
	// Enabled 新的启停状态；停用后不参与调度，历史记录保留。
	Enabled *bool `json:"enabled"`
}

// merge 把就地修改叠加到现有任务上，返回待校验的 CreateInput。
//
// schedule 与 interval_s 互斥：两个都显式给属于用法错误（不知道该切到哪种模式），
// 只给一个时另一个被清空——这是"就地改计划"的核心语义，不能两个都留下。
func (in UpdateInput) merge(task Task) (CreateInput, bool, error) {
	merged := CreateInput{
		Name: task.Name, Plugin: task.Plugin, Method: task.Method, Params: task.Params,
		Schedule: task.Schedule, IntervalS: task.IntervalS, TimeoutS: task.TimeoutS,
	}
	enabled := task.Enabled
	if in.Name != nil {
		merged.Name = *in.Name
	}
	if in.Params != nil {
		merged.Params = *in.Params
	}
	if in.TimeoutS != nil {
		merged.TimeoutS = *in.TimeoutS
	}
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	switch {
	case in.Schedule != nil && in.IntervalS != nil:
		return CreateInput{}, false, fmt.Errorf("%w: schedule 与 interval_s 不能同时修改，请只给一个", ErrInvalid)
	case in.Schedule != nil:
		merged.Schedule, merged.IntervalS = *in.Schedule, 0
	case in.IntervalS != nil:
		merged.IntervalS, merged.Schedule = *in.IntervalS, ""
	}
	return merged, enabled, nil
}

// normalize 校验并归一化输入：字段范围、表达式可解析、Params 为对象。
func (in CreateInput) normalize(now time.Time) (Task, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 64 {
		return Task{}, fmt.Errorf("%w: name 必填且 ≤64 字符", ErrInvalid)
	}
	if !pluginIDPattern.MatchString(in.Plugin) {
		return Task{}, fmt.Errorf("%w: plugin %q 不合法", ErrInvalid, in.Plugin)
	}
	// 内置任务保留名只允许内核自己写（BuiltinPlugin 是伪插件名，不是真插件）。
	// 放行等于给「审计删除」开出第二个入口：调用方自建 plugin=kore/method=audit.clean
	// 的任务并带上自己的 params，就能把审计清零（P1，见 api-security-redteam §5.2）。
	if in.Plugin == BuiltinPlugin {
		return Task{}, fmt.Errorf("%w: plugin %q 是内核内置任务的保留名，不能通过 API 创建任务；内置任务由内核自行注册", ErrInvalid, in.Plugin)
	}
	if !methodNamePattern.MatchString(in.Method) {
		return Task{}, fmt.Errorf("%w: method %q 不合法", ErrInvalid, in.Method)
	}
	params, err := normalizeParams(in.Params)
	if err != nil {
		return Task{}, err
	}
	timeout := in.TimeoutS
	if timeout == 0 {
		timeout = DefaultTimeoutS
	}
	if timeout < 1 || timeout > maxTimeoutS {
		return Task{}, fmt.Errorf("%w: timeout_s 必须在 1–%d 之间", ErrInvalid, maxTimeoutS)
	}
	if (in.Schedule == "" && in.IntervalS == 0) || (in.Schedule != "" && in.IntervalS != 0) {
		return Task{}, fmt.Errorf("%w: schedule 与 interval_s 必须恰好给一个", ErrInvalid)
	}
	if in.IntervalS != 0 && (in.IntervalS < minIntervalS || in.IntervalS > maxIntervalS) {
		return Task{}, fmt.Errorf("%w: interval_s 必须在 %d–%d 之间", ErrInvalid, minIntervalS, maxIntervalS)
	}
	if in.Schedule != "" {
		if _, err := Parse(in.Schedule); err != nil {
			return Task{}, err
		}
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	return Task{
		Name: name, Plugin: in.Plugin, Method: in.Method, Params: params,
		Schedule: in.Schedule, IntervalS: in.IntervalS, Enabled: enabled,
		TimeoutS: timeout, CreatedAt: now,
	}, nil
}

// normalizeParams 把空值归一为 {}，非对象 JSON 一律拒绝。
func normalizeParams(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage(`{}`), nil
	}
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return nil, fmt.Errorf("%w: params 必须是 JSON 对象", ErrInvalid)
	}
	return json.RawMessage(append([]byte(nil), trimmed...)), nil
}

// nextRun 计算 after 之后的下次执行时刻；找不到可行时刻返回错误（表达式过窄）。
func (t Task) nextRun(after time.Time) (time.Time, error) {
	if t.IntervalS > 0 {
		return after.Add(time.Duration(t.IntervalS) * time.Second), nil
	}
	schedule, err := Parse(t.Schedule)
	if err != nil {
		return time.Time{}, err
	}
	next, ok := schedule.Next(after)
	if !ok {
		return time.Time{}, fmt.Errorf("%w: 表达式 %q 在 8 年内没有可行执行时刻", ErrInvalid, t.Schedule)
	}
	return next, nil
}
