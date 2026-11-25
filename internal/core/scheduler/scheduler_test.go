package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// fakeClock 是可推进的测试时钟。
type fakeClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *fakeClock) Set(at time.Time) {
	c.mu.Lock()
	c.at = at
	c.mu.Unlock()
}

// fakeInvoker 记录调用并可注入阻塞/错误行为。
type fakeInvoker struct {
	mu    sync.Mutex
	calls int
	fn    func(ctx context.Context) (json.RawMessage, error)
}

func (f *fakeInvoker) Invoke(ctx context.Context, _, _ string, _ json.RawMessage, _ string) (json.RawMessage, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.fn != nil {
		return f.fn(ctx)
	}
	return json.RawMessage(`{"ok":true}`), nil
}

func (f *fakeInvoker) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// newTestService 打开临时状态库并构造 Service；清理时关闭状态库与循环。
func newTestService(t *testing.T, invoker Invoker) (*Service, *fakeClock) {
	t.Helper()
	return newTestServiceWithTick(t, invoker, time.Hour)
}

// newTestServiceWithTick 允许测试指定 ticker 间隔（回归用例要观察真实循环）。
func newTestServiceWithTick(t *testing.T, invoker Invoker, tick time.Duration) (*Service, *fakeClock) {
	t.Helper()
	db, err := store.Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	clock := &fakeClock{at: time.Date(2026, 11, 23, 9, 46, 0, 0, time.UTC)}
	service, err := New(Options{Store: db, Invoker: invoker, Now: clock.Now, Tick: tick,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatalf("构造调度器失败: %v", err)
	}
	t.Cleanup(func() {
		service.Stop()
		_ = db.Close()
	})
	return service, clock
}

// waitIdle 等待在途任务结束（轮询内部标记，避免用 sleep 猜时间）。
func waitIdle(t *testing.T, service *Service) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		service.mu.Lock()
		busy := len(service.running)
		service.mu.Unlock()
		if busy == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("等待任务结束超时")
}

// TestTaskCRUD 覆盖创建 / 列表 / 读取 / 删除 / 重复删除。
func TestTaskCRUD(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	ctx := context.Background()
	task, err := service.Add(ctx, CreateInput{Name: "ping", Plugin: "echo", Method: "echo.ping", Schedule: "*/5 * * * *"})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	if task.ID == "" || !task.Enabled || task.TimeoutS != DefaultTimeoutS {
		t.Fatalf("任务字段不符合预期: %+v", task)
	}
	if !task.NextRunAt.After(service.now()) {
		t.Fatalf("next_run_at 应在将来: %s", task.NextRunAt)
	}
	tasks, err := service.List(ctx)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("列表应为 1 条，实际 %d（err=%v）", len(tasks), err)
	}
	if err := service.Delete(ctx, task.ID); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if err := service.Delete(ctx, task.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("重复删除应返回 ErrNotFound，实际 %v", err)
	}
	if tasks, _ := service.List(ctx); len(tasks) != 0 {
		t.Fatalf("删除后列表应为空，实际 %d", len(tasks))
	}
}

// TestAddValidatesInput 验证非法输入被拒绝（表达式 / 周期 / 参数）。
func TestAddValidatesInput(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	ctx := context.Background()
	cases := []CreateInput{
		{Name: "x", Plugin: "echo", Method: "echo.ping"},
		{Name: "x", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *", IntervalS: 60},
		{Name: "x", Plugin: "echo", Method: "echo.ping", Schedule: "bad"},
		{Name: "", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *"},
		{Name: "x", Plugin: "Echo", Method: "echo.ping", Schedule: "* * * * *"},
		{Name: "x", Plugin: "echo", Method: "bad method", Schedule: "* * * * *"},
		{Name: "x", Plugin: "echo", Method: "echo.ping", IntervalS: 5},
		{Name: "x", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *", TimeoutS: 9999},
		{Name: "x", Plugin: "echo", Method: "echo.ping", Schedule: "* * * * *", Params: json.RawMessage(`[]`)},
	}
	for _, input := range cases {
		if _, err := service.Add(ctx, input); !errors.Is(err, ErrInvalid) {
			t.Errorf("输入 %+v 应返回 ErrInvalid，实际 %v", input, err)
		}
	}
}

// TestUpdateKeepsIdentityAndHistory：就地修改保留 id / 创建时刻 / 最近执行结果，
// 且修改后的表达式马上重算 next_run_at（不是等下一次 tick 才生效）。
func TestUpdateKeepsIdentityAndHistory(t *testing.T) {
	service, clock := newTestService(t, &fakeInvoker{})
	ctx := context.Background()
	clock.Set(time.Date(2026, 11, 25, 10, 0, 0, 0, time.Local))
	created, err := service.Add(ctx, CreateInput{
		Name: "nightly", Plugin: "echo", Method: "echo.ping", Schedule: "0 3 * * *",
	})
	if err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	lastRun := clock.Now().Add(-time.Hour)
	created.LastRunAt, created.LastResult = &lastRun, StatusFailed
	if err := service.saveTask(created); err != nil {
		t.Fatalf("写回最近执行结果失败: %v", err)
	}

	schedule := "0 4 * * *"
	updated, err := service.Update(ctx, created.ID, UpdateInput{Schedule: &schedule})
	if err != nil {
		t.Fatalf("就地修改失败: %v", err)
	}
	if updated.ID != created.ID || !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Fatalf("就地修改必须保留 id / created_at: %+v", updated)
	}
	if updated.Schedule != schedule || updated.IntervalS != 0 {
		t.Fatalf("表达式未生效: %+v", updated)
	}
	if updated.LastResult != StatusFailed || updated.LastRunAt == nil {
		t.Fatalf("最近执行结果不应被清空: %+v", updated)
	}
	// 现在 10:00，0 4 * * * 的下一个可行时刻是次日 04:00。
	want := time.Date(2026, 11, 26, 4, 0, 0, 0, time.Local)
	if !updated.NextRunAt.Equal(want) {
		t.Fatalf("next_run_at 应重算为 %s，实际 %s", want, updated.NextRunAt)
	}

	enabled := false
	disabled, err := service.Update(ctx, created.ID, UpdateInput{Enabled: &enabled})
	if err != nil || disabled.Enabled {
		t.Fatalf("停用失败: %+v err=%v", disabled, err)
	}
	if _, err := service.Update(ctx, created.ID, UpdateInput{Schedule: &schedule, IntervalS: intPtr(60)}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("同时给 schedule 与 interval_s 应返回 ErrInvalid，实际 %v", err)
	}
	if _, err := service.Update(ctx, "nope", UpdateInput{Enabled: &enabled}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("未知任务应返回 ErrNotFound，实际 %v", err)
	}
}

// TestUpdateRejectsBuiltinTask：内置任务由内核配置在启动时注册，就地修改会被
// 下次启动回填——必须明确拒绝，而不是让用户以为改成功了。
func TestUpdateRejectsBuiltinTask(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	builtin := Task{
		ID: builtinCertRenewID, Name: "证书续期", Plugin: BuiltinPlugin, Method: CertRenewMethod,
		Schedule: "0 3 * * *", Enabled: true, TimeoutS: DefaultTimeoutS, CreatedAt: time.Now(),
	}
	builtin.Params = json.RawMessage(`{}`)
	if err := service.saveTask(builtin); err != nil {
		t.Fatalf("写入内置任务失败: %v", err)
	}
	enabled := false
	if _, err := service.Update(context.Background(), builtinCertRenewID, UpdateInput{Enabled: &enabled}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("内置任务就地修改应返回 ErrInvalid，实际 %v", err)
	}
	reloaded, err := service.loadTask(builtinCertRenewID)
	if err != nil || !reloaded.Enabled {
		t.Fatalf("被拒绝的修改不得写盘: %+v err=%v", reloaded, err)
	}
}

// intPtr 是测试里取 *int 的小工具。
func intPtr(v int) *int { return &v }
