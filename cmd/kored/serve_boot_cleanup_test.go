package main

// 安装成功后清理接线的隔离测试（ADR-0059 §3.5 / task-76）：
// 用 reload 替身代替真实 install / CLI，验证「reload 成功 → 触发一次
// CleanupAfterInstall → 实际删除超限旧版本 → 审计落库」；reload 失败不清理。

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/internal/core/store"
)

// cleanupCall 记录一次 CleanupAfterInstall 的输入，供配置透传断言。
type cleanupCall struct {
	opts market.CleanupOptions
}

// recordingCleanup 是 cleanupService 的测试替身：只记录输入，不碰文件系统。
type recordingCleanup struct{ calls []cleanupCall }

func (r *recordingCleanup) CleanupAfterInstall(opts market.CleanupOptions) (market.CleanupResult, error) {
	r.calls = append(r.calls, cleanupCall{opts: opts})
	return market.CleanupResult{Kept: []string{"0.2.0"}, Deleted: []string{"0.1.0"}}, nil
}

// newCleanupTestService 构造只含状态库 / 插件根目录 / 清理入口的最小 service。
func newCleanupTestService(t *testing.T, keep int, disk int64, cleanup cleanupService) (*service, config) {
	t.Helper()
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	db, err := store.Open(stateDir, discardLogger())
	if err != nil {
		t.Fatalf("打开临时状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	snap := coreconfig.Default()
	snap.Backup.KeepCount = keep
	snap.Backup.MaxDiskBytes = disk
	cfg := config{StateDir: stateDir, snapshot: snap}
	return &service{db: db, pluginRootDir: filepath.Join(stateDir, "plugins"), marketSvc: cleanup}, cfg
}

// makeVersionDirs 在插件目录下造 3 个版本目录 + 一个 .prev 回滚材料。
func makeVersionDirs(t *testing.T, root, id string) string {
	t.Helper()
	dir := filepath.Join(root, id)
	for _, version := range []string{"0.1.0", "0.2.0", "0.3.0", ".prev"} {
		path := filepath.Join(dir, version)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatalf("建版本目录失败: %v", err)
		}
		if err := os.WriteFile(filepath.Join(path, "payload"), []byte("x"), 0o600); err != nil {
			t.Fatalf("写版本文件失败: %v", err)
		}
	}
	return dir
}

// TestInstallRefreshWithCleanupTriggersOnSuccess 验证接线触发清理 + 审计落库：
// reload 替身成功 → 旧版本目录被清掉 → audit bucket 出现 market.backup.clean。
// 全程不执行真实 install / 主流程 CLI。
func TestInstallRefreshWithCleanupTriggersOnSuccess(t *testing.T) {
	marketSvc := market.New(market.Options{}) // 真实清理原语，但输入全在 t.TempDir()
	svc, cfg := newCleanupTestService(t, 1, 1<<20, marketSvc)
	dir := makeVersionDirs(t, svc.pluginRootDir, "echo")

	reloads := 0
	refresh := installRefreshWithCleanup(cfg, svc, func(id string) (string, error) {
		reloads++
		if id != "echo" {
			t.Fatalf("reload 替身收到意外 id=%q", id)
		}
		return reloadRestarted, nil
	})
	result, err := refresh("echo")
	if err != nil || result != reloadRestarted {
		t.Fatalf("reload 成功路径被改变: result=%q err=%v", result, err)
	}
	if reloads != 1 {
		t.Fatalf("reload 替身调用 %d 次，期望 1", reloads)
	}

	// keep_count=1 触发清理；保底当前 + 1 份回滚 → 只删最旧 0.1.0。
	if _, err := os.Stat(filepath.Join(dir, "0.1.0")); !os.IsNotExist(err) {
		t.Fatalf("最旧版本目录应被清理，stat err=%v", err)
	}
	for _, kept := range []string{"0.2.0", "0.3.0", ".prev"} {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Fatalf("受保护目录 %s 不应被删: %v", kept, err)
		}
	}

	rows, err := svc.db.ListAudit(store.AuditFilter{Action: market.CleanupAction, Plugin: "echo"})
	if err != nil {
		t.Fatalf("查审计失败: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("清理审计应恰好 1 条，实际 %d", len(rows))
	}
	row := rows[0]
	if row.Subject != "kored" || row.Target != dir || row.Result != store.AuditResultOK {
		t.Fatalf("审计字段不符: %+v", row)
	}
	for key, want := range map[string]string{
		"keep_count": "1", "max_disk_bytes": "1048576", "deleted": "0.1.0",
		"reason": "count",
	} {
		if got := row.Detail[key]; got != want {
			t.Fatalf("审计 detail[%s]=%q，期望 %q；完整 detail=%v", key, got, want, row.Detail)
		}
	}
}

// TestInstallRefreshWithCleanupPassesBackupConfig 验证 backup.* 与生效确认标记透传。
func TestInstallRefreshWithCleanupPassesBackupConfig(t *testing.T) {
	fake := &recordingCleanup{}
	svc, cfg := newCleanupTestService(t, 10, 1<<30, fake)
	refresh := installRefreshWithCleanup(cfg, svc, func(string) (string, error) { return reloadRegistered, nil })
	if _, err := refresh("echo"); err != nil {
		t.Fatalf("reload 替身成功不应返回错误: %v", err)
	}
	if len(fake.calls) != 1 {
		t.Fatalf("清理入口调用 %d 次，期望 1", len(fake.calls))
	}
	opts := fake.calls[0].opts
	if !opts.Confirmed || opts.Actor != "kored" || opts.PluginID != "echo" {
		t.Fatalf("生效确认 / actor / plugin_id 透传错误: %+v", opts)
	}
	if opts.KeepCount != 10 || opts.MaxDiskBytes != 1<<30 {
		t.Fatalf("backup 配置未透传: keep=%d disk=%d", opts.KeepCount, opts.MaxDiskBytes)
	}
	if opts.Root != filepath.Join(svc.pluginRootDir, "echo") || opts.Auditor == nil {
		t.Fatalf("Root / Auditor 未装配: root=%q auditor_nil=%v", opts.Root, opts.Auditor == nil)
	}
	// 审计适配器必须真的写进 store（映射见 cleanupAuditorFromStore）。
	if err := opts.Auditor(market.CleanupAuditEvent{Actor: "kored", PluginID: "echo", Root: opts.Root, Result: "ok"}); err != nil {
		t.Fatalf("审计适配写入失败: %v", err)
	}
	rows, err := svc.db.ListAudit(store.AuditFilter{Action: market.CleanupAction})
	if err != nil || len(rows) != 1 {
		t.Fatalf("审计适配未落库: rows=%d err=%v", len(rows), err)
	}
}

// TestInstallRefreshWithCleanupSkipsOnReloadFailure 验证未生效确认不清理。
func TestInstallRefreshWithCleanupSkipsOnReloadFailure(t *testing.T) {
	fake := &recordingCleanup{}
	svc, cfg := newCleanupTestService(t, 2, 256<<20, fake)
	wantErr := errors.New("reload failed")
	refresh := installRefreshWithCleanup(cfg, svc, func(string) (string, error) { return reloadFailed, wantErr })
	result, err := refresh("echo")
	if !errors.Is(err, wantErr) || result != reloadFailed {
		t.Fatalf("reload 失败必须原样上抛: result=%q err=%v", result, err)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("未生效确认时不应清理，实际调用 %d 次", len(fake.calls))
	}
	rows, err := svc.db.ListAudit(store.AuditFilter{Action: market.CleanupAction})
	if err != nil || len(rows) != 0 {
		t.Fatalf("未清理时不应写清理审计: rows=%d err=%v", len(rows), err)
	}
}

// TestCleanupAuditorMapsFailureResult 验证审计适配器把 error 结果归一为 store 的 error。
func TestCleanupAuditorMapsFailureResult(t *testing.T) {
	svc, _ := newCleanupTestService(t, 2, 256<<20, &recordingCleanup{})
	auditor := &cleanupAuditorFromStore{db: svc.db}
	if err := auditor.Audit(market.CleanupAuditEvent{
		Actor: "kored", PluginID: "echo", Root: "/tmp/echo", Result: "error",
		Message: "审计写入测试",
	}); err != nil {
		t.Fatalf("审计写入失败: %v", err)
	}
	rows, err := svc.db.ListAudit(store.AuditFilter{Action: market.CleanupAction})
	if err != nil || len(rows) != 1 || rows[0].Result != store.AuditResultError {
		t.Fatalf("error 结果未落库: rows=%+v err=%v", rows, err)
	}
}
