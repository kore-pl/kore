package scheduler

import (
	"testing"
	"time"
)

// TestSyncLogsMaintainTask 验收"日志切割清理默认生效"的内核侧挂载点：
// 默认（未显式配置）注册一条**插件任务**（plugin=logs, method=logs.maintain）并启用，
// 周期 6h；重启不推迟下次执行；显式负值表示禁用。
func TestSyncLogsMaintainTask(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	// 默认装配：Options 未设置 LogsMaintainInterval → New 落成默认 6h。
	if service.logsMaintainInterval != 6*time.Hour {
		t.Fatalf("默认维护周期=%v，期望 6h（默认启用）", service.logsMaintainInterval)
	}
	if err := service.syncLogsMaintainTask(); err != nil {
		t.Fatalf("注册日志维护任务失败: %v", err)
	}
	task, err := service.loadTask(builtinLogsMaintainID)
	if err != nil {
		t.Fatalf("读取日志维护任务失败: %v", err)
	}
	if !task.Enabled || task.IntervalS != 21600 || task.Plugin != LogsMaintainPlugin || task.Method != LogsMaintainMethod {
		t.Fatalf("日志维护任务不符合预期: %+v", task)
	}
	if task.Schedule != "" || task.TimeoutS != logsMaintainTimeoutS {
		t.Fatalf("日志维护任务字段不符合预期: %+v", task)
	}
	// 重启（再次同步）不得把 next_run_at 往后推。
	first := task.NextRunAt
	if err := service.syncLogsMaintainTask(); err != nil {
		t.Fatalf("再次同步失败: %v", err)
	}
	again, err := service.loadTask(builtinLogsMaintainID)
	if err != nil {
		t.Fatalf("再次读取失败: %v", err)
	}
	if !again.NextRunAt.Equal(first) {
		t.Fatalf("重启后 next_run_at 被推迟：%v → %v", first, again.NextRunAt)
	}
	// 显式禁用：负周期 → 任务保留但 Enabled=false（不删除，便于界面上看到并重新开启）。
	service.logsMaintainInterval = -1
	if err := service.syncLogsMaintainTask(); err != nil {
		t.Fatalf("禁用失败: %v", err)
	}
	disabled, err := service.loadTask(builtinLogsMaintainID)
	if err != nil {
		t.Fatalf("禁用后读取失败: %v", err)
	}
	if disabled.Enabled {
		t.Fatalf("负周期应禁用任务：%+v", disabled)
	}
}
