package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/filewrite"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// TestAppendAndReadChanges 验证账本往返与 0600 权限。
func TestAppendAndReadChanges(t *testing.T) {
	path := changesPath(t.TempDir())
	entries := []changeEntry{
		{TS: "2026-11-23T10:00:00+08:00", Plugin: "site", Action: "vhost.write", Target: "/etc/nginx/conf.d/kore-a.conf", Reversible: true,
			PurgeOp: &purgeOp{Kind: purgeKindFileRemove, Args: []string{"/etc/nginx/conf.d/kore-a.conf"}}},
		{TS: "2026-11-23T10:01:00+08:00", Plugin: "firewall", Action: "allow", Target: "22/tcp", Reversible: false},
	}
	for _, entry := range entries {
		if err := appendChange(path, entry); err != nil {
			t.Fatalf("append 失败: %v", err)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("账本权限 = %o，期望 600", info.Mode().Perm())
	}
	got, skipped, err := readChanges(path)
	if err != nil || skipped != 0 || len(got) != 2 {
		t.Fatalf("读回 %d 条（跳过 %d）err=%v，期望 2 条", len(got), skipped, err)
	}
	if got[0].PurgeOp == nil || got[0].PurgeOp.Kind != purgeKindFileRemove || len(got[0].PurgeOp.Args) != 1 {
		t.Fatalf("结构化 purge_op 未保真: %+v", got[0].PurgeOp)
	}
}

// TestAppendChangeRejectsShellString 验证 reversible 条目必须带结构化 purge_op。
func TestAppendChangeRejectsShellString(t *testing.T) {
	path := changesPath(t.TempDir())
	err := appendChange(path, changeEntry{Plugin: "site", Action: "a", Target: "/x", Reversible: true})
	if err == nil || !strings.Contains(err.Error(), "purge_op") {
		t.Fatalf("reversible 无 purge_op 应报错，实际 %v", err)
	}
}

// TestReadChangesSkipsBadLines 验证坏行跳过并计数。
func TestReadChangesSkipsBadLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "changes.jsonl")
	body := "{\"plugin\":\"site\",\"action\":\"a\",\"target\":\"/x\"}\nnot-json\n{\"target\":\"\"}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	got, skipped, err := readChanges(path)
	if err != nil || len(got) != 1 || skipped != 2 {
		t.Fatalf("得到 %d 条、跳过 %d、err=%v，期望 1/2", len(got), skipped, err)
	}
}

// TestReadChangesMissingFile 验证账本缺失是空清单而非错误。
func TestReadChangesMissingFile(t *testing.T) {
	got, skipped, err := readChanges(filepath.Join(t.TempDir(), "absent.jsonl"))
	if err != nil || got != nil || skipped != 0 {
		t.Fatalf("缺失文件应返回空清单，实际 %v/%d/%v", got, skipped, err)
	}
}

// TestExecutePurgeOpFileRemove 验证 file.remove 只删指定文件。
func TestExecutePurgeOpFileRemove(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vhost.conf")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if err := executePurgeOp(purgeOp{Kind: purgeKindFileRemove, Args: []string{path}}); err != nil {
		t.Fatalf("file.remove 失败: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("文件应已删除: %v", err)
	}
	// 幂等：再删一次不报错。
	if err := executePurgeOp(purgeOp{Kind: purgeKindFileRemove, Args: []string{path}}); err != nil {
		t.Fatalf("重复删除应幂等: %v", err)
	}
}

// TestLedgerFileRestorePreservesMode 验证完整账本回滚链：受控写（备份保留原 mode）
// → changes.jsonl 登记 file.restore → 按账本执行回滚 → 内容逐字节一致且 mode 与写前一致。
// 覆盖 sshd drop-in 与 nginx vhost 两类 0644 片段，以及 0600 片段。
func TestLedgerFileRestorePreservesMode(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode os.FileMode
	}{
		{"sshd_dropin_0644", 0o644},
		{"nginx_vhost_0644", 0o644},
		{"sshd_dropin_0600", 0o600},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			// 类别目录按用例分名（同一临时根下避免相互干扰），注入 AllowedPrefixes。
			prefix := filepath.Join(root, strings.ReplaceAll(tc.name, "_", "-")) + "/"
			if err := os.MkdirAll(prefix, 0o755); err != nil {
				t.Fatalf("建类别目录失败：%v", err)
			}
			target := filepath.Join(prefix, "kore-test.conf")
			old := []byte("before\nsecond line\n")
			if err := os.WriteFile(target, old, tc.mode); err != nil {
				t.Fatalf("预置原文件失败：%v", err)
			}
			written, perr := filewrite.Write(filewrite.Options{
				Plugin: "site", Actor: "admin", Path: target, Content: []byte("after\n"), Mode: 0o644,
				CopyRoot:        filepath.Join(root, "backups"),
				Auditor:         func(filewrite.AuditEvent) error { return nil },
				AllowedPrefixes: []string{prefix},
			})
			if perr != nil {
				t.Fatalf("受控写失败：%v", perr)
			}
			if written.CopyPath == "" {
				t.Fatalf("覆盖写必须产生备份")
			}
			// 账本登记：与 privilege.fileWritePurgeOp 同形状（备份, 目标）。
			ledger := changesPath(root)
			entry := changeEntry{
				Plugin: "site", Action: "vhost.write", Target: target, Reversible: true,
				PurgeOp: &purgeOp{Kind: purgeKindFileRestore, Args: []string{written.CopyPath, target}},
			}
			if err := appendChange(ledger, entry); err != nil {
				t.Fatalf("账本登记失败：%v", err)
			}
			entries, skipped, err := readChanges(ledger)
			if err != nil || skipped != 0 || len(entries) != 1 {
				t.Fatalf("读回账本失败：%d 条 / 跳过 %d / err=%v", len(entries), skipped, err)
			}
			if err := executePurgeOp(*entries[0].PurgeOp); err != nil {
				t.Fatalf("按账本回滚失败：%v", err)
			}
			got, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(got, old) {
				t.Fatalf("回滚内容不一致：got=%q err=%v want=%q", got, err, old)
			}
			info, err := os.Stat(target)
			if err != nil {
				t.Fatalf("stat 目标失败：%v", err)
			}
			if info.Mode().Perm() != tc.mode {
				t.Fatalf("[%s] 回滚后权限 = %#o，期望写前 %#o", tc.name, info.Mode().Perm(), tc.mode)
			}
		})
	}
}

// TestExecutePurgeOpRejectsUnknownAndUnsafe 验证未知 kind 与危险路径被拒。
func TestExecutePurgeOpRejectsUnknownAndUnsafe(t *testing.T) {
	cases := []purgeOp{
		{Kind: "shell.exec", Args: []string{"rm -rf /"}},
		{Kind: purgeKindFileRemove, Args: []string{"relative/path"}},
		{Kind: purgeKindFileRemove, Args: []string{"/"}},
		{Kind: purgeKindFileRemove, Args: []string{}},
	}
	for _, op := range cases {
		if err := executePurgeOp(op); err == nil {
			t.Fatalf("应拒绝 %+v", op)
		}
	}
}

// TestRootChangeRecorderWritesEntry 验证 root 动作成功后的账本条目落盘且可回话：
// summary / target / reversible / 结构化 purge_op 全在，且没有 shell 字符串字段。
func TestRootChangeRecorderWritesEntry(t *testing.T) {
	stateDir := t.TempDir()
	recorder := newRootChangeRecorder(stateDir)
	op := &pluginapi.PurgeOp{Kind: pluginapi.PurgeKindFileRemove, Args: []string{"/etc/nginx/conf.d/kore-a.conf"}}
	if err := recorder.RecordHostChange(context.Background(), privilege.HostChange{
		PluginID: "site", ActionID: "vhost-write", Summary: "写入站点 vhost",
		Target: "/etc/nginx/conf.d/kore-a.conf", PurgeOp: op,
	}); err != nil {
		t.Fatalf("账本写入失败: %v", err)
	}
	path := changesPath(stateDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读账本失败: %v", err)
	}
	if !strings.Contains(string(raw), `"purge_op":{"kind":"file.remove"`) {
		t.Fatalf("账本缺结构化 purge_op: %s", raw)
	}
	if strings.Contains(string(raw), `"cmd"`) {
		t.Fatalf("账本不得出现 shell 命令字段: %s", raw)
	}
	entries, skipped, err := readChanges(path)
	if err != nil || skipped != 0 || len(entries) != 1 {
		t.Fatalf("读回 %d 条（跳过 %d）err=%v，期望 1 条", len(entries), skipped, err)
	}
	if entries[0].Summary != "写入站点 vhost" || !entries[0].Reversible || entries[0].TS == "" {
		t.Fatalf("账本条目字段不完整: %+v", entries[0])
	}
}

// TestRootChangeRecorderWithoutSummaryFallsBack 没有 description 时摘要退化为动作 id（不丢条目）。
func TestRootChangeRecorderWithoutSummaryFallsBack(t *testing.T) {
	stateDir := t.TempDir()
	if err := newRootChangeRecorder(stateDir).RecordHostChange(context.Background(), privilege.HostChange{
		PluginID: "firewall", ActionID: "ufw-allow", Target: "22/tcp",
	}); err != nil {
		t.Fatalf("账本写入失败: %v", err)
	}
	entries, _, err := readChanges(changesPath(stateDir))
	if err != nil || len(entries) != 1 {
		t.Fatalf("读回 %d 条 err=%v，期望 1 条", len(entries), err)
	}
	if entries[0].Summary != "ufw-allow" || entries[0].Reversible {
		t.Fatalf("摘要回退或 reversible 判定不对: %+v", entries[0])
	}
}
