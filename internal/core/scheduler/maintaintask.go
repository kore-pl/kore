package scheduler

import (
	"encoding/json"
	"errors"
)

// syncLogsMaintainTask 把"日志自动切割与清理"映射为一条**插件任务**（默认启用）。
//
// 为什么必须落在这里（G-19）：内核里唯一的周期来源是 internal/core/scheduler/ 的单 ticker；
// 日志插件（id=logs）是 lazy 常驻插件，**不得**在插件内起 ticker/AfterFunc 续命，
// 所以"按天切割 / 按天清理"的周期由本调度器提供，到点调用插件方法 logs.maintain。
//
// 与 cert_renew / audit.clean 的差别：
//   - 它是**插件任务**（plugin="logs"），不是内置任务（plugin="kore"）：切割/清理是插件业务，
//     内核只负责"到点调一次"，不实现任何日志策略（G-01 薄壳红线）；
//   - 默认**启用**：日志无界增长是真实运维问题（同 ADR-0044 对审计的取舍），
//     装完不配就生效；要停用可把 logs_maintain.interval 设为负值，或直接禁用这条任务。
//
// 插件未安装：任务照样保留，到点执行会以 failed 记录在 scheduler_runs（E_NOTFOUND），
// 不做静默跳过——宁可让用户看到一条失败记录，也不假装"已维护"。
const (
	// builtinLogsMaintainID 是日志自动维护任务的固定 id。
	builtinLogsMaintainID = "builtin-logs-maintain"
	// LogsMaintainMethod 是到点调用日志插件的方法名（插件内实现切割+清理）。
	LogsMaintainMethod = "logs.maintain"
	// LogsMaintainPlugin 是目标插件 id。
	LogsMaintainPlugin = "logs"
	// logsMaintainTimeoutS 是单次维护的执行超时（复制 100 MiB 量级文件足够）。
	logsMaintainTimeoutS = 120
	// defaultLogsMaintainInterval 是默认维护周期（6h：足够让"按天"判断落在同一天，
	// 又不会让单次维护太重；按大小阈值在每次维护时判断）。
	defaultLogsMaintainInterval = 6 * 3600
)

// syncLogsMaintainTask 注册/更新日志自动维护任务（参数未变时保留原 next_run_at，
// 避免频繁重启把首次维护一直往后推）。
func (s *Service) syncLogsMaintainTask() error {
	task, err := s.loadTask(builtinLogsMaintainID)
	missing := errors.Is(err, ErrNotFound)
	if err != nil && !missing {
		return err
	}
	if s.logsMaintainInterval < 0 {
		if missing || !task.Enabled {
			return nil
		}
		task.Enabled = false
		return s.saveTask(task)
	}
	interval := int(s.logsMaintainInterval / 1e9)
	if interval < minIntervalS {
		interval = defaultLogsMaintainInterval
	}
	params := json.RawMessage(`{}`)
	if missing {
		task = Task{ID: builtinLogsMaintainID, Name: "日志自动切割与清理", Plugin: LogsMaintainPlugin,
			Method: LogsMaintainMethod, Params: params, IntervalS: interval, Enabled: true,
			TimeoutS: logsMaintainTimeoutS, CreatedAt: s.now()}
		next, nerr := task.nextRun(s.now())
		if nerr != nil {
			return nerr
		}
		task.NextRunAt = next
		return s.saveTask(task)
	}
	changed := !task.Enabled || task.IntervalS != interval || task.Plugin != LogsMaintainPlugin ||
		task.Method != LogsMaintainMethod || string(task.Params) != string(params)
	if !changed {
		return nil
	}
	task.Plugin, task.Method, task.Schedule = LogsMaintainPlugin, LogsMaintainMethod, ""
	task.IntervalS, task.Enabled = interval, true
	if task.TimeoutS <= 0 || task.TimeoutS > logsMaintainTimeoutS {
		task.TimeoutS = logsMaintainTimeoutS
	}
	return s.saveTask(task)
}
