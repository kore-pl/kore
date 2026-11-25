package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestZeroIntrusionFixture 供 scripts/zero-intrusion-check.sh 调用：在脚本给定的
// 隔离目录（KORE_ZI_STATE_DIR，工作区内临时目录，绝不碰真实 <install>/data）里
// 写一次状态文件，产出 update-state.json + changes.jsonl 供 shell 断言。
// 这不是常规自测用例——未设置环境变量时直接跳过，不产生任何副作用。
func TestZeroIntrusionFixture(t *testing.T) {
	stateDir := os.Getenv("KORE_ZI_STATE_DIR")
	if stateDir == "" {
		t.Skip("KORE_ZI_STATE_DIR 未设置（零侵入门禁专用夹具）")
	}
	path, err := writeUpdateState(stateDir, testUpdateState())
	if err != nil {
		t.Fatalf("写隔离状态文件失败: %v", err)
	}
	t.Logf("ISOLATED_STATE_PATH=%s", path)
}

func testUpdateState() updateState {
	return updateState{
		Phase:           updatePhasePending,
		TargetVersion:   "0.2.0",
		PreviousVersion: "0.1.1",
		AssetSHA256:     strings.Repeat("a", 64),
		Unit:            "kore.service",
		CommitResult:    "",
		StartedAt:       "2026-11-26T03:00:00+08:00",
		FinishedAt:      "",
	}
}

func TestUpdateStatePathRejectsOutOfWhitelist(t *testing.T) {
	cases := []string{"", ".", "/", "relative/data", "/etc/kore/data", "/var/lib/kore", "/var/log/kore", "/run/kore", "/usr/lib/systemd/system", "/opt/kore/../etc"}
	for _, stateDir := range cases {
		if _, err := updateStatePath(stateDir); err == nil {
			t.Errorf("updateStatePath(%q) 应拒绝，实际通过", stateDir)
		}
	}
	path, err := updateStatePath("/opt/kore/data")
	if err != nil || path != "/opt/kore/data/update-state.json" {
		t.Fatalf("portable 状态路径 = %q, err=%v", path, err)
	}
}

func TestWriteUpdateStateAtomicLedgerAndMode(t *testing.T) {
	stateDir := t.TempDir()
	st := testUpdateState()
	path, err := writeUpdateState(stateDir, st)
	if err != nil {
		t.Fatalf("writeUpdateState: %v", err)
	}
	if filepath.Base(path) != updateStateFileName || filepath.Dir(path) != filepath.Clean(stateDir) {
		t.Fatalf("状态文件路径异常: %s", path)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat 状态文件: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("状态文件权限 = %04o，要求 0600", perm)
	}
	got, err := readUpdateState(stateDir)
	if err != nil {
		t.Fatalf("readUpdateState: %v", err)
	}
	if got != st {
		t.Fatalf("读回状态 = %+v，期望 %+v", got, st)
	}
	// 账本：存在 + file.remove 指向实际文件 + 0600
	ok, err := updateStateLedgerHasRemove(stateDir)
	if err != nil || !ok {
		t.Fatalf("账本缺少 file.remove 条目: ok=%v err=%v", ok, err)
	}
	ledger, err := os.Stat(changesPath(stateDir))
	if err != nil {
		t.Fatalf("stat 账本: %v", err)
	}
	if perm := ledger.Mode().Perm(); perm != 0o600 {
		t.Fatalf("账本权限 = %04o，要求 0600", perm)
	}
	// 原子写：目标目录内不得残留 .update-state-* 临时文件
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatalf("读取目录: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".update-state-") {
			t.Fatalf("残留临时文件: %s", e.Name())
		}
	}
}

func TestWriteUpdateStateOverwriteRegistersBeforeWrite(t *testing.T) {
	stateDir := t.TempDir()
	first := testUpdateState()
	first.Phase = updatePhaseDownloading
	if _, err := writeUpdateState(stateDir, first); err != nil {
		t.Fatalf("首次写: %v", err)
	}
	second := testUpdateState()
	second.Phase = updatePhaseCommitted
	second.TargetVersion = "0.3.0"
	if _, err := writeUpdateState(stateDir, second); err != nil {
		t.Fatalf("覆写: %v", err)
	}
	entries, _, err := readChanges(changesPath(stateDir))
	if err != nil {
		t.Fatalf("读账本: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("覆写后账本条目数 = %d，要求 2（每次写都登记）", len(entries))
	}
	for i, e := range entries {
		if e.Summary != updateStateSummary || e.PurgeOp == nil || e.PurgeOp.Kind != purgeKindFileRemove {
			t.Fatalf("第 %d 条账本登记不完整: %+v", i, e)
		}
	}
	got, err := readUpdateState(stateDir)
	if err != nil || got.TargetVersion != "0.3.0" || got.Phase != updatePhaseCommitted {
		t.Fatalf("覆写后读回 = %+v, err=%v", got, err)
	}
}

func TestWriteUpdateStateFailClosedOnBadLedger(t *testing.T) {
	stateDir := t.TempDir()
	// 账本路径被目录占用 → appendChange 必然失败 → 状态文件不得生成。
	if err := os.Mkdir(changesPath(stateDir), 0o700); err != nil {
		t.Fatalf("制造坏账本: %v", err)
	}
	if _, err := writeUpdateState(stateDir, testUpdateState()); err == nil {
		t.Fatal("账本登记失败时应拒绝写状态文件，实际通过")
	}
	if _, err := os.Stat(filepath.Join(stateDir, updateStateFileName)); !os.IsNotExist(err) {
		t.Fatalf("fail-closed 失败: 状态文件仍存在或 stat 异常: %v", err)
	}
}

func TestWriteUpdateStateRejectsUnknownPhaseAndCredentialField(t *testing.T) {
	stateDir := t.TempDir()
	st := testUpdateState()
	st.Phase = "???"
	if _, err := writeUpdateState(stateDir, st); err == nil {
		t.Fatal("未知 phase 应被拒绝")
	}
	if _, err := os.Stat(changesPath(stateDir)); !os.IsNotExist(err) {
		t.Fatalf("校验失败时不应产生账本条目: %v", err)
	}

	// 手工写入带凭据字段的状态文件 → 严格读取必须拒绝（G-30 纵深防御）。
	path := filepath.Join(stateDir, updateStateFileName)
	if err := os.WriteFile(path, []byte(`{"phase":"pending","target_version":"0.2.0","password":"x"}`), 0o600); err != nil {
		t.Fatalf("写样本: %v", err)
	}
	if _, err := readUpdateState(stateDir); err == nil {
		t.Fatal("含未知凭据字段的状态文件必须拒绝")
	}
}

func TestReadUpdateStateRejectsUnknownPhase(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, updateStateFileName)
	if err := os.WriteFile(path, []byte(`{"phase":"weird","target_version":"0.2.0"}`), 0o600); err != nil {
		t.Fatalf("写样本: %v", err)
	}
	if _, err := readUpdateState(stateDir); err == nil {
		t.Fatal("未知 phase 的状态文件必须拒绝")
	}
}

func TestPurgeUpdateStateRemovesFileAndLedgerEntryStays(t *testing.T) {
	stateDir := t.TempDir()
	path, err := writeUpdateState(stateDir, testUpdateState())
	if err != nil {
		t.Fatalf("写状态: %v", err)
	}
	if err := purgeUpdateState(stateDir); err != nil {
		t.Fatalf("purgeUpdateState: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("回滚后状态文件仍存在: %v", err)
	}
	// 账本条目保留（append-only）；卸载链按它执行，重复删除幂等。
	if err := purgeUpdateState(stateDir); err != nil {
		t.Fatalf("重复 purge 应幂等: %v", err)
	}
	ok, err := updateStateLedgerHasRemove(stateDir)
	if err != nil || !ok {
		t.Fatalf("回滚后账本条目应仍在: ok=%v err=%v", ok, err)
	}
}

func TestExecutePurgeOpFromLedger(t *testing.T) {
	// 模拟 kore uninstall --purge：只读账本里登记的结构化操作，逐条执行。
	stateDir := t.TempDir()
	path, err := writeUpdateState(stateDir, testUpdateState())
	if err != nil {
		t.Fatalf("写状态: %v", err)
	}
	entries, _, err := readChanges(changesPath(stateDir))
	if err != nil {
		t.Fatalf("读账本: %v", err)
	}
	for _, e := range entries {
		if e.PurgeOp != nil {
			if err := executePurgeOp(*e.PurgeOp); err != nil {
				t.Fatalf("按账本回滚失败: %v", err)
			}
		}
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("按账本回滚后状态文件仍存在: %v", err)
	}
}
