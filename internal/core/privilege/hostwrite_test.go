package privilege

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// ledgerRunner 是账本测试专用的执行器替身（ADR-0049 新签名：无 unit、无 KillUnit）。
type ledgerRunner struct {
	calls [][]string
	exit  int
	err   error
}

// Run 实现 Runner：记录 argv 并返回预设退出码。
func (r *ledgerRunner) Run(_ context.Context, argv []string, _, _ string) (int, error) {
	r.calls = append(r.calls, append([]string(nil), argv...))
	return r.exit, r.err
}

// fakeChangeRecorder 记录宿主变更条目；fail=true 模拟账本写失败（磁盘只读）。
type fakeChangeRecorder struct {
	changes []HostChange
	fail    bool
}

// RecordHostChange 实现 ChangeRecorder。
func (r *fakeChangeRecorder) RecordHostChange(_ context.Context, change HostChange) error {
	if r.fail {
		return errors.New("changes.jsonl 只读")
	}
	r.changes = append(r.changes, change)
	return nil
}

// testServiceWithLedger 装配带账本出口的提权服务（root + systemd 均可用）。
func testServiceWithLedger(t *testing.T, runner Runner, auditor *fakeAuditor, recorder *fakeChangeRecorder) *Service {
	t.Helper()
	return New(Options{
		Auditor: auditor, ChangeRecorder: recorder, Runner: runner, TempDir: t.TempDir(),
		Root: func() bool { return true },
	})
}

// ufwAllowHostWrite 是**带结构化回滚**的写宿主动作（放行 22/tcp）。
func ufwAllowHostWrite() Action {
	return Action{
		ID: "ufw-allow", Argv: []string{"ufw", "allow"}, TimeoutS: 30,
		Description: "放行 22/tcp", WritesHost: true, Target: "22/tcp",
		PurgeOp: &pluginapi.PurgeOp{Kind: pluginapi.PurgeKindFileRemove,
			Args: []string{"/etc/ufw/user.rules"}},
	}
}

// TestWritesHostActionAppendsChangeLedger 写宿主动作成功 → 账本恰好一条，字段与声明一致。
func TestWritesHostActionAppendsChangeLedger(t *testing.T) {
	runner := &ledgerRunner{exit: 0}
	auditor := &fakeAuditor{}
	recorder := &fakeChangeRecorder{}
	svc := testServiceWithLedger(t, runner, auditor, recorder)

	result, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: ufwAllowHostWrite()})
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if len(recorder.changes) != 1 {
		t.Fatalf("账本条目 %d 条，期望 1 条", len(recorder.changes))
	}
	got := recorder.changes[0]
	if got.PluginID != "firewall" || got.ActionID != "ufw-allow" || got.Target != "22/tcp" || got.Summary != "放行 22/tcp" {
		t.Fatalf("账本条目字段不对: %+v", got)
	}
	if got.PurgeOp == nil || got.PurgeOp.Kind != pluginapi.PurgeKindFileRemove {
		t.Fatalf("结构化 purge_op 未透传: %+v", got.PurgeOp)
	}
	if !result.HostChangeRecorded {
		t.Fatalf("结果未标记 host_change_recorded=true")
	}
}

// TestReadActionDoesNotAppendChangeLedger 只读动作 → 不写账本（argv 只读，无 target）。
func TestReadActionDoesNotAppendChangeLedger(t *testing.T) {
	runner := &ledgerRunner{exit: 0}
	recorder := &fakeChangeRecorder{}
	svc := testServiceWithLedger(t, runner, &fakeAuditor{}, recorder)

	if _, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: ufwStatus()}); err != nil {
		t.Fatalf("只读动作执行失败: %v", err)
	}
	if len(recorder.changes) != 0 {
		t.Fatalf("只读动作写了 %d 条账本，期望 0 条", len(recorder.changes))
	}
}

// TestFailedWritesHostActionDoesNotAppendChangeLedger 写宿主动作失败（exit!=0）→ 不写账本。
func TestFailedWritesHostActionDoesNotAppendChangeLedger(t *testing.T) {
	runner := &ledgerRunner{exit: 1}
	recorder := &fakeChangeRecorder{}
	svc := testServiceWithLedger(t, runner, &fakeAuditor{}, recorder)

	// 契约：exit_code!=0 不是"执行失败"，动作确实被执行了，错误码透传给调用方；
	// 但账本只记成功（exit_code=0）的宿主变更——失败的动作不该被当成"改成了"。
	result, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: ufwAllowHostWrite()})
	if err != nil {
		t.Fatalf("exit=1 不应返回执行错误（退出码透传）: %v", err)
	}
	if len(recorder.changes) != 0 {
		t.Fatalf("失败动作写了 %d 条账本，期望 0 条", len(recorder.changes))
	}
	if result.HostChangeRecorded {
		t.Fatalf("失败动作不应标记 host_change_recorded")
	}
}

// TestWritesHostWithoutPurgeRequiresConfirm 无回滚信息的写宿主动作**降级为需 confirm**：
// 无令牌 → E_UNAUTHORIZED 且不执行；签发令牌后才执行并落账（reversible=false）。
func TestWritesHostWithoutPurgeRequiresConfirm(t *testing.T) {
	action := ufwAllowHostWrite()
	action.PurgeOp = nil // 拿不出回滚方式：必须降级
	action.Target = "22/tcp"

	if !NeedsConfirm(action) {
		t.Fatalf("writes_host 且无 purge_op 的动作必须要求 confirm")
	}
	runner := &ledgerRunner{exit: 0}
	recorder := &fakeChangeRecorder{}
	svc := testServiceWithLedger(t, runner, &fakeAuditor{}, recorder)

	if _, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: action}); err == nil {
		t.Fatalf("缺 confirm 令牌的写宿主动作必须被拒绝")
	} else {
		if code := codeOf(t, err); code != pluginapi.E_UNAUTHORIZED {
			t.Fatalf("拒绝码 = %s，期望 %s", code, pluginapi.E_UNAUTHORIZED)
		}
		if !strings.Contains(err.Error(), "confirm") {
			t.Fatalf("拒绝原因未提到 confirm: %v", err)
		}
	}
	if len(runner.calls) != 0 {
		t.Fatalf("被拒绝的动作仍被执行了 %d 次", len(runner.calls))
	}
	if len(recorder.changes) != 0 {
		t.Fatalf("被拒绝的动作写了账本")
	}

	grant, err := svc.Confirm().Issue("firewall", action.ID)
	if err != nil {
		t.Fatalf("签发令牌失败: %v", err)
	}
	if _, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall",
		Action: action, Confirm: grant.Token}); err != nil {
		t.Fatalf("带令牌执行失败: %v", err)
	}
	if len(recorder.changes) != 1 || recorder.changes[0].PurgeOp != nil {
		t.Fatalf("降级动作落账应为 1 条且 purge_op=nil: %+v", recorder.changes)
	}
}

// TestWritesHostWithoutRecorderDenied 账本未装配 → 写宿主动作 fail-closed（不执行）。
func TestWritesHostWithoutRecorderDenied(t *testing.T) {
	runner := &ledgerRunner{exit: 0}
	auditor := &fakeAuditor{}
	svc := New(Options{
		Auditor: auditor, Runner: runner, TempDir: t.TempDir(),
		Root: func() bool { return true },
	})

	if _, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: ufwAllowHostWrite()}); err == nil {
		t.Fatalf("账本未装配时必须拒绝写宿主动作")
	}
	if len(runner.calls) != 0 {
		t.Fatalf("账本未装配的动作仍被执行了 %d 次", len(runner.calls))
	}
	last := auditor.events[len(auditor.events)-1]
	if last.Decision != DecisionDeny || last.DenyReason != "change_ledger_unavailable" {
		t.Fatalf("拒绝审计不对: %+v", last)
	}
}
