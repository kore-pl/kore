package privilege

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
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
	// Runner 是 systemd-run 执行器；nil 用真实实现。
	Runner Runner
	// Root 报告 kored 是否 root；nil 用 os.Geteuid()==0。
	Root func() bool
	// Systemd 报告 systemd 可用性；第二返回值是原因（不可用时写进 hint）。
	Systemd func() (bool, string)
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
	if opts.Systemd == nil {
		opts.Systemd = DetectSystemd
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
//  3. 非 root → E_NEED_ROOT，非 systemd → E_NO_SYSTEMD（均写 deny 审计）；
//  4. **先落审计再执行**（fail-closed），审计失败返回 E_INTERNAL；
//  5. systemd-run 执行，超时 kill unit，输出各截断 1 MiB；
//  6. 执行后补一条 end 审计（带 exit_code / dur_ms）。
func (s *Service) Execute(ctx context.Context, req Request) (Result, error) {
	argv := append([]string(nil), req.Action.Argv...)
	argv = append(argv, req.Args...)
	argvText := RedactArgv(argv)
	if perr := s.validateRequest(req); perr != nil {
		return Result{}, s.deny(ctx, req, argvText, "schema: "+perr.Message, perr)
	}
	if req.Action.Irreversible {
		if err := s.confirm.Consume(req.Confirm, req.PluginID, req.Action.ID); err != nil {
			return Result{}, s.deny(ctx, req, argvText, "confirm 校验失败", asProtocolError(err))
		}
	}
	if !s.opts.Root() {
		return Result{}, s.deny(ctx, req, argvText, "not_root", errCode(pluginapi.E_NEED_ROOT,
			"需要 root 权限：请用 sudo/systemd 启动 kored",
			"用 `sudo kored` 或 systemd unit（User=root）启动；插件进程自身永不提权"))
	}
	if ok, detail := s.opts.Systemd(); !ok {
		return Result{}, s.deny(ctx, req, argvText, "no_systemd", errCode(pluginapi.E_NO_SYSTEMD,
			"环境不支持提权通道："+detail,
			"安装并启用 systemd 后重启 kored；无 systemd 环境请显式配置 sudoers 降级（见 docs/RUNBOOK.md）"))
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
	runCtx, cancel := context.WithTimeout(ctx, timeout+rootTimeoutGrace)
	defer cancel()
	start := time.Now()
	exitCode, runErr := s.opts.Runner.Run(runCtx, unit, argv, stdoutPath, stderrPath)
	durMS := time.Since(start).Milliseconds()
	timedOut := errors.Is(runCtx.Err(), context.DeadlineExceeded)
	if timedOut {
		s.opts.Runner.KillUnit(unit)
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

	switch {
	case timedOut:
		return result, errCode(pluginapi.E_UPSTREAM,
			fmt.Sprintf("提权动作超时（%ds），已 kill unit", req.Action.TimeoutS),
			"缩短操作范围或调大 timeout_s（≤300）后重试")
	case runErr != nil:
		return result, errCode(pluginapi.E_UPSTREAM, "提权动作启动失败："+runErr.Error(),
			"检查 systemd / polkit 权限与命令是否存在")
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

// createOutputs 创建两个 0600 临时文件供 systemd unit 写 stdout / stderr。
func (s *Service) createOutputs() (string, string, func(), error) {
	dir := s.opts.TempDir
	stdout, err := os.CreateTemp(dir, "kore-root-stdout-*")
	if err != nil {
		return "", "", func() {}, err
	}
	stderr, err := os.CreateTemp(dir, "kore-root-stderr-*")
	if err != nil {
		_ = stdout.Close()
		_ = os.Remove(stdout.Name())
		return "", "", func() {}, err
	}
	_ = stdout.Chmod(0o600)
	_ = stderr.Chmod(0o600)
	_ = stdout.Close()
	_ = stderr.Close()
	cleanup := func() {
		_ = os.Remove(stdout.Name())
		_ = os.Remove(stderr.Name())
	}
	return stdout.Name(), stderr.Name(), cleanup, nil
}

// readOutputs 读取两个输出文件，各自截断到 limit（多读 1 字节判断是否截断）。
func readOutputs(stdoutPath, stderrPath string, limit int64) (string, string, bool) {
	stdout, truncOut := readCapped(stdoutPath, limit)
	stderr, truncErr := readCapped(stderrPath, limit)
	return stdout, stderr, truncOut || truncErr
}

func readCapped(path string, limit int64) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return string(raw), false
	}
	if int64(len(raw)) > limit {
		return string(raw[:limit]), true
	}
	return string(raw), false
}

// unitName 生成 transient unit 名：kore-root-<plugin>-<action>-<rand8>。
func unitName(pluginID, actionID string) string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("kore-root-%s-%s", pluginID, actionID)
	}
	return fmt.Sprintf("kore-root-%s-%s-%s", pluginID, actionID, hex.EncodeToString(buf[:]))
}

// sensitivePattern 命中即视为敏感参数（审计脱敏，ADR-0018 / SECURITY §11）。
var sensitivePattern = regexp.MustCompile(`(?i)(pass(word)?|token|secret|api[-_]?key|private[-_]?key)`)

// RedactArgv 把命令拼成审计字符串，敏感参数以 *** 代替。
//
// 规则：命中敏感词的 `--flag=value` 只脱敏 value；`--flag value` 脱敏下一个 arg；
// 其余整体脱敏。argv[0] 不参与脱敏失败（避免把程序名误伤得无法审计）。
func RedactArgv(argv []string) string {
	out := make([]string, len(argv))
	redactNext := false
	for index, arg := range argv {
		if redactNext {
			out[index] = "***"
			redactNext = false
			continue
		}
		if index > 0 && sensitivePattern.MatchString(arg) {
			if equal := strings.IndexByte(arg, '='); equal >= 0 {
				out[index] = arg[:equal+1] + "***"
				continue
			}
			if strings.HasPrefix(arg, "-") {
				out[index] = arg
				redactNext = true
				continue
			}
			out[index] = "***"
			continue
		}
		out[index] = arg
	}
	return strings.Join(out, " ")
}

// asProtocolError 把任意错误转成协议错误（保留已有 code）。
func asProtocolError(err error) *pluginapi.Error {
	var protocolErr *pluginapi.Error
	if errors.As(err, &protocolErr) {
		return protocolErr
	}
	return errCode(pluginapi.E_INTERNAL, err.Error(), "")
}
