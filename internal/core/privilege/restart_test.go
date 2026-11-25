package privilege

import (
	"strings"
	"testing"
)

// TestSelfRestartRootUsesSystemUnitAndNoBlock root + kore.service → 复用系统 unit 提交，argv 带 --no-block。
func TestSelfRestartRootUsesSystemUnitAndNoBlock(t *testing.T) {
	var argv []string
	deps := RestartDeps{
		EUID:          func() int { return 0 },
		HasSystemd:    func() bool { return true },
		ValidateUnit:  validateUnitName,
		SystemRestart: func(unit string) error { argv = BuildRestartArgv(unit); return nil },
		UserRestart:   func(string) error { t.Fatal("root 不应走 user 分支"); return nil },
	}
	out, err := SelfRestartWith(RestartRequest{Reason: "cold config", Unit: DefaultSystemUnit, Actor: "admin"}, deps)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !out.Committed || out.Mode != "system" {
		t.Fatalf("outcome=%+v", out)
	}
	if got := strings.Join(argv, " "); got != "systemctl --no-block restart kore.service" {
		t.Fatalf("argv=%q", got)
	}
}

// TestSelfRestartUserUnit 非 root + 显式 user unit → systemctl --user --no-block restart。
func TestSelfRestartUserUnit(t *testing.T) {
	var userUnit string
	deps := RestartDeps{
		EUID:          func() int { return 1000 },
		HasSystemd:    func() bool { return true },
		ValidateUnit:  validateUnitName,
		SystemRestart: func(string) error { t.Fatal("非 root 不应走 system 分支"); return nil },
		UserRestart:   func(unit string) error { userUnit = unit; return nil },
	}
	out, err := SelfRestartWith(RestartRequest{Reason: "index_dir", Unit: "kored-local.service"}, deps)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !out.Committed || out.Mode != "user" || userUnit != "kored-local.service" {
		t.Fatalf("out=%+v unit=%q", out, userUnit)
	}
	if !strings.Contains(out.Command, "--user --no-block restart") {
		t.Fatalf("command=%q", out.Command)
	}
}

// TestSelfRestartNoSystemdFailsClosed 无 systemd → E_NO_SELF_RESTART + hint，不静默降级。
func TestSelfRestartNoSystemdFailsClosed(t *testing.T) {
	deps := RestartDeps{
		EUID:          func() int { return 0 },
		HasSystemd:    func() bool { return false },
		ValidateUnit:  validateUnitName,
		SystemRestart: func(string) error { t.Fatal("无 systemd 不得提交"); return nil },
		UserRestart:   func(string) error { t.Fatal("无 systemd 不得提交"); return nil },
	}
	_, err := SelfRestartWith(RestartRequest{Reason: "r", Unit: DefaultSystemUnit}, deps)
	if err == nil || !IsNoSelfRestart(err) {
		t.Fatalf("err=%v want E_NO_SELF_RESTART", err)
	}
	if !strings.Contains(err.Error(), "systemd") {
		t.Fatalf("err no hint: %v", err)
	}
}

// TestSelfRestartNoUnit / 注入防护：无 unit 或非法 unit 一律结构化失败。
func TestSelfRestartRejectsInvalidUnit(t *testing.T) {
	deps := RestartDeps{
		EUID:          func() int { return 0 },
		HasSystemd:    func() bool { return true },
		ValidateUnit:  validateUnitName,
		SystemRestart: func(string) error { t.Fatal("非法 unit 不得提交"); return nil },
		UserRestart:   func(string) error { t.Fatal("非法 unit 不得提交"); return nil },
	}
	for _, unit := range []string{"", "kore.service; rm -rf /", "evil$(id).service"} {
		_, err := SelfRestartWith(RestartRequest{Reason: "r", Unit: unit}, deps)
		if err == nil || !IsNoSelfRestart(err) {
			t.Fatalf("unit=%q err=%v want E_NO_SELF_RESTART", unit, err)
		}
	}
}

// TestConfirmReasonBinding confirm 令牌绑 reason：错 reason / 重用均被拒。
func TestConfirmReasonBinding(t *testing.T) {
	store := NewConfirmStore(DefaultConfirmTTL)
	grant, err := store.IssueWithReason(RestartPluginID, RestartActionID, "restart A")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ConsumeWithReason(grant.Token, RestartPluginID, RestartActionID, "restart B"); err == nil {
		t.Fatal("错 reason 必须拒绝")
	}
	if err := store.ConsumeWithReason(grant.Token, RestartPluginID, RestartActionID, "restart A"); err != nil {
		t.Fatalf("正确 reason 应通过: %v", err)
	}
	if err := store.ConsumeWithReason(grant.Token, RestartPluginID, RestartActionID, "restart A"); err == nil {
		t.Fatal("一次性令牌不得重用")
	}
}
