package scheduler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// execute 执行一次任务并落执行记录；超时/失败都写记录，不静默吞错。
func (s *Service) execute(ctx context.Context, task Task) Run {
	start := s.now()
	timeout := time.Duration(task.TimeoutS) * time.Second
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_, err := s.invoke(runCtx, task)
	run := Run{TaskID: task.ID, StartedAt: start, FinishedAt: s.now()}
	run.DurMS = run.FinishedAt.Sub(start).Milliseconds()
	switch {
	case err == nil:
		run.Status = StatusOK
	case errors.Is(runCtx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded):
		run.Status = StatusTimeout
		run.Error = fmt.Sprintf("超过 timeout_s=%d 被取消", task.TimeoutS)
	default:
		run.Status = StatusFailed
		run.Error = err.Error()
	}
	s.saveRun(run)
	s.updateLastRun(task.ID, run)
	return run
}

// invoke 分流内置任务与插件任务；内置处理器缺失时返回错误（不假装执行）。
// audit.clean 由 scheduler 直接执行（需要状态库句柄，不经装配层处理器）。
func (s *Service) invoke(ctx context.Context, task Task) (json.RawMessage, error) {
	if task.Plugin == BuiltinPlugin {
		if task.Method == AuditCleanMethod {
			return s.cleanAudit(ctx, task.Params)
		}
		if s.builtin == nil {
			return nil, fmt.Errorf("内置任务处理器未装配")
		}
		return s.builtin(ctx, task.Method, task.Params)
	}
	if s.invoker == nil {
		return nil, fmt.Errorf("插件调用面未装配")
	}
	reqID := fmt.Sprintf("sched-%s-%d", task.ID, s.now().UnixNano())
	return s.invoker.Invoke(ctx, task.Plugin, task.Method, task.Params, reqID)
}

// updateLastRun 回填任务的最近执行信息；任务已删除时跳过（不复活）。
func (s *Service) updateLastRun(id string, run Run) {
	task, err := s.loadTask(id)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			s.log.Warn("回填执行结果失败", "task_id", id, "err", err)
		}
		return
	}
	started := run.StartedAt
	task.LastRunAt = &started
	task.LastResult = run.Status
	if err := s.saveTask(task); err != nil {
		s.log.Warn("保存执行结果失败", "task_id", id, "err", err)
	}
}

// release 清掉任务的执行中标记。
func (s *Service) release(id string) {
	s.mu.Lock()
	delete(s.running, id)
	s.mu.Unlock()
}

// newTaskID 生成任务 id（16 位十六进制，稳定可读、不含业务语义）。
func newTaskID() (string, error) {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "tsk-" + hex.EncodeToString(buffer), nil
}
