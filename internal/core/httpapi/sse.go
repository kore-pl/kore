package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 任务进度事件（CORE §2.10）：只推送本进程内的安装/升级任务，不落库、不跨重启。
const (
	// taskEventProgress 阶段进度：{task_id,phase,percent,message}。
	taskEventProgress = "task.progress"
	// taskEventDone 任务成功结束。
	taskEventDone = "task.done"
	// taskEventFailed 任务失败（phase 为最后成功进入的阶段）。
	taskEventFailed = "task.failed"
	// taskEventBuffer 是单订阅者缓冲；写满即丢事件，绝不阻塞安装主流程。
	taskEventBuffer = 16
)

// taskEvent 是一条任务事件；Data 序列化时 Type 只作为 SSE 事件名，不进 data。
type taskEvent struct {
	// Type 事件名（task.progress / task.done / task.failed）。
	Type string `json:"-"`
	// TaskID 任务标识，固定为 <plugin-id>@<version>，前端据此过滤。
	TaskID string `json:"task_id"`
	// Phase 阶段名（download/verify/extract/register/reload）；终态事件可空。
	Phase string `json:"phase,omitempty"`
	// Percent 总体进度 0–100。
	Percent int `json:"percent,omitempty"`
	// Message 面向用户的一句话说明。
	Message string `json:"message,omitempty"`
}

// TaskEvents 是进程内任务进度扇出中心。
//
// G-19：纯内存 map + chan，无后台 goroutine、无 ticker、无轮询；订阅者随请求结束退订。
// 只承载"本进程正在安装/升级的插件"进度，不是通用事件总线（事件总线归 bus）。
type TaskEvents struct {
	mu   sync.Mutex
	subs map[chan taskEvent]struct{}
	// last 记录每个任务的最后阶段，供 task.failed 报告"卡在哪个阶段"。
	last map[string]string
}

// NewTaskEvents 构造空的事件中心；nil 是其所有方法的合法接收者（不推送）。
func NewTaskEvents() *TaskEvents {
	return &TaskEvents{
		subs: make(map[chan taskEvent]struct{}),
		last: make(map[string]string),
	}
}

// taskID 是任务标识口径，前端必须用同一拼接规则过滤事件。
func taskID(id, version string) string { return id + "@" + version }

// subscribe 注册一个订阅者，返回只读通道与幂等的退订函数（关闭通道）。
func (h *TaskEvents) subscribe() (<-chan taskEvent, func()) {
	if h == nil {
		ch := make(chan taskEvent)
		close(ch)
		return ch, func() {}
	}
	ch := make(chan taskEvent, taskEventBuffer)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			h.mu.Lock()
			if _, ok := h.subs[ch]; ok {
				delete(h.subs, ch)
				close(ch)
			}
			h.mu.Unlock()
		})
	}
}

// publish 扇出一条事件；通道满的订阅者被跳过（宁可丢 UI 帧，不拖慢安装）。
func (h *TaskEvents) publish(ev taskEvent) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if ev.Type == taskEventProgress && ev.Phase != "" {
		h.last[ev.TaskID] = ev.Phase
	}
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
		}
	}
	if ev.Type != taskEventProgress {
		delete(h.last, ev.TaskID)
	}
}

// PublishProgress 上报一次阶段进度；由装配层注入 installer.Options.Progress。
func (h *TaskEvents) PublishProgress(id, version, phase string, percent int, message string) {
	h.publish(taskEvent{
		Type: taskEventProgress, TaskID: taskID(id, version),
		Phase: phase, Percent: percent, Message: message,
	})
}

// publishDone 广播任务成功结束。
func (h *TaskEvents) publishDone(id, version, message string) {
	h.publish(taskEvent{Type: taskEventDone, TaskID: taskID(id, version), Percent: 100, Message: message})
}

// publishFailed 广播任务失败，并带上最后进入的阶段。
func (h *TaskEvents) publishFailed(id, version, message string) {
	phase := ""
	if h != nil {
		h.mu.Lock()
		phase = h.last[taskID(id, version)]
		h.mu.Unlock()
	}
	h.publish(taskEvent{Type: taskEventFailed, TaskID: taskID(id, version), Phase: phase, Message: message})
}

// handleEvents 是 GET /api/v1/events 的 SSE 端点。
//
// 请求级连接：订阅本请求的 chan，客户端断开（ctx.Done）即退订并返回；
// 不起心跳定时器（G-19），也不持有跨请求 goroutine。
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"当前连接不支持事件推送（HTTP/1.1 需可 flush）", "")
		return
	}
	if s.taskEvents == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED, "事件推送后端未装配", "")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// 首帧注释让浏览器立刻进入 OPEN，前端据此判定 SSE 可用。
	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	ch, cancel := s.taskEvents.subscribe()
	defer cancel()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-ch:
			if !open {
				return
			}
			payload, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, payload); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// taskFailureMessage 取面向用户的失败文案（协议错误的 message 已经是人话）。
func taskFailureMessage(err error) string {
	var protocolErr *pluginapi.Error
	if errors.As(err, &protocolErr) && protocolErr.Message != "" {
		return protocolErr.Message
	}
	return err.Error()
}
