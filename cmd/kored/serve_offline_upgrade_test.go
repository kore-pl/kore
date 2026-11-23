package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/store"
)

// TestOfflineUpgradeRunsPostUpgradeOnServeStart 是「离线 CLI 升级」缺口的端到端断言。
//
// 复现的是真实序列：serve 停止 → 用户用 `kored install --package` 升级（CLI 独占
// state.db，不经 reloadOne，任何 post_upgrade 都无处执行）→ 下次 serve 启动。
// 期望：插件声明了 post_upgrade 时，serve 启动恢复启用态就会补跑一次，迁移不丢。
//
// 反例自证：改前安装器不写 post_upgrade_pending，serve 启动只按新版本拉起插件、
// consumePostUpgrade 读不到凭据 → 探针文件不存在，本测试 FAIL。
func TestOfflineUpgradeRunsPostUpgradeOnServeStart(t *testing.T) {
	stateDir := t.TempDir()
	logger := discardLogger()
	hook := "echo.postupgrade"
	// 1) 旧版本：离线安装（serve 从未启动）。
	installSpecs(t, stateDir, logger, []pluginSpec{
		{ID: "echo", Lifecycle: "lazy", PostUpgrade: hook},
	})
	cfg := testConfig(stateDir)
	app := newPlatform(t, cfg)
	db := openState(t, stateDir, logger)
	// 升级前用户已启用（启用态是「下次启动会恢复」的前提；regression 场景里
	// 用户装完并在面板启用了插件，之后 serve 才被停掉做离线升级）。
	if err := db.Update(func(tx *store.Tx) error {
		return tx.Put("plugin_state", "echo",
			[]byte(`{"desired":"enabled","actual":"idle","restarts":0,"updated_at":"2026-01-01T00:00:00Z"}`))
	}); err != nil {
		t.Fatalf("写入启用态失败: %v", err)
	}

	// 2) 离线 CLI 升级：走同一 installer 语义，没有 service、没有 reloadOne。
	upgraded := buildPackage(t, pluginSpec{
		ID: "echo", Lifecycle: "lazy", Version: "0.2.0", PostUpgrade: hook,
	})
	if _, err := newTestInstaller(t, stateDir, db, false).Install(upgraded); err != nil {
		t.Fatalf("离线升级安装失败: %v", err)
	}
	if got := pendingPostUpgradeVersion(t, db, "echo"); got != "0.2.0" {
		t.Fatalf("离线升级未落待补跑标记: got=%q want=0.2.0（serve 启动将无凭据可消费）", got)
	}

	// 3) serve 启动：恢复 desired=enabled → Enable → 消费标记 → 执行 post_upgrade。
	svc, code := buildService(cfg, app, db)
	if code != exitOK {
		t.Fatalf("装配 service 失败，退出码 %d", code)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = svc.manager.Stop(ctx, "echo")
	})
	if view, ok := svc.catalog.Manifest("echo"); !ok || view.Version != "0.2.0" {
		t.Fatalf("启动后清单版本 = %+v，期望 0.2.0", view)
	}
	if _, err := os.Stat(postUpgradeMarkerPath(stateDir, "echo")); err != nil {
		t.Fatalf("离线升级后 serve 启动未补跑 post_upgrade（crontab 仍指向旧版本）: %v", err)
	}
	if got := pendingPostUpgradeVersion(t, db, "echo"); got != "" {
		t.Fatalf("补跑后应清空待补跑标记，实际 %q（会重复迁移）", got)
	}
}
