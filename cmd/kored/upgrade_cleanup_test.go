package main

// 内核 finalize 成功路径的旧版本清理接线测试（ADR-0059 §3.5 第 3 条 / task-86）。
//
// 全程用测试替身 + t.TempDir() 隔离：不执行真实 upgrade / install / serve，
// 不打开主实例 state.db，不联网、不碰 .kore-local-*。覆盖：
//   - finalize 成功 → 触发一次清理；标记已是 success / sha 不符 → 零清理；
//   - 清理失败只 WARN，不改升级生效结论；
//   - backup.keep_count / max_disk_bytes 透传 + 审计落库（M7 原语复用）；
//   - 生产清理入口 finalizeCleanupInstalledPlugins 用临时 stateDir + 替身 service：
//     已装插件各触发一次、state.db 锁在返回前释放（后续可再次 openStore）。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/internal/core/store"
)

// finalizeCleanupCall 记录一次 finalize 清理的调用输入。
type finalizeCleanupCall struct {
	stateDir string
}

// finalizeCleanupRecorder 是 finalizeCleanup 替身：只记录 stateDir，可按 err 模拟失败。
type finalizeCleanupRecorder struct {
	calls []finalizeCleanupCall
	err   error
}

func (r *finalizeCleanupRecorder) clean(stateDir string) error {
	r.calls = append(r.calls, finalizeCleanupCall{stateDir: stateDir})
	return r.err
}

// finalizeFixture 造一个隔离的 pending 升级场景，复用 newUpgradeFixture 的目标二进制与 deps。
type finalizeFixture struct {
	*upgradeFixture
	cleanup *finalizeCleanupRecorder
	deps    upgradeDeps
}

// newFinalizeFixture 造 pending 标记与期望 sha 匹配的 finalize 场景；finalizeClean 注入替身。
func newFinalizeFixture(t *testing.T, cleanupErr error) *finalizeFixture {
	t.Helper()
	f := &upgradeFixture{
		dir:      t.TempDir(),
		target:   filepath.Join(t.TempDir(), "kored"),
		stateDir: filepath.Join(t.TempDir(), "data"),
		now:      time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC),
	}
	if err := os.WriteFile(f.target, []byte("running-v2"), 0o755); err != nil {
		t.Fatalf("准备运行二进制: %v", err)
	}
	if err := os.MkdirAll(f.stateDir, 0o700); err != nil {
		t.Fatalf("准备状态目录: %v", err)
	}
	sum := sha256.Sum256([]byte("running-v2"))
	marker := upgradeResult{
		State:          upgradeStatePending,
		Binary:         f.target,
		ExpectedSHA256: hex.EncodeToString(sum[:]),
		UpdatedAt:      f.now.Format(time.RFC3339),
	}
	if err := writeUpgradeResult(upgradeResultPath(f.stateDir), marker); err != nil {
		t.Fatalf("写 pending 标记: %v", err)
	}
	rec := &finalizeCleanupRecorder{err: cleanupErr}
	deps := upgradeDeps{
		euid:          func() int { return 0 },
		executable:    func() (string, error) { return f.target, nil },
		sha256File:    fileSHA256,
		stateDir:      func(string) (string, error) { return f.stateDir, nil },
		now:           func() time.Time { return f.now },
		finalizeClean: rec.clean,
	}
	return &finalizeFixture{upgradeFixture: f, cleanup: rec, deps: deps}
}

// readMarker 读标记（失败即测试失败）。
func (f *finalizeFixture) readMarker(t *testing.T) upgradeResult {
	t.Helper()
	marker, err := readUpgradeResult(upgradeResultPath(f.stateDir))
	if err != nil {
		t.Fatalf("读升级标记: %v", err)
	}
	return marker
}

// TestFinalizeSuccessTriggersCleanup finalize 成功 → 恰好一次清理；标记写成 success。
func TestFinalizeSuccessTriggersCleanup(t *testing.T) {
	f := newFinalizeFixture(t, nil)
	var w bytes.Buffer
	finalizePendingUpgrade(&w, f.deps)

	if marker := f.readMarker(t); marker.State != upgradeStateSuccess {
		t.Fatalf("标记未闭环: state=%s", marker.State)
	}
	if len(f.cleanup.calls) != 1 {
		t.Fatalf("清理调用 %d 次，期望 1", len(f.cleanup.calls))
	}
	if got := f.cleanup.calls[0].stateDir; got != f.stateDir {
		t.Fatalf("清理 stateDir=%q，期望 %q", got, f.stateDir)
	}
	if !strings.Contains(w.String(), "升级已生效") {
		t.Fatalf("缺少成功输出: %s", w.String())
	}
}

// TestFinalizeCleanupFailureOnlyWarns 清理失败只 WARN，不改升级生效结论。
func TestFinalizeCleanupFailureOnlyWarns(t *testing.T) {
	f := newFinalizeFixture(t, errors.New("清理替身失败"))
	var w bytes.Buffer
	finalizePendingUpgrade(&w, f.deps)

	if marker := f.readMarker(t); marker.State != upgradeStateSuccess {
		t.Fatalf("清理失败不应改判升级结果: state=%s", marker.State)
	}
	if len(f.cleanup.calls) != 1 {
		t.Fatalf("清理调用 %d 次，期望 1", len(f.cleanup.calls))
	}
	if !strings.Contains(w.String(), "[WARN]") || !strings.Contains(w.String(), "清理替身失败") {
		t.Fatalf("清理失败应留 WARN 且含原因: %s", w.String())
	}
	if !strings.Contains(w.String(), "升级已生效") {
		t.Fatalf("升级成功结论不应被清理失败覆盖: %s", w.String())
	}
}

// TestFinalizeAlreadySuccessZeroCleanup 标记已 success → 幂等短路、零清理。
func TestFinalizeAlreadySuccessZeroCleanup(t *testing.T) {
	f := newFinalizeFixture(t, nil)
	marker := f.readMarker(t)
	marker.State = upgradeStateSuccess
	marker.VerifiedAt = f.now.Format(time.RFC3339)
	if err := writeUpgradeResult(upgradeResultPath(f.stateDir), marker); err != nil {
		t.Fatalf("改写 success 标记: %v", err)
	}
	var w bytes.Buffer
	finalizePendingUpgrade(&w, f.deps)
	if len(f.cleanup.calls) != 0 {
		t.Fatalf("已 success 不应清理，实际 %d 次", len(f.cleanup.calls))
	}
}

// TestFinalizeShaMismatchZeroCleanup 运行二进制 sha 与标记不符 → 保留 pending、零清理。
func TestFinalizeShaMismatchZeroCleanup(t *testing.T) {
	f := newFinalizeFixture(t, nil)
	if err := os.WriteFile(f.target, []byte("tampered-binary"), 0o755); err != nil {
		t.Fatalf("篡改运行二进制: %v", err)
	}
	var w bytes.Buffer
	finalizePendingUpgrade(&w, f.deps)
	if marker := f.readMarker(t); marker.State != upgradeStatePending {
		t.Fatalf("校验失败不应谎报成功: state=%s", marker.State)
	}
	if len(f.cleanup.calls) != 0 {
		t.Fatalf("未生效确认不应清理，实际 %d 次", len(f.cleanup.calls))
	}
	if !strings.Contains(w.String(), "[WARN]") {
		t.Fatalf("校验失败应有 WARN: %s", w.String())
	}
}

// TestFinalizeMissingMarkerZeroCleanup 无标记（未升级过）→ 零清理。
func TestFinalizeMissingMarkerZeroCleanup(t *testing.T) {
	f := newFinalizeFixture(t, nil)
	if err := os.Remove(upgradeResultPath(f.stateDir)); err != nil {
		t.Fatalf("删除标记: %v", err)
	}
	var w bytes.Buffer
	finalizePendingUpgrade(&w, f.deps)
	if len(f.cleanup.calls) != 0 {
		t.Fatalf("无标记不应清理，实际 %d 次", len(f.cleanup.calls))
	}
}

// recordingMarketCleanup 是 cleanupService 替身：记录每次 CleanupOptions，返回可配置错误。
// emitAudit=true 时在调用期（state.db 仍打开）经 opts.Auditor 写一条审计，验证落库链路。
type recordingMarketCleanup struct {
	opts      []market.CleanupOptions
	err       error
	emitAudit bool
}

func (r *recordingMarketCleanup) CleanupAfterInstall(opts market.CleanupOptions) (market.CleanupResult, error) {
	r.opts = append(r.opts, opts)
	if r.emitAudit && opts.Auditor != nil {
		result := "ok"
		if r.err != nil {
			result = "error"
		}
		_ = opts.Auditor(market.CleanupAuditEvent{
			Actor: opts.Actor, PluginID: opts.PluginID, Root: opts.Root, Result: result,
		})
	}
	if r.err != nil {
		return market.CleanupResult{}, r.err
	}
	return market.CleanupResult{Kept: []string{"0.2.0"}, Deleted: []string{"0.1.0"}}, nil
}

// putPluginRef 直接在 plugins bucket 写一条已装记录（最小插件 id + version）。
func putPluginRef(t *testing.T, db *store.Store, id, version string) {
	t.Helper()
	raw, err := json.Marshal(pluginRef{ID: id, Version: version})
	if err != nil {
		t.Fatalf("序列化插件记录: %v", err)
	}
	if err := db.Update(func(tx *store.Tx) error {
		return tx.Put(bucketPlugins, id, raw)
	}); err != nil {
		t.Fatalf("写 plugins bucket: %v", err)
	}
}

// newFinalizeCleanupTestEnv 造 finalizeCleanupWith 用的隔离环境：
// 临时 stateDir + 打开的 state.db（供测试预置插件记录）+ 配置快照（backup 可配）。
// bbolt 独占锁：调用 finalizeCleanupWith 前必须先 closeFixtureDB()，让它重新开库。
func newFinalizeCleanupTestEnv(t *testing.T, keep int, disk int64) (string, *store.Store, config) {
	t.Helper()
	stateDir := t.TempDir()
	db, err := store.Open(stateDir, discardLogger())
	if err != nil {
		t.Fatalf("打开临时状态库: %v", err)
	}
	snap := coreconfig.Default()
	snap.Backup.KeepCount = keep
	snap.Backup.MaxDiskBytes = disk
	snap.Paths.PluginDir = filepath.Join(stateDir, "plugins")
	return stateDir, db, config{StateDir: stateDir, snapshot: snap}
}

// closeFixtureDB 关闭测试预置的库，释放独占锁供 finalizeCleanupWith 重新打开。
func closeFixtureDB(t *testing.T, db *store.Store) {
	t.Helper()
	if err := db.Close(); err != nil {
		t.Fatalf("关闭预置状态库: %v", err)
	}
}

// TestFinalizeCleanupWithPassesConfigAndAudit 验证生产清理入口的语义（用替身 svc）：
// backup.* 透传、Confirmed=true、actor=kored、每个已装插件一次、审计适配真实落库。
func TestFinalizeCleanupWithPassesConfigAndAudit(t *testing.T) {
	fake := &recordingMarketCleanup{emitAudit: true}
	stateDir, db, cfg := newFinalizeCleanupTestEnv(t, 10, 1<<30)
	putPluginRef(t, db, "echo", "0.2.0")
	putPluginRef(t, db, "site", "0.3.0")
	closeFixtureDB(t, db)

	if err := finalizeCleanupWith(stateDir, cfg.snapshot, fake); err != nil {
		t.Fatalf("finalizeCleanupWith: %v", err)
	}
	if len(fake.opts) != 2 {
		t.Fatalf("清理调用 %d 次，期望 2（每插件一次）", len(fake.opts))
	}
	for _, opts := range fake.opts {
		if !opts.Confirmed || opts.Actor != "kored" || opts.Auditor == nil {
			t.Fatalf("确认标记 / actor / 审计适配缺失: %+v", opts)
		}
		if opts.KeepCount != 10 || opts.MaxDiskBytes != 1<<30 {
			t.Fatalf("backup 配置未透传: keep=%d disk=%d", opts.KeepCount, opts.MaxDiskBytes)
		}
		if opts.Root == "" {
			t.Fatalf("Root 不应为空: %+v", opts)
		}
	}
	// finalizeCleanupWith 返回后锁已释放，重新开库回读审计 bucket。
	rowsDB, err := store.Open(stateDir, discardLogger())
	if err != nil {
		t.Fatalf("回读审计开库失败: %v", err)
	}
	defer func() { _ = rowsDB.Close() }()
	rows, err := rowsDB.ListAudit(store.AuditFilter{Action: market.CleanupAction})
	if err != nil || len(rows) != 2 {
		t.Fatalf("审计应落 2 条，实际 %d err=%v", len(rows), err)
	}
}

// TestFinalizeCleanupWithRealPrimitiveDeletesAndAudits 用真实 market 清理原语验证：
// finalize 触发后旧版本目录被删、审计落库（全程 t.TempDir，不执行真实 CLI）。
func TestFinalizeCleanupWithRealPrimitiveDeletesAndAudits(t *testing.T) {
	stateDir, db, cfg := newFinalizeCleanupTestEnv(t, 1, 1<<20)
	putPluginRef(t, db, "echo", "0.3.0")
	closeFixtureDB(t, db)
	dir := makeVersionDirs(t, cfg.snapshot.Paths.PluginDir, "echo")
	svc := market.New(market.Options{})

	if err := finalizeCleanupWith(stateDir, cfg.snapshot, svc); err != nil {
		t.Fatalf("finalizeCleanupWith: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "0.1.0")); !os.IsNotExist(err) {
		t.Fatalf("最旧版本应被清理，stat err=%v", err)
	}
	for _, kept := range []string{"0.2.0", "0.3.0", ".prev"} {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Fatalf("受保护目录 %s 不应被删: %v", kept, err)
		}
	}
	rowsDB, err := store.Open(stateDir, discardLogger())
	if err != nil {
		t.Fatalf("回读审计开库失败: %v", err)
	}
	defer func() { _ = rowsDB.Close() }()
	rows, err := rowsDB.ListAudit(store.AuditFilter{Action: market.CleanupAction, Plugin: "echo"})
	if err != nil || len(rows) != 1 {
		t.Fatalf("清理审计应恰好 1 条，实际 %d err=%v", len(rows), err)
	}
	for key, want := range map[string]string{
		"keep_count": "1", "max_disk_bytes": "1048576", "deleted": "0.1.0",
	} {
		if got := rows[0].Detail[key]; got != want {
			t.Fatalf("审计 detail[%s]=%q 期望 %q；完整=%v", key, got, want, rows[0].Detail)
		}
	}
}

// TestFinalizeCleanupWithCleanupErrorOnlyWarns 清理失败只 WARN，不使 finalizeCleanupWith 报错。
func TestFinalizeCleanupWithCleanupErrorOnlyWarns(t *testing.T) {
	fake := &recordingMarketCleanup{err: errors.New("清理服务失败"), emitAudit: true}
	stateDir, db, cfg := newFinalizeCleanupTestEnv(t, 2, 256<<20)
	putPluginRef(t, db, "echo", "0.2.0")
	closeFixtureDB(t, db)

	if err := finalizeCleanupWith(stateDir, cfg.snapshot, fake); err != nil {
		t.Fatalf("清理失败不应上抛: %v", err)
	}
	if len(fake.opts) != 1 {
		t.Fatalf("清理调用 %d 次，期望 1", len(fake.opts))
	}
	// 审计仍落库（替身在调用期经 auditor 写 result=error）。
	rowsDB, err := store.Open(stateDir, discardLogger())
	if err != nil {
		t.Fatalf("回读审计开库失败: %v", err)
	}
	defer func() { _ = rowsDB.Close() }()
	rows, err := rowsDB.ListAudit(store.AuditFilter{Action: market.CleanupAction})
	if err != nil || len(rows) != 1 || rows[0].Result != store.AuditResultError {
		t.Fatalf("清理失败也应留 error 审计，实际 %d err=%v rows=%+v", len(rows), err, rows)
	}
}

// TestFinalizeCleanupWithReleasesStoreLock 验证 state.db 在 finalize 清理返回前已 close：
// 后续 openStore 能再次拿到独占锁（否则 runServe 会因 ErrLocked 启动失败）。
func TestFinalizeCleanupWithReleasesStoreLock(t *testing.T) {
	fake := &recordingMarketCleanup{}
	stateDir, db, cfg := newFinalizeCleanupTestEnv(t, 2, 256<<20)
	putPluginRef(t, db, "echo", "0.2.0")
	closeFixtureDB(t, db)
	if err := finalizeCleanupWith(stateDir, cfg.snapshot, fake); err != nil {
		t.Fatalf("finalizeCleanupWith: %v", err)
	}
	again, err := store.Open(stateDir, discardLogger())
	if err != nil {
		t.Fatalf("清理返回后无法再次打开 state.db（锁未释放）: %v", err)
	}
	_ = again.Close()
}
