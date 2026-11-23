package supervisor_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// TestResidentQuotaRejectsThird 是 RESOURCE-MODEL §2.6 候选 A 的验收判据：
// 3 个 resident 的 enable 请求，第 3 个必须被拒（E_RATELIMIT + 当前 resident 列表），
// 且不能被静默拉起。
func TestResidentQuotaRejectsThird(t *testing.T) {
	env := newLazyEnv(t, []string{"res-a", "res-b", "res-c"}, "resident", time.Minute)
	ctx := context.Background()
	for _, id := range []string{"res-a", "res-b"} {
		if err := env.manager.Start(ctx, id); err != nil {
			t.Fatalf("启动 %s 失败: %v", id, err)
		}
	}
	err := env.manager.Start(ctx, "res-c")
	if err == nil {
		t.Fatal("第 3 个 resident 应被拒绝，实际启动成功")
	}
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_RATELIMIT {
		t.Fatalf("错误码应为 %s，实际 %v", pluginapi.E_RATELIMIT, err)
	}
	for _, want := range []string{"常驻插件已达上限 2", "res-a", "res-b"} {
		if !strings.Contains(perr.Message, want) {
			t.Fatalf("错误提示缺少 %q：%s", want, perr.Message)
		}
	}
	view, _ := env.manager.Snapshot("res-c")
	if view.State != supervisor.StateStopped {
		t.Fatalf("被拒的第 3 个 resident 不应有进程，实际 state=%s", view.State)
	}
	assertRunningSlots(t, env.manager, []string{"res-a", "res-b", "res-c"}, 2)
}

// TestResidentTwoPlusLazyWakeSucceeds 是事故 CS-20261123-01 的回归：
// 2 个 resident 占 2 槽后，再唤醒 1 个 lazy 必须成功（lazy 保留槽生效）。
func TestResidentTwoPlusLazyWakeSucceeds(t *testing.T) {
	env := newMixedEnv(t, []string{"res-a", "res-b", "lz-monitor"}, time.Minute)
	ctx := context.Background()
	for _, id := range []string{"res-a", "res-b"} {
		if err := env.manager.Start(ctx, id); err != nil {
			t.Fatalf("启动 %s 失败: %v", id, err)
		}
	}
	if _, err := env.manager.Ensure(ctx, "lz-monitor"); err != nil {
		t.Fatalf("2 resident + 1 lazy 唤醒必须成功（事故回归），实际: %v", err)
	}
	view, _ := env.manager.Snapshot("lz-monitor")
	if view.State != supervisor.StateReady {
		t.Fatalf("lz-monitor 应为 ready，实际 %s", view.State)
	}
	assertRunningSlots(t, env.manager, []string{"res-a", "res-b", "lz-monitor"}, 3)
}

// TestResidentTwoPlusThreeLazyAlternate 验证 2 resident + 3 lazy 交替唤醒不会 429：
// 唯一保底槽位被轮换使用，resident 始终不被驱逐。
func TestResidentTwoPlusThreeLazyAlternate(t *testing.T) {
	env := newMixedEnv(t, []string{"res-a", "res-b", "lz-1", "lz-2", "lz-3"}, time.Minute)
	ctx := context.Background()
	for _, id := range []string{"res-a", "res-b"} {
		if err := env.manager.Start(ctx, id); err != nil {
			t.Fatalf("启动 %s 失败: %v", id, err)
		}
	}
	order := []string{"lz-1", "lz-2", "lz-3", "lz-1", "lz-2", "lz-3"}
	for i, id := range order {
		if _, err := env.manager.Ensure(ctx, id); err != nil {
			t.Fatalf("第 %d 次唤醒 %s 不应 429，实际: %v", i+1, id, err)
		}
		for _, rid := range []string{"res-a", "res-b"} {
			view, _ := env.manager.Snapshot(rid)
			if view.State != supervisor.StateReady {
				t.Fatalf("第 %d 次唤醒后 %s 应保持 ready，实际 %s", i+1, rid, view.State)
			}
		}
		assertRunningSlots(t, env.manager,
			[]string{"res-a", "res-b", "lz-1", "lz-2", "lz-3"}, 3)
	}
}

// TestResidentMaxOneRejectsSecond 验证配置 resources.resident_max=1 时更保守：
// 第 2 个 resident 即被拒。
func TestResidentMaxOneRejectsSecond(t *testing.T) {
	env := newLazyEnv(t, []string{"res-a", "res-b"}, "resident", time.Minute,
		func(o *supervisor.Options) { o.ResidentMax = 1 })
	ctx := context.Background()
	if err := env.manager.Start(ctx, "res-a"); err != nil {
		t.Fatalf("启动 res-a 失败: %v", err)
	}
	err := env.manager.Start(ctx, "res-b")
	if err == nil {
		t.Fatal("resident_max=1 时第 2 个 resident 应被拒绝")
	}
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_RATELIMIT {
		t.Fatalf("错误码应为 %s，实际 %v", pluginapi.E_RATELIMIT, err)
	}
	if !strings.Contains(perr.Message, "常驻插件已达上限 1") || !strings.Contains(perr.Message, "res-a") {
		t.Fatalf("错误提示应含上限 1 与 res-a，实际: %s", perr.Message)
	}
}

// TestResidentMaxThreeIsProtectionOff 验证显式放弃保护（resident_max=3）：
// 3 个 resident 均允许，lazy 唤醒如预期 429（诚实披露：这是保护不是根治）。
func TestResidentMaxThreeIsProtectionOff(t *testing.T) {
	env := newMixedEnv(t, []string{"res-a", "res-b", "res-c", "lz-1"}, time.Minute,
		func(o *supervisor.Options) { o.ResidentMax = 3 })
	ctx := context.Background()
	for _, id := range []string{"res-a", "res-b", "res-c"} {
		if err := env.manager.Start(ctx, id); err != nil {
			t.Fatalf("resident_max=3 时启动 %s 应允许，实际: %v", id, err)
		}
	}
	_, err := env.manager.Ensure(ctx, "lz-1")
	if err == nil {
		t.Fatal("3 个 resident 占满后 lazy 唤醒应 429")
	}
	var perr *pluginapi.Error
	if !errors.As(err, &perr) || perr.Code != pluginapi.E_RATELIMIT {
		t.Fatalf("lazy 唤醒错误码应为 %s，实际 %v", pluginapi.E_RATELIMIT, err)
	}
	if !strings.Contains(perr.Message, "均为 resident") {
		t.Fatalf("错误提示应说明槽位均被 resident 占用，实际: %s", perr.Message)
	}
}

// TestResidentInvokeCannotBypassQuota 验证绕过 enable 直接 invoke resident 也不能
// 突破配额（bus.Call → Ensure 与 enable 走同一闸门）。
func TestResidentInvokeCannotBypassQuota(t *testing.T) {
	env := newLazyEnv(t, []string{"res-a", "res-b", "res-c"}, "resident", time.Minute)
	ctx := context.Background()
	for _, id := range []string{"res-a", "res-b"} {
		if err := env.manager.Start(ctx, id); err != nil {
			t.Fatalf("启动 %s 失败: %v", id, err)
		}
	}
	if _, err := env.manager.Ensure(ctx, "res-c"); err == nil {
		t.Fatal("第 3 个 resident 的 invoke 冷启应被配额拒绝，实际成功")
	}
	view, _ := env.manager.Snapshot("res-c")
	if view.State != supervisor.StateStopped {
		t.Fatalf("被拒的 res-c 不应被拉起，实际 %s", view.State)
	}
}

// TestResidentAdmissionEvictsLazy 验证 resident 拉起时若总槽位已满（lazy 占位），
// 会驱逐最久未用的 lazy 腾位，而不是把总数顶到 4。
func TestResidentAdmissionEvictsLazy(t *testing.T) {
	env := newMixedEnv(t, []string{"res-a", "res-b", "lz-1", "lz-2"}, time.Minute)
	ctx := context.Background()
	if err := env.manager.Start(ctx, "res-a"); err != nil {
		t.Fatalf("启动 res-a 失败: %v", err)
	}
	for _, id := range []string{"lz-1", "lz-2"} {
		if _, err := env.manager.Ensure(ctx, id); err != nil {
			t.Fatalf("唤醒 %s 失败: %v", id, err)
		}
	}
	// res-a + lz-1 + lz-2 = 3 槽满；启动 res-b 应驱逐 lz-1。
	if err := env.manager.Start(ctx, "res-b"); err != nil {
		t.Fatalf("启动 res-b 应驱逐 idle lazy 腾位，实际: %v", err)
	}
	evicted, _ := env.manager.Snapshot("lz-1")
	if evicted.State != supervisor.StateStopped {
		t.Fatalf("最久未用的 lz-1 应被驱逐，实际 %s", evicted.State)
	}
	assertRunningSlots(t, env.manager, []string{"res-a", "res-b", "lz-1", "lz-2"}, 3)
}

// TestSlotLimitsClampsResidentMax 验证直接调 New 传入越界 ResidentMax 时兜底为
// max_slots，防止绕过配置校验后仍能超卖。
func TestSlotLimitsClampsResidentMax(t *testing.T) {
	env := newLazyEnv(t, []string{"res-a"}, "resident", time.Minute,
		func(o *supervisor.Options) { o.ResidentMax = 5 })
	maxSlots, residentMax := env.manager.SlotLimits()
	if maxSlots != 3 || residentMax != 3 {
		t.Fatalf("SlotLimits = (%d,%d)，期望 (3,3)", maxSlots, residentMax)
	}
}
