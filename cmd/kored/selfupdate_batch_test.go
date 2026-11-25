package main

// M3 批量编排器单测（全部在内存替身上跑，不执行 install/serve/upgrade、不碰运行态）：
//   - happy path：N 条按依赖序逐条调单条 install + reloadOne，全部成功；
//   - 注入一条失败：其余项仍成功、失败项可单条重试、不整批回滚；
//   - 幂等：同输入重复跑得到同样的顺序与汇总；
//   - fail-closed：审计出口写不进就不开始（复用 M2 语义）；
//   - 复用契约：结果内嵌 M2 的 OrchestrationResult / httpapi.SelfUpdateJob。

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/market"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// batchFakeSource 是只读索引计算的测试替身，返回有序待更新项或错误。
type batchFakeSource struct {
	items []market.PendingUpdate
	err   error
	calls int
}

func (s *batchFakeSource) PendingUpdates(map[string]string) ([]market.PendingUpdate, error) {
	s.calls++
	return s.items, s.err
}

// batchFakeInstaller 单条 store/install（download 分支）替身，可注入指定 id 失败。
type batchFakeInstaller struct {
	failID string
	calls  []string
}

func (i *batchFakeInstaller) InstallDownload(_ context.Context, id, version string) (*market.InstallJob, error) {
	i.calls = append(i.calls, id)
	if id == i.failID {
		return nil, &pluginapi.Error{Code: pluginapi.E_UPSTREAM, Message: "模拟下载失败: " + id}
	}
	return &market.InstallJob{
		ID: id + "-" + version, PluginID: id, Version: version,
		State: "succeeded", Message: "安装完成",
	}, nil
}

// newBatchTestOrchestrator 组装带 orchAuditRecorder 的批量编排器（审计出口可注入失败）。
func newBatchTestOrchestrator(
	items []market.PendingUpdate, failID string, auditErr error,
) (*batchUpdateOrchestrator, *batchFakeInstaller, *orchAuditRecorder, *[]string) {
	audit := &orchAuditRecorder{err: auditErr}
	orch := &updateOrchestrator{audit: audit}
	source := &batchFakeSource{items: items}
	installer := &batchFakeInstaller{failID: failID}
	reloads := &[]string{}
	b := &batchUpdateOrchestrator{
		orch: orch, pendingSource: source, installer: installer,
		installed: func() (map[string]string, error) {
			return map[string]string{"echo": "0.1.1", "site": "0.1.9", "waf": "0.2.0"}, nil
		},
		reloadOne: func(id string) (string, error) {
			*reloads = append(*reloads, id)
			return reloadRestarted, nil
		},
	}
	return b, installer, audit, reloads
}

// batchItems 依赖序 fixtures：echo → site → waf（与 market 层拓扑序一致）。
func batchItems() []market.PendingUpdate {
	return []market.PendingUpdate{
		{ID: "echo", Version: "0.1.2", PreviousVersion: "0.1.1"},
		{ID: "site", Version: "0.2.0", PreviousVersion: "0.1.9", DependsOn: []string{"echo"}},
		{ID: "waf", Version: "0.3.0", PreviousVersion: "0.2.0"},
	}
}

// TestBatchHappyPath 验证一次触发 N 项全部成功：逐条 install + reloadOne、汇总计数、
// 结果结构与 M2 共用（OrchestrationResult + SelfUpdateJob）、无需重启内核。
func TestBatchHappyPath(t *testing.T) {
	b, installer, audit, reloads := newBatchTestOrchestrator(batchItems(), "", nil)
	res, err := b.Run(context.Background())
	if err != nil {
		t.Fatalf("批量更新失败: %v", err)
	}
	if res.Phase != phaseCommitted {
		t.Fatalf("整批 phase 应为 %q，实际 %q", phaseCommitted, res.Phase)
	}
	if res.Summary != (BatchSummary{Total: 3, Succeeded: 3, Failed: 0}) {
		t.Fatalf("汇总不符: %+v", res.Summary)
	}
	if len(res.Failures) != 0 {
		t.Fatalf("happy path 不应有失败分诊: %+v", res.Failures)
	}
	if !reflect.DeepEqual(installer.calls, []string{"echo", "site", "waf"}) {
		t.Fatalf("单条 install 未按依赖序调用: %v", installer.calls)
	}
	if !reflect.DeepEqual(*reloads, []string{"echo", "site", "waf"}) {
		t.Fatalf("reloadOne 未按依赖序调用: %v", *reloads)
	}
	for i, item := range res.Items {
		if item.Phase != phaseCommitted || item.Job.State != jobStateSuccess || item.Job.ExitCode != exitOK {
			t.Fatalf("第 %d 项未成功: %+v", i, item)
		}
		if item.Reload != reloadRestarted {
			t.Fatalf("第 %d 项 reload 分类不符: %q", i, item.Reload)
		}
		// 结果结构复用 M2：内嵌 OrchestrationResult.Job 就是 httpapi.SelfUpdateJob。
		if typ := reflect.TypeOf(item.Job); typ != reflect.TypeOf(httpapi.SelfUpdateJob{}) {
			t.Fatalf("结果类型不是 M2 共用的 SelfUpdateJob: %v", typ)
		}
	}
	// 审计与 M2 同一出口、同一事件结构，channel=inprocess，无凭据字段。
	evs := audit.snapshot()
	if len(evs) != 1 || evs[0].Action != orchestrationAuditAction || evs[0].Subject != inProcessActor {
		t.Fatalf("批量审计应复用 M2 出口与主体: %+v", evs)
	}
	if evs[0].Detail["channel"] != orchestrationChannel || evs[0].Detail["target_version"] != batchAuditTarget {
		t.Fatalf("批量审计 detail 不符: %+v", evs[0])
	}
}

// TestBatchIsolatedFailure 验证注入一条失败：其余项仍成功、失败项可单条重试、
// 不整批回滚（成功项不做任何撤销动作）。
func TestBatchIsolatedFailure(t *testing.T) {
	b, installer, _, reloads := newBatchTestOrchestrator(batchItems(), "site", nil)
	res, err := b.Run(context.Background())
	if err != nil {
		t.Fatalf("单条失败不应导致整批 error: %v", err)
	}
	if res.Summary != (BatchSummary{Total: 3, Succeeded: 2, Failed: 1}) {
		t.Fatalf("部分失败汇总不符: %+v", res.Summary)
	}
	// 三条都尝试了：失败项不阻断后续项。
	if !reflect.DeepEqual(installer.calls, []string{"echo", "site", "waf"}) {
		t.Fatalf("失败项阻断后续项: %v", installer.calls)
	}
	// reloadOne 只对成功项调用（失败项未落盘，不重载）。
	if !reflect.DeepEqual(*reloads, []string{"echo", "waf"}) {
		t.Fatalf("失败项不应触发 reload: %v", *reloads)
	}
	if len(res.Failures) != 1 || res.Failures[0].ID != "site" ||
		res.Failures[0].ErrorCode != pluginapi.E_UPSTREAM || !res.Failures[0].Retryable {
		t.Fatalf("失败分诊不符: %+v", res.Failures)
	}
	if res.Items[1].Phase != phaseFailed || res.Items[1].Job.State != jobStateFailed {
		t.Fatalf("失败项状态不符: %+v", res.Items[1])
	}
	if res.Items[0].Phase != phaseCommitted || res.Items[2].Phase != phaseCommitted {
		t.Fatal("其余项应仍成功（无整批回滚）")
	}

	// 单条重试：把注入失败取消后原地重跑，失败项单独成功，不重复安装已成功项。
	installer.failID = ""
	retry, err := installer.InstallDownload(context.Background(), "site", "0.2.0")
	if err != nil || retry == nil || retry.State != "succeeded" {
		t.Fatalf("单条重试应成功: job=%+v err=%v", retry, err)
	}
}

// TestBatchIdempotent 同一输入重复执行得到相同顺序与汇总（概要幂等）。
func TestBatchIdempotent(t *testing.T) {
	b1, _, _, _ := newBatchTestOrchestrator(batchItems(), "", nil)
	first, err := b1.Run(context.Background())
	if err != nil {
		t.Fatalf("首次失败: %v", err)
	}
	b2, _, _, _ := newBatchTestOrchestrator(batchItems(), "", nil)
	second, err := b2.Run(context.Background())
	if err != nil {
		t.Fatalf("重复失败: %v", err)
	}
	if first.Summary != second.Summary || first.Phase != second.Phase {
		t.Fatalf("重复执行汇总不一致: first=%+v second=%+v", first.Summary, second.Summary)
	}
	ids := func(items []BatchItemResult) []string {
		out := make([]string, 0, len(items))
		for _, it := range items {
			out = append(out, it.PluginID)
		}
		return out
	}
	if !reflect.DeepEqual(ids(first.Items), ids(second.Items)) {
		t.Fatalf("重复执行顺序不一致: %v / %v", ids(first.Items), ids(second.Items))
	}
}

// TestBatchAuditFailClosed 审计写不进时不开始任何安装（复用 M2 fail-closed 语义）。
func TestBatchAuditFailClosed(t *testing.T) {
	b, installer, _, reloads := newBatchTestOrchestrator(batchItems(), "", errors.New("审计库不可写"))
	_, err := b.Run(context.Background())
	if !errors.Is(err, httpapi.ErrUpgradeAudit) {
		t.Fatalf("审计失败应回 ErrUpgradeAudit，实际 %v", err)
	}
	if len(installer.calls) != 0 || len(*reloads) != 0 {
		t.Fatalf("审计失败不应安装/重载: calls=%v reloads=%v", installer.calls, *reloads)
	}
}

// TestBatchPlanningError 规划阶段（验签/循环依赖）失败时整批拒绝，零安装。
func TestBatchPlanningError(t *testing.T) {
	b, installer, _, reloads := newBatchTestOrchestrator(nil, "", nil)
	b.pendingSource = &batchFakeSource{err: &pluginapi.Error{Code: pluginapi.E_UNAUTHORIZED, Message: "索引验签失败"}}
	res, err := b.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "索引验签失败") {
		t.Fatalf("规划失败应返回错误，实际 %v", err)
	}
	if res.Phase != phaseFailed {
		t.Fatalf("规划失败 phase 应为 %q，实际 %q", phaseFailed, res.Phase)
	}
	if len(installer.calls) != 0 || len(*reloads) != 0 {
		t.Fatal("规划失败时不得安装任何项")
	}
}

// TestBatchErrorCodeUsesMarketCodes 分诊码优先用 market/pluginapi 的结构化码（不丢码）。
func TestBatchErrorCodeUsesMarketCodes(t *testing.T) {
	got := batchErrorCode(&pluginapi.Error{Code: pluginapi.E_NOTFOUND, Message: "索引中不存在"})
	if got != pluginapi.E_NOTFOUND {
		t.Fatalf("结构化错误码应透传，实际 %q", got)
	}
	if got := batchErrorCode(httpapi.ErrUpgradeBusy); got != "E_UPGRADE_BUSY" {
		t.Fatalf("M2 哨兵映射错误: %q", got)
	}
	if got := batchErrorCode(errors.New("x")); got != "E_INTERNAL" {
		t.Fatalf("未知错误应映射 E_INTERNAL，实际 %q", got)
	}
}
