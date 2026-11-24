package privilege

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fileDeleteAction 构造一条**干净**的 file_delete 声明：无 argv、无静态 purge_op。
func fileDeleteAction() pluginapi.RootAction {
	return pluginapi.RootAction{
		ID: "site-delete-vhost", WritesHost: true,
		Target:      pluginapi.FileWritePrefixClasses["nginx.conf.d"].Dir,
		Description: "删除站点 nginx 片段",
		FileDelete:  &pluginapi.FileDelete{PrefixClass: "nginx.conf.d"},
	}
}

// newFileDeleteService 组装只在临时目录里删、属主复核为 no-op 的提权服务。
func newFileDeleteService(t *testing.T, dir string) (*Service, *collectAuditor, *collectChanges, *failRunner) {
	t.Helper()
	audit := &collectAuditor{}
	changes := &collectChanges{}
	runner := &failRunner{}
	svc := New(Options{
		Auditor:        audit,
		ChangeRecorder: changes,
		Runner:         runner,
		Root:           func() bool { return true },
		FileDelete: &FileDeleteOptions{
			CopyRoot:     filepath.Join(t.TempDir(), "backups"),
			DirOverrides: map[string]string{"nginx.conf.d": dir},
			OwnerCheck:   func(string, os.FileMode) error { return nil },
		},
	})
	return svc, audit, changes, runner
}

// seedVHost 在测试目录下放一个 vhost 片段，返回其路径。
func seedVHost(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := dir + name
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("准备文件失败：%v", err)
	}
	return path
}

// TestExecuteFileDeleteDispatch 覆盖删站走通道：成功 + 审计 begin/end + 备份 +
// changes.jsonl 的 purge_op 恒为 file.restore（删除可回滚，所以不需要 irreversible）。
func TestExecuteFileDeleteDispatch(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	vhost := seedVHost(t, dir, "kore-site-x.conf", dispatchVHost)
	svc, audit, changes, runner := newFileDeleteService(t, dir)

	result, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileDeleteAction(),
		Args: []string{"kore-site-x.conf"},
	})
	if err != nil {
		t.Fatalf("file_delete 执行失败：%v", err)
	}
	// 反例自证 1：删除不得走 os/exec（否则路径校验/备份/审计全被绕开）。
	if runner.called {
		t.Fatalf("file_delete 不得走 os/exec（Runner 被调用）")
	}
	// 反例自证 2：文件必须真的没了。
	if _, statErr := os.Stat(vhost); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("文件应已被删除，实际 stat 错误：%v", statErr)
	}
	if result.FileWrite == nil || result.FileWrite.Path != vhost {
		t.Fatalf("结果字段不符：%+v", result.FileWrite)
	}
	// 备份必须存在且内容完整（不可逆性由备份消解）。
	if result.FileWrite.CopyPath == "" {
		t.Fatalf("删除必须留下备份路径")
	}
	backup, readErr := os.ReadFile(result.FileWrite.CopyPath)
	if readErr != nil || string(backup) != dispatchVHost {
		t.Fatalf("备份内容不完整：err=%v body=%q", readErr, string(backup))
	}
	// 审计：begin + end 两条，且带 sha256 与备份路径。
	if len(audit.events) < 2 {
		t.Fatalf("审计应有 begin+end 两条，实际 %d 条", len(audit.events))
	}
	var sawBegin bool
	for _, ev := range audit.events {
		if ev.FileWrite == nil || ev.FileWrite.SHA256 == "" || ev.FileWrite.CopyPath == "" {
			t.Fatalf("审计事件缺 sha256/备份路径：%+v", ev)
		}
		if ev.Phase == PhaseBegin {
			sawBegin = true
		}
	}
	if !sawBegin {
		t.Fatalf("缺少 begin 审计（防「删了但查无此事」）")
	}
	// 账本：purge_op 必须是 file.restore(备份, 原路径)，否则回滚链断裂。
	if !result.HostChangeRecorded || len(changes.changes) != 1 {
		t.Fatalf("changes.jsonl 未记录：%+v", changes.changes)
	}
	op := changes.changes[0].PurgeOp
	if op == nil || op.Kind != pluginapi.PurgeKindFileRestore {
		t.Fatalf("删除的 purge_op 应为 file.restore：%+v", op)
	}
	if len(op.Args) != 2 || op.Args[0] != result.FileWrite.CopyPath || op.Args[1] != vhost {
		t.Fatalf("purge_op 参数不是（备份, 原路径）：%+v", op.Args)
	}
}

// TestExecuteFileDeleteNotRoot 覆盖非 root → E_NEED_ROOT，且**不删文件**（fail-closed）。
func TestExecuteFileDeleteNotRoot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	vhost := seedVHost(t, dir, "kore-site-x.conf", dispatchVHost)
	svc := New(Options{
		Auditor: &collectAuditor{}, ChangeRecorder: &collectChanges{},
		Root: func() bool { return false },
		FileDelete: &FileDeleteOptions{
			CopyRoot:     filepath.Join(t.TempDir(), "backups"),
			DirOverrides: map[string]string{"nginx.conf.d": dir},
			OwnerCheck:   func(string, os.FileMode) error { return nil },
		},
	})
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileDeleteAction(),
		Args: []string{"kore-site-x.conf"},
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_NEED_ROOT {
		t.Fatalf("非 root 应 E_NEED_ROOT，实际 %v", err)
	}
	if _, statErr := os.Stat(vhost); statErr != nil {
		t.Fatalf("非 root 被拒时不得删除任何文件：%v", statErr)
	}
}

// TestExecuteFileDeleteOtherPluginsFile 覆盖删别人的文件 → 拒绝（横向隔离）。
func TestExecuteFileDeleteOtherPluginsFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	// 另一个插件（ssl）写的片段：site 不得删除。
	other := seedVHost(t, dir, "kore-ssl-x.conf", dispatchVHost)
	svc, _, changes, _ := newFileDeleteService(t, dir)
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileDeleteAction(),
		Args: []string{"kore-ssl-x.conf"},
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_INVALID {
		t.Fatalf("删别人的片段应 E_INVALID，实际 %v", err)
	}
	if _, statErr := os.Stat(other); statErr != nil {
		t.Fatalf("被拒时不得删除他人文件：%v", statErr)
	}
	if len(changes.changes) != 0 {
		t.Fatalf("被拒的动作不得进 changes.jsonl：%+v", changes.changes)
	}
}

// TestExecuteFileDeleteNotFound 锁定判据：删不存在的文件 → E_NOTFOUND（不静默幂等）。
//
// 为什么不幂等：静默成功会让「我删了」与「本来就没有」不可区分，账本会记一条
// 没发生过的删除（审计说谎）。幂等属于插件层（site 按自身清单幂等返回）。
func TestExecuteFileDeleteNotFound(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	svc, _, changes, _ := newFileDeleteService(t, dir)
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileDeleteAction(),
		Args: []string{"kore-site-missing.conf"},
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_NOTFOUND {
		t.Fatalf("删除不存在的文件应 E_NOTFOUND，实际 %v", err)
	}
	if len(changes.changes) != 0 {
		t.Fatalf("未发生的删除不得记账：%+v", changes.changes)
	}
}

// TestExecuteFileDeleteContentRejected 覆盖「删除请求带正文」→ 拒绝（不许两种语义混在一起）。
func TestExecuteFileDeleteContentRejected(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	vhost := seedVHost(t, dir, "kore-site-x.conf", dispatchVHost)
	svc, _, _, _ := newFileDeleteService(t, dir)
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileDeleteAction(),
		Args: []string{"kore-site-x.conf"}, Content: dispatchVHost,
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_INVALID {
		t.Fatalf("删除带正文应 E_INVALID，实际 %v", err)
	}
	if _, statErr := os.Stat(vhost); statErr != nil {
		t.Fatalf("被拒的删除不得动文件：%v", statErr)
	}
}

// TestExecuteFileDeleteUnwired 覆盖未装配：file_delete 一律 E_UNSUPPORTED（fail-closed）。
func TestExecuteFileDeleteUnwired(t *testing.T) {
	svc := New(Options{Auditor: &collectAuditor{}, ChangeRecorder: &collectChanges{}, Root: func() bool { return true }})
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileDeleteAction(),
		Args: []string{"kore-site-x.conf"},
	})
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_UNSUPPORTED {
		t.Fatalf("未装配应 E_UNSUPPORTED，实际 %v", err)
	}
}

// TestExecuteFileDeleteBackupFailureAborts 是**反例自证**：备份失败必须中止删除。
//
// 做法：把 CopyRoot 指向一个已存在的普通文件——MkdirAll 必然失败。
// 若实现里「备份失败继续删」，这个用例会红：文件会被删掉而账本记不出回滚路径。
func TestExecuteFileDeleteBackupFailureAborts(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf.d") + "/"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	vhost := seedVHost(t, dir, "kore-site-x.conf", dispatchVHost)
	blocked := filepath.Join(t.TempDir(), "backups-as-file")
	if err := os.WriteFile(blocked, []byte("not a dir"), 0o644); err != nil {
		t.Fatalf("准备阻塞备份路径失败：%v", err)
	}
	svc := New(Options{
		Auditor: &collectAuditor{}, ChangeRecorder: &collectChanges{},
		Root: func() bool { return true },
		FileDelete: &FileDeleteOptions{
			CopyRoot:     blocked,
			DirOverrides: map[string]string{"nginx.conf.d": dir},
			OwnerCheck:   func(string, os.FileMode) error { return nil },
		},
	})
	_, err := svc.Execute(context.Background(), Request{
		Actor: "admin", PluginID: "site", Action: fileDeleteAction(),
		Args: []string{"kore-site-x.conf"},
	})
	if err == nil {
		t.Fatalf("备份失败时删除必须失败（不能做无备份删除）")
	}
	if _, statErr := os.Stat(vhost); statErr != nil {
		t.Fatalf("备份失败后文件必须还在：%v", statErr)
	}
}
