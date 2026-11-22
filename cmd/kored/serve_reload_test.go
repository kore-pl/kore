package main

import (
	"context"
	"encoding/json"
	"testing"

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
