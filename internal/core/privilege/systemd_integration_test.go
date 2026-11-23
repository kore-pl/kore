//go:build linux

package privilege

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// requireRealPrivilegeChannel 是真实提权通道集成测试的前置门禁：
// 仅当进程是 root、系统以 systemd 引导且 systemd-run 可用时才执行，其余一律 skip。
//
// 这样 CI 容器（非 root / 无 systemd）不会因缺少宿主能力失败，而在真机 root 下
// 每次 `go test ./internal/core/privilege/` 都会覆盖 R5-1 的"动作真的执行且输出可读"。
func requireRealPrivilegeChannel(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("需要 root：真实提权通道以 uid=0 拉 systemd transient unit")
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		t.Skip("跳过：/run/systemd/system 不存在（未以 systemd 引导）")
	}
	for _, binary := range []string{"systemd-run", "systemctl"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skipf("跳过：%s 不在 PATH", binary)
		}
	}
}

// TestExecRunnerCapturesOutput 验证真实 systemd-run 的 stdout/stderr 落盘。
//
// 回归点（R5-1）：argv 若同时带 --pipe 与 `-p StandardOutput=file:`，文件重定向会被
// systemd 静默忽略，unit 输出丢失、exit code 照常为 0——本测试直接对 Runner 断言输出内容。
func TestExecRunnerCapturesOutput(t *testing.T) {
	requireRealPrivilegeChannel(t)
	dir := t.TempDir()
	stdoutPath := filepath.Join(dir, "stdout")
	stderrPath := filepath.Join(dir, "stderr")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	exitCode, err := (execRunner{}).Run(ctx, unitName("selftest", "echo"),
		[]string{"/bin/sh", "-c", "echo out-line; echo err-line >&2; exit 3"}, stdoutPath, stderrPath)
	if err != nil {
		t.Fatalf("systemd-run 启动失败：%v", err)
	}
	if exitCode != 3 {
		t.Fatalf("exit code 应为 3，实际 %d", exitCode)
	}
	stdout, err := os.ReadFile(stdoutPath)
	if err != nil {
		t.Fatalf("读取 stdout 文件失败（输出未落盘）：%v", err)
	}
	stderr, err := os.ReadFile(stderrPath)
	if err != nil {
		t.Fatalf("读取 stderr 文件失败（输出未落盘）：%v", err)
	}
	if !strings.Contains(string(stdout), "out-line") {
		t.Fatalf("stdout 未捕获 unit 输出：%q", stdout)
	}
	if !strings.Contains(string(stderr), "err-line") {
		t.Fatalf("stderr 未捕获 unit 输出：%q", stderr)
	}
}

// TestServiceExecuteSystemdEndToEnd 走完整 Service.Execute 路径：schema → 审计 begin
// → systemd-run transient unit → 读输出 → 审计 end，断言退出码与两条审计事件。
//
// 命令必须是**受控形状内**的命令（ADR-0022 之后 /bin/sh 已被拒绝——把 shell 放进
// 提权通道等于放行任意 argv）。这里用只读的 `nft list table`：表不存在 → nft 退出 1
// 且 stderr 有 "Error"，正好同时验证「退出码透传」与「stderr 落盘」。
// stdout 的落盘由 TestExecRunnerCapturesOutput（直接调 Runner，不经 schema）覆盖。
func TestServiceExecuteSystemdEndToEnd(t *testing.T) {
	requireRealPrivilegeChannel(t)
	if _, err := exec.LookPath("nft"); err != nil {
		t.Skip("跳过：nft 不在 PATH")
	}
	auditor := &fakeAuditor{}
	service := New(Options{
		Auditor: auditor,
		Root:    func() bool { return true },
		Systemd: func() (bool, string) { return true, "" },
		TempDir: t.TempDir(),
	})
	action := pluginapi.RootAction{
		ID:       "nft-probe",
		Argv:     []string{"nft", "list", "table", "inet", "kore_policy_selftest"},
		TimeoutS: 10,
	}
	result, err := service.Execute(context.Background(), Request{
		Actor: "verifier", PluginID: "selftest", Action: action,
	})
	if err != nil {
		t.Fatalf("Execute 返回错误：%v", err)
	}
	if !result.Executed || result.ExitCode == 0 {
		t.Fatalf("应执行且 exit≠0（表不存在），实际 %+v", result)
	}
	if !strings.Contains(result.Stderr, "Error") {
		t.Fatalf("stderr 未捕获：%q", result.Stderr)
	}
	if !strings.HasPrefix(result.Unit, "kore-root-selftest-selftest-echo-") {
		t.Fatalf("unit 名不符合 kore-root-<plugin>-<action>-<rand>：%q", result.Unit)
	}
	if len(auditor.events) != 2 {
		t.Fatalf("应有 begin/end 两条审计，实际 %d：%+v", len(auditor.events), auditor.events)
	}
	begin, end := auditor.events[0], auditor.events[1]
	if AuditAction != "root.action" {
		t.Fatalf("审计事件名漂移：%q", AuditAction)
	}
	if begin.Phase != PhaseBegin || begin.Decision != DecisionAllow {
		t.Fatalf("begin 审计不符：%+v", begin)
	}
	if end.Phase != PhaseEnd || end.ExitCode != result.ExitCode {
		t.Fatalf("end 审计不符：%+v", end)
	}
	if begin.Actor != "verifier" || begin.PluginID != "selftest" || begin.Unit != result.Unit {
		t.Fatalf("begin 审计主体/unit 不符：%+v", begin)
	}
}
