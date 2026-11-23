package scheduler

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/pengtang1024/kore/internal/core/store"
)

// 任务与执行记录的 bucket 名（DATA-MODEL §5，schema v1 的追加 bucket）。
const (
	// bucketTasks 存任务定义，key = task id，value = Task JSON。
	bucketTasks = "scheduler_tasks"
	// bucketRuns 存执行记录，key = 零填充纳秒时刻 + task id（字典序即时间序）。
	bucketRuns = "scheduler_runs"
)

// loadTasks 读出全部任务（按 next_run_at、id 升序，便于前端直接展示）。
func (s *Service) loadTasks() ([]Task, error) {
	tasks := make([]Task, 0, 8)
	err := s.store.View(func(tx *store.Tx) error {
		return tx.ForEach(bucketTasks, func(key, value []byte) error {
			var task Task
			if err := json.Unmarshal(value, &task); err != nil {
				// 单条损坏不拖垮调度：跳过并记 WARN（不猜内容、不自动删）。
				s.log.Warn("定时任务记录无法解析，已跳过", "task_id", string(key), "err", err)
				return nil
			}
			tasks = append(tasks, task)
			return nil
		})
	})
	if err != nil {
		return nil, fmt.Errorf("读取定时任务失败: %w", err)
	}
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].NextRunAt.Equal(tasks[j].NextRunAt) {
			return tasks[i].ID < tasks[j].ID
		}
		return tasks[i].NextRunAt.Before(tasks[j].NextRunAt)
	})
	return tasks, nil
}

// loadTask 读单个任务；不存在返回 ErrNotFound。
func (s *Service) loadTask(id string) (Task, error) {
	var raw []byte
	err := s.store.View(func(tx *store.Tx) error {
		value, err := tx.Get(bucketTasks, id)
		if err != nil {
			return err
		}
		raw = value
		return nil
	})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Task{}, fmt.Errorf("%w: %s", ErrNotFound, id)
		}
		return Task{}, fmt.Errorf("读取定时任务失败: %w", err)
	}
	var task Task
	if err := json.Unmarshal(raw, &task); err != nil {
		return Task{}, fmt.Errorf("解析定时任务 %s 失败: %w", id, err)
	}
	return task, nil
}

// saveTask 写入或覆盖一条任务。
func (s *Service) saveTask(task Task) error {
	if task.Params == nil {
		task.Params = json.RawMessage(`{}`)
	}
	data, err := json.Marshal(task)
	if err != nil {
		return fmt.Errorf("序列化定时任务失败: %w", err)
	}
	if err := s.store.Update(func(tx *store.Tx) error {
		return tx.Put(bucketTasks, task.ID, data)
	}); err != nil {
		return fmt.Errorf("写入定时任务失败: %w", err)
	}
	return nil
}

// deleteTask 删除任务；不存在返回 ErrNotFound（调用方据此回 404）。
func (s *Service) deleteTask(id string) error {
	err := s.store.Update(func(tx *store.Tx) error {
		if _, err := tx.Get(bucketTasks, id); err != nil {
			return err
		}
		return tx.Delete(bucketTasks, id)
	})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("%w: %s", ErrNotFound, id)
		}
		return fmt.Errorf("删除定时任务失败: %w", err)
	}
	return nil
}

// saveRun 追加一条执行记录，并裁剪到最近 maxRuns 条。
func (s *Service) saveRun(run Run) {
	data, err := json.Marshal(run)
	if err != nil {
		s.log.Warn("执行记录序列化失败", "task_id", run.TaskID, "err", err)
		return
	}
	key := fmt.Sprintf("%020d-%s-%06d", run.StartedAt.UnixNano(), run.TaskID, s.runSeq.Add(1))
	err = s.store.Update(func(tx *store.Tx) error {
		if err := tx.Put(bucketRuns, key, data); err != nil {
			return err
		}
		keys := make([]string, 0, maxRuns+1)
		if err := tx.ForEach(bucketRuns, func(k, _ []byte) error {
			keys = append(keys, string(k))
			return nil
		}); err != nil {
			return err
		}
		for i := 0; i < len(keys)-maxRuns; i++ {
			if err := tx.Delete(bucketRuns, keys[i]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		s.log.Warn("执行记录写入失败", "task_id", run.TaskID, "err", err)
	}
}

// loadRuns 读出全部执行记录（时间升序），供测试与排障使用。
func (s *Service) loadRuns() ([]Run, error) {
	runs := make([]Run, 0, maxRuns)
	err := s.store.View(func(tx *store.Tx) error {
		return tx.ForEach(bucketRuns, func(_, value []byte) error {
			var run Run
			if err := json.Unmarshal(value, &run); err != nil {
				return nil
			}
			runs = append(runs, run)
			return nil
		})
	})
	if err != nil {
		return nil, fmt.Errorf("读取执行记录失败: %w", err)
	}
	return runs, nil
}
