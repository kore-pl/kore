package main

import (
	"context"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
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
	inst, err := installer.New(installer.Options{
		StateDir: stateDir, PluginDir: stateDir + "/plugins",
		KoreVersion: testVersion, Logger: logger, Store: db,
	})
	if err != nil {
		t.Fatalf("构造安装器失败: %v", err)
	}
	pkg := buildPackage(t, pluginSpec{ID: "echo", Lifecycle: "resident"})
	if _, err := inst.Install(pkg); err != nil {
		t.Fatalf("安装 echo 失败: %v", err)
	}

	// 未刷新前仍不可见（证明缺口真实存在）。
	if _, ok := svc.catalog.Manifest("echo"); ok {
		t.Fatal("安装后未刷新不应立即可见——否则本测试失去意义")
	}

	// 增量刷新后立即可见、可 enable。
	if err := svc.reloadOne("echo"); err != nil {
		t.Fatalf("reloadOne 失败: %v", err)
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

// TestReloadOneIdempotent 验证 reloadOne 对已登记插件幂等、不报错。
func TestReloadOneIdempotent(t *testing.T) {
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
	// catalog 已由 loadCatalog 登记 echo；reloadOne 应幂等跳过。
	if err := svc.reloadOne("echo"); err != nil {
		t.Fatalf("reloadOne 已登记插件应幂等，实际: %v", err)
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
	if err := svc.reloadOne("does-not-exist"); err == nil {
		t.Fatal("reloadOne 未知 id 应返回错误")
	}
}
