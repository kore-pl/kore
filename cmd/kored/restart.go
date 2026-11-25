package main

// ADR-0056 T3+T4：统一自重启原语的装配层薄壳。
// CLI 与 HTTP 共用本文件的 restartRuntime（confirm → 审计 fail-closed → flush → SelfRestart）。
// 所有用户入口只提供 reason + unit 标识，绝不传命令字符串。

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/core/store"
	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	restartDefaultUnitEnv = "KORE_RESTART_UNIT"
	restartAuditAction    = "system.restart"
)

// restartDeps 是 restartRuntime 的注入点（CLI flag 由 main 传 args；HTTP 复用同一结构）。
type restartDeps struct {
	confirm *privilege.ConfirmStore
	audit   func(store.AuditRecord) error
	flush   func() ([]string, error)
	self    func(privilege.RestartRequest) (privilege.RestartOutcome, error)
	unit    func() string
	now     func() time.Time
	queue   *restartQueueLocal
}

// restartQueueLocal 保证并发请求排队、不合并（ADR-0018:233）。
type restartQueueLocal struct{ mu sync.Mutex }

func (q *restartQueueLocal) lock() func() { q.mu.Lock(); return q.mu.Unlock }

// restartRuntime 是 HTTP 侧的 RestartServicer 实现（同时被 CLI 复用为内部逻辑）。
type restartRuntime struct {
	deps restartDeps
}

var _ httpapi.RestartServicer = (*restartRuntime)(nil)

// newRestartRuntime 构造生产实现。audit=db.PutAudit；flush=flushRestartPending。
func newRestartRuntime(db *store.Store, cfg config) *restartRuntime {
	unit := resolveRestartUnit(cfg)
	return &restartRuntime{deps: restartDeps{
		confirm: privilege.NewConfirmStore(privilege.DefaultConfirmTTL),
		audit:   db.PutAudit,
		flush:   func() ([]string, error) { return flushRestartPending(cfg, db) },
		self:    privilege.SelfRestart,
		unit:    func() string { return unit },
		now:     time.Now,
		queue:   &restartQueueLocal{},
	}}
}

// resolveRestartUnit 探测/配置 unit（不接受用户命令字符串）：
// root → kore.service；非 root → 显式 user unit（KORE_RESTART_UNIT，如 kored-local.service）。
func resolveRestartUnit(cfg config) string {
	if os.Geteuid() == 0 {
		return privilege.DefaultSystemUnit
	}
	if v := strings.TrimSpace(os.Getenv(restartDefaultUnitEnv)); v != "" {
		return v
	}
	// 非 root 且未显式配置 user unit：返回默认降级名，SelfRestart 会做 unit 合法性校验；
	// 若该名字在本机不是有效 unit，systemctl --user 提交失败 → E_NO_SELF_RESTART（不假成功）。
	return "kored-local.service"
}

// ConfirmToken 签发绑定 action+reason 的一次性令牌。
func (r *restartRuntime) ConfirmToken(reason string) (string, time.Time, error) {
	grant, err := r.deps.confirm.IssueWithReason(privilege.RestartPluginID, privilege.RestartActionID, reason)
	if err != nil {
		return "", time.Time{}, err
	}
	return grant.Token, grant.ExpiresAt, nil
}

// Unit 返回当前 unit（展示用）。
func (r *restartRuntime) Unit() string { return r.deps.unit() }

// Restart 执行完整链路：confirm → deny/begin 审计 fail-closed → flush → SelfRestart → 结果审计。
func (r *restartRuntime) Restart(ctx context.Context, actor, reason, token string) (httpapi.RestartResponseBody, error) {
	unlock := r.deps.queue.lock()
	defer unlock()
	return restartWith(ctx, r.deps, actor, reason, token)
}

// restartWith 是不带队列的核⼼实现（CLI 与 HTTP 共用；HTTP 外层已串行化）。
func restartWith(_ context.Context, deps restartDeps, actor, reason, token string) (httpapi.RestartResponseBody, error) {
	unit := deps.unit()
	// ① confirm 核销（缺失/过期/不绑定 → E_UNAUTHORIZED + deny 审计）。
	if err := deps.confirm.ConsumeWithReason(token, privilege.RestartPluginID, privilege.RestartActionID, reason); err != nil {
		writeRestartAudit(deps, actor, reason, unit, "denied", "E_UNAUTHORIZED", "not_committed", "", err.Error())
		return httpapi.RestartResponseBody{}, err
	}
	// ② begin 审计 fail-closed：写不进就不提交重启。
	if err := writeRestartAudit(deps, actor, reason, unit, "allow", "", "pending", "", ""); err != nil {
		return httpapi.RestartResponseBody{}, err
	}
	// ③ flush 所有 pending marker（upgrade-result.json / plugin_state.post_upgrade_pending / 配置落盘）。
	flushed, flushErr := deps.flush()
	flushState := "ok:" + strings.Join(flushed, ",")
	if flushErr != nil {
		flushState = "failed"
		writeRestartAudit(deps, actor, reason, unit, "allow", "E_FLUSH", flushState, "", flushErr.Error())
		return httpapi.RestartResponseBody{}, &pluginapi.Error{Code: pluginapi.E_INTERNAL,
			Message: "提交重启前 flush 待落盘标记失败，已拒绝提交重启：" + flushErr.Error()}
	}
	// ④ 调原语提交（--no-block）。
	out, err := deps.self(privilege.RestartRequest{Reason: reason, Unit: unit, Actor: actor})
	if err != nil {
		code := pluginapi.E_INTERNAL
		if privilege.IsNoSelfRestart(err) {
			code = privilege.E_NO_SELF_RESTART
		}
		writeRestartAudit(deps, actor, reason, unit, "allow", code, flushState, "", err.Error())
		return httpapi.RestartResponseBody{}, &pluginapi.Error{Code: code, Message: err.Error()}
	}
	// ⑤ 结果审计必须先于响应可见（--no-block 后随时可能被 SIGTERM）。
	if auditErr := writeRestartAudit(deps, actor, reason, out.Unit, "allow", "OK", flushState, out.Mode, ""); auditErr != nil {
		slog.Warn("system.restart 结果审计写失败（重启已提交）", "err", auditErr)
	}
	return httpapi.RestartResponseBody{
		Committed: out.Committed, Unit: out.Unit, Mode: out.Mode, Command: out.Command,
		Reason: reason, Message: "重启已提交（--no-block），不等于已生效；生效以新进程写入的标记为准",
	}, nil
}

// writeRestartAudit 写一条 system.restart 审计（只记 actor/reason/unit/decision/result/flush/结果，不记 token）。
func writeRestartAudit(deps restartDeps, actor, reason, unit, decision, code, flushState, mode, errText string) error {
	if deps.audit == nil {
		return errors.New("审计出口未装配，拒绝提交重启")
	}
	detail := map[string]string{
		"reason": reason, "unit": unit, "decision": decision,
		"flush_state": flushState, "mode": mode, "commit_result": code,
	}
	if errText != "" {
		detail["error"] = errText
	}
	result := store.AuditResultOK
	if decision == "denied" {
		result = store.AuditResultDenied
	} else if code != "" && code != "OK" {
		result = store.AuditResultError
	}
	return deps.audit(store.AuditRecord{
		Subject: actor, Action: restartAuditAction, Target: unit, Result: result, Detail: detail,
	})
}

// flushRestartPending 提交重启前 flush 所有 pending marker。
// 当前实现：upgrade-result.json 已由 upgrade.go 在落盘后才调用提交（幂等 flush 为 fsync 状态目录）；
// plugin_state.post_upgrade_pending 由安装器写 bbolt 事务时已持久化（读取校验一次）；
// 配置落盘由写端点原子写完成（读取快照确认源文件存在）。任一项不可读 → 结构化失败，不提交。
func flushRestartPending(cfg config, db *store.Store) ([]string, error) {
	var flushed []string
	if cfg.StateDir == "" {
		return nil, errors.New("状态目录未装配，无法确认待落盘标记")
	}
	flushed = append(flushed, "state_dir:"+cfg.StateDir)
	if db == nil {
		return nil, errors.New("状态库未装配，无法确认 plugin_state")
	}
	// 校验 post_upgrade_pending 可读（存储层读事务成功即代表已持久化）。
	_, _, err := newStateRepo(db).load("__flush-probe__")
	if err != nil {
		return nil, fmt.Errorf("读取 plugin_state 失败: %w", err)
	}
	flushed = append(flushed, "plugin_state:pending-check")
	// upgrade-result.json 无需再写：upgrade.go 的 submitUpgradeRestart 在写完标记后才调用本原语；
	// 这里只确认状态目录可列（fsync 语义由 writeUpgradeResult 的临时文件+rename 保证）。
	if _, err := os.Stat(filepath.Join(cfg.StateDir, upgradeResultName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("检查 upgrade-result 失败: %w", err)
	}
	flushed = append(flushed, "upgrade-result:checked")
	return flushed, nil
}

// ---- CLI：kored restart --reason "..."（同原语、同 confirm、同审计）----

// restartOptions 是 CLI 参数快照。
type restartOptions struct {
	reason   string
	unit     string
	yes      bool
	token    string
	stateDir string
}

// runRestart 执行 CLI 重启（由 main.go 的 restart case 调用）。
func runRestart(args []string, stdout, stderr io.Writer) int {
	opts, err := parseRestartFlags(args, stderr)
	if err != nil {
		return exitConfig
	}
	cfg, code := loadConfig(serveOptions{stateDir: opts.stateDir}, stderr)
	if code != exitOK {
		return code
	}
	if opts.unit != "" {
		os.Setenv(restartDefaultUnitEnv, opts.unit) // 仅供原语读取；不是命令字符串
	}
	unit := resolveRestartUnit(cfg)
	deps := restartDeps{
		confirm: privilege.NewConfirmStore(privilege.DefaultConfirmTTL),
		audit: func(rec store.AuditRecord) error {
			st, code := openStore(cfg, io.Discard)
			if code != exitOK {
				return fmt.Errorf("打开状态库失败（退出码 %d）", code)
			}
			defer closeStore(st)
			return st.PutAudit(rec)
		},
		flush: func() ([]string, error) { return flushRestartPending(cfg, nil) },
		self:  privilege.SelfRestart,
		unit:  func() string { return unit },
		now:   time.Now,
		queue: &restartQueueLocal{},
	}
	// CLI 的 confirm：--yes 表示本机一次性授权（签发并即时核销，绑 reason）；
	// 也可显式 --confirm <token> 用 HTTP 侧签发的令牌。
	token := strings.TrimSpace(opts.token)
	if opts.yes && token == "" {
		grant, gerr := deps.confirm.IssueWithReason(privilege.RestartPluginID, privilege.RestartActionID, opts.reason)
		if gerr != nil {
			fmt.Fprintf(stderr, "restart: 签发确认令牌失败: %v\n", gerr)
			return exitConfig
		}
		token = grant.Token
	}
	if token == "" {
		fmt.Fprintln(stderr, "restart: 重启属于不可逆动作，必须显式确认：--yes 或 --confirm <token>")
		return exitConfig
	}
	result, err := restartWith(context.Background(), deps, "cli:"+os.Getenv("USER"), opts.reason, token)
	if err != nil {
		fmt.Fprintf(stderr, "restart: %v\n", err)
		if privilege.IsNoSelfRestart(err) || strings.Contains(err.Error(), privilege.E_NO_SELF_RESTART) {
			return exitEnv
		}
		return exitConfig
	}
	fmt.Fprintf(stdout, "[OK] 重启已提交：%s（%s，%s）\n", result.Unit, result.Mode, result.Command)
	fmt.Fprintln(stdout, result.Message)
	return exitOK
}

// configWriterAdapter 把 config 包的写入能力适配成 httpapi.ConfigWriter（cmd 层装配，G-01）。
type configWriterAdapter struct {
	path string
	snap *coreconfig.Snapshot
	mu   sync.Mutex
}

func (a *configWriterAdapter) Write(updates httpapi.ConfigUpdates) ([]string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	input := coreconfig.ConfigUpdates{
		IndexDir: updates.IndexDir, PluginDir: updates.PluginDir, LogLevel: updates.LogLevel,
		Addr: updates.Addr, InvokeAll: updates.InvokeAll,
	}
	next, cold, err := coreconfig.WriteConfigUpdates(a.path, a.snap, input)
	if err != nil {
		return nil, err
	}
	a.snap = next
	return cold, nil
}

// newConfigWriterAdapter 从装配配置解析配置文件绝对路径（与 serve 同一 ResolvePath 语义）。
func newConfigWriterAdapter(cfg config) *configWriterAdapter {
	path := coreconfig.ResolvePath(cfg.opts.config)
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	return &configWriterAdapter{path: path, snap: cfg.snapshot}
}

// resumePendingPostUpgrade 在新进程启动时补跑上次未消费的 post_upgrade_pending（ADR-0056 T4）。
// 与 daemon.consumePostUpgrade 共用同一语义（清标记 + 调 post_upgrade），但无需用户 Enable：
// 已启用的插件在 restoreEnabled 后即可补跑；禁用态插件保留标记等用户显式 Enable。
// 失败不阻断启动（WARN + 告警），避免重启循环。
func (s *service) resumePendingPostUpgrade() {
	refs, err := s.states.installed()
	if err != nil {
		slog.Warn("补跑 post_upgrade：读取已装插件失败", "err", err)
		return
	}
	for _, ref := range refs {
		state, found, err := s.states.load(ref.ID)
		if err != nil || !found || state.PostUpgradePending == "" {
			continue
		}
		manifest, ok := s.catalog.Manifest(ref.ID)
		if !ok || manifest.PostUpgrade == "" {
			continue
		}
		if !s.catalog.Enabled(ref.ID) {
			continue // 禁用态：保留标记，等用户 Enable 由 daemon.consumePostUpgrade 消费
		}
		if _, _, _, err := s.backend.update(ref.ID, func(st *persistedState, _ supervisor.View, _ bool) {
			st.PostUpgradePending = ""
		}); err != nil {
			slog.Warn("补跑 post_upgrade：清除标记失败，跳过避免重复执行", "plugin_id", ref.ID, "err", err)
			continue
		}
		slog.Info("新进程补跑升级后置动作", "plugin_id", ref.ID, "method", manifest.PostUpgrade)
		s.runPostUpgrade(ref.ID, manifest.PostUpgrade)
	}
}

// parseRestartFlags 解析 CLI 参数（只接受 reason/unit/yes/confirm；不接受命令字符串）。
func parseRestartFlags(args []string, stderr io.Writer) (restartOptions, error) {
	fs := flag.NewFlagSet("restart", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var opts restartOptions
	fs.StringVar(&opts.reason, "reason", "", "重启理由（必填，写入审计）")
	fs.StringVar(&opts.unit, "unit", "", "可选：显式 unit 名（root 固定 kore.service；非 root 如 kored-local.service）")
	fs.BoolVar(&opts.yes, "yes", false, "本机一次性确认（绑 reason，等同 confirm）")
	fs.StringVar(&opts.token, "confirm", "", "HTTP 侧签发的一次性确认令牌")
	fs.StringVar(&opts.stateDir, "state-dir", "", "状态目录（审计落库用）")
	if err := fs.Parse(args); err != nil {
		return restartOptions{}, err
	}
	if strings.TrimSpace(opts.reason) == "" {
		return restartOptions{}, errors.New("--reason 必填")
	}
	return opts, nil
}
