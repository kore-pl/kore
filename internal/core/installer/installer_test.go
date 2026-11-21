package installer_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kore-project/kore/internal/core/installer"
)

// TestInstallSuccess 覆盖验收用例 1：正常安装后目录结构、plugins 与 plugin_state 均正确。
func TestInstallSuccess(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))

	result, err := f.inst.Install(pkg)
	if err != nil {
		t.Fatalf("正常安装应成功: %v", err)
	}
	if result.ID != "site" || result.Version != "0.1.0" {
		t.Fatalf("安装结果不符: %+v", result)
	}
	sum := fileHash(t, pkg)
	if result.SHA256 != sum {
		t.Fatalf("自算 sha256 不符: got=%s want=%s", result.SHA256, sum)
	}
	entry := filepath.Join(f.pluginRoot(), "site", "0.1.0", "bin", "site")
	info, err := os.Stat(entry)
	if err != nil {
		t.Fatalf("bin/site 未落位: %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("bin/site 缺少执行位: %v", info.Mode())
	}
	if _, err := os.Stat(filepath.Join(f.pluginRoot(), "site", "0.1.0", "web", "index.js")); err != nil {
		t.Fatalf("web 资产未落位: %v", err)
	}

	record := f.pluginRecord(t, "site")
	if record["version"] != "0.1.0" || record["package_sha256"] != sum {
		t.Fatalf("plugins 记录不符: %v", record)
	}
	if record["source"] != "manual" || record["lifecycle"] != "resident" {
		t.Fatalf("plugins 来源/生命周期不符: %v", record)
	}
	state := f.pluginState(t, "site")
	if state["desired"] != "disabled" || state["actual"] != "stopped" {
		t.Fatalf("plugin_state 初始值应为 disabled/stopped: %v", state)
	}
	assertEmptyDir(t, filepath.Join(f.pluginRoot(), ".staging"))
}

// TestInstallChecksumMismatch 覆盖验收用例 2：sha256 不符返回 ErrChecksum 且无残留。
func TestInstallChecksumMismatch(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	declared := strings.Repeat("0", 64) + "  " + filepath.Base(pkg) + "\n"
	if err := os.WriteFile(pkg+".sha256", []byte(declared), 0o600); err != nil {
		t.Fatalf("写旁路 sha256 失败: %v", err)
	}

	if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrChecksum) {
		t.Fatalf("应返回 ErrChecksum，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
	f.requireNoKey(t, "plugins", "site")
}

// TestInstallAtomicOnInvalidManifest 覆盖验收用例 6：中途校验失败后无半装态、无落库。
func TestInstallAtomicOnInvalidManifest(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	entries := validEntries(t, map[string]any{"version": nil})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", entries)

	if _, err := f.inst.Install(pkg); !errors.Is(err, installer.ErrInvalid) {
		t.Fatalf("缺 version 应返回 ErrInvalid，实际: %v", err)
	}
	f.assertNoResidue(t, "site", "0.1.0")
	f.requireNoKey(t, "plugins", "site")
	f.requireNoKey(t, "plugin_state", "site")
}
