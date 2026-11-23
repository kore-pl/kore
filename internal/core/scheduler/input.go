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

// normalize 校验并归一化输入：字段范围、表达式可解析、Params 为对象。
func (in CreateInput) normalize(now time.Time) (Task, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 64 {
		return Task{}, fmt.Errorf("%w: name 必填且 ≤64 字符", ErrInvalid)
	}
	if !pluginIDPattern.MatchString(in.Plugin) {
		return Task{}, fmt.Errorf("%w: plugin %q 不合法", ErrInvalid, in.Plugin)
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
