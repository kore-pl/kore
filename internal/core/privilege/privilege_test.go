package privilege

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fakeRunner 记录调用并模拟命令执行（ADR-0049 直接 exec 契约：无 unit、无 Kill）；
// block=true 时等 ctx 超时（测超时路径）。
type fakeRunner struct {
	calls  [][]string
	exit   int
	err    error
	block  bool
	out    string
	errOut string
}

func (f *fakeRunner) Run(ctx context.Context, argv []string, stdoutPath, stderrPath string) (int, error) {
	f.calls = append(f.calls, append([]string(nil), argv...))
	if f.out != "" {
		_ = os.WriteFile(stdoutPath, []byte(f.out), 0o600)
	}
	if f.errOut != "" {
		_ = os.WriteFile(stderrPath, []byte(f.errOut), 0o600)
	}
	if f.block {
		<-ctx.Done()
		return -1, ctx.Err()
	}
	return f.exit, f.err
}

// fakeAuditor 记录审计事件；fail=true 模拟 bbolt 写失败。
type fakeAuditor struct {
	events []Event
	fail   bool
}

func (a *fakeAuditor) Record(_ context.Context, ev Event) error {
	if a.fail {
		return errors.New("state.db 只读")
	}
	a.events = append(a.events, ev)
	return nil
}

func testService(t *testing.T, runner *fakeRunner, auditor *fakeAuditor, root bool) *Service {
	t.Helper()
	return New(Options{
		Auditor: auditor, Runner: runner, TempDir: t.TempDir(),
		Root: func() bool { return root },
	})
}

// ufwStatus 是合法动作（argv[0] 为白名单命令名）。
func ufwStatus() Action {
	return Action{ID: "ufw-status", Argv: []string{"ufw", "status", "verbose"}, TimeoutS: 5,
		Description: "读取 ufw 状态"}
}

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var protocolErr *pluginapi.Error
	if !errors.As(err, &protocolErr) {
		t.Fatalf("期望 *pluginapi.Error，实际 %T: %v", err, err)
	}
	return protocolErr.Code
}

func hintOf(t *testing.T, err error) string {
	t.Helper()
	var protocolErr *pluginapi.Error
	if !errors.As(err, &protocolErr) {
		t.Fatalf("期望 *pluginapi.Error，实际 %T", err)
	}
	var detail struct {
		Hint string `json:"hint"`
	}
	if err := json.Unmarshal(protocolErr.Detail, &detail); err != nil {
		t.Fatalf("detail 不是合法 JSON: %v", err)
	}
	return detail.Hint
}

// TestValidateActionSchema 覆盖非法 id / argv / timeout 的拒绝与合法动作的通过。
func TestValidateActionSchema(t *testing.T) {
	cases := []struct {
		name   string
		action Action
		ok     bool
	}{
		{"合法命令名", ufwStatus(), true},
		{"合法绝对路径（系统目录）", Action{ID: "a", Argv: []string{"/usr/sbin/ufw", "status"}, TimeoutS: 1}, true},
		{"绝对路径目录不受控", Action{ID: "a", Argv: []string{"/tmp/nft", "list", "ruleset"}, TimeoutS: 1}, false},
		{"未受控命令", Action{ID: "a", Argv: []string{"sed", "-i", "s/a/b/", "/etc/passwd"}, TimeoutS: 1}, false},
		{"合法：ufw enable（第 40 把新增形状）", Action{ID: "ufw-enable", Argv: []string{"ufw", "enable"}, TimeoutS: 15}, true},
		{"合法：ufw disable", Action{ID: "ufw-disable", Argv: []string{"ufw", "disable"}, TimeoutS: 15}, true},
		{"子命令未锁定（多余参数）", Action{ID: "a", Argv: []string{"ufw", "enable", "--force"}, TimeoutS: 15}, false},
		{"非法 id 大写", Action{ID: "Ufw", Argv: []string{"ufw"}, TimeoutS: 5}, false},
		{"非法 id 下划线", Action{ID: "ufw_status", Argv: []string{"ufw"}, TimeoutS: 5}, false},
		{"空 argv", Action{ID: "a", Argv: nil, TimeoutS: 5}, false},
		{"argv0 不在白名单", Action{ID: "a", Argv: []string{"rm", "-rf", "/"}, TimeoutS: 5}, false},
		{"argv0 相对路径", Action{ID: "a", Argv: []string{"./run.sh"}, TimeoutS: 5}, false},
		{"argv0 含 ..", Action{ID: "a", Argv: []string{"/usr/bin/../bin/id"}, TimeoutS: 5}, false},
		{"timeout 0", Action{ID: "a", Argv: []string{"ufw"}, TimeoutS: 0}, false},
		{"timeout 301", Action{ID: "a", Argv: []string{"ufw"}, TimeoutS: 301}, false},
		{"参数含换行", Action{ID: "a", Argv: []string{"ufw", "status\nrm"}, TimeoutS: 5}, false},
		{"参数为空", Action{ID: "a", Argv: []string{"ufw", ""}, TimeoutS: 5}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateAction(tc.action)
			if tc.ok && err != nil {
				t.Fatalf("应通过，实际拒绝：%v", err)
			}
			if !tc.ok && err == nil {
				t.Fatalf("应拒绝，实际通过：%+v", tc.action)
			}
		})
	}
}

// TestExecuteArgvFixed 证明追加参数只能附在声明 argv 之后、且必须落在形状 Tail 上。
func TestExecuteArgvFixed(t *testing.T) {
	runner := &fakeRunner{out: "Rule added\n"}
	auditor := &fakeAuditor{}
	svc := testService(t, runner, auditor, true)
	// ufw allow 的形状是「声明 [allow] + 追加 <ufw-target>」。
	action := Action{ID: "ufw-allow", Argv: []string{"ufw", "allow"}, TimeoutS: 5}
	result, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "firewall", Action: action, Args: []string{"22/tcp"},
	})
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if !result.Executed || result.ExitCode != 0 || result.Stdout != "Rule added\n" {
		t.Fatalf("结果不符：%+v", result)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("应调用一次，实际 %d", len(runner.calls))
	}
	want := append(append([]string{}, action.Argv...), "22/tcp")
	if strings.Join(runner.calls[0], "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv 不是固定前缀 + 追加参数：got %v want %v", runner.calls[0], want)
	}
	// 追加参数不能替换 argv[0]：路径形态的 arg 不是合法目标形状 → E_INVALID 且不执行。
	_, err = svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "firewall", Action: action, Args: []string{"../systemctl"},
	})
	if code := codeOf(t, err); code != pluginapi.E_INVALID {
		t.Fatalf("非法追加参数应 E_INVALID，实际 %q", code)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("非法追加参数不得执行：%v", runner.calls)
	}
	// 审计：第一轮 begin+end 两条 + 第二轮 deny 一条。
	if len(auditor.events) != 3 {
		t.Fatalf("审计应有 begin/end + deny 三条，实际 %d：%+v", len(auditor.events), auditor.events)
	}
	if auditor.events[2].Decision != DecisionDeny {
		t.Fatalf("第三条应为 deny 审计：%+v", auditor.events[2])
	}
}

// TestExecuteRejectsAppendedInjection 追加参数注入（分号 / 命令替换 / 换行）在执行期
// 被拒绝，且不产生任何执行（ADR-0022）。
func TestExecuteRejectsAppendedInjection(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		args []string
	}{
		{"分号拼接第二语句", []string{"ufw", "allow"}, []string{"22/tcp; ufw disable"}},
		{"命令替换", []string{"ufw", "allow"}, []string{"$(reboot)"}},
		{"换行", []string{"ufw", "allow"}, []string{"22\ndisable"}},
		{"只读语句被追加写参数", []string{"nft", "list", "table", "inet", "kore_waf"},
			[]string{"counter", "drop"}},
		{"集合元素非 IP", []string{"nft", "add", "element", "inet", "kore_waf", "banned4"},
			[]string{"{", "not-an-ip", "}"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runner := &fakeRunner{}
			auditor := &fakeAuditor{}
			svc := testService(t, runner, auditor, true)
			_, err := svc.Execute(context.Background(), Request{
				Actor: "admin", PluginID: "waf",
				Action: Action{ID: "probe", Argv: tc.argv, TimeoutS: 5}, Args: tc.args,
			})
			if code := codeOf(t, err); code != pluginapi.E_INVALID {
				t.Fatalf("应 E_INVALID，实际 %q", code)
			}
			if len(runner.calls) != 0 {
				t.Fatalf("注入参数不得执行：%v", runner.calls)
			}
			if len(auditor.events) != 1 || auditor.events[0].Decision != DecisionDeny {
				t.Fatalf("应有一条 deny 审计：%+v", auditor.events)
			}
		})
	}
}

// TestExecuteNeedRoot 非 root → E_NEED_ROOT + hint，且不执行、写 deny 审计。
func TestExecuteNeedRoot(t *testing.T) {
	runner := &fakeRunner{}
	auditor := &fakeAuditor{}
	svc := testService(t, runner, auditor, false)
	_, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: ufwStatus()})
	if code := codeOf(t, err); code != pluginapi.E_NEED_ROOT {
		t.Fatalf("应 E_NEED_ROOT，实际 %s", code)
	}
	if hint := hintOf(t, err); !strings.Contains(hint, "系统服务") || strings.Contains(hint, "sudo") {
		t.Fatalf("hint 应按 ADR-0042 指向系统服务形态且不教 sudo，实际 %q", hint)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("拒绝路径不得执行命令，实际调用 %d 次", len(runner.calls))
	}
	if len(auditor.events) != 1 || auditor.events[0].Decision != DecisionDeny ||
		auditor.events[0].DenyReason != "not_root" {
		t.Fatalf("应写一条 deny 审计，实际 %+v", auditor.events)
	}
}

// TestNoSystemdGate 证明提权准入里**不再有 systemd 前置**（ADR-0049）：
// 同一个请求在旧实现会返回 E_NO_SYSTEMD，现在必须正常执行。
//
// 「/run/systemd/system 不存在」的真实环境用例见 exec_integration_test.go
// （TestExecuteWithoutSystemdMarker），那里用真实 Runner 跑通全链路。
func TestNoSystemdGate(t *testing.T) {
	runner := &fakeRunner{out: "Status: active\n"}
	auditor := &fakeAuditor{}
	svc := testService(t, runner, auditor, true)
	result, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "firewall", Action: ufwStatus(),
	})
	if err != nil {
		t.Fatalf("不应因缺 systemd 被拒绝（ADR-0049）：%v", err)
	}
	if !result.Executed || len(runner.calls) != 1 {
		t.Fatalf("应执行一次，实际 %+v / calls=%d", result, len(runner.calls))
	}
	// 常量保留做协议兼容（老客户端认识这个码），只是不再触发。
	if pluginapi.E_NO_SYSTEMD == "" {
		t.Fatal("E_NO_SYSTEMD 常量必须保留做协议兼容")
	}
}

// TestAuditFailureBlocksExecution 审计写失败 → E_INTERNAL 且不执行（fail-closed）。
func TestAuditFailureBlocksExecution(t *testing.T) {
	runner := &fakeRunner{}
	svc := testService(t, runner, &fakeAuditor{fail: true}, true)
	_, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: ufwStatus()})
	if code := codeOf(t, err); code != pluginapi.E_INTERNAL {
		t.Fatalf("应 E_INTERNAL，实际 %s", code)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("审计失败时动作不得执行，实际调用 %d 次", len(runner.calls))
	}
}

// TestExecuteIrreversibleConfirm 不可回滚动作必须带一次性 confirm 令牌。
func TestExecuteIrreversibleConfirm(t *testing.T) {
	runner := &fakeRunner{}
	auditor := &fakeAuditor{}
	svc := testService(t, runner, auditor, true)
	action := ufwStatus()
	action.Irreversible = true

	_, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: action})
	if code := codeOf(t, err); code != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("缺 confirm 应 E_UNAUTHORIZED，实际 %s", code)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("缺 confirm 不得执行")
	}

	grant, err := svc.Confirm().Issue("firewall", action.ID)
	if err != nil {
		t.Fatalf("签发令牌失败：%v", err)
	}
	if _, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "firewall", Action: action, Confirm: grant.Token,
	}); err != nil {
		t.Fatalf("带有效令牌应执行：%v", err)
	}
	// 用完即废：同一令牌再用必须失败。
	_, err = svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "firewall", Action: action, Confirm: grant.Token,
	})
	if code := codeOf(t, err); code != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("令牌复用应 E_UNAUTHORIZED，实际 %s", code)
	}
}

// TestConfirmTokenLifecycle 覆盖缺失 / 过期 / 绑定不匹配 / 用完即废。
func TestConfirmTokenLifecycle(t *testing.T) {
	store := NewConfirmStore(time.Minute)
	store.now = func() time.Time { return time.Unix(1000, 0) }
	grant, err := store.Issue("firewall", "ufw-allow")
	if err != nil {
		t.Fatalf("签发失败：%v", err)
	}
	if err := store.Consume("", "firewall", "ufw-allow"); codeOf(t, err) != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("缺失令牌应拒绝")
	}
	if err := store.Consume(grant.Token, "nginx", "ufw-allow"); codeOf(t, err) != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("绑定不匹配应拒绝")
	}
	if err := store.Consume(grant.Token, "firewall", "ufw-deny"); codeOf(t, err) != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("action 不匹配应拒绝")
	}
	if err := store.Consume(grant.Token, "firewall", "ufw-allow"); err != nil {
		t.Fatalf("匹配令牌应通过：%v", err)
	}
	if err := store.Consume(grant.Token, "firewall", "ufw-allow"); codeOf(t, err) != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("令牌只能用一次")
	}

	store.now = func() time.Time { return time.Unix(2000, 0) }
	expired, _ := store.Issue("firewall", "ufw-allow")
	store.now = func() time.Time { return time.Unix(2000+61, 0) }
	if err := store.Consume(expired.Token, "firewall", "ufw-allow"); codeOf(t, err) != pluginapi.E_UNAUTHORIZED {
		t.Fatalf("过期令牌应拒绝")
	}
}

// TestTimeoutReturnsUpstream 超时返回 E_UPSTREAM，退出码归一为 -1。
//
// 进程树真的被 kill 由 exec_integration_test.go 的真实用例覆盖（pgrep -g 断言）：
// fakeRunner 只负责验证上层判定与归一，不假装自己会杀进程。
func TestTimeoutReturnsUpstream(t *testing.T) {
	runner := &fakeRunner{block: true}
	svc := testService(t, runner, &fakeAuditor{}, true)
	action := ufwStatus()
	action.TimeoutS = 1
	start := time.Now()
	result, err := svc.Execute(context.Background(), Request{Actor: "admin", PluginID: "firewall", Action: action})
	if code := codeOf(t, err); code != pluginapi.E_UPSTREAM {
		t.Fatalf("超时应 E_UPSTREAM，实际 %s", code)
	}
	if !result.Executed || result.ExitCode != -1 {
		t.Fatalf("超时结果应 executed=true/exit=-1，实际 %+v", result)
	}
	// 直接执行没有 systemd-run 的 2s 宽限：动作 timeout_s 到点即返回。
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("超时应在 timeout_s 附近返回，实际 %v", elapsed)
	}
}

// TestRedactArgv 敏感参数不应进审计。
func TestRedactArgv(t *testing.T) {
	got := RedactArgv([]string{"systemctl", "--password=hunter2", "--token", "abc123", "status"})
	if strings.Contains(got, "hunter2") || strings.Contains(got, "abc123") {
		t.Fatalf("敏感值未脱敏：%s", got)
	}
}
