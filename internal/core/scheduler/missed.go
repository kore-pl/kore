package scheduler

import (
	"time"
)

// markMissed 记录一次错过：不补跑、累加 missed_count、从 now 重算下次时间。
func (s *Service) markMissed(task Task, now time.Time) {
	planned := task.NextRunAt
	task.MissedCount++
	task.LastResult = StatusMissed
	next, err := task.nextRun(now)
	if err != nil {
		task.Enabled = false
		s.log.Error("表达式无法计算下次时间，任务已自动禁用", "task_id", task.ID, "err", err)
	} else {
		task.NextRunAt = next
	}
	s.saveRun(Run{TaskID: task.ID, StartedAt: planned, FinishedAt: now,
		Status: StatusMissed, Error: "服务停机期间错过，不补跑"})
	if err := s.saveTask(task); err != nil {
		s.log.Warn("保存错过状态失败", "task_id", task.ID, "err", err)
	}
	s.log.Warn("定时任务错过，不补跑", "task_id", task.ID, "planned_at", planned)
}
