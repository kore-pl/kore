package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pengtang1024/kore/internal/core/httpapi"
	"github.com/pengtang1024/kore/internal/core/store"
)

// newUpgradeTestFixture 构造隔离的假安装根：旧二进制 + 新二进制 + 独立状态目录。
func newUpgradeTestFixture(t *testing.T) (dir, oldBin, newBin, stateDir string) {
	t.Helper()
	dir = t.TempDir()
	oldBin = filepath.Join(dir, "kored")
	newBin = filepath.Join(dir, "kored-new")
	stateDir = filepath.Join(dir, "state")
	if err := os.WriteFile(oldBin, []byte("old-binary"), 0o755); err != nil {
		t.Fatalf("写旧二进制失败: %v", err)
	}
	if err := os.WriteFile(newBin, []byte("new-binary"), 0o755); err != nil {
		t.Fatalf("写新二进制失败: %v", err)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("建状态目录失败: %v", err)
	}
	return dir, oldBin, newBin, stateDir
}

// newUpgradeTestUpdater 构造注入假 deps 的 selfUpdater（不重启真实 unit）。
func newUpgradeTestUpdater(oldBin, stateDir string, restart func(string) error) *selfUpdater {
	return &selfUpdater{
		version: "0.1.0-test",
		deps: upgradeDeps{
			euid:       func() int { return 0 },
			executable: func() (string, error) { return oldBin, nil },
			sha256File: fileSHA256,
			restart:    restart,
			stateDir:   func(string) (string, error) { return stateDir, nil },
			now:        time.Now,
		},
		stateFallback: stateDir,
		now:           time.Now,
		jobs:          make(map[string]*httpapi.SelfUpdateJob),
	}
}

// waitUpgradeJob 轮询到任务结束（测试用有界等待，不引入生产轮询）。
func waitUpgradeJob(t *testing.T, u *selfUpdater, id string) httpapi.SelfUpdateJob {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		job, ok := u.UpgradeJob(id)
		if ok && (job.State == "success" || job.State == "failed") {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("任务 %s 未在 3s 内结束", id)
	return httpapi.SelfUpdateJob{}
}

// TestSelfUpdaterApplyChain 是面板触发链路的装配层实测：
// 预检 sha256 → 原子替换 → 保留 .prev → pending 标记 → 提交重启 + 起止审计。
func TestSelfUpdaterApplyChain(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, err := os.ReadFile(newBin)
	if err != nil {
		t.Fatalf("读新二进制失败: %v", err)
	}
	var audits []store.AuditRecord
	var restarted string
	u := newUpgradeTestUpdater(oldBin, stateDir, func(unit string) error {
		restarted = unit
		return nil
	})
	u.audit = func(rec store.AuditRecord) error { audits = append(audits, rec); return nil }

	job, err := u.StartUpgrade(context.Background(), "admin", httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: true,
	})
	if err != nil {
		t.Fatalf("StartUpgrade 失败: %v", err)
	}
	final := waitUpgradeJob(t, u, job.ID)
	if final.State != "success" || final.ExitCode != 0 {
		t.Fatalf("任务未成功: %+v", final)
	}
	if restarted != upgradeDefaultUnit {
		t.Fatalf("未提交重启 unit=%q", restarted)
	}
	got, err := os.ReadFile(oldBin)
	if err != nil || string(got) != "new-binary" {
		t.Fatalf("目标二进制未替换: %q err=%v", got, err)
	}
	prev, err := os.ReadFile(oldBin + upgradePrevSuffix)
	if err != nil || string(prev) != "old-binary" {
		t.Fatalf(".prev 未保留旧二进制: %q err=%v", prev, err)
	}
	marker, err := readUpgradeResult(upgradeResultPath(stateDir))
	if err != nil {
		t.Fatalf("pending 标记未落盘: %v", err)
	}
	if marker.State != upgradeStatePending || marker.ExpectedSHA256 != sha256Hex(newData) || marker.PreviousSHA256 != sha256Hex([]byte("old-binary")) {
		t.Fatalf("pending 标记字段不符: %+v", marker)
	}
	if len(audits) != 2 || audits[0].Action != upgradeAuditStart || audits[1].Action != upgradeAuditResult {
		t.Fatalf("审计应含发起+结果两条: %+v", audits)
	}
	if audits[0].Detail["to_sha256"] != sha256Hex(newData) || audits[0].Target != oldBin {
		t.Fatalf("发起审计缺少 from/to sha 或目标: %+v", audits[0])
	}
}

// TestSelfUpdaterResultAuditPrecedesCompletion 固化顺序契约：任务终态可见时，
// 结果审计必须已经写过（不依赖 -race 的时序巧合，纯断言即可判定）。
//
// 为什么这是硬契约而不是实现细节：升级链以 `systemctl --no-block` 提交重启
// （upgrade.go 的 submitUpgradeRestart），完成状态一旦可见，本进程随时可能被
// SIGTERM；晚于完成状态写的结果审计会永久丢失，升级审计链就断在"已成功"那一刻。
func TestSelfUpdaterResultAuditPrecedesCompletion(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)

	var mu sync.Mutex
	auditCount := 0
	resultAuditSawTerminal := false
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(rec store.AuditRecord) error {
		mu.Lock()
		defer mu.Unlock()
		auditCount++
		if rec.Action != upgradeAuditResult {
			return nil
		}
		// 写结果审计的当口，任务必须仍是 running（尚未发布终态）。
		if job, ok := u.UpgradeJob(rec.Detail["job_id"]); ok && job.State != upgradeJobRunning {
			resultAuditSawTerminal = true
		}
		return nil
	}

	job, err := u.StartUpgrade(context.Background(), "admin", httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: true,
	})
	if err != nil {
		t.Fatalf("StartUpgrade 失败: %v", err)
	}
	if final := waitUpgradeJob(t, u, job.ID); final.State != upgradeJobSuccess {
		t.Fatalf("任务未成功: %+v", final)
	}

	mu.Lock()
	defer mu.Unlock()
	if resultAuditSawTerminal {
		t.Fatalf("结果审计晚于完成状态发布：完成状态可见后进程可能被重启，审计记录会永久丢失")
	}
	if auditCount != 2 {
		t.Fatalf("审计应含发起+结果两条，实际 %d 条", auditCount)
	}
}

// TestSelfUpdaterAuditFailClosed 校验审计写不进去时升级不开始、二进制零改动。
func TestSelfUpdaterAuditFailClosed(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return errors.New("audit bucket unavailable") }

	_, err := u.StartUpgrade(context.Background(), "admin", httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: true,
	})
	if !errors.Is(err, httpapi.ErrUpgradeAudit) {
		t.Fatalf("期望 ErrUpgradeAudit，实际: %v", err)
	}
	if got, _ := os.ReadFile(oldBin); string(got) != "old-binary" {
		t.Fatalf("审计失败时不应替换二进制: %q", got)
	}
}

// TestSelfUpdaterChecksumRejected 校验 sha256 不符时目标文件零改动。
func TestSelfUpdaterChecksumRejected(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return nil }

	_, err := u.StartUpgrade(context.Background(), "admin", httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex([]byte("other")), Confirm: true,
	})
	if !errors.Is(err, httpapi.ErrUpgradeChecksum) {
		t.Fatalf("期望 ErrUpgradeChecksum，实际: %v", err)
	}
	if got, _ := os.ReadFile(oldBin); string(got) != "old-binary" {
		t.Fatalf("校验失败时不应替换二进制: %q", got)
	}
}

// TestSelfUpdaterRejectsURLSource 校验 URL 来源在预检即被拒绝。
func TestSelfUpdaterRejectsURLSource(t *testing.T) {
	_, oldBin, _, stateDir := newUpgradeTestFixture(t)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return nil }
	_, err := u.StartUpgrade(context.Background(), "admin", httpapi.SelfUpdateRequest{
		SourcePath: "https://example.com/kored", SHA256: sha256Hex([]byte("x")), Confirm: true,
	})
	if !errors.Is(err, httpapi.ErrUpgradeSource) {
		t.Fatalf("期望 ErrUpgradeSource，实际: %v", err)
	}
}

// TestSelfUpdaterStatus 校验状态端点能读到当前/回滚/.prev 标记。
func TestSelfUpdaterStatus(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return nil }
	job, err := u.StartUpgrade(context.Background(), "admin", httpapi.SelfUpdateRequest{
		SourcePath: newBin, SHA256: sha256Hex(newData), Confirm: true,
	})
	if err != nil {
		t.Fatalf("StartUpgrade 失败: %v", err)
	}
	if final := waitUpgradeJob(t, u, job.ID); final.State != "success" {
		t.Fatalf("任务未成功: %+v", final)
	}
	status, err := u.UpgradeStatus(context.Background())
	if err != nil {
		t.Fatalf("UpgradeStatus 失败: %v", err)
	}
	if !status.CanUpgrade || !status.CanRollback || status.Previous == nil {
		t.Fatalf("状态不完整: %+v", status)
	}
	if status.Marker == nil || status.Marker.State != upgradeStatePending {
		t.Fatalf("应读到 pending 标记: %+v", status.Marker)
	}
}

// upgradeHTTPBackend 把 selfUpdater 暴露成 httpapi.Backend（其余方法空实现），
// 让 cmd 测试能走**真实 HTTP 路由 + 真实 selfUpdater**，而不是只测两段。
type upgradeHTTPBackend struct{ *selfUpdater }

func (upgradeHTTPBackend) Plugins(context.Context) ([]httpapi.PluginStatus, error) { return nil, nil }
func (upgradeHTTPBackend) Plugin(context.Context, string) (httpapi.PluginStatus, bool, error) {
	return httpapi.PluginStatus{}, false, nil
}
func (upgradeHTTPBackend) Enable(context.Context, string) error  { return nil }
func (upgradeHTTPBackend) Disable(context.Context, string) error { return nil }
func (upgradeHTTPBackend) Invoke(context.Context, string, string, json.RawMessage, string) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}
func (upgradeHTTPBackend) Stats(context.Context) (httpapi.SupervisorStats, error) {
	return httpapi.SupervisorStats{}, nil
}

// TestUpgradeViaHTTPAppliesAndVerifies 复现验收链路：
// 面板（HTTP POST）→ sha256 校验 → 原子替换 → pending 标记 →（--verify 语义）success。
// 沙箱非 root，不触达真实 systemd：restart 注入假实现，真重启由隔离实例的外部命令替代。
func TestUpgradeViaHTTPAppliesAndVerifies(t *testing.T) {
	_, oldBin, newBin, stateDir := newUpgradeTestFixture(t)
	newData, _ := os.ReadFile(newBin)
	u := newUpgradeTestUpdater(oldBin, stateDir, func(string) error { return nil })
	u.audit = func(store.AuditRecord) error { return nil }
	server := httpapi.New(httpapi.Options{Version: "0.1.0-test", Backend: upgradeHTTPBackend{u}}, nil)

	body := `{"source_path":"` + newBin + `","sha256":"` + sha256Hex(newData) + `","confirm":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/system/upgrade", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("HTTP 发起状态码 = %d，期望 202: %s", rec.Code, rec.Body.String())
	}
	var job httpapi.SelfUpdateJob
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil || job.ID == "" {
		t.Fatalf("响应缺少 job: %v %s", err, rec.Body.String())
	}
	if final := waitUpgradeJob(t, u, job.ID); final.State != "success" {
		t.Fatalf("任务未成功: %+v", final)
	}
	if got, _ := os.ReadFile(oldBin); string(got) != "new-binary" {
		t.Fatalf("HTTP 触发后二进制未替换: %q", got)
	}
	marker, err := readUpgradeResult(upgradeResultPath(stateDir))
	if err != nil || marker.State != upgradeStatePending {
		t.Fatalf("pending 标记未落盘: %+v err=%v", marker, err)
	}
	// 真重启在沙箱不可执行：用 `kored upgrade --verify` 语义闭环标记。
	if code := runUpgradeVerify(oldBin, upgradeOptions{stateDir: stateDir}, io.Discard, io.Discard, u.deps); code != exitOK {
		t.Fatalf("--verify 退出码 = %d，期望 0", code)
	}
	if marker, err = readUpgradeResult(upgradeResultPath(stateDir)); err != nil || marker.State != upgradeStateSuccess {
		t.Fatalf("verify 后标记应为 success: %+v err=%v", marker, err)
	}
}
