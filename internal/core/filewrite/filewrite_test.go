package filewrite

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testEnv 在临时目录下造一个「白名单前缀」，模拟 /etc/ssh/sshd_config.d/。
func testEnv(t *testing.T) (prefix, copyRoot string) {
	t.Helper()
	root := t.TempDir()
	prefix = filepath.Join(root, "sshd_config.d") + "/"
	if err := os.MkdirAll(prefix, 0o755); err != nil {
		t.Fatalf("建测试目录失败：%v", err)
	}
	copyRoot = filepath.Join(root, "backups")
	return prefix, copyRoot
}

func okAuditor(events *[]AuditEvent) Auditor {
	return func(event AuditEvent) error {
		*events = append(*events, event)
		return nil
	}
}

// TestWriteLegal 覆盖合法写：内容/权限/备份/审计字段（不含全文）。
func TestWriteLegal(t *testing.T) {
	prefix, copyRoot := testEnv(t)
	target := filepath.Join(prefix, "kore-ssh-test.conf")
	old := []byte("PermitRootLogin no\n")
	if err := os.WriteFile(target, old, 0o644); err != nil {
		t.Fatalf("预置旧文件失败：%v", err)
	}
	var events []AuditEvent
	content := []byte("PasswordAuthentication no\n")
	result, perr := Write(Options{
		Plugin: "ssh-guard", Actor: "admin", Path: target, Content: content, Mode: 0o644,
		CopyRoot: copyRoot, Auditor: okAuditor(&events), AllowedPrefixes: []string{prefix},
	})
	if perr != nil {
		t.Fatalf("合法写失败：%v", perr)
	}
	if result.Size != len(content) || result.Mode != 0o644 || len(result.SHA256) != 64 {
		t.Fatalf("结果字段不符：%+v", result)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != string(content) {
		t.Fatalf("目标内容不符：%q %v", got, err)
	}
	info, err := os.Stat(target)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("目标权限不符：%v %v", info.Mode().Perm(), err)
	}
	if result.CopyPath == "" {
		t.Fatalf("覆盖已有文件必须产生备份")
	}
	backup, err := os.ReadFile(result.CopyPath)
	if err != nil || string(backup) != string(old) {
		t.Fatalf("备份内容不符：%q %v", backup, err)
	}
	if len(events) != 1 {
		t.Fatalf("审计事件数应为 1，实际 %d", len(events))
	}
	event := events[0]
	if event.Size != len(content) || event.SHA256 != result.SHA256 || event.PreviousSHA256 == "" || event.CopyPath == "" {
		t.Fatalf("审计字段缺失：%+v", event)
	}
	if strings.Contains(event.Path, "\n") {
		t.Fatalf("审计不应包含异常路径")
	}
}

// TestBackupPreservesMode 验证写前备份保留源文件权限位（账本 file.restore 还原 mode 的前提）。
func TestBackupPreservesMode(t *testing.T) {
	for _, mode := range []os.FileMode{0o644, 0o600, 0o640} {
		t.Run(fmt.Sprintf("mode_%04o", mode), func(t *testing.T) {
			prefix, copyRoot := testEnv(t)
			target := filepath.Join(prefix, "kore-mode.conf")
			old := []byte("original\n")
			if err := os.WriteFile(target, old, mode); err != nil {
				t.Fatalf("预置旧文件失败：%v", err)
			}
			result, perr := Write(Options{
				Plugin: "ssh-guard", Actor: "admin", Path: target, Content: []byte("new\n"), Mode: 0o644,
				CopyRoot: copyRoot, Auditor: func(AuditEvent) error { return nil }, AllowedPrefixes: []string{prefix},
			})
			if perr != nil {
				t.Fatalf("受控写失败：%v", perr)
			}
			if result.CopyPath == "" {
				t.Fatalf("覆盖写必须产生备份")
			}
			info, err := os.Stat(result.CopyPath)
			if err != nil {
				t.Fatalf("stat 备份失败：%v", err)
			}
			if info.Mode().Perm() != mode {
				t.Fatalf("备份权限 = %#o，期望保留源权限 %#o", info.Mode().Perm(), mode)
			}
		})
	}
}

// TestRestorePreservesModeAndContent 验证备份还原是「逐属性还原」：内容逐字节一致且 mode 不变。
// 覆盖 sshd drop-in（0644）与 nginx vhost（0644）两类白名单片段目录，以及 0600 片段。
func TestRestorePreservesModeAndContent(t *testing.T) {
	cases := []struct {
		name   string
		prefix string // 由测试临时目录派生的类别目录名
		mode   os.FileMode
	}{
		{"sshd_dropin_0644", "sshd_config.d", 0o644},
		{"nginx_vhost_0644", "nginx-conf.d", 0o644},
		{"sshd_dropin_0600", "sshd_config.d", 0o600},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			prefix := filepath.Join(root, tc.prefix) + "/"
			if err := os.MkdirAll(prefix, 0o755); err != nil {
				t.Fatalf("建类别目录失败：%v", err)
			}
			copyRoot := filepath.Join(root, "backups")
			target := filepath.Join(prefix, "kore-test.conf")
			old := []byte("before write\nsecond line\n")
			if err := os.WriteFile(target, old, tc.mode); err != nil {
				t.Fatalf("预置原文件失败：%v", err)
			}
			written, perr := Write(Options{
				Plugin: "ssh-guard", Actor: "admin", Path: target, Content: []byte("after write\n"), Mode: 0o644,
				CopyRoot: copyRoot, Auditor: func(AuditEvent) error { return nil }, AllowedPrefixes: []string{prefix},
			})
			if perr != nil {
				t.Fatalf("受控写失败：%v", perr)
			}
			if written.CopyPath == "" {
				t.Fatalf("覆盖写必须产生备份")
			}
			if err := Restore(target, written.CopyPath); err != nil {
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
				t.Fatalf("回滚后权限 = %#o，期望写前权限 %#o", info.Mode().Perm(), tc.mode)
			}
			// 重复回滚幂等：备份不被消费，再次还原仍逐字节一致且 mode 不变。
			if err := Restore(target, written.CopyPath); err != nil {
				t.Fatalf("重复回滚失败：%v", err)
			}
			got2, _ := os.ReadFile(target)
			if !bytes.Equal(got2, old) {
				t.Fatalf("重复回滚内容不一致：%q", got2)
			}
		})
	}
}

// TestRestoreRejectsUnsafeMode 验证被篡改的宽权限备份不会被还原到目标（fail-closed）。
func TestRestoreRejectsUnsafeMode(t *testing.T) {
	root := t.TempDir()
	backup := filepath.Join(root, "backup.conf")
	target := filepath.Join(root, "target.conf")
	if err := os.WriteFile(backup, []byte("x\n"), 0o777); err != nil {
		t.Fatalf("造备份失败：%v", err)
	}
	if err := os.WriteFile(target, []byte("y\n"), 0o600); err != nil {
		t.Fatalf("造目标失败：%v", err)
	}
	if err := Restore(target, backup); err == nil {
		t.Fatalf("备份权限 0777 必须拒绝还原")
	}
	got, _ := os.ReadFile(target)
	if string(got) != "y\n" {
		t.Fatalf("拒绝还原时目标不得变化：%q", got)
	}
}

// TestRejectPaths 覆盖路径形状反例（ADR §5.1/§5.2/§5.3）。
func TestRejectPaths(t *testing.T) {
	prefix, _ := testEnv(t)
	cases := []struct {
		name string
		path string
		code string
	}{
		{"相对路径", "etc/ssh/sshd_config.d/x.conf", CodeDeniedPath},
		{"路径含 ..", prefix + "../escape.conf", CodeDeniedPath},
		{"前缀相似但越界", prefix + "../../cron.d/x.conf", CodeDeniedPath},
		{"白名单外 /etc/shadow", "/etc/shadow", CodeDeniedPath},
		{"白名单外 /etc/passwd", "/etc/passwd", CodeDeniedPath},
		{"可执行扩展名", filepath.Join(prefix, "x.sh"), CodeDeniedPath},
		{"无扩展名", filepath.Join(prefix, "x"), CodeDeniedPath},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, perr := ValidatePath(tc.path, []string{prefix})
			if perr == nil || perr.Code != tc.code {
				t.Fatalf("%q 应 %s，实际 %+v", tc.path, tc.code, perr)
			}
		})
	}
}

// TestRejectSymlink 覆盖目标/父目录软链接（ADR §5.3）。
func TestRejectSymlink(t *testing.T) {
	prefix, copyRoot := testEnv(t)
	outside := filepath.Join(t.TempDir(), "outside.conf")
	if err := os.WriteFile(outside, []byte("x\n"), 0o644); err != nil {
		t.Fatalf("预置外部文件失败：%v", err)
	}
	link := filepath.Join(prefix, "kore-link.conf")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("当前文件系统不支持 symlink：%v", err)
	}
	_, perr := Write(Options{
		Plugin: "ssh-guard", Path: link, Content: []byte("y\n"), Mode: 0o644,
		CopyRoot: copyRoot, Auditor: func(AuditEvent) error { return nil }, AllowedPrefixes: []string{prefix},
	})
	if perr == nil || perr.Code != CodeSymlink {
		t.Fatalf("软链接目标应 E_SYMLINK，实际 %+v", perr)
	}
	parentLink := filepath.Join(t.TempDir(), "linkeddir")
	if err := os.Symlink(prefix, parentLink); err != nil {
		t.Skipf("当前文件系统不支持 symlink：%v", err)
	}
	_, perr = Write(Options{
		Plugin: "ssh-guard", Path: filepath.Join(parentLink, "x.conf"), Content: []byte("y\n"), Mode: 0o644,
		CopyRoot: copyRoot, Auditor: func(AuditEvent) error { return nil }, AllowedPrefixes: []string{parentLink + "/"},
	})
	if perr == nil || (perr.Code != CodeSymlink && perr.Code != CodeUnsafeTarget) {
		t.Fatalf("父目录软链接应拒绝（E_SYMLINK/E_UNSAFE_TARGET），实际 %+v", perr)
	}
}

// TestRejectContentAndMode 覆盖大小/权限/NUL（ADR §5.5/§5.6）。
func TestRejectContentAndMode(t *testing.T) {
	if perr := ValidateContent(make([]byte, MaxContentBytes+1)); perr == nil || perr.Code != CodeTooLarge {
		t.Fatalf("300 KiB 应 E_TOO_LARGE，实际 %+v", perr)
	}
	if perr := ValidateContent([]byte("a\x00b")); perr == nil || perr.Code != CodeBadContent {
		t.Fatalf("NUL 应 E_BAD_CONTENT，实际 %+v", perr)
	}
	for _, mode := range []os.FileMode{0o777, 0o755, 0o666, 0o600} {
		err := ValidateMode(mode)
		if mode == 0o600 {
			if err != nil {
				t.Fatalf("0600 应允许：%v", err)
			}
			continue
		}
		if err == nil || err.Code != CodeBadMode {
			t.Fatalf("mode %#o 应 E_BAD_MODE，实际 %+v", mode, err)
		}
	}
}

// TestAuditFailClosed 覆盖审计不可用/失败时不写文件（ADR §5.8）。
func TestAuditFailClosed(t *testing.T) {
	prefix, copyRoot := testEnv(t)
	target := filepath.Join(prefix, "kore-audit.conf")
	_, perr := Write(Options{
		Plugin: "ssh-guard", Path: target, Content: []byte("x\n"), Mode: 0o644,
		CopyRoot: copyRoot, AllowedPrefixes: []string{prefix},
	})
	if perr == nil || perr.Code != CodeAuditDenied {
		t.Fatalf("审计未注入应 E_AUDIT_DENIED，实际 %+v", perr)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("审计失败时不得落盘：%v", err)
	}
	_, perr = Write(Options{
		Plugin: "ssh-guard", Path: target, Content: []byte("x\n"), Mode: 0o644,
		CopyRoot: copyRoot, AllowedPrefixes: []string{prefix},
		Auditor: func(AuditEvent) error { return os.ErrPermission },
	})
	if perr == nil || perr.Code != CodeAuditDenied {
		t.Fatalf("审计写失败应 E_AUDIT_DENIED，实际 %+v", perr)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("审计失败时不得落盘：%v", err)
	}
}

// TestBackupFailureAborts 覆盖备份失败即中止（ADR §2 回滚）。
func TestBackupFailureAborts(t *testing.T) {
	prefix, _ := testEnv(t)
	target := filepath.Join(prefix, "kore-backup.conf")
	if err := os.WriteFile(target, []byte("old\n"), 0o644); err != nil {
		t.Fatalf("预置旧文件失败：%v", err)
	}
	badRoot := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(badRoot, []byte("x"), 0o600); err != nil {
		t.Fatalf("预置阻塞文件失败：%v", err)
	}
	_, perr := Write(Options{
		Plugin: "ssh-guard", Path: target, Content: []byte("new\n"), Mode: 0o644,
		CopyRoot: badRoot, AllowedPrefixes: []string{prefix},
		Auditor: func(AuditEvent) error { return nil },
	})
	if perr == nil || perr.Code != CodeCopyFailed {
		t.Fatalf("备份失败应 E_BACKUP_FAILED，实际 %+v", perr)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "old\n" {
		t.Fatalf("备份失败时原文件必须保持不变：%q", got)
	}
}

// TestUnsafeExistingTarget 覆盖目标已存在但权限异常（ADR §5.4）。
func TestUnsafeExistingTarget(t *testing.T) {
	prefix, copyRoot := testEnv(t)
	target := filepath.Join(prefix, "kore-unsafe.conf")
	if err := os.WriteFile(target, []byte("x\n"), 0o666); err != nil {
		t.Fatalf("预置文件失败：%v", err)
	}
	_, perr := Write(Options{
		Plugin: "ssh-guard", Path: target, Content: []byte("y\n"), Mode: 0o644,
		CopyRoot: copyRoot, AllowedPrefixes: []string{prefix},
		Auditor: func(AuditEvent) error { return nil },
	})
	if perr == nil || perr.Code != CodeUnsafeTarget {
		t.Fatalf("目标权限 0666 应 E_UNSAFE_TARGET，实际 %+v", perr)
	}
}
