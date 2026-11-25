package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pengtang1024/kore/internal/core/scheduler"
	"github.com/pengtang1024/kore/internal/core/store"
)

// schedulerInvoker 是测试用调用面：记录调用次数并返回固定结果。
type schedulerInvoker struct {
	calls int
}

func (i *schedulerInvoker) Invoke(context.Context, string, string, json.RawMessage, string) (json.RawMessage, error) {
	i.calls++
	return json.RawMessage(`{"pong":true}`), nil
}

// newSchedulerServer 装配一个只含调度器后端的 httpapi 实例（鉴权未装配，走 admin 口径）。
func newSchedulerServer(t *testing.T) (*Server, *schedulerInvoker) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	db, err := store.Open(t.TempDir(), logger)
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	invoker := &schedulerInvoker{}
	service, err := scheduler.New(scheduler.Options{Store: db, Invoker: invoker, Logger: logger})
	if err != nil {
		t.Fatalf("构造调度器失败: %v", err)
	}
	t.Cleanup(func() {
		service.Stop()
		_ = db.Close()
	})
	return New(Options{Scheduler: service}, nil), invoker
}

// doScheduler 发一次请求并返回状态码与响应体。
func doScheduler(t *testing.T, server *Server, method, path string, body any) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, path, reader)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, req)
	return recorder.Code, recorder.Body.Bytes()
}

// TestSchedulerEndpoints 覆盖列表 / 创建 / 立即执行 / 删除四个端点的主路径。
func TestSchedulerEndpoints(t *testing.T) {
	server, invoker := newSchedulerServer(t)
	body := map[string]any{
		"name": "ping", "plugin": "echo", "method": "echo.ping", "schedule": "*/5 * * * *",
	}
	code, data := doScheduler(t, server, http.MethodPost, schedulerTasksPath, body)
	if code != http.StatusOK {
		t.Fatalf("创建应回 200，实际 %d: %s", code, data)
	}
	var task scheduler.Task
	if err := json.Unmarshal(data, &task); err != nil || task.ID == "" {
		t.Fatalf("创建响应不可解析: %v / %s", err, data)
	}

	code, data = doScheduler(t, server, http.MethodGet, schedulerTasksPath, nil)
	var list schedulerListBody
	if code != http.StatusOK || json.Unmarshal(data, &list) != nil || len(list.Tasks) != 1 {
		t.Fatalf("列表应回 1 条，实际 %d: %s", code, data)
	}

	code, data = doScheduler(t, server, http.MethodPost, schedulerTasksPath+"/"+task.ID+"/run", nil)
	var run scheduler.Run
	if code != http.StatusOK || json.Unmarshal(data, &run) != nil || run.Status != scheduler.StatusOK {
		t.Fatalf("立即执行应成功，实际 %d: %s", code, data)
	}
	if invoker.calls != 1 {
		t.Fatalf("应立即调用插件 1 次，实际 %d", invoker.calls)
	}

	code, data = doScheduler(t, server, http.MethodDelete, schedulerTasksPath+"/"+task.ID, nil)
	if code != http.StatusOK {
		t.Fatalf("删除应回 200，实际 %d: %s", code, data)
	}
	if _, data = doScheduler(t, server, http.MethodGet, schedulerTasksPath, nil); json.Unmarshal(data, &list) != nil || len(list.Tasks) != 0 {
		t.Fatalf("删除后列表应为空: %s", data)
	}
}

// TestSchedulerCreateRejectsBuiltinPlugin 是 P1 攻击路径的端点级回归：
// POST /scheduler/tasks 不得创建 plugin=kore 的内置任务——否则可自建 audit.clean
// 任务、带上 retention_seconds=1 把审计清零（见 api-security-redteam-2026-11-24 §5.2）。
func TestSchedulerCreateRejectsBuiltinPlugin(t *testing.T) {
	server, _ := newSchedulerServer(t)
	body := map[string]any{
		"name": "h", "plugin": "kore", "method": "audit.clean",
		"params":     map[string]any{"retention_seconds": 1, "batch": 1000},
		"interval_s": 3600, "enabled": true,
	}
	code, data := doScheduler(t, server, http.MethodPost, schedulerTasksPath, body)
	if code != http.StatusBadRequest {
		t.Fatalf("创建 plugin=kore 任务应回 400，实际 %d: %s", code, data)
	}
	code, data = doScheduler(t, server, http.MethodGet, schedulerTasksPath, nil)
	var list schedulerListBody
	if code != http.StatusOK || json.Unmarshal(data, &list) != nil || len(list.Tasks) != 0 {
		t.Fatalf("被拒绝的任务不得出现在列表，实际 %d: %s", code, data)
	}
}

// TestSchedulerUpdateInPlace 覆盖 PATCH 语义的就地改计划：
// 改表达式 / 只改启停 / 两个计划字段同时给被拒 / 未知任务 404 / 非法表达式 400。
func TestSchedulerUpdateInPlace(t *testing.T) {
	server, _ := newSchedulerServer(t)
	body := map[string]any{
		"name": "ping", "plugin": "echo", "method": "echo.ping", "schedule": "*/5 * * * *",
	}
	code, data := doScheduler(t, server, http.MethodPost, schedulerTasksPath, body)
	if code != http.StatusOK {
		t.Fatalf("创建应回 200，实际 %d: %s", code, data)
	}
	var created scheduler.Task
	if err := json.Unmarshal(data, &created); err != nil || created.ID == "" {
		t.Fatalf("创建响应不可解析: %v / %s", err, data)
	}
	firstNext := created.NextRunAt

	code, data = doScheduler(t, server, http.MethodPut, schedulerTasksPath+"/"+created.ID,
		map[string]any{"schedule": "0 4 * * *"})
	if code != http.StatusOK {
		t.Fatalf("就地改表达式应回 200，实际 %d: %s", code, data)
	}
	var updated scheduler.Task
	if err := json.Unmarshal(data, &updated); err != nil {
		t.Fatalf("更新响应不可解析: %v / %s", err, data)
	}
	if updated.Schedule != "0 4 * * *" || updated.IntervalS != 0 {
		t.Fatalf("表达式未就地生效: %+v", updated)
	}
	if updated.ID != created.ID || updated.CreatedAt != created.CreatedAt {
		t.Fatalf("就地修改必须保留 id 与创建时刻: %+v", updated)
	}
	if updated.NextRunAt.Equal(firstNext) {
		t.Fatalf("改表达式后下次执行时间应重算，实际仍为 %s", updated.NextRunAt)
	}

	code, data = doScheduler(t, server, http.MethodPut, schedulerTasksPath+"/"+created.ID,
		map[string]any{"enabled": false})
	if code != http.StatusOK {
		t.Fatalf("只改启停应回 200，实际 %d: %s", code, data)
	}
	if err := json.Unmarshal(data, &updated); err != nil || updated.Enabled {
		t.Fatalf("停用未生效: %v / %s", err, data)
	}

	code, data = doScheduler(t, server, http.MethodPut, schedulerTasksPath+"/"+created.ID,
		map[string]any{"schedule": "0 5 * * *", "interval_s": 60})
	if code != http.StatusBadRequest {
		t.Fatalf("同时给 schedule 与 interval_s 应回 400，实际 %d: %s", code, data)
	}
	if code, _ = doScheduler(t, server, http.MethodPut, schedulerTasksPath+"/"+created.ID,
		map[string]any{"schedule": "bad"}); code != http.StatusBadRequest {
		t.Fatalf("非法表达式应回 400，实际 %d", code)
	}
	if code, _ = doScheduler(t, server, http.MethodPut, schedulerTasksPath+"/nope",
		map[string]any{"enabled": true}); code != http.StatusNotFound {
		t.Fatalf("未知任务应回 404，实际 %d", code)
	}
	// 就改结果必须持久化：列表里读到的就是新计划。
	_, data = doScheduler(t, server, http.MethodGet, schedulerTasksPath, nil)
	var list schedulerListBody
	if err := json.Unmarshal(data, &list); err != nil || len(list.Tasks) != 1 {
		t.Fatalf("列表应回 1 条: %v / %s", err, data)
	}
	if list.Tasks[0].Schedule != "0 4 * * *" || list.Tasks[0].Enabled {
		t.Fatalf("就地修改未持久化: %+v", list.Tasks[0])
	}
}

// TestSchedulerRuns 覆盖执行历史端点：跑两次后有两条、最新在前、带保留说明；
// 未知任务 404、非法 limit 400。
func TestSchedulerRuns(t *testing.T) {
	server, _ := newSchedulerServer(t)
	body := map[string]any{
		"name": "ping", "plugin": "echo", "method": "echo.ping", "schedule": "*/5 * * * *",
	}
	code, data := doScheduler(t, server, http.MethodPost, schedulerTasksPath, body)
	if code != http.StatusOK {
		t.Fatalf("创建应回 200，实际 %d: %s", code, data)
	}
	var task scheduler.Task
	if err := json.Unmarshal(data, &task); err != nil {
		t.Fatalf("创建响应不可解析: %s", data)
	}
	for i := 0; i < 2; i++ {
		if code, runData := doScheduler(t, server, http.MethodPost, schedulerTasksPath+"/"+task.ID+"/run", nil); code != http.StatusOK {
			t.Fatalf("第 %d 次立即执行应回 200，实际 %d: %s", i+1, code, runData)
		}
	}

	code, data = doScheduler(t, server, http.MethodGet, schedulerTasksPath+"/"+task.ID+"/runs", nil)
	if code != http.StatusOK {
		t.Fatalf("执行历史应回 200，实际 %d: %s", code, data)
	}
	var runs schedulerRunsBody
	if err := json.Unmarshal(data, &runs); err != nil {
		t.Fatalf("执行历史不可解析: %v / %s", err, data)
	}
	if runs.Count != 2 || len(runs.Runs) != 2 {
		t.Fatalf("应有 2 条记录，实际 %d / %s", runs.Count, data)
	}
	if runs.Runs[0].StartedAt.Before(runs.Runs[1].StartedAt) {
		t.Fatalf("执行历史应最新在前: %+v", runs.Runs)
	}
	if runs.Runs[0].TaskID != task.ID || runs.Runs[0].Status != scheduler.StatusOK {
		t.Fatalf("记录字段不符: %+v", runs.Runs[0])
	}
	if runs.Note == "" {
		t.Fatal("执行历史必须带保留口径说明（避免把轮转误判成丢记录）")
	}

	_, data = doScheduler(t, server, http.MethodGet, schedulerTasksPath+"/"+task.ID+"/runs?limit=1", nil)
	if err := json.Unmarshal(data, &runs); err != nil || runs.Count != 1 {
		t.Fatalf("limit=1 应只回 1 条，实际 %v / %s", err, data)
	}
	if code, _ = doScheduler(t, server, http.MethodGet, schedulerTasksPath+"/"+task.ID+"/runs?limit=abc", nil); code != http.StatusBadRequest {
		t.Fatalf("非法 limit 应回 400，实际 %d", code)
	}
	if code, _ = doScheduler(t, server, http.MethodGet, schedulerTasksPath+"/nope/runs", nil); code != http.StatusNotFound {
		t.Fatalf("未知任务应回 404，实际 %d", code)
	}
}

// TestSchedulerEndpointErrors 覆盖非法输入 / 未知任务 / 未装配三类失败口径。
func TestSchedulerEndpointErrors(t *testing.T) {
	server, _ := newSchedulerServer(t)
	if code, _ := doScheduler(t, server, http.MethodPost, schedulerTasksPath,
		map[string]any{"name": "x", "plugin": "echo", "method": "echo.ping", "schedule": "bad"}); code != http.StatusBadRequest {
		t.Fatalf("非法表达式应回 400，实际 %d", code)
	}
	if code, _ := doScheduler(t, server, http.MethodPost, schedulerTasksPath+"/nope/run", nil); code != http.StatusNotFound {
		t.Fatalf("未知任务应回 404，实际 %d", code)
	}
	if code, _ := doScheduler(t, server, http.MethodDelete, schedulerTasksPath+"/nope", nil); code != http.StatusNotFound {
		t.Fatalf("删除未知任务应回 404，实际 %d", code)
	}
	// 未装配调度器时端点回 501（不假装成功）。
	bare := New(Options{}, nil)
	if code, _ := doScheduler(t, bare, http.MethodGet, schedulerTasksPath, nil); code != http.StatusNotImplemented {
		t.Fatalf("未装配调度器应回 501，实际 %d", code)
	}
}
