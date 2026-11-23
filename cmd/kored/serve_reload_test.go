package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
)

// TestReloadOneRegistersLateInstall 验证缺口2：service 装配后 catalog 为空，
// 此时经 installer 落盘安装 echo，再调 reloadOne，catalog 立即可见且可 enable，
// 无需重启进程（对应端到端"装完不重启直接 enable → 200"）。
func TestReloadOneRegistersLateInstall(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()

	// 空 catalog 启动：没有任何预装插件。
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}

	if _, ok := svc.catalog.Manifest("echo"); ok {
		t.Fatal("前置条件失败：空启动下 catalog 不应有 echo")
	}

	// 运行时安装（模拟 POST /store/install 走 installer 落盘）。
	if _, err := newTestInstaller(t, stateDir, db, false).Install(buildPackage(t, pluginSpec{ID: "echo", Lifecycle: "resident"})); err != nil {
		t.Fatalf("安装 echo 失败: %v", err)
	}

	// 未刷新前仍不可见（证明缺口真实存在）。
	if _, ok := svc.catalog.Manifest("echo"); ok {
		t.Fatal("安装后未刷新不应立即可见——否则本测试失去意义")
	}

	// 重载后立即可见、可 enable。
	result, err := svc.reloadOne("echo")
	if err != nil {
		t.Fatalf("reloadOne 失败: %v", err)
	}
	if result != reloadRegistered {
		t.Fatalf("首次安装后重载结果 = %q，期望 %q", result, reloadRegistered)
	}
	if _, ok := svc.catalog.Manifest("echo"); !ok {
		t.Fatal("reloadOne 后 echo 未登记进 catalog")
	}
	if err := svc.backend.Enable(context.Background(), "echo"); err != nil {
		t.Fatalf("reloadOne 后 enable echo 失败: %v", err)
	}
	status, ok, err := svc.backend.Plugin(context.Background(), "echo")
	if err != nil || !ok || !status.Enabled {
		t.Fatalf("enable 后视图异常: ok=%v enabled=%v err=%v", ok, status.Enabled, err)
	}
}

// TestReloadOneRegisteredPluginReloads 验证已登记插件也走真正重载（旧实现直接
// return nil，这正是同 id 升级静默失效的根因），且 desired=disabled 时只重载不拉起。
func TestReloadOneRegisteredPluginReloads(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	installSpecs(t, stateDir, logger, []pluginSpec{{ID: "echo", Lifecycle: "resident"}})
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配失败: %d", code)
	}
	result, err := svc.reloadOne("echo")
	if err != nil {
		t.Fatalf("reloadOne 已登记插件应成功重载，实际: %v", err)
	}
	if result != reloadRegistered {
		t.Fatalf("desired=disabled 时结果 = %q，期望 %q", result, reloadRegistered)
	}
	if view, ok := svc.catalog.Manifest("echo"); !ok || view.Version != testVersion {
		t.Fatalf("重载后清单版本 = %+v，期望 %s", view, testVersion)
	}
}

// TestReloadOneUnknownID 验证未知 id 返回错误而非静默成功。
func TestReloadOneUnknownID(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配失败: %d", code)
	}
	if _, err := svc.reloadOne("does-not-exist"); err == nil {
		t.Fatal("reloadOne 未知 id 应返回错误")
	}
}

// TestReloadOneHotUpgradeSameID 是本轮 P0 的回归测试：
// 装 v1 → enable → 装同 id v2（不 force，版本目录不同）→ reloadOne 不重启内核即：
// catalog 报 v2、运行进程换成 v2 二进制（新方法可调）、旧方法仍可用。
func TestReloadOneHotUpgradeSameID(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}
	ctx := context.Background()

	v1 := buildPackage(t, pluginSpec{ID: "echo", Lifecycle: "resident", Version: "0.1.0"})
	if _, err := newTestInstaller(t, stateDir, db, false).Install(v1); err != nil {
		t.Fatalf("安装 v1 失败: %v", err)
	}
	if _, err := svc.reloadOne("echo"); err != nil {
		t.Fatalf("重载 v1 失败: %v", err)
	}
	if err := svc.backend.Enable(ctx, "echo"); err != nil {
		t.Fatalf("enable v1 失败: %v", err)
	}
	before, ok := svc.manager.Snapshot("echo")
	if !ok || before.PID == 0 {
		t.Fatalf("v1 未就绪: %+v", before)
	}
	if _, err := svc.backend.Invoke(ctx, "echo", "new.ping", json.RawMessage(`{}`), "r-v1"); err == nil {
		t.Fatal("v1 不应支持 new.ping（否则本测试无法证明升级换了二进制）")
	}

	v2 := buildPackage(t, pluginSpec{ID: "echo", Lifecycle: "resident", Version: "0.2.0", ExtraMethod: "new.ping"})
	if _, err := newTestInstaller(t, stateDir, db, false).Install(v2); err != nil {
		t.Fatalf("安装 v2 失败: %v", err)
	}
	result, err := svc.reloadOne("echo")
	if err != nil {
		t.Fatalf("热升级重载失败: %v", err)
	}
	if result != reloadRestarted {
		t.Fatalf("desired=enabled 的升级结果 = %q，期望 %q", result, reloadRestarted)
	}
	view, ok := svc.catalog.Manifest("echo")
	if !ok || view.Version != "0.2.0" {
		t.Fatalf("重载后 catalog 版本 = %+v，期望 0.2.0", view)
	}
	after, ok := svc.manager.Snapshot("echo")
	if !ok || after.PID == 0 {
		t.Fatalf("v2 未就绪: %+v", after)
	}
	if after.PID == before.PID {
		t.Fatalf("热升级后 PID 未变化（%d），说明仍在跑旧版本二进制", before.PID)
	}
	reply, err := svc.backend.Invoke(ctx, "echo", "new.ping", json.RawMessage(`{}`), "r-v2")
	if err != nil {
		t.Fatalf("v2 新方法 new.ping 调用失败: %v", err)
	}
	var got struct {
		Pong   bool   `json:"pong"`
		Method string `json:"method"`
	}
	if err := json.Unmarshal(reply, &got); err != nil || !got.Pong || got.Method != "new.ping" {
		t.Fatalf("new.ping 结果异常: %s (err=%v)", reply, err)
	}
}

// newTestInstaller 构造绑定同一状态库的测试安装器（force 控制是否允许覆盖）。
func newTestInstaller(t *testing.T, stateDir string, db *store.Store, force bool) *installer.Installer {
	t.Helper()
	inst, err := installer.New(installer.Options{
		StateDir: stateDir, PluginDir: stateDir + "/plugins",
		KoreVersion: testVersion, Logger: discardLogger(), Store: db, Force: force,
	})
	if err != nil {
		t.Fatalf("构造安装器失败: %v", err)
	}
	return inst
}

// TestReloadOneRunsDeclaredPostUpgrade 是「升级后 lazy 插件静默不迁移」缺口的核心断言：
// 插件声明了 post_upgrade 时，即使它从未被手动调用，内核也在升级重载后拉起并执行一次。
//
// 反例：不实现该机制时本测试 FAIL——标记文件不会被创建（插件没被拉起）。
func TestReloadOneRunsDeclaredPostUpgrade(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	installSpecs(t, stateDir, logger, []pluginSpec{
		{ID: "echo", Lifecycle: "lazy", PostUpgrade: "echo.postupgrade"},
	})
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = svc.manager.Stop(ctx, "echo")
	})
	// 只标记 desired=enabled（lazy 的 Enable 不拉起进程），模拟"用户装完/升级完但没打开页面"。
	if err := svc.backend.Enable(context.Background(), "echo"); err != nil {
		t.Fatalf("enable echo 失败: %v", err)
	}
	result, err := svc.reloadOne("echo")
	if err != nil {
		t.Fatalf("reloadOne 失败: %v", err)
	}
	if result != reloadRestarted {
		t.Fatalf("重载结果 = %q，期望 %q", result, reloadRestarted)
	}
	marker := filepath.Join(svc.pluginRootDir, "echo", "post_upgrade_ran")
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("升级后置动作未被调用（lazy 插件升级后仍停在旧状态）: %v", err)
	}
}

// postUpgradeMarkerPath 返回测试插件升级后置动作的探针文件路径：插件进程工作目录
// 是 <plugin_root>/<id>（见 supervisor.spawn 的 cmd.Dir）。
func postUpgradeMarkerPath(stateDir, id string) string {
	return filepath.Join(stateDir, "plugins", id, "post_upgrade_ran")
}

// pendingPostUpgradeVersion 读取 plugin_state 里「待补跑」标记的版本值；空串表示无标记。
//
// 刻意按原始 JSON 读取（不依赖装配层结构体字段），让本断言在修复前也能编译并失败，
// 而不是靠编译错误「证明」缺口存在。
func pendingPostUpgradeVersion(t *testing.T, db *store.Store, id string) string {
	t.Helper()
	var record struct {
		PostUpgradePending string `json:"post_upgrade_pending"`
	}
	if err := db.View(func(tx *store.Tx) error {
		value, err := tx.Get(bucketPluginState, id)
		if err != nil {
			return err
		}
		return json.Unmarshal(value, &record)
	}); err != nil {
		t.Fatalf("读取 plugin_state 失败: %v", err)
	}
	return record.PostUpgradePending
}

// upgradeSpec 返回同 id 的升级包（默认从 0.1.0 升到 0.2.0，并声明升级后置动作）。
func upgradeSpec(id string) pluginSpec {
	return pluginSpec{
		ID: id, Lifecycle: "resident", Version: "0.2.0",
		PostUpgrade: id + ".postupgrade",
	}
}

// TestDisabledUpgradeDefersPostUpgrade 断言「禁用态升级」不违背禁用意图：
// 升级当下不拉起插件进程、不执行声明动作，只在状态库留下「待补跑」标记。
//
// 反例：修复前该测试 FAIL——标记字段不存在。
func TestDisabledUpgradeDefersPostUpgrade(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	installSpecs(t, stateDir, logger, []pluginSpec{{ID: "echo", Lifecycle: "resident"}})
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = svc.manager.Stop(ctx, "echo")
	})

	// 前置：用户从未启用过该插件（desired=disabled）。
	if result, err := svc.reloadOne("echo"); err != nil || result != reloadRegistered {
		t.Fatalf("初始重载结果 = %q err=%v，期望 %q", result, err, reloadRegistered)
	}
	if state, found, err := svc.states.load("echo"); err != nil || !found || state.Desired != desiredDisabled {
		t.Fatalf("前置失败：期望 desired=disabled，实际 found=%v state=%+v err=%v", found, state, err)
	}

	// 升级到 0.2.0（声明 post_upgrade），插件仍处于禁用态。
	if _, err := newTestInstaller(t, stateDir, db, false).Install(buildPackage(t, upgradeSpec("echo"))); err != nil {
		t.Fatalf("安装 0.2.0 失败: %v", err)
	}
	result, err := svc.reloadOne("echo")
	if err != nil {
		t.Fatalf("禁用态升级重载失败: %v", err)
	}
	if result != reloadRegistered {
		t.Fatalf("禁用态升级重载结果 = %q，期望 %q", result, reloadRegistered)
	}

	// 断言 1：升级当下不拉起插件进程（尊重禁用意图）。
	if view, ok := svc.manager.Snapshot("echo"); ok && view.PID != 0 {
		t.Fatalf("禁用态升级不应拉起插件进程，实际 state=%s pid=%d", view.State, view.PID)
	}
	// 断言 2：升级当下不执行声明动作。
	if _, statErr := os.Stat(postUpgradeMarkerPath(stateDir, "echo")); statErr == nil {
		t.Fatal("禁用态升级不应执行升级后置动作（探针文件已存在）")
	}
	// 断言 3：待补跑标记落库，供后续 Enable 消费。
	if got := pendingPostUpgradeVersion(t, db, "echo"); got != "0.2.0" {
		t.Fatalf("待补跑标记 = %q，期望 %q（禁用态升级必须记下待迁移版本）", got, "0.2.0")
	}
}

// TestEnableConsumesDeferredPostUpgrade 断言「禁用态升级 → 启用」闭环：
// 启用成功后补跑一次声明动作，并清空待补跑标记。
//
// 反例：修复前该测试 FAIL——Enable 路径没有消费逻辑，探针文件不会出现。
func TestEnableConsumesDeferredPostUpgrade(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	// lazy 与 cron 同形态：Enable 本身不拉起进程，钩子必须由内核主动调用。
	installSpecs(t, stateDir, logger, []pluginSpec{{ID: "echo", Lifecycle: "lazy"}})
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = svc.manager.Stop(ctx, "echo")
	})

	if _, err := svc.reloadOne("echo"); err != nil {
		t.Fatalf("初始重载失败: %v", err)
	}
	spec := pluginSpec{ID: "echo", Lifecycle: "lazy", Version: "0.2.0", PostUpgrade: "echo.postupgrade"}
	if _, err := newTestInstaller(t, stateDir, db, false).Install(buildPackage(t, spec)); err != nil {
		t.Fatalf("安装 0.2.0 失败: %v", err)
	}
	if result, err := svc.reloadOne("echo"); err != nil || result != reloadRegistered {
		t.Fatalf("禁用态升级重载结果 = %q err=%v", result, err)
	}
	marker := postUpgradeMarkerPath(stateDir, "echo")
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatal("禁用态升级不应执行升级后置动作")
	}
	if view, ok := svc.manager.Snapshot("echo"); ok && view.PID != 0 {
		t.Fatalf("禁用态升级不应拉起插件进程，实际 pid=%d", view.PID)
	}

	// 用户重新启用：内核必须补跑一次升级后置动作。
	if err := svc.backend.Enable(context.Background(), "echo"); err != nil {
		t.Fatalf("启用 echo 失败: %v", err)
	}
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Fatalf("启用后未补跑升级后置动作（禁用态升级的迁移被永久丢失）: %v", statErr)
	}
	if got := pendingPostUpgradeVersion(t, db, "echo"); got != "" {
		t.Fatalf("补跑后待补跑标记应清空，实际 %q", got)
	}
}

// TestEnableWithoutUpgradeDoesNotRunPostUpgrade 断言「从未升级过」的禁用插件启用时
// 不误跑升级后置动作：首次安装不是升级，没有待补跑标记。
func TestEnableWithoutUpgradeDoesNotRunPostUpgrade(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	installSpecs(t, stateDir, logger, []pluginSpec{
		{ID: "echo", Lifecycle: "resident", PostUpgrade: "echo.postupgrade"},
	})
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = svc.manager.Stop(ctx, "echo")
	})

	// 首次安装（无旧版本）后的禁用态重载不是升级。
	if result, err := svc.reloadOne("echo"); err != nil || result != reloadRegistered {
		t.Fatalf("首次安装重载结果 = %q err=%v", result, err)
	}
	if got := pendingPostUpgradeVersion(t, db, "echo"); got != "" {
		t.Fatalf("首次安装不应留下待补跑标记，实际 %q", got)
	}
	if err := svc.backend.Enable(context.Background(), "echo"); err != nil {
		t.Fatalf("启用 echo 失败: %v", err)
	}
	if _, statErr := os.Stat(postUpgradeMarkerPath(stateDir, "echo")); statErr == nil {
		t.Fatal("从未升级过的插件启用时不应执行升级后置动作")
	}
}
