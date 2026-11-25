package privilege

// ADR-0056 §裁决/设计要点 1：统一内部原语 SelfRestart。
// 本文件刻意保持薄壳：只接受 reason 与 unit 标识（来自配置/探测），
// 不接受用户提供的命令字符串，因此没有注入面（G-01 / G-23）。

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

const (
	// RestartActionID 是 system.restart 动作的标识（confirm 绑定用）。
	RestartActionID = "system.restart"
	// RestartPluginID 是系统动作的伪 plugin id（confirm 表按 plugin+action 绑定）。
	RestartPluginID = "system"
	// DefaultSystemUnit 是系统级 root 服务的 unit 名（与 upgrade.go 同口径）。
	DefaultSystemUnit = "kore.service"
)

// RestartRequest 是自重启请求（显式字段，G-24）：
//   - Reason：人话理由，写审计、与 confirm 绑定；
//   - Unit：要重启的 unit 名；root 分支只接受 kore.service，非 root 分支必须显式 user unit；
//   - Actor：调用方主体，写审计，绝不写口令/token。
type RestartRequest struct {
	Reason string
	Unit   string
	Actor  string
}

// RestartOutcome 是提交结果；committed=true 只表示 --no-block job 已提交，
// 不等于新进程已生效（生效证据由新进程写 marker / 健康探针给出）。
type RestartOutcome struct {
	Committed bool   `json:"committed"`
	Unit      string `json:"unit"`
	Mode      string `json:"mode"`
	Command   string `json:"command"`
}

// E_NO_SELF_RESTART 是"本实例无法自重启"的结构化失败码（白话 hint 同时返回）。
const E_NO_SELF_RESTART = "E_NO_SELF_RESTART"

// RestartDeps 是 SelfRestart 的注入点（测试用 mock 记录 argv，绝不碰真实 systemd）。
type RestartDeps struct {
	EUID          func() int
	HasSystemd    func() bool
	SystemRestart func(unit string) error
	UserRestart   func(unit string) error
	ValidateUnit  func(unit string) error
}

// defaultRestartDeps 是生产实现：复用 systemd.go 的 BuildRestartArgv / RestartUnitNoBlock。
func defaultRestartDeps() RestartDeps {
	return RestartDeps{
		EUID:          os.Geteuid,
		HasSystemd:    func() bool { return findSelfCtl() != "" },
		SystemRestart: RestartUnitNoBlock,
		UserRestart:   restartUserUnit,
		ValidateUnit:  validateUnitName,
	}
}

// restartUserUnit 以 --no-block 提交 user unit 重启（同 uid 服务控制，不提权）。
// 用固定绝对路径候选的 systemctl --user；不查 PATH（与 selfCtl 同口径）。
func restartUserUnit(unit string) error {
	for _, candidate := range selfCtlCandidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			_, ctlErr := selfCtlExec(candidate, "--user", "--no-block", "restart", unit)
			return ctlErr
		}
	}
	return fmt.Errorf("找不到 systemctl（候选 %v）：无法重启用户 unit", selfCtlCandidates)
}

// validateUnitName 只接受 systemd unit 的保守语法（字母数字 + ._-@），杜绝注入。
func validateUnitName(unit string) error {
	if unit == "" {
		return errors.New("unit 名为空")
	}
	for _, r := range unit {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' || r == '@' {
			continue
		}
		return fmt.Errorf("unit 名 %q 含非法字符", unit)
	}
	return nil
}

// SelfRestart 执行自重启原语。前置：确认令牌已由调用方核销（HTTP/CLI 层负责），
// 审计由调用方在提交前 fail-closed 写入（见 handlers_restart.go / restart.go CLI）。
// 无 systemd / 无 unit / bus 不可达 → E_NO_SELF_RESTART + hint，绝不静默降级。
func SelfRestart(req RestartRequest) (RestartOutcome, error) {
	return SelfRestartWith(req, defaultRestartDeps())
}

// SelfRestartWith 是可测试实现。
func SelfRestartWith(req RestartRequest, deps RestartDeps) (RestartOutcome, error) {
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		return RestartOutcome{}, errNoRestart("重启理由不能为空", "调用时必须提供人话理由（写进审计）")
	}
	if deps.ValidateUnit == nil || deps.EUID == nil || deps.HasSystemd == nil || deps.SystemRestart == nil || deps.UserRestart == nil {
		return RestartOutcome{}, errNoRestart("重启依赖未装配", "检查内核装配（SelfRestart deps 缺失）")
	}
	if err := deps.ValidateUnit(req.Unit); err != nil {
		return RestartOutcome{}, errNoRestart("没有可用的自重启 unit："+err.Error(), hintNoUnit)
	}
	if !deps.HasSystemd() {
		return RestartOutcome{}, errNoRestart("当前环境没有 systemd，无法自重启", hintNoUnit)
	}
	if deps.EUID() == 0 {
		if req.Unit != DefaultSystemUnit {
			return RestartOutcome{}, errNoRestart("root 实例只允许重启 "+DefaultSystemUnit+"（实际 "+req.Unit+"）", hintNoUnit)
		}
		if err := deps.SystemRestart(req.Unit); err != nil {
			return RestartOutcome{}, errNoRestart("提交系统 unit 重启失败："+err.Error(), hintSubmitFailed)
		}
		return RestartOutcome{Committed: true, Unit: req.Unit, Mode: "system", Command: strings.Join(BuildRestartArgv(req.Unit), " ")}, nil
	}
	// 非 root：必须是配置显式指定的 user unit（形如 kored-local.service）。
	if strings.HasPrefix(req.Unit, DefaultSystemUnit) {
		return RestartOutcome{}, errNoRestart("非 root 实例不能重启系统 unit "+req.Unit, hintNoUnit)
	}
	if err := deps.UserRestart(req.Unit); err != nil {
		return RestartOutcome{}, errNoRestart("提交用户 unit 重启失败："+err.Error(), hintSubmitFailed)
	}
	return RestartOutcome{Committed: true, Unit: req.Unit, Mode: "user", Command: "systemctl --user --no-block restart " + req.Unit}, nil
}

const (
	hintNoUnit       = "本实例不是服务运行，无法自重启；请按 RUNBOOK 重新拉起（或用 --unit-name 指定已配置的 unit）"
	hintSubmitFailed = "重启未提交，当前配置未生效；检查 systemd/用户 bus 后重试，生效以新进程写入的标记为准"
)

// errNoRestart 构造带白话 hint 的结构化失败（pluginapi.Error 的 Detail.hint 供 HTTP 顶层透出）。
func errNoRestart(message, hint string) error {
	return errCode(E_NO_SELF_RESTART, message, hint)
}

// IsNoSelfRestart 报告错误是否为 E_NO_SELF_RESTART（供 HTTP 层精准映射）。
func IsNoSelfRestart(err error) bool {
	var perr *pluginapi.Error
	return errors.As(err, &perr) && perr.Code == E_NO_SELF_RESTART
}
