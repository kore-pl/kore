package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// TestDispatchRunsDueTask 验证到期任务被执行、记录落库、下次时间推进。
func TestDispatchRunsDueTask(t *testing.T) {
	invoker := &fakeInvoker{}
	service, clock := newTestService(t, invoker)
	task, err := service.Add(context.Background(), CreateInput{Name: "ping", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *"})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	task.NextRunAt = clock.Now().Add(-time.Second)
	if err := service.saveTask(task); err != nil {
		t.Fatalf("回写失败: %v", err)
	}
	service.dispatchDue(context.Background())
	waitIdle(t, service)
	if invoker.Calls() != 1 {
		t.Fatalf("应执行 1 次，实际 %d", invoker.Calls())
	}
	runs, err := service.loadRuns()
	if err != nil || len(runs) != 1 || runs[0].Status != StatusOK {
		t.Fatalf("执行记录不符合预期: %+v（err=%v）", runs, err)
	}
	updated, err := service.loadTask(task.ID)
	if err != nil || updated.LastRunAt == nil || updated.LastResult != StatusOK {
		t.Fatalf("任务回填不符合预期: %+v（err=%v）", updated, err)
	}
	if !updated.NextRunAt.After(clock.Now()) {
		t.Fatalf("下次执行时间应已推进: %s", updated.NextRunAt)
	}
}

// TestStartMarksMissedWithoutCatchUp 验证停机期间错过的任务不补跑、只记 missed。
func TestStartMarksMissedWithoutCatchUp(t *testing.T) {
	invoker := &fakeInvoker{}
	service, clock := newTestService(t, invoker)
	task, err := service.Add(context.Background(), CreateInput{Name: "ping", Plugin: "echo", Method: "echo.ping", Schedule: "0 3 * * *"})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	task.NextRunAt = clock.Now().Add(-48 * time.Hour)
	if err := service.saveTask(task); err != nil {
		t.Fatalf("回写失败: %v", err)
	}
	// 模拟停机后重启：Start 应标 missed 且从 now 重算下次时间。
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	if invoker.Calls() != 0 {
		t.Fatalf("错过任务不得补跑，实际执行 %d 次", invoker.Calls())
	}
	runs, _ := service.loadRuns()
	if len(runs) != 1 || runs[0].Status != StatusMissed {
		t.Fatalf("应有一条 missed 记录，实际 %+v", runs)
	}
	updated, err := service.loadTask(task.ID)
	if err != nil || updated.MissedCount != 1 || !updated.NextRunAt.After(clock.Now()) {
		t.Fatalf("错过统计或下次时间不符合预期: %+v（err=%v）", updated, err)
	}
}

// TestNoConcurrentRun 验证同一任务不并发：执行中再次触发被拒绝/跳过。
func TestNoConcurrentRun(t *testing.T) {
	release := make(chan struct{})
	invoker := &fakeInvoker{fn: func(ctx context.Context) (json.RawMessage, error) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return json.RawMessage(`{}`), nil
	}}
	service, clock := newTestService(t, invoker)
	task, err := service.Add(context.Background(), CreateInput{Name: "ping", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *", TimeoutS: 30})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	task.NextRunAt = clock.Now().Add(-time.Second)
	if err := service.saveTask(task); err != nil {
		t.Fatalf("回写失败: %v", err)
	}
	service.dispatchDue(context.Background())
	if _, err := service.RunNow(context.Background(), task.ID); !errors.Is(err, ErrBusy) {
		t.Fatalf("执行中手动触发应返回 ErrBusy，实际 %v", err)
	}
	service.launch(context.Background(), task, clock.Now())
	close(release)
	waitIdle(t, service)
	runs, _ := service.loadRuns()
	skipped := 0
	for _, run := range runs {
		if run.Status == StatusSkipped {
			skipped++
		}
	}
	if skipped != 1 {
		t.Fatalf("应有一条 skipped 记录，实际 %d（runs=%+v）", skipped, runs)
	}
}

// TestTimeoutCancels 验证超时取消并记 timeout。
func TestTimeoutCancels(t *testing.T) {
	invoker := &fakeInvoker{fn: func(ctx context.Context) (json.RawMessage, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	service, _ := newTestService(t, invoker)
	task, err := service.Add(context.Background(), CreateInput{Name: "ping", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *", TimeoutS: 1})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	run, err := service.RunNow(context.Background(), task.ID)
	if err != nil {
		t.Fatalf("立即执行失败: %v", err)
	}
	if run.Status != StatusTimeout {
		t.Fatalf("应记 timeout，实际 %s（%s）", run.Status, run.Error)
	}
}
