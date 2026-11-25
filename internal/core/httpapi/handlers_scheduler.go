package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

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

// schedulerRunsBody 是执行历史响应体（最新在前）。
//
// Note 说明保留上限：内核只保留最近 maxRuns（100）条，用户看到条数变少时
// 需要知道是"被轮转"而不是"记录丢了"。
type schedulerRunsBody struct {
	// Runs 该任务的执行记录，最新在前。
	Runs []scheduler.Run `json:"runs"`
	// Count 本次返回条数。
	Count int `json:"count"`
	// Note 保留口径说明。
	Note string `json:"note,omitempty"`
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

// handleSchedulerUpdate 就地修改任务计划（表达式 / 周期 / 超时 / 启停）。
//
// 校验与审计口径与创建一致：写操作需 system:admin（越权记 capability.denied），
// 参数校验复用调度器的 normalize（不在这里重写一套）。目标插件与方法不可改。
func (s *Server) handleSchedulerUpdate(w http.ResponseWriter, r *http.Request) {
	service, ok := s.requireScheduler(w)
	if !ok || !s.authorizeScheduler(w, r, "update") {
		return
	}
	var input scheduler.UpdateInput
	if err := decodeJSONBody(w, r, &input); err != nil {
		writeSchedulerError(w, err)
		return
	}
	task, err := service.Update(r.Context(), r.PathValue("id"), input)
	if err != nil {
		writeSchedulerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, task)
}

// handleSchedulerRuns 返回某条任务的执行历史（最新在前）。
//
// 只读内核自己的调度记录（scheduler_runs）——不代理插件业务：crontab 任务的
// 逐次执行日志由 cron 插件的 cron.runlog 提供，前端直接调插件方法（G-01）。
func (s *Server) handleSchedulerRuns(w http.ResponseWriter, r *http.Request) {
	service, ok := s.requireScheduler(w)
	if !ok || !s.authorizeScheduler(w, r, "runs") {
		return
	}
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, pluginapi.E_INVALID, "limit 必须是正整数", "")
			return
		}
		limit = parsed
	}
	runs, err := service.Runs(r.Context(), r.PathValue("id"), limit)
	if err != nil {
		writeSchedulerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, schedulerRunsBody{
		Runs: runs, Count: len(runs),
		Note: "内核只保留每条任务最近 100 条执行记录；更早的记录已被轮转",
	})
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
