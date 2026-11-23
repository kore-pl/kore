package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/platform"
)

// fakeCleanup 记录调用顺序，绝不触碰真实 systemd / 系统用户。
type fakeCleanup struct {
	calls      []string
	unit       platform.UnitCleanup
	accounts   platform.AccountCleanup
	unitErr    error
	accountErr error
}

func (f *fakeCleanup) RemoveServiceUnit(string, string, bool) (platform.UnitCleanup, error) {
	f.calls = append(f.calls, "unit")
	return f.unit, f.unitErr
}

func (f *fakeCleanup) ListAccountsByPrefix(string) ([]string, error) {
	f.calls = append(f.calls, "list")
	return f.accounts.Matched, nil
}

func (f *fakeCleanup) RemoveAccountsByPrefix(string, bool) (platform.AccountCleanup, error) {
	f.calls = append(f.calls, "users")
	return f.accounts, f.accountErr
}

// uninstallFixture 构造隔离依赖：临时 state、假 cleanup、无 TTY、记录 purge。
func uninstallFixture(t *testing.T) (uninstallDeps, *fakeCleanup, *[]purgeOp, string) {
	t.Helper()
	state := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatalf("建 state 失败: %v", err)
	}
	cleanup := &fakeCleanup{
		unit: platform.UnitCleanup{
			UnitName: "kore.service",
			UnitPath: "/etc/systemd/system/kore.service",
			Present:  true,
			Active:   true,
			Actions:  []string{"systemctl stop kore.service", "systemctl disable kore.service", "rm -f /etc/systemd/system/kore.service", "systemctl daemon-reload"},
		},
		accounts: platform.AccountCleanup{Prefix: "kore-test-", Matched: []string{"kore-test-a"}, Removed: []string{"kore-test-a"}},
	}
	executed := &[]purgeOp{}
	removed := &[]string{}
	deps := uninstallDeps{
		cleanup:    cleanup,
		stdinIsTTY: func() bool { return false },
		confirm:    func(io.Reader, io.Writer) bool { return false },
		execPurge: func(op purgeOp) error {
			*executed = append(*executed, op)
			return nil
		},
		loadPaths: func(uninstallOptions) (string, string, error) { return state, "/tmp/fake-install", nil },
		removeAll: func(path string) error {
			*removed = append(*removed, path)
			return nil
		},
		euid: func() int { return 0 },
	}
	return deps, cleanup, executed, state
}

// TestUninstallOrder 验证执行序：unit → users → state 删除（ADR-0023 阶段 B）。
func TestUninstallOrder(t *testing.T) {
	deps, cleanup, executed, state := uninstallFixture(t)
	if err := appendChange(changesPath(state), changeEntry{
		Plugin: "site", Action: "vhost.write", Target: "/etc/nginx/conf.d/kore-x.conf",
		Reversible: true, PurgeOp: &purgeOp{Kind: purgeKindFileRemove, Args: []string{"/etc/nginx/conf.d/kore-x.conf"}},
	}); err != nil {
		t.Fatalf("写账本失败: %v", err)
	}
	var out, errOut bytes.Buffer
	code := runUninstallWith([]string{"--yes", "--purge", "--user-prefix", "kore-test-"}, &out, &errOut, deps)
	if code != exitOK {
		t.Fatalf("退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	if strings.Join(cleanup.calls, ",") != "unit,users" {
		t.Fatalf("调用序 = %v，期望 [unit users]", cleanup.calls)
	}
	if len(*executed) != 1 || (*executed)[0].Kind != purgeKindFileRemove {
		t.Fatalf("应执行结构化 purge_op，实际 %v", *executed)
	}
	if !strings.Contains(out.String(), "已删除状态目录："+state) {
		t.Fatalf("应删除状态目录，输出：\n%s", out.String())
	}
}

// TestUninstallDryRunNoMutations 验证 dry-run 不做任何变更。
func TestUninstallDryRunNoMutations(t *testing.T) {
	deps, _, executed, state := uninstallFixture(t)
	if err := appendChange(changesPath(state), changeEntry{
		Plugin: "site", Action: "a", Target: "/x", Reversible: true,
		PurgeOp: &purgeOp{Kind: purgeKindFileRemove, Args: []string{"/x"}},
	}); err != nil {
		t.Fatalf("写账本失败: %v", err)
	}
	var out, errOut bytes.Buffer
	code := runUninstallWith([]string{"--dry-run", "--purge"}, &out, &errOut, deps)
	if code != exitOK {
		t.Fatalf("dry-run 退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	if len(*executed) != 0 {
		t.Fatalf("dry-run 不得执行 purge，实际 %v", *executed)
	}
	if !strings.Contains(out.String(), "[DRY-RUN]") || !strings.Contains(out.String(), "将删除状态目录") {
		t.Fatalf("dry-run 输出缺少计划：\n%s", out.String())
	}
}

// TestUninstallNonInteractiveRefuses 验证非交互无 --yes 时零变更退出 2。
func TestUninstallNonInteractiveRefuses(t *testing.T) {
	deps, cleanup, _, _ := uninstallFixture(t)
	var out, errOut bytes.Buffer
	code := runUninstallWith(nil, &out, &errOut, deps)
	if code != exitConfig {
		t.Fatalf("退出码 = %d，期望 %d", code, exitConfig)
	}
	if len(cleanup.calls) != 0 {
		t.Fatalf("拒绝执行时不得调用平台层，实际 %v", cleanup.calls)
	}
	if !strings.Contains(errOut.String(), "--yes") {
		t.Fatalf("应提示 --yes，stderr=%s", errOut.String())
	}
}

// TestUninstallNeedsRoot 验证非 root 且要清 unit/用户时退出 6。
func TestUninstallNeedsRoot(t *testing.T) {
	deps, cleanup, _, _ := uninstallFixture(t)
	deps.euid = func() int { return 1000 }
	var out, errOut bytes.Buffer
	code := runUninstallWith([]string{"--yes"}, &out, &errOut, deps)
	if code != exitEnv {
		t.Fatalf("退出码 = %d，期望 %d", code, exitEnv)
	}
	if len(cleanup.calls) != 0 {
		t.Fatalf("非 root 不得调用平台层，实际 %v", cleanup.calls)
	}
}

// TestUninstallKeepFlags 验证 --keep-service / --keep-users 跳过对应步骤。
func TestUninstallKeepFlags(t *testing.T) {
	deps, cleanup, _, _ := uninstallFixture(t)
	var out, errOut bytes.Buffer
	code := runUninstallWith([]string{"--yes", "--keep-service", "--keep-users"}, &out, &errOut, deps)
	if code != exitOK {
		t.Fatalf("退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	if len(cleanup.calls) != 0 {
		t.Fatalf("两个 --keep-* 都不应调用平台层，实际 %v", cleanup.calls)
	}
	if !strings.Contains(out.String(), "kore.service 仍在") || !strings.Contains(out.String(), "kore-* 用户仍在") {
		t.Fatalf("应提示豁免项仍在：\n%s", out.String())
	}
}

// TestUninstallIdempotent 验证 unit/用户/状态都不存在时仍成功。
func TestUninstallIdempotent(t *testing.T) {
	deps, _, _, state := uninstallFixture(t)
	deps.cleanup = &fakeCleanup{
		unit:     platform.UnitCleanup{UnitName: "kore.service", Actions: []string{"unit 不存在且未运行，跳过"}},
		accounts: platform.AccountCleanup{Prefix: "kore-"},
	}
	if err := os.RemoveAll(state); err != nil {
		t.Fatalf("预清 state 失败: %v", err)
	}
	var out, errOut bytes.Buffer
	code := runUninstallWith([]string{"--yes", "--purge"}, &out, &errOut, deps)
	if code != exitOK {
		t.Fatalf("幂等执行退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "幂等") {
		t.Fatalf("应说明幂等：\n%s", out.String())
	}
}

// TestUninstallPurgeSkipsIrreversible 验证不可回滚条目不被执行。
func TestUninstallPurgeSkipsIrreversible(t *testing.T) {
	deps, _, executed, state := uninstallFixture(t)
	if err := appendChange(changesPath(state), changeEntry{
		Plugin: "ufw", Action: "allow", Target: "22/tcp", Reversible: false,
	}); err != nil {
		t.Fatalf("写账本失败: %v", err)
	}
	var out, errOut bytes.Buffer
	code := runUninstallWith([]string{"--yes", "--purge"}, &out, &errOut, deps)
	if code != exitOK {
		t.Fatalf("退出码 = %d；stderr=%s", code, errOut.String())
	}
	if len(*executed) != 0 {
		t.Fatalf("不可回滚条目不得执行 purge，实际 %v", *executed)
	}
}
