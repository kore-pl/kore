//go:build linux

package privilege

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// requireRootForNetAdmin 是真实 root 动作端到端测试的前置门禁：只要求 root
// （nft 读内核态需要 CAP_NET_ADMIN），**不再要求 systemd**——ADR-0049 后执行通道
// 直接 exec，非 systemd 宿主同样可测。
//
// 非 root 的 CI 容器会 skip；直接执行 / 退出码 / 进程组回收的用例在
// exec_integration_test.go 里，全部不需要 root。
func requireRootForNetAdmin(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("需要 root：nft 读内核态需要 CAP_NET_ADMIN")
	}
	if _, err := exec.LookPath("nft"); err != nil {
		t.Skip("跳过：nft 不在 PATH")
	}
}

// TestServiceExecuteEndToEnd 走完整 Service.Execute 路径：schema → 审计 begin
// → 直接 exec → 读输出 → 审计 end，断言真实退出码与两条审计事件。
//
// 命令必须是**受控形状内**的命令（ADR-0022：/bin/sh 一律拒绝）。这里用只读的
// `nft list table`：表不存在 → nft 退出 1 且 stderr 有 "Error"，正好同时验证
// 「退出码透传」与「stderr 落盘」。
func TestServiceExecuteEndToEnd(t *testing.T) {
	requireRootForNetAdmin(t)
	auditor := &fakeAuditor{}
	service := New(Options{
		Auditor: auditor,
		Root:    func() bool { return true },
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
	if result.ExitCode != 1 {
		t.Fatalf("nft 表不存在的真实退出码应为 1，实际 %d（说明没透传真实退出码）", result.ExitCode)
	}
	if !strings.Contains(result.Stderr, "Error") {
		t.Fatalf("stderr 未捕获：%q", result.Stderr)
	}
	if !strings.HasPrefix(result.Unit, "kore-root-selftest-nft-probe-") {
		t.Fatalf("审计标识不符合 kore-root-<plugin>-<action>-<rand>：%q", result.Unit)
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
