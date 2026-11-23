package scheduler

import (
	"context"
	"time"
)

// loop 是唯一的周期源：单 goroutine + 单 ticker。
func (s *Service) loop(ctx context.Context, done chan struct{}) {
	defer func() {
		s.mu.Lock()
		if s.done == done {
			s.cancel, s.done = nil, nil
		}
		s.mu.Unlock()
		close(done)
	}()
	ticker := time.NewTicker(s.tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.dispatchDue(ctx)
		}
	}
}

// startLoop 幂等启动循环；生命周期只跟随 Stop()，不跟随任何请求 ctx。
func (s *Service) startLoop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return
	}
	loopCtx, cancel := context.WithCancel(s.baseCtx)
	done := make(chan struct{})
	s.cancel, s.done = cancel, done
	go s.loop(loopCtx, done)
}

// cancelLoop 停掉循环并等待退出；无循环时直接返回。
func (s *Service) cancelLoop() {
	s.mu.Lock()
	cancel, done := s.cancel, s.done
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

// stopIfIdle 在没有启用任务时停掉循环（守住"默认零后台定时器"）。
func (s *Service) stopIfIdle() {
	tasks, err := s.loadTasks()
	if err != nil {
		s.log.Warn("读取任务失败，保留调度循环", "err", err)
		return
	}
	for _, task := range tasks {
		if task.Enabled {
			return
		}
	}
	s.cancelLoop()
}

// dispatchDue 派发所有到期任务；同一任务并发时跳过并记 skipped。
func (s *Service) dispatchDue(ctx context.Context) {
	tasks, err := s.loadTasks()
	if err != nil {
		s.log.Warn("扫描到期任务失败", "err", err)
		return
	}
	now := s.now()
	for _, task := range tasks {
		if !task.Enabled || task.NextRunAt.After(now) {
			continue
		}
		if now.Sub(task.NextRunAt) > missGrace {
			s.markMissed(task, now)
			continue
		}
		s.launch(ctx, task, now)
	}
}

// launch 先推进 next_run_at 再异步执行，避免下一个 tick 重复派发。
func (s *Service) launch(ctx context.Context, task Task, now time.Time) {
	s.mu.Lock()
	if s.running[task.ID] {
		s.mu.Unlock()
		s.saveRun(Run{TaskID: task.ID, StartedAt: now, FinishedAt: now,
			Status: StatusSkipped, Error: "上一次执行未完成，本次跳过"})
		s.log.Warn("定时任务仍在执行，本次跳过", "task_id", task.ID)
		return
	}
	s.running[task.ID] = true
	s.mu.Unlock()
	if next, err := task.nextRun(now); err == nil {
		task.NextRunAt = next
		if err := s.saveTask(task); err != nil {
			s.log.Warn("推进下次执行时间失败", "task_id", task.ID, "err", err)
		}
	}
	go func() {
		defer s.release(task.ID)
		s.execute(ctx, task)
	}()
}
