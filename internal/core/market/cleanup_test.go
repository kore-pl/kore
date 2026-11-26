package market

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// testCleanupLogger 返回丢弃输出的 logger，避免单测刷屏。
func testCleanupLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// writeVersionDir 在 root 下建一个带 payload 文件的版本目录。
func writeVersionDir(t *testing.T, root, version string, payloadBytes int) string {
	t.Helper()
	dir := filepath.Join(root, version)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if payloadBytes > 0 {
		path := filepath.Join(dir, "bin", "payload")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(strings.Repeat("x", payloadBytes)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// cleanupAuditorRecorder 收集审计事件（验证删除清单 / 主体 / 保留份数）。
type cleanupAuditorRecorder struct {
	events []CleanupAuditEvent
	err    error
}

func (r *cleanupAuditorRecorder) record(ev CleanupAuditEvent) error {
	r.events = append(r.events, ev)
	return r.err
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// TestCleanupKeepCountTwoOfFourOld 装 4 个旧版本 + keep_count=2 →
// 清理后恰好 2 份 + 当前版本可回滚；审计含删除清单。
func TestCleanupKeepCountTwoOfFourOld(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"0.1.0", "0.2.0", "0.3.0", "0.4.0"} {
		writeVersionDir(t, root, v, 8)
	}
	// .prev 与 .bak-<ts> 一律不删。
	writeVersionDir(t, root, ".prev", 3)
	writeVersionDir(t, root, "0.4.0.bak-1710000000000000000", 3)

	rec := &cleanupAuditorRecorder{}
	result, err := CleanupStaleVersions(CleanupOptions{
		Root: root, PluginID: "echo", CurrentVersion: "0.4.0",
		KeepCount: 2, MaxDiskBytes: 1 << 30, Confirmed: true,
		Actor: "admin", Auditor: rec.record, Logger: testCleanupLogger(),
	})
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if got, want := result.Kept, []string{"0.3.0", "0.4.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("保留版本 = %v，期望 %v", got, want)
	}
	if got, want := result.Deleted, []string{"0.1.0", "0.2.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("删除版本 = %v，期望 %v", got, want)
	}
	for _, v := range []string{"0.1.0", "0.2.0"} {
		if exists(filepath.Join(root, v)) {
			t.Fatalf("旧版本 %s 应被删除", v)
		}
	}
	for _, v := range []string{"0.3.0", "0.4.0", ".prev", "0.4.0.bak-1710000000000000000"} {
		if !exists(filepath.Join(root, v)) {
			t.Fatalf("版本/回滚材料 %s 应保留", v)
		}
	}
	if len(rec.events) != 1 {
		t.Fatalf("审计事件数 = %d，期望 1", len(rec.events))
	}
	ev := rec.events[0]
	if ev.Actor != "admin" || ev.PluginID != "echo" || ev.KeepCount != 2 {
		t.Fatalf("审计主体/插件/份数不符: %+v", ev)
	}
	if !reflect.DeepEqual(ev.Deleted, []string{"0.1.0", "0.2.0"}) {
		t.Fatalf("审计删除清单不符: %v", ev.Deleted)
	}
	detail := ev.AuditDetail()
	if !strings.Contains(detail["deleted"], "0.1.0") || !strings.Contains(detail["deleted"], "0.2.0") {
		t.Fatalf("审计 detail 缺删除清单: %+v", detail)
	}
	if len(detail) > 16 {
		t.Fatalf("审计 detail 键数 %d > 16", len(detail))
	}
}

// TestCleanupDiskLimitTriggers 份数没超但磁盘超限 → 触发删除最旧版本。
func TestCleanupDiskLimitTriggers(t *testing.T) {
	root := t.TempDir()
	// 三个版本各 300 字节；上限 650 字节 → 必须删掉最旧的 1 个（剩 600）。
	for _, v := range []string{"1.0.0", "1.1.0", "1.2.0"} {
		writeVersionDir(t, root, v, 300)
	}
	rec := &cleanupAuditorRecorder{}
	result, err := CleanupStaleVersions(CleanupOptions{
		Root: root, PluginID: "cron", CurrentVersion: "1.2.0",
		KeepCount: 10, MaxDiskBytes: 650, Confirmed: true,
		Actor: "admin", Auditor: rec.record, Logger: testCleanupLogger(),
	})
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if got, want := result.Deleted, []string{"1.0.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("磁盘超限删除 = %v，期望 %v", got, want)
	}
	if !exists(filepath.Join(root, "1.1.0")) || !exists(filepath.Join(root, "1.2.0")) {
		t.Fatal("可回滚版本必须保留")
	}
	if result.OverBudget {
		t.Fatal("删到上限内不应标记 OverBudget")
	}
	if len(rec.events) == 1 && rec.events[0].Reason != "disk" {
		t.Fatalf("审计触发原因 = %q，期望 disk", rec.events[0].Reason)
	}
}

// TestCleanupFloorOneRollback keep_count=0 / 磁盘极低时仍保留至少 1 份可回滚版本。
func TestCleanupFloorOneRollback(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"2.0.0", "2.1.0", "2.2.0"} {
		writeVersionDir(t, root, v, 100)
	}
	result, err := CleanupStaleVersions(CleanupOptions{
		Root: root, PluginID: "site", CurrentVersion: "2.2.0",
		KeepCount: 0, MaxDiskBytes: 1, Confirmed: true, // 上限 1 字节必然超限
		Actor: "admin", Auditor: (&cleanupAuditorRecorder{}).record, Logger: testCleanupLogger(),
	})
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if !exists(filepath.Join(root, "2.1.0")) || !exists(filepath.Join(root, "2.2.0")) {
		t.Fatal("保底 1 份可回滚版本 + 当前版本不得删除")
	}
	if !result.OverBudget {
		t.Fatal("受保护版本导致磁盘仍超限时必须标记 OverBudget")
	}
	if got, want := result.Kept, []string{"2.1.0", "2.2.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("保留版本 = %v，期望 %v", got, want)
	}
}

// TestCleanupSingleVersionKeepCountOne 只有 1 个版本时 keep_count=1 不删当前版本。
func TestCleanupSingleVersionKeepCountOne(t *testing.T) {
	root := t.TempDir()
	writeVersionDir(t, root, "3.0.0", 50)
	result, err := CleanupStaleVersions(CleanupOptions{
		Root: root, PluginID: "echo", CurrentVersion: "3.0.0",
		KeepCount: 1, MaxDiskBytes: 1 << 20, Confirmed: true,
		Actor: "admin", Auditor: (&cleanupAuditorRecorder{}).record, Logger: testCleanupLogger(),
	})
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if len(result.Deleted) != 0 || !exists(filepath.Join(root, "3.0.0")) {
		t.Fatal("唯一版本不得删除")
	}
}

// TestCleanupUnconfirmedSkips 未确认新版本生效 → 短路跳过、不删任何文件、审计留痕。
func TestCleanupUnconfirmedSkips(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"4.0.0", "4.1.0", "4.2.0"} {
		writeVersionDir(t, root, v, 10)
	}
	rec := &cleanupAuditorRecorder{}
	result, err := CleanupStaleVersions(CleanupOptions{
		Root: root, PluginID: "echo", CurrentVersion: "4.2.0",
		KeepCount: 1, MaxDiskBytes: 1, Confirmed: false,
		Actor: "admin", Auditor: rec.record, Logger: testCleanupLogger(),
	})
	if err != nil {
		t.Fatalf("短路清理不应报错: %v", err)
	}
	if !result.Skipped || result.SkipReason != "new_version_unconfirmed" {
		t.Fatalf("期望 Skipped=unconfirmed，实际 %+v", result)
	}
	for _, v := range []string{"4.0.0", "4.1.0", "4.2.0"} {
		if !exists(filepath.Join(root, v)) {
			t.Fatalf("未确认生效时不得删除 %s", v)
		}
	}
	if len(rec.events) != 0 {
		t.Fatal("未确认生效时短路，不写清理审计")
	}
}

// TestCleanupAuditFailureReported 审计写入失败 → error 返回，但删除已完成且不回滚。
func TestCleanupAuditFailureReported(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"5.0.0", "5.1.0", "5.2.0"} {
		writeVersionDir(t, root, v, 10)
	}
	rec := &cleanupAuditorRecorder{err: errors.New("audit store down")}
	result, err := CleanupStaleVersions(CleanupOptions{
		Root: root, PluginID: "echo", CurrentVersion: "5.2.0",
		KeepCount: 2, MaxDiskBytes: 1 << 20, Confirmed: true,
		Actor: "admin", Auditor: rec.record, Logger: testCleanupLogger(),
	})
	if err == nil || !strings.Contains(err.Error(), "审计写入失败") {
		t.Fatalf("审计失败应返回 error，实际 %v", err)
	}
	if exists(filepath.Join(root, "5.0.0")) {
		t.Fatal("审计失败不回滚已完成的删除")
	}
	if len(result.Deleted) != 1 {
		t.Fatalf("删除清单 = %v", result.Deleted)
	}
}

// TestCleanupIgnoresTempDirs .staging / 非版本名目录一律不删（G-31 回滚材料保护）。
func TestCleanupIgnoresTempDirs(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"6.0.0", "6.1.0", "6.2.0"} {
		writeVersionDir(t, root, v, 10)
	}
	for _, name := range []string{".staging", ".prev", "backup", "6.0.0.bak-123", "v6.3.0"} {
		writeVersionDir(t, root, name, 10)
	}
	result, err := CleanupStaleVersions(CleanupOptions{
		Root: root, PluginID: "echo", CurrentVersion: "6.2.0",
		KeepCount: 2, MaxDiskBytes: 1 << 20, Confirmed: true,
		Actor: "admin", Auditor: (&cleanupAuditorRecorder{}).record, Logger: testCleanupLogger(),
	})
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if got, want := result.Deleted, []string{"6.0.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("删除 = %v，期望只删最旧版本 %v", got, want)
	}
	for _, name := range []string{".staging", ".prev", "backup", "6.0.0.bak-123", "v6.3.0"} {
		if !exists(filepath.Join(root, name)) {
			t.Fatalf("临时/回滚目录 %s 不得删除", name)
		}
	}
}

// TestServiceCleanupAfterInstallUsesServiceLogger Service 入口补齐 logger 后走同一清理原语。
func TestServiceCleanupAfterInstallUsesServiceLogger(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"7.0.0", "7.1.0", "7.2.0"} {
		writeVersionDir(t, root, v, 10)
	}
	svc := New(Options{Logger: testCleanupLogger()})
	result, err := svc.CleanupAfterInstall(CleanupOptions{
		Root: root, PluginID: "echo", CurrentVersion: "7.2.0",
		KeepCount: 2, MaxDiskBytes: 1 << 20, Confirmed: true,
		Actor: "admin", Auditor: (&cleanupAuditorRecorder{}).record,
	})
	if err != nil {
		t.Fatalf("Service 清理入口失败: %v", err)
	}
	if got, want := result.Deleted, []string{"7.0.0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("删除 = %v，期望 %v", got, want)
	}
	if !exists(filepath.Join(root, "7.1.0")) || !exists(filepath.Join(root, "7.2.0")) {
		t.Fatal("可回滚版本不得删除")
	}
}

// TestCleanupAuditDetailTruncation 审计 detail 值按上限截断，不破坏 UTF-8。
func TestCleanupAuditDetailTruncation(t *testing.T) {
	ev := CleanupAuditEvent{
		Actor: strings.Repeat("操", 100), Root: strings.Repeat("p", 400),
		Kept: []string{"1.0.0"}, Deleted: []string{"0.9.0"},
	}
	detail := ev.AuditDetail()
	for key, value := range detail {
		if len([]rune(value)) > 256 {
			t.Fatalf("detail[%s] 超过 256 字符: %d", key, len([]rune(value)))
		}
	}
	if !strings.HasSuffix(detail["actor"], "...") {
		t.Fatalf("超长值应截断并标记: %q", detail["actor"])
	}
}
