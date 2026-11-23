package installer_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
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

// TestInstallNormalizesFileModes 覆盖 R5 P0：安装不采信包内 mode。
//
// root 构建的包常把 info.json / 前端资产写成 0600、入口 0700；root 安装后若原样
// 保留，非 root 启动的 kored 读不到清单 → 插件被误判"未安装"（waf 实测）。
// 归一规则：可执行 → 0755，其余 → 0644（插件包内容公开，世界可读）。
func TestInstallNormalizesFileModes(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	entries := validEntries(t, nil)
	entries[0].mode = 0o600 // info.json（root 构建常见）
	entries[1].mode = 0o700 // bin/site
	entries[2].mode = 0o600 // web/index.js
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", entries)
	if _, err := f.inst.Install(pkg); err != nil {
		t.Fatalf("安装应成功: %v", err)
	}
	base := filepath.Join(f.pluginRoot(), "site", "0.1.0")
	want := map[string]os.FileMode{
		base:                                   0o755,
		filepath.Join(base, "info.json"):       0o644,
		filepath.Join(base, "web", "index.js"): 0o644,
		filepath.Join(base, "bin", "site"):     0o755,
	}
	for path, mode := range want {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("%s 未落位: %v", path, err)
		}
		if got := info.Mode().Perm(); got != mode {
			t.Fatalf("%s 权限 = %04o，期望 %04o（不采信包内 mode）", path, got, mode)
		}
		if mode == 0o644 && info.Mode().Perm()&0o004 == 0 {
			t.Fatalf("%s 缺 world-read 位，非 root kored 仍会读不到", path)
		}
	}
}

// TestInstallForceReplacesSameVersion 覆盖 P1「同版本重装」：
// 不带 Force → ErrConflict；带 Force → 覆盖目录与记录，且不留备份目录。
func TestInstallForceReplacesSameVersion(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	if _, err := f.inst.Install(pkg); err != nil {
		t.Fatalf("首次安装应成功: %v", err)
	}
	infoPath := filepath.Join(f.pluginRoot(), "site", "0.1.0", "info.json")
	before, err := os.Stat(infoPath)
	if err != nil {
		t.Fatalf("读取首次安装 info.json 失败: %v", err)
	}

	replacement := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz",
		validEntries(t, map[string]any{"name": "重装后名字"}))
	if _, err := f.inst.Install(replacement); !errors.Is(err, installer.ErrConflict) {
		t.Fatalf("同版本且未 force 应返回 ErrConflict，实际: %v", err)
	}

	forced := f.withForce(t)
	result, err := forced.Install(replacement)
	if err != nil {
		t.Fatalf("force 重装应成功: %v", err)
	}
	if result.ID != "site" || result.Version != "0.1.0" {
		t.Fatalf("force 重装结果不符: %+v", result)
	}
	data, err := os.ReadFile(infoPath)
	if err != nil {
		t.Fatalf("读取重装后 info.json 失败: %v", err)
	}
	if !strings.Contains(string(data), "重装后名字") {
		t.Fatalf("force 重装后 payload 未替换: %s", data)
	}
	after, err := os.Stat(infoPath)
	if err != nil {
		t.Fatalf("stat 重装后 info.json 失败: %v", err)
	}
	if after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("force 重装后 info.json mtime 未变化: %v", after.ModTime())
	}
	entries, err := os.ReadDir(filepath.Join(f.pluginRoot(), "site"))
	if err != nil {
		t.Fatalf("读取插件目录失败: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if strings.Join(names, ",") != "0.1.0,current" {
		t.Fatalf("force 成功后只应有版本目录与稳定链接（current），实际: %v", names)
	}
}

// TestForceReinstallPreservesPostUpgradePending 覆盖 P0「同版本强制重装抹掉待补跑标记」：
//
// installer 若用 stateRecord 整体覆盖 plugin_state，会把装配层写入的
// post_upgrade_pending（禁用态升级的唯一凭据）连同它不认识的未来字段一起抹掉，
// 用户启用后跑旧迁移、且无任何提示。断言：installer 只覆盖自己负责的字段
// （desired/actual/updated_at），未知字段原样保留，同时已知字段仍被正确更新。
func TestForceReinstallPreservesPostUpgradePending(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	if _, err := f.inst.Install(pkg); err != nil {
		t.Fatalf("首次安装应成功: %v", err)
	}

	// 模拟装配层 daemon.deferPostUpgrade 写入待补跑标记，并夹带一个 installer
	// 完全不认识的未来字段与运行期重启计数——整体覆盖会把这些一起清掉。
	const seededUpdatedAt = "2020-01-01T00:00:00Z"
	seeded := []byte(`{"desired":"enabled","actual":"ready","restarts":3,` +
		`"post_upgrade_pending":"0.2.0","future_field":{"keep":true},` +
		`"updated_at":"` + seededUpdatedAt + `"}`)
	if err := f.store.Update(func(tx *store.Tx) error {
		return tx.Put("plugin_state", "site", seeded)
	}); err != nil {
		t.Fatalf("写入待补跑标记失败: %v", err)
	}

	// 同版本 force 重装，复现「禁用态升级 → 启用前又 force 重装」的等价序列。
	replacement := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz",
		validEntries(t, map[string]any{"name": "重装后名字"}))
	if _, err := f.withForce(t).Install(replacement); err != nil {
		t.Fatalf("force 重装应成功: %v", err)
	}

	state := f.pluginState(t, "site")
	if got := state["post_upgrade_pending"]; got != "0.2.0" {
		t.Fatalf("force 重装后待补跑标记丢失: got=%v want=0.2.0（state=%v）", got, state)
	}
	if _, ok := state["future_field"]; !ok {
		t.Fatalf("force 重装后 installer 不认识的字段丢失: %v", state)
	}
	if got := state["restarts"]; got != float64(3) {
		t.Fatalf("force 重装不应重置 restarts: got=%v want=3", got)
	}
	//  installer 负责的字段必须仍被正确更新：desired 按既有策略保留、actual 归 stopped、时间刷新。
	if got := state["desired"]; got != "enabled" {
		t.Fatalf("desired 应按既有策略保留 enabled，实际 %v", got)
	}
	if got := state["actual"]; got != "stopped" {
		t.Fatalf("actual 应重置为 stopped，实际 %v", got)
	}
	if got, _ := state["updated_at"].(string); got == "" || got == seededUpdatedAt {
		t.Fatalf("updated_at 应刷新为本次安装时间，实际 %v", state["updated_at"])
	}
	// plugins 记录（包哈希）同样必须更新，不能因为保留未知字段就跳过已知字段。
	wantSum := fileHash(t, replacement)
	if rec := f.pluginRecord(t, "site"); rec["package_sha256"] != wantSum {
		t.Fatalf("plugins 包哈希未更新: got=%v want=%s", rec["package_sha256"], wantSum)
	}
}

// withForce 用同一状态库构造 Force=true 的安装器（模拟 store/install force 路径）。
func (f *fixture) withForce(t *testing.T) *installer.Installer {
	t.Helper()
	inst, err := installer.New(installer.Options{
		StateDir: f.stateDir, KoreVersion: "0.1.0", Logger: discardLogger(), Store: f.store, Force: true,
	})
	if err != nil {
		t.Fatalf("构造 force 安装器失败: %v", err)
	}
	return inst
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

// TestPreviousVersionReadsInstalledRecord 验证升级前快照能读回已装版本。
func TestPreviousVersionReadsInstalledRecord(t *testing.T) {
	f := newFixture(t, installer.Limits{})
	if v, err := installer.PreviousVersion(f.store, "site"); err != nil || v != "" {
		t.Fatalf("未安装时 previous_version 应为空，实际 %q err=%v", v, err)
	}
	pkg := writePackage(t, t.TempDir(), "site-0.1.0.tar.gz", validEntries(t, nil))
	if _, err := f.inst.Install(pkg); err != nil {
		t.Fatalf("安装应成功: %v", err)
	}
	if v, err := installer.PreviousVersion(f.store, "site"); err != nil || v != "0.1.0" {
		t.Fatalf("安装后 previous_version = %q err=%v，期望 0.1.0", v, err)
	}
}
