package privilege

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/filewrite"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fakeAuditor 收集审计事件（实现 privilege.Auditor）。
type collectAuditor struct{ events []Event }

func (a *collectAuditor) Record(_ context.Context, ev Event) error {
	a.events = append(a.events, ev)
	return nil
}

// fakeChanges 收集宿主变更账本条目（实现 ChangeRecorder）。
type collectChanges struct{ changes []HostChange }

func (c *collectChanges) RecordHostChange(_ context.Context, change HostChange) error {
	c.changes = append(c.changes, change)
	return nil
}

// failRunner 在 file_write 分支被调用即报错——证明受控写不走 os/exec。
type failRunner struct{ called bool }

func (r *failRunner) Run(context.Context, []string, string, string) (int, error) {
	r.called = true
	return -1, errors.New("file_write 不应走 exec")
}

const dispatchVHost = "server {\n    listen 80;\n    server_name example.com;\n    root /var/www/example;\n}\n"

// fileWriteAction 构造一条合法的 file_write 动作声明（带 purge_op → 无需 confirm）。
func fileWriteAction() pluginapi.RootAction {
	return pluginapi.RootAction{
		ID: "site-write-vhost", WritesHost: true,
		Target:      pluginapi.FileWritePrefixClasses["nginx.conf.d"].Dir,
		Description: "写站点 nginx 片段",
		PurgeOp: &pluginapi.PurgeOp{
			Kind: pluginapi.PurgeKindFileRemove,
			Args: []string{"/etc/nginx/conf.d/kore-site-x.conf"},
		},
		FileWrite: &pluginapi.FileWrite{
			PrefixClass:   "nginx.conf.d",
			Mode:          pluginapi.FileWriteModeRoot0644,
			ContentPolicy: pluginapi.ContentPolicyNginxVHost,
		},
	}
}

// newFileWriteService 组装一个只在临时目录里写、属主复核为 no-op 的提权服务。
func newFileWriteService(t *testing.T, dir string) (*Service, *collectAuditor, *collectChanges, *failRunner) {
	t.Helper()
	audit := &collectAuditor{}
	changes := &collectChanges{}
	runner := &failRunner{}
	svc := New(Options{
		Auditor:        audit,
		ChangeRecorder: changes,
		Runner:         runner,
		Root:           func() bool { return true },
		FileWrite: &FileWriteOptions{
			CopyRoot:     filepath.Join(t.TempDir(), "backups"),
			Policy:       pluginapi.DefaultFileWriteOptions(),
			DirOverrides: map[string]string{"nginx.conf.d": dir},
			OwnerCheck:   func(string, os.FileMode) error { return nil },
		},
	})
	return svc, audit, changes, runner
}

// TestExecuteFileWriteDispatch 覆盖：file_write 分派到受控写（不 exec）、审计 begin/end、
// changes.jsonl 的 purge_op（新文件 file.remove；覆盖 file.restore）。
func TestExecuteFileWriteDispatch(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	svc, audit, changes, runner := newFileWriteService(t, dir)
	action := fileWriteAction()
	result, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: action,
		Args: []string{"kore-site-x.conf"}, Content: dispatchVHost,
	})
	if err != nil {
		t.Fatalf("file_write 执行失败：%v", err)
	}
	if runner.called {
		t.Fatalf("file_write 不得走 os/exec（Runner 被调用）")
	}
	if !result.Executed || result.ExitCode != 0 || result.FileWrite == nil {
		t.Fatalf("结果字段不符：%+v", result)
	}
	if result.FileWrite.Path != dir+"kore-site-x.conf" {
		t.Fatalf("落盘路径不符：%q", result.FileWrite.Path)
	}
	if !result.HostChangeRecorded || len(changes.changes) != 1 {
		t.Fatalf("changes.jsonl 未记录：%+v", changes.changes)
	}
	first := changes.changes[0]
	if first.PurgeOp == nil || first.PurgeOp.Kind != pluginapi.PurgeKindFileRemove {
		t.Fatalf("新文件的 purge_op 应为 file.remove：%+v", first.PurgeOp)
	}
	if first.Target != action.Target {
		t.Fatalf("账本 target 应为类别目录（声明值），实际 %q", first.Target)
	}
	// 审计：begin（写盘前）+ end（结果）两条，且都不含正文。
	if len(audit.events) != 2 {
		t.Fatalf("审计应有 begin+end 两条，实际 %d：%+v", len(audit.events), audit.events)
	}
	if audit.events[0].Phase != PhaseBegin || audit.events[1].Phase != PhaseEnd {
		t.Fatalf("审计 phase 不符：%+v", audit.events)
	}
	for _, ev := range audit.events {
		if ev.FileWrite == nil || strings.Contains(ev.Argv, "server {") {
			t.Fatalf("审计必须带哈希元数据且不记正文：%+v", ev)
		}
	}

	// 覆盖同一文件 → purge_op 变成 file.restore（备份, 目标）。
	result, err = svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: action,
		Args: []string{"kore-site-x.conf"}, Content: dispatchVHost,
	})
	if err != nil {
		t.Fatalf("二次写入失败：%v", err)
	}
	restore := changes.changes[len(changes.changes)-1]
	if restore.PurgeOp == nil || restore.PurgeOp.Kind != pluginapi.PurgeKindFileRestore {
		t.Fatalf("覆盖写应产生 file.restore：%+v", restore.PurgeOp)
	}
	if len(restore.PurgeOp.Args) != 2 || restore.PurgeOp.Args[1] != result.FileWrite.Path {
		t.Fatalf("file.restore 参数应为（备份, 目标）：%v", restore.PurgeOp.Args)
	}
	if restore.PurgeOp.Args[0] != result.FileWrite.CopyPath {
		t.Fatalf("file.restore 备份参数与结果不一致：%v vs %q", restore.PurgeOp.Args, result.FileWrite.CopyPath)
	}
}

// TestExecuteFileWriteNonRoot 覆盖非 root 降级：E_NEED_ROOT + deny 审计。
func TestExecuteFileWriteNonRoot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	svc, audit, changes, _ := newFileWriteService(t, dir)
	svc.opts.Root = func() bool { return false }
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileWriteAction(),
		Args: []string{"kore-site-x.conf"}, Content: dispatchVHost,
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_NEED_ROOT {
		t.Fatalf("非 root 应 E_NEED_ROOT，实际 %v", err)
	}
	if len(changes.changes) != 0 {
		t.Fatalf("拒绝路径不得写账本：%+v", changes.changes)
	}
	if len(audit.events) != 1 || audit.events[0].Decision != DecisionDeny {
		t.Fatalf("拒绝路径必须落 deny 审计：%+v", audit.events)
	}
	if _, statErr := os.Stat(dir + "kore-site-x.conf"); !os.IsNotExist(statErr) {
		t.Fatalf("非 root 不得落盘：%v", statErr)
	}
}

// TestExecuteFileWriteBadNameDeny 覆盖请求期失败：只落 deny 审计，不造「无 begin 的 end」。
func TestExecuteFileWriteBadNameDeny(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	svc, audit, changes, runner := newFileWriteService(t, dir)
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileWriteAction(),
		Args: []string{"evil.conf"}, Content: dispatchVHost,
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_INVALID {
		t.Fatalf("非法文件名应 E_INVALID，实际 %v", err)
	}
	if runner.called || len(changes.changes) != 0 {
		t.Fatalf("拒绝路径不得 exec 或写账本")
	}
	if len(audit.events) != 1 || audit.events[0].Decision != DecisionDeny {
		t.Fatalf("应只落一条 deny 审计（不造假 end）：%+v", audit.events)
	}
	if _, statErr := os.Stat(dir + "evil.conf"); !os.IsNotExist(statErr) {
		t.Fatalf("拒绝路径不得落盘：%v", statErr)
	}
}

// TestExecuteFileWriteUnwired 覆盖未装配：file_write 一律 E_UNSUPPORTED（fail-closed）。
func TestExecuteFileWriteUnwired(t *testing.T) {
	svc := New(Options{Auditor: &collectAuditor{}, ChangeRecorder: &collectChanges{}, Root: func() bool { return true }})
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileWriteAction(),
		Args: []string{"kore-site-x.conf"}, Content: dispatchVHost,
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_UNSUPPORTED {
		t.Fatalf("未装配应 E_UNSUPPORTED，实际 %v", err)
	}
}

// TestExecuteExecRejectsContent 覆盖语义隔离：exec 动作携带 content 直接拒绝。
func TestExecuteExecRejectsContent(t *testing.T) {
	audit := &collectAuditor{}
	svc := New(Options{
		Auditor: audit, ChangeRecorder: &collectChanges{},
		Root:   func() bool { return true },
		Runner: &failRunner{},
	})
	action := pluginapi.RootAction{ID: "nginx.reload", Argv: []string{"/bin/systemctl", "reload", "nginx"}, TimeoutS: 10}
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: action,
		Args: []string{"nginx"}, Content: "x",
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_INVALID {
		t.Fatalf("exec 动作带 content 应 E_INVALID，实际 %v", err)
	}
	if len(audit.events) != 1 || audit.events[0].Decision != DecisionDeny {
		t.Fatalf("拒绝必须留 deny 审计：%+v", audit.events)
	}
}

// TestFileWriteErrorMapping 覆盖错误码映射：输入类 → E_INVALID，系统类 → E_INTERNAL。
func TestFileWriteErrorMapping(t *testing.T) {
	cases := []struct {
		code     string
		wantCode string
	}{
		{filewrite.CodeDeniedPath, pluginapi.E_INVALID},
		{filewrite.CodeTooLarge, pluginapi.E_INVALID},
		{filewrite.CodeBadContent, pluginapi.E_INVALID},
		{filewrite.CodeOwnerDenied, pluginapi.E_INTERNAL},
		{filewrite.CodeAuditDenied, pluginapi.E_INTERNAL},
		{filewrite.CodeIO, pluginapi.E_INTERNAL},
	}
	for _, tc := range cases {
		got := fileWriteProtocolError(&filewrite.Error{Code: tc.code, Message: "x"})
		if got.Code != tc.wantCode {
			t.Fatalf("%s 应映射 %s，实际 %s", tc.code, tc.wantCode, got.Code)
		}
	}
}
