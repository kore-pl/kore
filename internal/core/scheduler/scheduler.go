package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// 调度循环参数（ADR-0019：30s 检查一次；运行时迟到超过 5min 视为错过）。
const (
	defaultTick = 30 * time.Second
	missGrace   = 5 * time.Minute
)

// Invoker 是调度器对插件调用面的最小依赖（cmd/kored 的 daemon 实现）。
type Invoker interface {
	// Invoke 调用一次插件方法；ctx 到期必须返回（超时由上层取消）。
	Invoke(ctx context.Context, plugin, method string, params json.RawMessage, reqID string) (json.RawMessage, error)
}

// BuiltinHandler 处理内置任务（plugin == BuiltinPlugin），不经过插件调用面。
type BuiltinHandler func(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error)

// Options 是 Service 的装配参数。
type Options struct {
	// Store 是状态库句柄（scheduler_tasks / scheduler_runs 两个 bucket）。
	Store *store.Store
	// Invoker 是插件调用面；内置任务可只给 Builtin。
	Invoker Invoker
	// Logger 可空，默认 slog.Default()。
	Logger *slog.Logger
	// Now 可空，默认 time.Now（测试注入）。
	Now func() time.Time
	// Tick 可空，默认 30s（仅测试需要改）。
	Tick time.Duration
	// Builtin 是内置任务处理器；nil 时内置任务执行返回错误（不假装成功）。
	Builtin BuiltinHandler
	// CertRenewEnabled 对应配置 cert_renew.enabled：true 时注册/启用内置任务。
	CertRenewEnabled bool
	// CertRenewInterval 对应配置 cert_renew.interval（默认 6h）。
	CertRenewInterval time.Duration
	// AuditRetention 对应配置 audit.retention：审计记录保留期；0 表示不注册清理任务。
	AuditRetention time.Duration
	// AuditCleanEnabled 对应配置 audit.clean_enabled：false 时不注册内置清理任务。
	AuditCleanEnabled bool
	// AuditCleanInterval 对应配置 audit.clean_interval（默认 6h）。
	AuditCleanInterval time.Duration
	// AuditCleanBatch 对应配置 audit.clean_batch：单次删除上限（默认 1000）。
	AuditCleanBatch int
	// LogsMaintainInterval 是日志自动维护（切割+清理）周期：0 取默认 6h（默认启用），
	// 负值表示不注册该任务。默认启用是产品决策：日志无界增长是真实运维问题，
	// 装完不配就该有人负责切割与清理（G-19：周期仍只来自本调度器的单 ticker）。
	LogsMaintainInterval time.Duration
}

// Service 是内核唯一的周期执行器：单实例、单 ticker、任务表在 state.db。
type Service struct {
	store   *store.Store
	invoker Invoker
	log     *slog.Logger
	now     func() time.Time
	tick    time.Duration
	builtin BuiltinHandler

	certEnabled  bool
	certInterval time.Duration

	// 审计按龄清理（内置任务 builtin-audit-clean）：复用同一 ticker，不新增定时器。
	auditEnabled   bool
	auditRetention time.Duration
	auditInterval  time.Duration
	auditBatch     int
	// logsMaintainInterval 是日志自动维护任务周期；<0 表示禁用。
	logsMaintainInterval time.Duration
	// baseCtx 是调度循环的生命周期根：不能绑定请求 ctx（响应写完即取消，ticker 会秒退）。
	baseCtx context.Context

	mu      sync.Mutex
	running map[string]bool
	cancel  context.CancelFunc
	done    chan struct{}
	// runSeq 让同一纳秒内的多条记录键不冲突（键 = 时刻 + 序号）。
	runSeq atomic.Uint64
}

// New 校验依赖并构造 Service；Store 为空属于装配错误（不回 501 掩盖）。
func New(opts Options) (*Service, error) {
	if opts.Store == nil {
		return nil, fmt.Errorf("scheduler: Store 未装配")
	}
	service := &Service{
		store: opts.Store, invoker: opts.Invoker, builtin: opts.Builtin,
		log: opts.Logger, now: opts.Now, tick: opts.Tick,
		certEnabled: opts.CertRenewEnabled, certInterval: opts.CertRenewInterval,
		auditEnabled:         opts.AuditCleanEnabled && opts.AuditRetention > 0,
		auditRetention:       opts.AuditRetention,
		auditInterval:        opts.AuditCleanInterval,
		auditBatch:           opts.AuditCleanBatch,
		logsMaintainInterval: opts.LogsMaintainInterval,
		baseCtx:              context.Background(), running: map[string]bool{},
	}
	if service.log == nil {
		service.log = slog.Default()
	}
	if service.now == nil {
		service.now = time.Now
	}
	if service.tick <= 0 {
		service.tick = defaultTick
	}
	if service.certInterval <= 0 {
		service.certInterval = 6 * time.Hour
	}
	if service.auditInterval <= 0 {
		service.auditInterval = 6 * time.Hour
	}
	if service.auditBatch <= 0 {
		service.auditBatch = 1000
	}
	// 0 = 未配置 → 默认 6h（默认启用）；只有显式负值才表示禁用。
	if service.logsMaintainInterval == 0 {
		service.logsMaintainInterval = defaultLogsMaintainInterval * time.Second
	}
	return service, nil
}

// List 返回全部任务（按下次执行时间升序）。
func (s *Service) List(context.Context) ([]Task, error) { return s.loadTasks() }

// Add 校验并持久化一条任务；启用时启动调度循环（无启用任务时无 ticker）。
func (s *Service) Add(ctx context.Context, in CreateInput) (Task, error) {
	now := s.now()
	task, err := in.normalize(now)
	if err != nil {
		return Task{}, err
	}
	task.ID, err = newTaskID()
	if err != nil {
		return Task{}, fmt.Errorf("生成任务 id 失败: %w", err)
	}
	next, err := task.nextRun(now)
	if err != nil {
		return Task{}, err
	}
	task.NextRunAt = next
	if err := s.saveTask(task); err != nil {
		return Task{}, err
	}
	if task.Enabled {
		s.startLoop()
	}
	return task, nil
}

// Delete 删除任务并停掉空闲的调度循环；不存在返回 ErrNotFound。
func (s *Service) Delete(_ context.Context, id string) error {
	if err := s.deleteTask(id); err != nil {
		return err
	}
	s.stopIfIdle()
	return nil
}

// RunNow 立即执行一次（不改 next_run_at）；执行中或已禁用时拒绝。
func (s *Service) RunNow(ctx context.Context, id string) (Run, error) {
	task, err := s.loadTask(id)
	if err != nil {
		return Run{}, err
	}
	if !task.Enabled {
		return Run{}, fmt.Errorf("%w: %s", ErrDisabled, id)
	}
	s.mu.Lock()
	if s.running[id] {
		s.mu.Unlock()
		return Run{}, fmt.Errorf("%w: %s", ErrBusy, id)
	}
	s.running[id] = true
	s.mu.Unlock()
	defer s.release(id)
	return s.execute(ctx, task), nil
}

// Start 恢复任务状态（错过不补跑）、注册内置 cert_renew 与审计清理任务并启动单 ticker。
func (s *Service) Start(ctx context.Context) error {
	if err := s.syncCertRenewTask(); err != nil {
		return err
	}
	if err := s.syncAuditCleanTask(); err != nil {
		return err
	}
	if err := s.syncLogsMaintainTask(); err != nil {
		return err
	}
	tasks, err := s.loadTasks()
	if err != nil {
		return err
	}
	now := s.now()
	enabled := 0
	for _, task := range tasks {
		if !task.Enabled {
			continue
		}
		enabled++
		if task.NextRunAt.IsZero() || !task.NextRunAt.After(now) {
			s.markMissed(task, now)
		}
	}
	_ = ctx // 循环生命周期由 baseCtx 管理，不跟随调用方 ctx
	if enabled > 0 {
		s.startLoop()
	}
	return nil
}

// Stop 停掉 ticker 并等待循环退出（不等待在途任务：由调用方先停 HTTP）。
func (s *Service) Stop() { s.cancelLoop() }
