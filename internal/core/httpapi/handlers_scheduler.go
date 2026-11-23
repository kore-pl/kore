package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/pengtang1024/kore/internal/core/scheduler"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// schedulerTasksPath 是定时任务端点前缀（ADR-0019）。
const schedulerTasksPath = "/api/v1/scheduler/tasks"

// maxSchedulerBody 是定时任务请求体上限（任务定义 + 参数，64 KiB 足够）。
const maxSchedulerBody = 64 << 10

// schedulerListBody 是任务列表响应体。
type schedulerListBody struct {
	// Tasks 按下次执行时间升序。
	Tasks []scheduler.Task `json:"tasks"`
}

// schedulerDeletedBody 是删除成功的响应体。
type schedulerDeletedBody struct {
	// Deleted 固定为 true（不存在的任务回 404，不会伪装成功）。
	Deleted bool `json:"deleted"`
}

// requireScheduler 取调度器；未装配时回 501（不假装任务已保存）。
func (s *Server) requireScheduler(w http.ResponseWriter) (*scheduler.Service, bool) {
	if s.scheduler == nil {
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"定时任务调度器未装配", "")
		return nil, false
	}
	return s.scheduler, true
}

// authorizeScheduler 校验管理会话（system:admin）；失败即写 401/403 并返回 false。
func (s *Server) authorizeScheduler(w http.ResponseWriter, r *http.Request, target string) bool {
	if s.auth == nil {
		return true // 探活骨架（测试）未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if subject == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
		return false
	}
	if !hasCapability(granted, "system:admin") {
		s.auditDenied(subject, "scheduler", target, "缺少 system:admin 特权能力")
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED,
			"越权：定时任务端点需要 system:admin 能力", "system:admin")
		return false
	}
	return true
}

// handleSchedulerList 返回全部任务（含 next_run_at 与最近执行结果）。
func (s *Server) handleSchedulerList(w http.ResponseWriter, r *http.Request) {
	service, ok := s.requireScheduler(w)
	if !ok || !s.authorizeScheduler(w, r, "list") {
		return
	}
	tasks, err := service.List(r.Context())
	if err != nil {
		writeSchedulerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, schedulerListBody{Tasks: tasks})
}

// handleSchedulerCreate 创建一条任务（cron 表达式或固定周期二选一）。
func (s *Server) handleSchedulerCreate(w http.ResponseWriter, r *http.Request) {
	service, ok := s.requireScheduler(w)
	if !ok || !s.authorizeScheduler(w, r, "add") {
		return
	}
	var input scheduler.CreateInput
	if err := decodeJSONBody(w, r, &input); err != nil {
		writeSchedulerError(w, err)
		return
	}
	task, err := service.Add(r.Context(), input)
	if err != nil {
		writeSchedulerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, task)
}

// handleSchedulerRun 立即执行一次任务（不改 next_run_at）。
func (s *Server) handleSchedulerRun(w http.ResponseWriter, r *http.Request) {
	service, ok := s.requireScheduler(w)
	if !ok || !s.authorizeScheduler(w, r, "run") {
		return
	}
	run, err := service.RunNow(r.Context(), r.PathValue("id"))
	if err != nil {
		writeSchedulerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// handleSchedulerDelete 删除任务；不存在回 404。
func (s *Server) handleSchedulerDelete(w http.ResponseWriter, r *http.Request) {
	service, ok := s.requireScheduler(w)
	if !ok || !s.authorizeScheduler(w, r, "delete") {
		return
	}
	if err := service.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeSchedulerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, schedulerDeletedBody{Deleted: true})
}

// decodeJSONBody 读取并解码请求体；空体与超限都归一成 ErrInvalid。
func decodeJSONBody(w http.ResponseWriter, r *http.Request, target any) error {
	limited := http.MaxBytesReader(w, r.Body, maxSchedulerBody)
	data, err := io.ReadAll(limited)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return errf(pluginapi.E_INVALID, "请求体超过 %d 字节上限", maxSchedulerBody)
		}
		return errf(pluginapi.E_INVALID, "读取请求体失败：%v", err)
	}
	if len(data) == 0 {
		return errf(pluginapi.E_INVALID, "请求体不能为空")
	}
	if err := json.Unmarshal(data, target); err != nil {
		return errf(pluginapi.E_INVALID, "请求体不是合法 JSON：%v", err)
	}
	return nil
}

// writeSchedulerError 按调度器错误分类映射 HTTP 状态码。
func writeSchedulerError(w http.ResponseWriter, err error) {
	var protocol *pluginapi.Error
	if errors.As(err, &protocol) {
		writeError(w, http.StatusBadRequest, protocol.Code, protocol.Message, "")
		return
	}
	switch {
	case errors.Is(err, scheduler.ErrInvalid):
		writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, err.Error(), "")
	case errors.Is(err, scheduler.ErrNotFound):
		writeError(w, http.StatusNotFound, pluginapi.E_NOTFOUND, err.Error(), "")
	case errors.Is(err, scheduler.ErrBusy), errors.Is(err, scheduler.ErrDisabled):
		writeError(w, http.StatusConflict, pluginapi.E_CONFLICT, err.Error(), "")
	default:
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, err.Error(), "")
	}
}
