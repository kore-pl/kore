package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 测试用检查器：记录是否被调用、返回什么结果/错误。
type recordingChecker struct {
	calls  int
	source string
	result UpdateCheckResult
	err    error
}

func (c *recordingChecker) check(_ context.Context, source string) (UpdateCheckResult, error) {
	c.calls++
	c.source = source
	return c.result, c.err
}

// configureUpdateCheck 直接注入启用配置，复用 newTestService 的隔离状态库。
func configureUpdateCheck(s *Service, enabled bool, source string, checker UpdateIndexCheck, offline func() bool) {
	s.updateEnabled = enabled
	s.updateSource = source
	s.updateInterval = 6 * time.Hour
	s.updateChecker = checker
	s.isOffline = offline
}

// TestUpdateCheckDefaultDisabled 验收：默认（enabled=false / source 空 / checker nil）
// Start 不注册任务、不起 ticker——空闲行为与 M4 之前完全一致（U4 默认关闭）。
func TestUpdateCheckDefaultDisabled(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("默认 Start 失败: %v", err)
	}
	if _, err := service.loadTask(builtinUpdateCheckID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("默认不应注册更新检查任务，err=%v", err)
	}
	// 注意：logs-maintain 默认启用，ticker 本来就会起；这里只断言更新任务不存在，
	// 不把"ticker 是否存在"当判据（G-19 单 ticker 由其它门禁守护）。
	tasks, err := service.List(context.Background())
	if err != nil {
		t.Fatalf("读取任务失败: %v", err)
	}
	for _, task := range tasks {
		if task.Method == UpdateCheckMethod {
			t.Fatalf("默认配置不应出现 %s 任务: %+v", UpdateCheckMethod, task)
		}
	}
}

// TestUpdateCheckOfflineShortCircuit 验收：IsOffline=true 时任务短路，
// 检查器零调用（=零出站）、无错误、状态 offline_skipped。
func TestUpdateCheckOfflineShortCircuit(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	checker := &recordingChecker{result: UpdateCheckResult{Status: UpdateCheckChecked, Count: 3}}
	configureUpdateCheck(service, true, "https://updates.example.com/index", checker.check,
		func() bool { return true })
	if err := service.syncUpdateCheckTask(); err != nil {
		t.Fatalf("注册更新检查任务失败: %v", err)
	}
	task, err := service.loadTask(builtinUpdateCheckID)
	if err != nil || !task.Enabled || task.Method != UpdateCheckMethod {
		t.Fatalf("启用后任务不符合预期: task=%+v err=%v", task, err)
	}
	run := service.execute(context.Background(), task)
	if run.Status != StatusOK {
		t.Fatalf("离线短路不得报错，status=%s err=%s", run.Status, run.Error)
	}
	if checker.calls != 0 {
		t.Fatalf("离线时检查器（出站）不得被调用，实际 %d 次", checker.calls)
	}
	runs, err := service.loadRuns()
	if err != nil {
		t.Fatalf("读取执行记录失败: %v", err)
	}
	found := false
	for _, r := range runs {
		if r.TaskID == builtinUpdateCheckID {
			found = true
		}
	}
	if !found {
		t.Fatal("离线短路应写一条成功执行记录")
	}
	// 直接调用执行体核对结构化结果（Run 只存状态，结果从调用返回读）。
	out, err := service.runUpdateCheck(context.Background(), task)
	if err != nil {
		t.Fatalf("离线短路不应返回错误: %v", err)
	}
	var result UpdateCheckResult
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("解析离线结果失败: %v", err)
	}
	if result.Status != UpdateCheckOfflineSkipped || result.Count != 0 {
		t.Fatalf("离线结果不符合预期: %+v", result)
	}
}

// TestUpdateCheckOnlineResult 验收：在线时调用注入检查器，源地址透传，结果结构化。
func TestUpdateCheckOnlineResult(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	checker := &recordingChecker{result: UpdateCheckResult{Status: UpdateCheckChecked, Count: 2, Source: "s"}}
	configureUpdateCheck(service, true, "https://updates.example.com/index", checker.check,
		func() bool { return false })
	if err := service.syncUpdateCheckTask(); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	task, _ := service.loadTask(builtinUpdateCheckID)
	run := service.execute(context.Background(), task)
	if run.Status != StatusOK {
		t.Fatalf("在线检查应成功，status=%s err=%s", run.Status, run.Error)
	}
	if checker.calls != 1 || checker.source != "https://updates.example.com/index" {
		t.Fatalf("在线检查应调用一次且透传源地址，calls=%d source=%q", checker.calls, checker.source)
	}
}

// TestUpdateCheckSignatureFailureRequiresRestart 验收：验签失败（E_UNAUTHORIZED）
// 的错误 detail 含 requires_restart:true，任务记 failed 且本次不更新（检查器无成功结果）。
func TestUpdateCheckSignatureFailureRequiresRestart(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	checker := &recordingChecker{err: &pluginapi.Error{
		Code: pluginapi.E_UNAUTHORIZED, Message: "索引签名校验失败",
		Detail: json.RawMessage(`{"requires_restart":true,"hint":"重启 kored 重新载入公钥"}`),
	}}
	configureUpdateCheck(service, true, "https://updates.example.com/index", checker.check,
		func() bool { return false })
	if err := service.syncUpdateCheckTask(); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	task, _ := service.loadTask(builtinUpdateCheckID)
	run := service.execute(context.Background(), task)
	if run.Status != StatusFailed {
		t.Fatalf("验签失败应记 failed，实际 status=%s", run.Status)
	}
	if !strings.Contains(run.Error, `"requires_restart":true`) {
		t.Fatalf("验签失败错误 detail 缺 requires_restart:true: %s", run.Error)
	}
	// 未带 detail 的 E_UNAUTHORIZED 也要补齐提示（防止上游漏写 detail）。
	err := mapUpdateCheckError(&pluginapi.Error{Code: pluginapi.E_UNAUTHORIZED, Message: "签名不符"})
	if err == nil || !strings.Contains(err.Error(), `"requires_restart":true`) {
		t.Fatalf("缺 detail 的签名错误也应补 requires_restart: %v", err)
	}
	// 非签名错误不得误导用户重启。
	other := errors.New("磁盘读取失败")
	if got := mapUpdateCheckError(other); !errors.Is(got, other) {
		t.Fatalf("非签名错误不应改写: %v", got)
	}
}

// TestUpdateCheckMissingCheckerFailClosed 验收：启用但检查器未装配/源空时
// 拒绝注册；已有任务被冒用时拒绝执行（不假装成功、不隐式为他人开出站）。
func TestUpdateCheckMissingCheckerFailClosed(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	configureUpdateCheck(service, true, "https://updates.example.com/index", nil,
		func() bool { return false })
	if err := service.syncUpdateCheckTask(); err == nil {
		t.Fatal("检查器未装配时启用应 fail-closed")
	}
	service.updateChecker = func(context.Context, string) (UpdateCheckResult, error) {
		return UpdateCheckResult{Status: UpdateCheckChecked}, nil
	}
	service.updateSource = "  "
	if err := service.syncUpdateCheckTask(); err == nil {
		t.Fatal("源为空时启用应 fail-closed")
	}
	// 用户任务冒用内置 method 必须拒绝。
	_, err := service.runUpdateCheck(context.Background(), Task{ID: "tsk-1", Method: UpdateCheckMethod})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("冒用内置 method 应拒绝: %v", err)
	}
}

// TestUpdateCheckOfflineNilFailClosed 验收：IsOffline 未注入视为离线（默认零出站）。
func TestUpdateCheckOfflineNilFailClosed(t *testing.T) {
	service, _ := newTestService(t, &fakeInvoker{})
	checker := &recordingChecker{result: UpdateCheckResult{Status: UpdateCheckChecked}}
	configureUpdateCheck(service, true, "https://updates.example.com/index", checker.check, nil)
	if err := service.syncUpdateCheckTask(); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	task, _ := service.loadTask(builtinUpdateCheckID)
	run := service.execute(context.Background(), task)
	if run.Status != StatusOK || checker.calls != 0 {
		t.Fatalf("未注入 IsOffline 应离线短路，status=%s calls=%d", run.Status, checker.calls)
	}
}
