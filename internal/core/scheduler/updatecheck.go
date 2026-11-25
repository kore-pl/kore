package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 内置更新检查任务（ADR-0019 修订记录 / ADR-0059 §3.1，U4 默认关闭）。
//
// 这里只做「唯一 ticker 上注册任务 + 离线短路 + 验签失败结构化提示」的调度语义；
// 真实的「已验签索引 → https 资产 → sha256 → 触发更新」供应链由装配层注入
// （M6），调度器不 import market / installer，也不自行发起任何出站连接（G-01/G-10）。
const (
	// builtinUpdateCheckID 是更新检查内置任务 id（id 固定，不由用户创建）。
	builtinUpdateCheckID = "builtin-update-check"
	// UpdateCheckMethod 是内置任务到点执行的方法名。
	UpdateCheckMethod = "update.check"
	// updateCheckTimeoutS 是单次检查的执行上限：只读索引 + 比对，不给后台留长任务。
	updateCheckTimeoutS = 60
	// defaultUpdateCheckInterval 是检查周期默认 6h；仅 Enabled 时生效。
	defaultUpdateCheckInterval = 6 * time.Hour
)

// 更新检查结果状态（显式枚举，G-24 禁 any/object）。
const (
	// UpdateCheckOfflineSkipped 表示 IsOffline 短路：零出站、零报错。
	UpdateCheckOfflineSkipped = "offline_skipped"
	// UpdateCheckChecked 表示检查器正常返回。
	UpdateCheckChecked = "checked"
)

// updateCheckParams 是内置任务落库的参数形状（源地址显式字符串，G-24）。
type updateCheckParams struct {
	Source string `json:"source"`
}

// UpdateCheckResult 是装配层检查器返回的结构化结果（G-24：字段全部显式类型）。
type UpdateCheckResult struct {
	// Status 取 UpdateCheckOfflineSkipped / UpdateCheckChecked 或检查器自定义状态。
	Status string `json:"status"`
	// Source 本次检查的源标识（不写凭据）。
	Source string `json:"source,omitempty"`
	// Count 本次发现的待更新项数量。
	Count int `json:"count,omitempty"`
	// Detail 是给人看的补充说明；不得含凭据。
	Detail string `json:"detail,omitempty"`
}

// UpdateIndexCheck 是装配层注入的检查能力：读已验签索引并比对版本。
// 注入 nil 时任务即使被误启用也拒绝执行（fail-closed，不假装成功）。
type UpdateIndexCheck func(ctx context.Context, source string) (UpdateCheckResult, error)

// UpdateSignatureError 把验签失败映射成带 requires_restart 的结构化错误。
// Error() 文本本身就是 detail JSON（写进 scheduler_runs.error），前端据此提示重启内核。
type UpdateSignatureError struct {
	Message string
	Detail  string
}

// Error 实现 error：detail 缺省时生成含 requires_restart:true 的最小 JSON。
func (e *UpdateSignatureError) Error() string {
	if e.Detail != "" {
		return e.Detail
	}
	return fmt.Sprintf(`{"requires_restart":true,"hint":%q}`, e.Message)
}

// mapUpdateCheckError 把装配层的验签错误收敛成带 requires_restart 的错误；
// 其他错误原样返回（IO/超时不该误导用户重启）。market 的签名错误是 E_UNAUTHORIZED，
// 这里只看协议码与 detail，不依赖 market 内部函数（薄壳只做规则映射）。
func mapUpdateCheckError(err error) error {
	if err == nil {
		return nil
	}
	var signature *UpdateSignatureError
	if errors.As(err, &signature) {
		return signature
	}
	var protocolErr *pluginapi.Error
	if errors.As(err, &protocolErr) && protocolErr.Code == pluginapi.E_UNAUTHORIZED {
		detail := string(protocolErr.Detail)
		if detail == "" || !strings.Contains(detail, "requires_restart") {
			detail = fmt.Sprintf(`{"requires_restart":true,"hint":%q}`, protocolErr.Message)
		}
		return &UpdateSignatureError{Message: protocolErr.Message, Detail: detail}
	}
	return err
}

// syncUpdateCheckTask 把用户开关映射为内置任务（同 cert_renew / audit_clean 方式）。
// 默认（Enabled=false 且任务不存在）不落任何任务行：空闲行为与今天完全一致，
// 无任何启用任务时 scheduler 不启动 ticker（ADR-0019「默认零后台定时器」）。
func (s *Service) syncUpdateCheckTask() error {
	task, err := s.loadTask(builtinUpdateCheckID)
	missing := errors.Is(err, ErrNotFound)
	if err != nil && !missing {
		return err
	}
	if !s.updateEnabled {
		if missing || !task.Enabled {
			return nil
		}
		task.Enabled = false
		return s.saveTask(task)
	}
	// 显式启用也必须同时具备源地址与检查器：否则拒绝注册，不留"开了却什么都不做"的空任务。
	if strings.TrimSpace(s.updateSource) == "" {
		return fmt.Errorf("scheduler: %s 已启用但更新源为空（拒绝隐式出站）", UpdateCheckMethod)
	}
	if s.updateChecker == nil {
		return fmt.Errorf("scheduler: %s 已启用但检查器未装配（fail-closed）", UpdateCheckMethod)
	}
	interval := int(s.updateInterval.Seconds())
	if interval < minIntervalS {
		interval = minIntervalS
	}
	params, err := json.Marshal(updateCheckParams{Source: s.updateSource})
	if err != nil {
		return fmt.Errorf("序列化更新检查参数失败: %w", err)
	}
	if missing {
		task = Task{ID: builtinUpdateCheckID, Name: "更新检查", Plugin: BuiltinPlugin,
			Method: UpdateCheckMethod, Params: params, IntervalS: interval, Enabled: true,
			TimeoutS: updateCheckTimeoutS, CreatedAt: s.now()}
		next, err := task.nextRun(s.now())
		if err != nil {
			return err
		}
		task.NextRunAt = next
		return s.saveTask(task)
	}
	changed := !task.Enabled || task.IntervalS != interval || task.Plugin != BuiltinPlugin ||
		task.Method != UpdateCheckMethod || string(task.Params) != string(params)
	if !changed {
		return nil
	}
	task.Plugin, task.Method, task.Schedule = BuiltinPlugin, UpdateCheckMethod, ""
	task.IntervalS, task.Enabled, task.Params = interval, true, params
	if task.TimeoutS <= 0 || task.TimeoutS > updateCheckTimeoutS {
		task.TimeoutS = updateCheckTimeoutS
	}
	next, err := task.nextRun(s.now())
	if err != nil {
		return err
	}
	task.NextRunAt = next
	return s.saveTask(task)
}

// runUpdateCheck 执行一次更新检查：离线短路 → 读参数 → 调注入检查器 → 结果/错误落执行记录。
// 只有固定 id 的内置任务可用；用户任务冒用 method 一律拒绝（同 audit.clean 的身份约束）。
func (s *Service) runUpdateCheck(ctx context.Context, task Task) (json.RawMessage, error) {
	if task.ID != builtinUpdateCheckID {
		return nil, fmt.Errorf("%w: %s 只能由内核内置任务 %q 执行（拒绝任务 %q）",
			ErrInvalid, UpdateCheckMethod, builtinUpdateCheckID, task.ID)
	}
	// IsOffline 为真或未注入可达性判定（默认 fail-closed）时直接短路：
	// 不调用检查器、不产生任何出站连接、不报错、不重试。
	if s.isOffline == nil || s.isOffline() {
		out, err := json.Marshal(UpdateCheckResult{
			Status: UpdateCheckOfflineSkipped, Detail: "离线跳过：未发起任何出站连接",
		})
		if err != nil {
			return nil, fmt.Errorf("序列化离线跳过结果失败: %w", err)
		}
		s.log.Info("更新检查离线短路", "task_id", task.ID, "outbound", 0)
		return out, nil
	}
	var in updateCheckParams
	if err := json.Unmarshal(task.Params, &in); err != nil {
		return nil, fmt.Errorf("%w: %s 参数无法解析: %v", ErrInvalid, UpdateCheckMethod, err)
	}
	if strings.TrimSpace(in.Source) == "" {
		return nil, fmt.Errorf("%w: %s 更新源为空（拒绝隐式出站）", ErrInvalid, UpdateCheckMethod)
	}
	if s.updateChecker == nil {
		return nil, fmt.Errorf("scheduler: %s 检查器未装配（fail-closed，不假装成功）", UpdateCheckMethod)
	}
	result, err := s.updateChecker(ctx, in.Source)
	if err != nil {
		return nil, mapUpdateCheckError(err)
	}
	out, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("序列化更新检查结果失败: %w", err)
	}
	return out, nil
}
