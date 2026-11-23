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
