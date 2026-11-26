package config

import (
	"os"
	"strings"
	"testing"
)

// TestBackupDefaultsConservative 未配置时 backup.* 取保守默认：
// keep_count=2，max_disk_bytes=256 MiB（单插件解压硬上限 128 MiB × 2）。
func TestBackupDefaultsConservative(t *testing.T) {
	snap := Default()
	if snap.Backup.KeepCount != 2 {
		t.Fatalf("默认 backup.keep_count = %d，期望 2", snap.Backup.KeepCount)
	}
	if snap.Backup.MaxDiskBytes != 256*1024*1024 {
		t.Fatalf("默认 backup.max_disk_bytes = %d，期望 268435456（256 MiB）", snap.Backup.MaxDiskBytes)
	}
	// 文件缺失场景同样拿到默认值（load 走 Default()）。
	path := t.TempDir() + "/absent.yaml"
	loaded, _, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("文件缺失不应失败: %v", err)
	}
	if loaded.Backup.KeepCount != 2 || loaded.Backup.MaxDiskBytes != 256*1024*1024 {
		t.Fatalf("缺失文件时 backup 默认不符: %+v", loaded.Backup)
	}
}

// TestBackupParseOverrides 显式 backup.* 配置覆盖默认值（整数与 int64 字节数）。
func TestBackupParseOverrides(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "backup:\n  keep_count: 5\n  max_disk_bytes: 805306368\n")
	snap, warnings, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("解析失败: %v（warnings=%v）", err, warnings)
	}
	if snap.Backup.KeepCount != 5 {
		t.Fatalf("keep_count = %d，期望 5", snap.Backup.KeepCount)
	}
	if snap.Backup.MaxDiskBytes != 805306368 {
		t.Fatalf("max_disk_bytes = %d，期望 805306368", snap.Backup.MaxDiskBytes)
	}
}

// TestBackupPartialConfigKeepsOtherDefault 只写 keep_count 时 max_disk_bytes 保留默认。
func TestBackupPartialConfigKeepsOtherDefault(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "backup:\n  keep_count: 3\n")
	snap, _, err := loadFile(t, path)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if snap.Backup.KeepCount != 3 || snap.Backup.MaxDiskBytes != 256*1024*1024 {
		t.Fatalf("部分配置保留默认失败: %+v", snap.Backup)
	}
}

// TestBackupInvalidValuesRejected 份数 0 / 磁盘上限过小必须校验失败（带字段名）。
func TestBackupInvalidValuesRejected(t *testing.T) {
	for _, body := range []string{
		"backup:\n  keep_count: 0\n",
		"backup:\n  keep_count: 11\n",
		"backup:\n  max_disk_bytes: 100\n",
	} {
		path := writeConfig(t, t.TempDir(), body)
		_, _, err := loadFile(t, path)
		if err == nil || !strings.Contains(err.Error(), "backup.") {
			t.Fatalf("非法配置应被拒并指名字段: body=%q err=%v", body, err)
		}
	}
}

// TestBackupWrongTypeRejected 字符串写成字节数按类型错误拒绝。
func TestBackupWrongTypeRejected(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "backup:\n  max_disk_bytes: \"256MB\"\n")
	_, _, err := loadFile(t, path)
	if err == nil || !strings.Contains(err.Error(), "backup.max_disk_bytes") {
		t.Fatalf("类型错误应指名字段，实际 %v", err)
	}
}

// TestBackupReloadIsCold backup.* 变更需重启（market.Service 构造时固化）。
func TestBackupReloadIsCold(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "backup:\n  keep_count: 2\n")
	old, _, err := loadFile(t, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("backup:\n  keep_count: 4\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	next, warnings, err := old.Reload(Options{FlagPath: path, Logger: testLogger()})
	if err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	if next.Backup.KeepCount != 2 {
		t.Fatalf("冷字段应保持旧值，实际 %d", next.Backup.KeepCount)
	}
	found := false
	for _, w := range warnings {
		if w.Key == "backup.keep_count" && strings.Contains(w.Message, "不可热更") {
			found = true
		}
	}
	if !found {
		t.Fatalf("缺 backup.keep_count 冷字段 WARN: %v", warnings)
	}
}
