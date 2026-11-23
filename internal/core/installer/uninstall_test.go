package installer_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/pengtang1024/kore/internal/core/installer"
	"github.com/pengtang1024/kore/internal/core/store"
)

// uninstallEnv 是卸载测试的隔离环境：真实状态库 + 可控 Stop/Audit 注入点。
type uninstallEnv struct {
	inst     *installer.Installer
	st       *store.Store
	stateDir string
	pluginID string
	// events 记录调用顺序（stop / audit），用于断言"先停后删"与"审计在删除前"。
	events []string
}

// newUninstallEnv 构造卸载环境；auditErr 非 nil 时注入一个必然失败的审计。
func newUninstallEnv(t *testing.T, auditErr error) *uninstallEnv {
	t.Helper()
	stateDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	st, err := store.Open(stateDir, logger)
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	env := &uninstallEnv{st: st, stateDir: stateDir, pluginID: "echo"}
	// 落一条安装记录 + 插件目录，模拟"已安装"。
	if err := st.Update(func(tx *store.Tx) error {
		if err := tx.Put("plugins", "echo", []byte(`{"id":"echo","version":"0.1.0"}`)); err != nil {
			return err
		}
		return tx.Put("plugin_state", "echo", []byte(`{"desired":"enabled","actual":"ready"}`))
	}); err != nil {
		t.Fatalf("写入安装记录失败: %v", err)
	}
	dir := filepath.Join(env.pluginRoot(), "echo", "0.1.0")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建立插件目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "echo"), []byte("bin"), 0o755); err != nil {
		t.Fatalf("写入插件文件失败: %v", err)
	}
	env.inst, err = installer.New(installer.Options{
		StateDir: stateDir, KoreVersion: "0.1.0", Logger: logger, Store: st,
		Stop: func(_ context.Context, id string) error {
			// 停止时目录必须还在：证明"先停后删"。
			if _, statErr := os.Stat(filepath.Join(env.pluginRoot(), id)); statErr != nil {
				t.Errorf("Stop 时插件目录已不存在：%v", statErr)
			}
			env.events = append(env.events, "stop")
			return nil
		},
		Audit: func(_ context.Context, rec store.AuditRecord) error {
			// 审计写入时插件数据必须尚未被销毁：要么还在原位，要么在可还原的隔离目录里。
			// （实现先把目录原子改名到隔离区、审计成功后才 RemoveAll，因此这里两种都算正常。）
			if !env.dataPreserved(rec.Plugin) {
				t.Errorf("审计时插件数据已被销毁，违反 fail-closed 不留半删态")
			}
			env.events = append(env.events, "audit:"+rec.Action)
			return auditErr
		},
	})
	if err != nil {
		t.Fatalf("构造安装器失败: %v", err)
	}
	return env
}

// dataPreserved 判断插件数据是"还在原位"或"在隔离目录里"。
func (e *uninstallEnv) dataPreserved(id string) bool {
	if _, err := os.Stat(filepath.Join(e.pluginRoot(), id)); err == nil {
		return true
	}
	matches, err := filepath.Glob(filepath.Join(e.pluginRoot(), id+".uninstalling-*"))
	return err == nil && len(matches) > 0
}

// pluginRoot 返回插件根目录。
func (e *uninstallEnv) pluginRoot() string { return filepath.Join(e.stateDir, "plugins") }

// recordExists 判断某 bucket 里是否还有该 id 的记录。
func (e *uninstallEnv) recordExists(t *testing.T, bucket, id string) bool {
	t.Helper()
	var found bool
	if err := e.st.View(func(tx *store.Tx) error {
		_, getErr := tx.Get(bucket, id)
		if getErr == nil {
			found = true
			return nil
		}
		return getErr
	}); err != nil && !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("读取 %s/%s 失败: %v", bucket, id, err)
	}
	return found
}

// TestUninstallHappyPath 验证正常卸载：目录消失、两条记录消失、审计有记录。
func TestUninstallHappyPath(t *testing.T) {
	env := newUninstallEnv(t, nil)
	result, err := env.inst.Uninstall(context.Background(), env.pluginID)
	if err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	if result.AlreadyAbsent || !result.Stopped {
		t.Fatalf("结果 = %+v，期望 already_absent=false stopped=true", result)
	}
	if _, statErr := os.Stat(filepath.Join(env.pluginRoot(), env.pluginID)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("插件目录应已删除，Stat=%v", statErr)
	}
	if env.recordExists(t, "plugins", env.pluginID) {
		t.Fatal("plugins 记录应已删除")
	}
	if env.recordExists(t, "plugin_state", env.pluginID) {
		t.Fatal("plugin_state 记录应已删除")
	}
	if len(env.events) != 2 || env.events[0] != "stop" || env.events[1] != "audit:plugin.uninstall" {
		t.Fatalf("调用顺序 = %v，期望 [stop audit:plugin.uninstall]", env.events)
	}
}

// TestUninstallRunningOrder 验证运行中卸载先优雅停止再删（Stop 在 Audit 之前）。
func TestUninstallRunningOrder(t *testing.T) {
	env := newUninstallEnv(t, nil)
	if _, err := env.inst.Uninstall(context.Background(), env.pluginID); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	var sawStop, sawAudit bool
	for i, ev := range env.events {
		switch {
		case ev == "stop":
			sawStop = true
			if i != 0 {
				t.Fatalf("停进程应在第一步，实际顺序 %v", env.events)
			}
		case ev == "audit:plugin.uninstall":
			sawAudit = true
		}
	}
	if !sawStop || !sawAudit {
		t.Fatalf("事件 = %v，期望包含 stop 与 audit", env.events)
	}
}

// TestUninstallRejectsPathTraversal 验证 id 校验挡住路径穿越，且零变更。
func TestUninstallRejectsPathTraversal(t *testing.T) {
	env := newUninstallEnv(t, nil)
	for _, id := range []string{
		"../../etc", "foo/bar", `foo\bar`, "..", ".", "", "Echo", "echo/../etc", "echo.0",
	} {
		_, err := env.inst.Uninstall(context.Background(), id)
		if !errors.Is(err, installer.ErrInvalid) {
			t.Fatalf("id %q 期望 ErrInvalid，实际 %v", id, err)
		}
	}
	if len(env.events) != 0 {
		t.Fatalf("非法 id 不应触发任何停进程/审计，实际 %v", env.events)
	}
	if !env.recordExists(t, "plugins", env.pluginID) {
		t.Fatal("非法 id 调用不应影响已装插件记录")
	}
}

// TestUninstallAbsentIsIdempotent 验证未安装 id 幂等返回 AlreadyAbsent。
func TestUninstallAbsentIsIdempotent(t *testing.T) {
	env := newUninstallEnv(t, nil)
	if _, err := env.inst.Uninstall(context.Background(), env.pluginID); err != nil {
		t.Fatalf("首次卸载失败: %v", err)
	}
	result, err := env.inst.Uninstall(context.Background(), env.pluginID)
	if err != nil {
		t.Fatalf("重复卸载应幂等成功，实际 %v", err)
	}
	if !result.AlreadyAbsent {
		t.Fatalf("重复卸载结果 = %+v，期望 already_absent=true", result)
	}
}

// TestUninstallAuditFailureRollsBack 验证审计失败时整体还原，不留半删状态。
func TestUninstallAuditFailureRollsBack(t *testing.T) {
	boom := errors.New("audit db down")
	env := newUninstallEnv(t, boom)
	_, err := env.inst.Uninstall(context.Background(), env.pluginID)
	if !errors.Is(err, installer.ErrAudit) {
		t.Fatalf("期望 ErrAudit，实际 %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(env.pluginRoot(), env.pluginID, "0.1.0", "echo")); statErr != nil {
		t.Fatalf("审计失败后插件目录应完整还原：%v", statErr)
	}
	if !env.recordExists(t, "plugins", env.pluginID) {
		t.Fatal("审计失败后 plugins 记录应已还原")
	}
	if !env.recordExists(t, "plugin_state", env.pluginID) {
		t.Fatal("审计失败后 plugin_state 记录应已还原")
	}
	if _, statErr := os.Stat(filepath.Join(env.pluginRoot(), env.pluginID, "0.1.0", "echo")); statErr != nil {
		t.Fatalf("文件应完整还原：%v", statErr)
	}
}

// TestUninstallStopFailureLeavesIntact 验证停进程失败时目录与记录都不动。
func TestUninstallStopFailureLeavesIntact(t *testing.T) {
	stateDir := t.TempDir()
	st, err := store.Open(stateDir, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err != nil {
		t.Fatalf("打开状态库失败: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Update(func(tx *store.Tx) error {
		return tx.Put("plugins", "echo", []byte(`{"id":"echo"}`))
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "plugins", "echo"), 0o755); err != nil {
		t.Fatalf("建立目录失败: %v", err)
	}
	inst, err := installer.New(installer.Options{
		StateDir: stateDir, KoreVersion: "0.1.0",
		Logger: slog.New(slog.NewTextHandler(os.Stderr, nil)), Store: st,
		Stop: func(context.Context, string) error { return errors.New("grace 超时且 SIGKILL 失败") },
	})
	if err != nil {
		t.Fatalf("构造安装器失败: %v", err)
	}
	if _, err := inst.Uninstall(context.Background(), "echo"); !errors.Is(err, installer.ErrStop) {
		t.Fatalf("期望 ErrStop，实际 %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(stateDir, "plugins", "echo")); statErr != nil {
		t.Fatalf("停进程失败后目录应原样保留：%v", statErr)
	}
	var found bool
	if err := st.View(func(tx *store.Tx) error {
		_, getErr := tx.Get("plugins", "echo")
		found = getErr == nil
		if getErr != nil {
			return getErr
		}
		return nil
	}); err != nil {
		t.Fatalf("读取记录失败: %v", err)
	}
	if !found {
		t.Fatal("停进程失败后记录应原样保留")
	}
}
