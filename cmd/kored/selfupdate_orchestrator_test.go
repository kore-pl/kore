package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
)

// orchAuditRecorder 是进程内编排的 fail-closed 审计出口测试替身。
type orchAuditRecorder struct {
	mu     sync.Mutex
	events []httpapi.AuditEvent
	err    error
}

func (r *orchAuditRecorder) Record(ev httpapi.AuditEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	r.events = append(r.events, ev)
	return nil
}

func (r *orchAuditRecorder) snapshot() []httpapi.AuditEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]httpapi.AuditEvent(nil), r.events...)
}

// waitOrchestrationPhase 有界等待编排结果进入终态（测试专用，不进生产轮询白名单）。
func waitOrchestrationPhase(t *testing.T, o *updateOrchestrator, id string) OrchestrationResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		res, ok := o.OrchestrationStatus(id)
		if ok && (res.Phase == phaseCommitted || res.Phase == phaseRolledBack || res.Phase == phaseFailed) {
			return res
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("编排任务 %s 未在 3s 内进入终态", id)
	return OrchestrationResult{}
}

// TestOrchestratorHappyPathCommitted 是进程内编排的 happy path 实测：
// 显式确认 → fail-closed 审计 → 委托共享 updater（校验 → 原子替换 → pending →
// 提交重启）→ 终态 phase=committed；结果结构与 M1 共用 httpapi.SelfUpdateJob。
func TestOrchestratorHappyPathCommitted(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, err := os.ReadFile(newBin)
	if err != nil {
		t.Fatalf("读新二进制失败: %v", err)
	}
	var restarted []string
	u := newUpgradeTestUpdater(oldBin, stateDir, func(unit string) error {
		restarted = append(restarted, unit)
		return nil
	})
	var updaterAudits []store.AuditRecord
	u.audit = func(rec store.AuditRecord) error { updaterAudits = append(updaterAudits, rec); return nil }
	orchAudit := &orchAuditRecorder{}
	orch := &updateOrchestrator{updater: u, audit: orchAudit}

	res, err := orch.OrchestrateUpgrade(context.Background(), httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: true,
	})
	if err != nil {
		t.Fatalf("OrchestrateUpgrade 失败: %v", err)
	}
	if res.Phase != phaseVerified {
		t.Fatalf("受理阶段应为 %q，实际 %q", phaseVerified, res.Phase)
	}

	final := waitOrchestrationPhase(t, orch, res.Job.ID)
	if final.Phase != phaseCommitted {
		t.Fatalf("终态 phase 应为 %q，实际 %q（reason=%s）", phaseCommitted, final.Phase, final.Reason)
	}
	if final.Job.State != jobStateSuccess || final.Job.ExitCode != exitOK {
		t.Fatalf("任务未成功: %+v", final.Job)
	}

	// 编排结果结构与 M1 一致：Job 就是 httpapi.SelfUpdateJob（无第二套结果类型）。
	if typ := reflect.TypeOf(final.Job); typ != reflect.TypeOf(httpapi.SelfUpdateJob{}) {
		t.Fatalf("Job 类型不是 M1 共用的 httpapi.SelfUpdateJob: %v", typ)
	}

	// 内核升级在进程内只做到「替换 + pending + 重启提交」；生效由新进程确认。
	got, _ := os.ReadFile(oldBin)
	if string(got) != "new-binary" {
		t.Fatalf("目标二进制未替换: %q", got)
	}
	prev, _ := os.ReadFile(oldBin + upgradePrevSuffix)
	if string(prev) != "old-binary" {
		t.Fatalf(".prev 未保留旧二进制: %q", prev)
	}
	marker, err := readUpgradeResult(upgradeResultPath(stateDir))
	if err != nil || marker.State != upgradeStatePending {
		t.Fatalf("pending 标记未落盘: state=%q err=%v", marker.State, err)
	}
	if len(restarted) != 1 || restarted[0] != upgradeDefaultUnit {
		t.Fatalf("未提交重启 unit: %v", restarted)
	}

	// 审计：编排写一条 system.self_update（actor=进程身份，channel=inprocess），
	// updater 自己再写 start/result 两条——与 M1 UDS 入口审计口径一致。
	evs := orchAudit.snapshot()
	if len(evs) != 1 || evs[0].Action != orchestrationAuditAction || evs[0].Subject != inProcessActor {
		t.Fatalf("编排审计应含一条 system.self_update: %+v", evs)
	}
	if evs[0].Detail["channel"] != orchestrationChannel || evs[0].Result != store.AuditResultOK {
		t.Fatalf("编排审计 detail/result 不符: %+v", evs[0])
	}
	if len(updaterAudits) != 2 || updaterAudits[0].Action != upgradeAuditStart || updaterAudits[1].Action != upgradeAuditResult {
		t.Fatalf("共享 updater 审计应含 start+result: %+v", updaterAudits)
	}
}

// TestOrchestratorSharesM1ResultStructure 是任务卡要求的「对比测试」：
// M1 直调 StartUpgrade 的结果与进程内编排的结果必须是同一结构（JSON 字段集一致）。
func TestOrchestratorSharesM1ResultStructure(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	sha := sha256Hex(newData)

	// M1 路径：直接调 selfUpdater.StartUpgrade。
	m1 := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	m1.audit = func(store.AuditRecord) error { return nil }
	m1Job, err := m1.StartUpgrade(context.Background(), "admin", httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha, Confirm: true,
	})
	if err != nil {
		t.Fatalf("M1 StartUpgrade 失败: %v", err)
	}

	// 进程内路径：同一份 updater 实现、经编排入口调用。
	_, oldBin2, newBin2, stateDir2 := newUpgradeTestFixture(t)
	u2 := newUpgradeTestUpdater(oldBin2, stateDir2, func(string) error { return nil })
	u2.audit = func(store.AuditRecord) error { return nil }
	orch := &updateOrchestrator{updater: u2, audit: &orchAuditRecorder{}}
	orchRes, err := orch.OrchestrateUpgrade(context.Background(), httpapi.SelfUpdateRequest{
		SourcePath: newBin2, SHA256: sha256Hex(newData), Confirm: true,
	})
	if err != nil {
		t.Fatalf("编排 StartUpgrade 失败: %v", err)
	}

	// 两条路径的结果字段集与字段类型必须一致（同一结果结构，不复制字段）。
	m1Keys := jsonFieldSet(t, m1Job)
	orchKeys := jsonFieldSet(t, orchRes.Job)
	if !reflect.DeepEqual(m1Keys, orchKeys) {
		t.Fatalf("M1 与进程内编排结果结构不一致:\nM1=%v\n编排=%v", m1Keys, orchKeys)
	}
	if reflect.TypeOf(m1Job) != reflect.TypeOf(orchRes.Job) {
		t.Fatalf("结果类型不一致: M1=%v 编排=%v", reflect.TypeOf(m1Job), reflect.TypeOf(orchRes.Job))
	}
}

// jsonFieldSet 返回结构体 JSON 序列化后的字段集（用于结构一致性对比）。
func jsonFieldSet(t *testing.T, v any) []string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// TestOrchestratorAuditFailClosed 验证审计写不进时不执行更新（与 M1 同语义）。
func TestOrchestratorAuditFailClosed(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return nil }
	orch := &updateOrchestrator{
		updater: u,
		audit:   &orchAuditRecorder{err: errors.New("审计库不可写")},
	}

	_, err := orch.OrchestrateUpgrade(context.Background(), httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: true,
	})
	if !errors.Is(err, httpapi.ErrUpgradeAudit) {
		t.Fatalf("审计失败应回 ErrUpgradeAudit，实际 %v", err)
	}
	// 没审计就没有任务、没有替换：fail-closed。
	if _, ok := orch.OrchestrationStatus("any"); ok {
		t.Fatal("审计失败不应产生任何编排任务")
	}
	got, _ := os.ReadFile(oldBin)
	if string(got) != "old-binary" {
		t.Fatalf("审计失败时目标文件被改动: %q", got)
	}
}

// TestOrchestratorUnwiredAuditRejects 验证未装配审计出口时同样拒绝（不静默放行）。
func TestOrchestratorUnwiredAuditRejects(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return nil }
	orch := &updateOrchestrator{updater: u, audit: nil}

	_, err := orch.OrchestrateUpgrade(context.Background(), httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: true,
	})
	if !errors.Is(err, httpapi.ErrUpgradeAudit) {
		t.Fatalf("未装配审计出口应回 ErrUpgradeAudit，实际 %v", err)
	}
}

// TestOrchestratorRequiresConfirm 验证缺省 confirm 被拒（与 M1 高危二次确认一致）。
func TestOrchestratorRequiresConfirm(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	audit := &orchAuditRecorder{}
	orch := &updateOrchestrator{updater: u, audit: audit}

	_, err := orch.OrchestrateUpgrade(context.Background(), httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: false,
	})
	if !errors.Is(err, orchestrationErrNoConfirm) || !strings.Contains(err.Error(), "confirm=true") {
		t.Fatalf("缺 confirm 应拒绝并给出可操作提示，实际 %v", err)
	}
	if len(audit.snapshot()) != 0 {
		t.Fatal("缺 confirm 不应写审计")
	}
}

// TestOrchestrationErrorCodeSharesM1Sentinels 验证错误码映射复用 M1 哨兵（同一失败语义）。
func TestOrchestrationErrorCodeSharesM1Sentinels(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{httpapi.ErrUpgradeSource, "E_UPGRADE_SOURCE"},
		{httpapi.ErrUpgradeChecksum, "E_UPGRADE_CHECKSUM"},
		{httpapi.ErrUpgradeNeedRoot, "E_NEED_ROOT"},
		{httpapi.ErrUpgradeBusy, "E_UPGRADE_BUSY"},
		{httpapi.ErrUpgradeAudit, "E_UPGRADE_AUDIT"},
		{httpapi.ErrUpgradeRestart, "E_UPGRADE_RESTART"},
		{errors.New("x"), "E_INTERNAL"},
	}
	for _, c := range cases {
		if got := orchestrationErrorCode(c.err); got != c.want {
			t.Errorf("orchestrationErrorCode(%v)=%q，期望 %q", c.err, got, c.want)
		}
	}
}

// TestOrchestratorRollbackPhase 验证回滚终态 phase=rolled_back。
func TestOrchestratorRollbackPhase(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	sha := sha256Hex(newData)

	// 先经编排升级一次，产生 .prev。
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return nil }
	orch := &updateOrchestrator{updater: u, audit: &orchAuditRecorder{}}
	up, err := orch.OrchestrateUpgrade(context.Background(), httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha, Confirm: true,
	})
	if err != nil {
		t.Fatalf("升级失败: %v", err)
	}
	if final := waitOrchestrationPhase(t, orch, up.Job.ID); final.Phase != phaseCommitted {
		t.Fatalf("升级未 committed: %q", final.Phase)
	}

	// 回滚到 .prev（sha256 传新版本的摘要用于校验 .prev 不符时会拒绝；这里不传）。
	rb, err := orch.OrchestrateRollback(context.Background(), httpapi.SelfUpdateRollbackRequest{Confirm: true})
	if err != nil {
		t.Fatalf("回滚受理失败: %v", err)
	}
	final := waitOrchestrationPhase(t, orch, rb.Job.ID)
	if final.Phase != phaseRolledBack {
		t.Fatalf("回滚终态 phase=%q，期望 %q（reason=%s）", final.Phase, phaseRolledBack, final.Reason)
	}
}
