package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/store"
)

// TestReportInstallErrorLockedHint 验证占用错误保留原始 pid 且追加可操作命令（P0-3）。
func TestReportInstallErrorLockedHint(t *testing.T) {
	err := &store.LockedError{Path: "/tmp/x/data/state.db", PID: 4242}
	var buf bytes.Buffer
	reportInstallError(&buf, err)
	text := buf.String()
	for _, want := range []string{
		"持有者 pid=4242",         // 原始错误原样保留，便于排查
		"/tmp/x/data/state.db", // 路径也要在
		"systemctl --user stop kored-local",
		"sudo systemctl stop kore",
		"商店页面安装",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("占用错误提示缺少 %q：\n%s", want, text)
		}
	}
}

// TestReportInstallErrorNonLockedNoHint 验证非占用错误不刷服务提示（避免误导）。
func TestReportInstallErrorNonLockedNoHint(t *testing.T) {
	var buf bytes.Buffer
	reportInstallError(&buf, store.ErrCorrupt)
	text := buf.String()
	if !strings.Contains(text, "安装失败") {
		t.Fatalf("应打印原始错误：%s", text)
	}
	if strings.Contains(text, "systemctl") {
		t.Fatalf("非锁错误不应出现停服务提示：\n%s", text)
	}
}

// TestInstallLockedStateExitsThreeWithHint 端到端验证 install 撞锁：退出码 3 + 停服务指引。
//
// 锁由进程内第二次 store.Open 制造（bbolt 的 flock 按 open file description 冲突），
// ValidatePackage 只校验文件名与常规文件，因此这里用空文件即可走到 open 状态库这一步。
func TestInstallLockedStateExitsThreeWithHint(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "data")
	holder, err := store.Open(stateDir, nil)
	if err != nil {
		t.Fatalf("先占住状态库失败: %v", err)
	}
	defer func() { _ = holder.Close() }()

	pkg := filepath.Join(t.TempDir(), "site-0.1.0.tar.gz")
	if err := os.WriteFile(pkg, []byte("not-a-real-package"), 0o600); err != nil {
		t.Fatalf("写假包失败: %v", err)
	}
	var out, errOut bytes.Buffer
	code := runPackageInstall(installOptions{stateDir: stateDir, packagePath: pkg}, &out, &errOut)
	if code != exitState {
		t.Fatalf("撞锁退出码 = %d，期望 %d；stderr=%s", code, exitState, errOut.String())
	}
	text := errOut.String()
	if !strings.Contains(text, "持有者 pid=") {
		t.Fatalf("应保留原始 pid：%s", text)
	}
	if !strings.Contains(text, "systemctl --user stop kored-local") || !strings.Contains(text, "sudo systemctl stop kore") {
		t.Fatalf("应给出停服务命令：%s", text)
	}
	if !strings.Contains(text, "商店页面安装") {
		t.Fatalf("应说明商店页面安装无需停服务：%s", text)
	}
}
