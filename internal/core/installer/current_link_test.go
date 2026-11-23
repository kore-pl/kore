package installer_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
)

// TestInstallMaintainsCurrentLink 验证升级后稳定链接原子切到新版本，
// 且旧版本目录仍在（回滚依赖它，清理旧目录是另一回事）。
func TestInstallMaintainsCurrentLink(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	root := filepath.Join(f.pluginRoot(), "site")
	current := filepath.Join(root, "current")

	oldPkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	if _, err := f.inst.Install(oldPkg); err != nil {
		t.Fatalf("安装 0.1.0 失败: %v", err)
	}
	if target, err := os.Readlink(current); err != nil || target != "0.1.0" {
		t.Fatalf("current 应指向 0.1.0（相对链接）: target=%q err=%v", target, err)
	}

	newPkg := writePackage(t, t.TempDir(), "site-0.2.0.tar.gz",
		validEntries(t, map[string]any{"version": "0.2.0"}))
	if _, err := f.inst.Install(newPkg); err != nil {
		t.Fatalf("安装 0.2.0 失败: %v", err)
	}
	target, err := os.Readlink(current)
	if err != nil {
		t.Fatalf("读取 current 失败: %v", err)
	}
	if target != "0.2.0" {
		t.Fatalf("升级后 current 应指向 0.2.0，实际 %q", target)
	}
	// 稳定路径必须解析到新版本二进制（cron 等宿主条目的落点）。
	resolved, err := filepath.EvalSymlinks(filepath.Join(current, "bin", "site"))
	if err != nil {
		t.Fatalf("稳定路径不可解析: %v", err)
	}
	want := filepath.Join(root, "0.2.0", "bin", "site")
	if resolved != want {
		t.Fatalf("稳定路径应解析到新版本二进制: got=%s want=%s", resolved, want)
	}
	// 旧版本目录保留（供回滚），不被稳定链接维护逻辑清理。
	if _, err := os.Stat(filepath.Join(root, "0.1.0", "bin", "site")); err != nil {
		t.Fatalf("旧版本目录应保留: %v", err)
	}
}

// TestInstallForceKeepsCurrentLinkOnSameVersion 验证同版本强制重装后稳定链接仍有效。
func TestInstallForceKeepsCurrentLinkOnSameVersion(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	if _, err := f.inst.Install(pkg); err != nil {
		t.Fatalf("首次安装失败: %v", err)
	}
	forced := f.withForce(t)
	replacement := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz",
		validEntries(t, map[string]any{"name": "重装后名字"}))
	if _, err := forced.Install(replacement); err != nil {
		t.Fatalf("force 重装失败: %v", err)
	}
	current := filepath.Join(f.pluginRoot(), "site", "current")
	if target, err := os.Readlink(current); err != nil || target != "0.1.0" {
		t.Fatalf("重装后 current 应仍指向 0.1.0: target=%q err=%v", target, err)
	}
	if _, err := os.Stat(filepath.Join(current, "bin", "site")); err != nil {
		t.Fatalf("重装后稳定链接悬空: %v", err)
	}
}
