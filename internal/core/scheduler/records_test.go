package scheduler

import (
	"context"
	"testing"
	"time"
)

// TestRunsTrimmedToMax 验证执行记录只保留最近 maxRuns 条。
func TestRunsTrimmedToMax(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	for i := 0; i < maxRuns+5; i++ {
		service.saveRun(Run{TaskID: "t", StartedAt: clock.Now().Add(time.Duration(i) * time.Second), FinishedAt: clock.Now(), Status: StatusOK})
	}
	runs, err := service.loadRuns()
	if err != nil {
		t.Fatalf("读取记录失败: %v", err)
	}
	if len(runs) != maxRuns {
		t.Fatalf("应保留 %d 条，实际 %d", maxRuns, len(runs))
	}
}

// TestSyncCertRenewTask 验证 cert_renew 配置迁移为内置任务（启用/禁用）。
func TestSyncCertRenewTask(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	service.certEnabled, service.certInterval = true, 6*time.Hour
	if err := service.syncCertRenewTask(); err != nil {
		t.Fatalf("注册内置任务失败: %v", err)
	}
	task, err := service.loadTask(builtinCertRenewID)
	if err != nil || !task.Enabled || task.IntervalS != 21600 || task.Plugin != BuiltinPlugin {
		t.Fatalf("内置任务不符合预期: %+v（err=%v）", task, err)
	}
	service.certEnabled = false
	if err := service.syncCertRenewTask(); err != nil {
		t.Fatalf("禁用内置任务失败: %v", err)
	}
	if task, _ := service.loadTask(builtinCertRenewID); task.Enabled {
		t.Fatalf("关闭 cert_renew 后内置任务应禁用: %+v", task)
	}
}

// TestBuiltinTaskRequiresHandler 验证内置任务无处理器时报错（不假装成功）。
func TestBuiltinTaskRequiresHandler(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	_, err := service.invoke(context.Background(), Task{Plugin: BuiltinPlugin, Method: CertRenewMethod})
	if err == nil {
		t.Fatal("内置处理器未装配时应返回错误")
	}
}

// TestLoopSurvivesRequestContext 回归：创建任务的请求 ctx 结束后 ticker 不能跟着退出。
//
// 曾经的缺陷：Add 把 r.Context() 传给调度循环，HTTP 响应写完即取消 → ticker 秒退，
// 任务永远不执行（真机 18849 实测暴露）。
func TestLoopSurvivesRequestContext(t *testing.T) {
	invoker := &fakeInvoker{}
	service, clock := newTestServiceWithTick(t, invoker, 20*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	task, err := service.Add(ctx, CreateInput{Name: "ping", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *", TimeoutS: 5})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	cancel() // 模拟 HTTP 请求结束
	task.NextRunAt = clock.Now().Add(-time.Second)
	if err := service.saveTask(task); err != nil {
		t.Fatalf("回写失败: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if invoker.Calls() >= 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("请求 ctx 结束后 ticker 不再派发任务")
}

// TestLoopStopsWhenNoEnabledTasks 验证"默认零后台定时器"：无启用任务时不起循环，
// 最后一个启用任务删除后循环停掉。
func TestLoopStopsWhenNoEnabledTasks(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	ctx := context.Background()
	disabled := false
	if _, err := service.Add(ctx, CreateInput{Name: "d", Plugin: "echo", Method: "echo.ping",
		Schedule: "0 3 * * *", Enabled: &disabled}); err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	service.mu.Lock()
	started := service.cancel != nil
	service.mu.Unlock()
	if started {
		t.Fatal("全部任务禁用时不应启动循环")
	}
	task, err := service.Add(ctx, CreateInput{Name: "e", Plugin: "echo", Method: "echo.ping", Schedule: "0 3 * * *"})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	service.mu.Lock()
	started = service.cancel != nil
	service.mu.Unlock()
	if !started {
		t.Fatal("有启用任务时应启动循环")
	}
	if err := service.Delete(ctx, task.ID); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		service.mu.Lock()
		still := service.cancel != nil
		service.mu.Unlock()
		if !still {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("删除最后一个启用任务后循环应停止")
}
