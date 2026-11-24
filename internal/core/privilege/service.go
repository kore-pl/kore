package privilege

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// maxOutput 是 stdout / stderr 各自的采集上限（1 MiB，ADR-0018）。
const maxOutput = 1 << 20

// pluginIDPattern 是插件 id 语法（与 registry 同口径；此处只做防注入复核）。
var pluginIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// Options 是提权服务的装配参数；零值字段由 New 填默认实现。
type Options struct {
	// Auditor 是审计出口（必须注入；nil 时所有动作 fail-closed）。
	Auditor Auditor
	// ChangeRecorder 是宿主变更账本出口；声明 writes_host 的动作在 nil 时 fail-closed。
	ChangeRecorder ChangeRecorder
	// FileWrite 是受控文件写执行面（file_write 动作走这里，不走 os/exec）；
	// nil 时 file_write 动作一律 E_UNSUPPORTED（fail-closed）。
	FileWrite *FileWriteOptions
	// Runner 是 systemd-run 执行器；nil 用真实实现。
	Runner Runner
	// Root 报告 kored 是否 root；nil 用 os.Geteuid()==0。
	Root func() bool
	// TempDir 是 stdout/stderr 临时文件目录；空串用 os.TempDir()。
	TempDir string
	// MaxOutput 是单个输出流上限；<=0 用 1 MiB。
	MaxOutput int64
	// ConfirmTTL 是不可回滚动作令牌有效期；<=0 用 5 分钟。
	ConfirmTTL time.Duration
	// Logger 可空，默认 slog.Default()。
	Logger *slog.Logger
}

// Service 是提权通道的执行面；并发安全（每次执行独立 unit）。
type Service struct {
	opts    Options
	confirm *ConfirmStore
	logger  *slog.Logger
}

// New 构造提权服务并补齐默认实现。
func New(opts Options) *Service {
	if opts.Runner == nil {
		opts.Runner = execRunner{}
	}
	if opts.Root == nil {
		opts.Root = DetectRoot
	}
	if opts.MaxOutput <= 0 {
		opts.MaxOutput = maxOutput
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Service{opts: opts, confirm: NewConfirmStore(opts.ConfirmTTL), logger: opts.Logger}
}

// Confirm 返回确认令牌表（HTTP 层签发 confirm-token 用）。
func (s *Service) Confirm() *ConfirmStore { return s.confirm }

// Execute 执行一次 root 动作：
//  1. schema 复核（argv 固定、args 仅追加）；
//  2. 不可回滚动作核销 confirm 令牌；
//  3. 非 root → E_NEED_ROOT（写 deny 审计）；**不再有 systemd 前置**（ADR-0049）——
//     无 systemd 的宿主（容器 / Alpine / Tier B）同样能执行；
//  4. **先落审计再执行**（fail-closed），审计失败返回 E_INTERNAL；
//  5. 直接 exec 执行（不经 shell），超时 kill 整棵进程树，输出各截断 1 MiB；
//  6. 执行后补一条 end 审计（带**真实** exit_code / dur_ms）。
func (s *Service) Execute(ctx context.Context, req Request) (Result, error) {
	// 两条互斥执行语义：file_write 声明 → 受控写（不 exec）；否则 → 固定 argv 执行。
	// 互斥性由协议层 ValidateRootAction 保证（声明了 file_write 还带 argv 直接拒绝），
	// 这里只按声明分派，不再二次推断。
	if req.Action.FileWrite != nil {
		return s.executeFileWrite(ctx, req)
	}
	if req.Content != "" {
		// exec 动作不接受正文：允许它会让「同一请求一半走参数、一半走文件」的语义
		// 无法审计。显式拒绝，不静默丢弃。
		return Result{}, s.deny(ctx, req, "exec", "content_on_exec_action",
			errCode(pluginapi.E_INVALID, "content 仅用于 file_write 动作，exec 动作不得携带正文", ""))
	}
	argv := append([]string(nil), req.Action.Argv...)
	argv = append(argv, req.Args...)
	argvText := RedactArgv(argv)
	if perr := s.validateRequest(req); perr != nil {
		return Result{}, s.deny(ctx, req, argvText, "schema: "+perr.Message, perr)
	}
	if NeedsConfirm(req.Action) {
		if err := s.confirm.Consume(req.Confirm, req.PluginID, req.Action.ID); err != nil {
			return Result{}, s.deny(ctx, req, argvText, "confirm 校验失败", asProtocolError(err))
		}
	}
	if !s.opts.Root() {
		return Result{}, s.deny(ctx, req, argvText, "not_root", errCode(pluginapi.E_NEED_ROOT,
			"需要 root 权限：内核需以系统服务形态运行",
			"按 ADR-0042 以系统服务形态运行内核（systemd unit 内 User=root，`systemctl enable --now kore`）后重试；插件进程自身永不提权"))
	}
	// 写宿主动作必须能落账：账本未装配时拒绝执行（不能"改了宿主但查无此事"）。
	if req.Action.WritesHost && s.opts.ChangeRecorder == nil {
		return Result{}, s.deny(ctx, req, argvText, "change_ledger_unavailable", errCode(pluginapi.E_INTERNAL,
			"宿主变更账本未装配，写宿主动作已拒绝",
			"按 ADR-0023 以系统服务形态运行内核（装配 changes.jsonl 账本）后重试"))
	}

	unit := unitName(req.PluginID, req.Action.ID)
	begin := Event{Actor: req.Actor, PluginID: req.PluginID, ActionID: req.Action.ID,
		Argv: argvText, Unit: unit, Decision: DecisionAllow, Phase: PhaseBegin, ExitCode: -1}
	if err := s.record(ctx, begin); err != nil {
		return Result{}, errCode(pluginapi.E_INTERNAL, "提权审计写入失败，动作未执行："+err.Error(),
			"检查状态库（state.db）可写后重试")
	}

	stdoutPath, stderrPath, cleanup, err := s.createOutputs()
	if err != nil {
		return Result{}, errCode(pluginapi.E_INTERNAL, "创建输出临时文件失败，动作未执行："+err.Error(), "")
	}
	defer cleanup()

	timeout := time.Duration(req.Action.TimeoutS) * time.Second
	// 直接执行没有中间层开销，ctx 截止时间就是动作的 timeout_s；到点即由
	// execRunner 回收整棵进程树（不再像 systemd-run 时代那样额外留 2s 宽限）。
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	// Runner 契约（ADR-0049 直接执行）：超时 / 取消由实现自己回收进程组，
	// 上层只负责判定 timedOut 并归一退出码。
	exitCode, runErr := s.opts.Runner.Run(runCtx, argv, stdoutPath, stderrPath)
	durMS := time.Since(start).Milliseconds()
	timedOut := errors.Is(runCtx.Err(), context.DeadlineExceeded)
	if timedOut {
		exitCode = -1
	}
	stdout, stderr, truncated := readOutputs(stdoutPath, stderrPath, s.opts.MaxOutput)
	result := Result{Executed: timedOut || runErr == nil, ExitCode: exitCode,
		Stdout: stdout, Stderr: stderr, DurMS: durMS, Unit: unit, Truncated: truncated}

	end := Event{Actor: req.Actor, PluginID: req.PluginID, ActionID: req.Action.ID,
		Argv: argvText, Unit: unit, Decision: DecisionAllow, Phase: PhaseEnd,
		ExitCode: exitCode, DurMS: durMS}
	if err := s.record(ctx, end); err != nil {
		// 动作已经执行，无法回滚；这里只告警，把结果照实返回（begin 记录已保证 fail-closed）。
		s.logger.Warn("提权结果审计写入失败（动作已执行）", "plugin_id", req.PluginID,
			"action_id", req.Action.ID, "unit", unit, "err", err)
	}

	// 写宿主动作成功（exit_code=0 且未超时）→ 追加一条用户可见、可回滚的变更账本。
	// 顺序在 end 审计之后：审计是 fail-closed 的事前凭证，账本是事后产品记录；
	// 账本写失败不回滚已执行的动作（做不到），但必须 WARN 留痕且结果里可见。
	if req.Action.WritesHost && runErr == nil && !timedOut && exitCode == 0 {
		if err := s.opts.ChangeRecorder.RecordHostChange(ctx, HostChangeOf(req.PluginID, req.Action)); err != nil {
			s.logger.Warn("宿主变更账本写入失败（动作已执行）", "plugin_id", req.PluginID,
				"action_id", req.Action.ID, "target", req.Action.Target, "err", err)
		} else {
			result.HostChangeRecorded = true
		}
	}

	switch {
	case timedOut:
		return result, errCode(pluginapi.E_UPSTREAM,
			fmt.Sprintf("提权动作超时（%ds），已 kill 整个进程组", req.Action.TimeoutS),
			"缩短操作范围或调大 timeout_s（≤300）后重试")
	case runErr != nil:
		return result, errCode(pluginapi.E_UPSTREAM, "提权动作执行失败："+runErr.Error(),
			"确认命令存在、当前内核进程（uid=0）对它有执行权限；仍失败请查 journalctl -u kore 的 root.action 日志")
	}
	return result, nil
}

// validateRequest 复核插件 id、动作 schema 与追加参数（防注入，不认业务语义）。
func (s *Service) validateRequest(req Request) *pluginapi.Error {
	if !pluginIDPattern.MatchString(req.PluginID) {
		return errCode(pluginapi.E_INVALID, "plugin_id 不合法： "+req.PluginID, "")
	}
	if err := ValidateAction(req.Action); err != nil {
		return errCode(pluginapi.E_INVALID, "root_action schema 非法："+err.Error(), "")
	}
	// 追加参数来自插件进程（视为不可信），必须落在该动作命中形状的 Tail 上：
	// 声明 argv 合法不代表「声明 + 追加」合法——`nft list …` + `counter drop` 就
	// 会把只读动作变成写规则（ADR-0022）。
	if err := pluginapi.ValidateRootAppendedArgv(req.Action.Argv, req.Args); err != nil {
		return errCode(pluginapi.E_INVALID, "追加参数不合法："+err.Error(), "")
	}
	if len(req.Args) > pluginapi.MaxRootArgs-1 {
		return errCode(pluginapi.E_INVALID, "args 数量超限", "")
	}
	total := 0
	for index, arg := range req.Args {
		if arg == "" {
			return errCode(pluginapi.E_INVALID, fmt.Sprintf("args[%d] 不能为空", index), "")
		}
		if utf8.RuneCountInString(arg) > pluginapi.MaxRootArgRunes {
			return errCode(pluginapi.E_INVALID, fmt.Sprintf("args[%d] 超过 %d 个字符", index, pluginapi.MaxRootArgRunes), "")
		}
		if strings.ContainsRune(arg, 0) || strings.ContainsAny(arg, "\n\r\t") {
			return errCode(pluginapi.E_INVALID, fmt.Sprintf("args[%d] 含 NUL/控制字符", index), "")
		}
		total += utf8.RuneCountInString(arg)
	}
	if total > pluginapi.MaxRootArgvRunes {
		return errCode(pluginapi.E_INVALID, "args 总长度超限", "")
	}
	return nil
}
