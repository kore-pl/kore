package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	coreconfig "github.com/pengtang1024/kore/internal/core/config"
	"github.com/pengtang1024/kore/internal/core/store"
)

// TestReportInstallErrorLockedHint 验证占用错误保留原始 pid 且追加可操作命令（P0-3）。
func TestReportInstallErrorLockedHint(t *testing.T) {
	err := &store.LockedError{Path: "/tmp/x/data/state.db", PID: 4242}
	var buf bytes.Buffer
	reportInstallError(&buf, err)
	text := buf.String()
	for _, want := range []string{
		"持有者 pid=4242",         // 原始错误原样保留，便于排查
		"/tmp/x/data/state.db", // 路径也要在
		"systemctl --user stop kored-local",
		"sudo systemctl stop kore",
		"商店页面安装",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("占用错误提示缺少 %q：\n%s", want, text)
		}
	}
}

// TestReportInstallErrorNonLockedNoHint 验证非占用错误不刷服务提示（避免误导）。
func TestReportInstallErrorNonLockedNoHint(t *testing.T) {
	var buf bytes.Buffer
	reportInstallError(&buf, store.ErrCorrupt)
	text := buf.String()
	if !strings.Contains(text, "安装失败") {
		t.Fatalf("应打印原始错误：%s", text)
	}
	if strings.Contains(text, "systemctl") {
		t.Fatalf("非锁错误不应出现停服务提示：\n%s", text)
	}
}

// TestInstallLockedStateExitsThreeWithHint 端到端验证 install 撞锁：退出码 3 + 停服务指引。
//
// 锁由进程内第二次 store.Open 制造（bbolt 的 flock 按 open file description 冲突），
// ValidatePackage 只校验文件名与常规文件，因此这里用空文件即可走到 open 状态库这一步。
func TestInstallLockedStateExitsThreeWithHint(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "data")
	holder, err := store.Open(stateDir, nil)
	if err != nil {
		t.Fatalf("先占住状态库失败: %v", err)
	}
	defer func() { _ = holder.Close() }()

	pkg := filepath.Join(t.TempDir(), "site-0.1.0.tar.gz")
	if err := os.WriteFile(pkg, []byte("not-a-real-package"), 0o600); err != nil {
		t.Fatalf("写假包失败: %v", err)
	}
	cfg := writeCLIConfig(t, filepath.Join(root, "cfg"), stateDir, "127.0.0.1:1")
	var out, errOut bytes.Buffer
	code := runPackageInstall(installOptions{config: cfg, packagePath: pkg}, &out, &errOut)
	if code != exitState {
		t.Fatalf("撞锁退出码 = %d，期望 %d；stderr=%s", code, exitState, errOut.String())
	}
	text := errOut.String()
	if !strings.Contains(text, "持有者 pid=") {
		t.Fatalf("应保留原始 pid：%s", text)
	}
	if !strings.Contains(text, "systemctl --user stop kored-local") || !strings.Contains(text, "sudo systemctl stop kore") {
		t.Fatalf("应给出停服务命令：%s", text)
	}
	if !strings.Contains(text, "商店页面安装") {
		t.Fatalf("应说明商店页面安装无需停服务：%s", text)
	}
}

// writeCLIConfig 在临时目录写一份最小配置，显式钉住 state_dir。
func writeCLIConfig(t *testing.T, dir, stateDir, addr string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("建配置目录失败: %v", err)
	}
	body := "server:\n  addr: " + addr + "\npaths:\n  state_dir: " + stateDir + "\n"
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}
	return path
}

// TestInstallFailClosedWithoutConfig 验证 task-198 a)：配置文件不存在且没给 --config → 非 0 退出。
func TestInstallFailClosedWithoutConfig(t *testing.T) {
	pkg := filepath.Join(t.TempDir(), "site-0.1.0.tar.gz")
	if err := os.WriteFile(pkg, []byte("x"), 0o600); err != nil {
		t.Fatalf("写假包失败: %v", err)
	}
	// KORE_HOME 指到空目录：默认配置路径 <install>/config/config.yaml 必然不存在。
	t.Setenv(coreconfig.EnvConfigPath, "")
	t.Setenv(coreconfig.EnvHome, t.TempDir())
	var out, errOut bytes.Buffer
	code := runPackageInstall(installOptions{packagePath: pkg}, &out, &errOut)
	if code == exitOK {
		t.Fatalf("缺配置必须非 0 退出，实际 0；stdout=%s", out.String())
	}
	text := errOut.String()
	if !strings.Contains(text, "未找到配置文件") || !strings.Contains(text, "kored status") {
		t.Fatalf("fail-closed 文案不合格：\n%s", text)
	}
	if !strings.Contains(text, "同一个 --config") {
		t.Fatalf("应提示用与 serve 相同的 --config：\n%s", text)
	}
}

// TestInstallPrintsResolvedTargets 验证 b)：有配置时打印的路径是真实解析值（绝对路径）。
func TestInstallPrintsResolvedTargets(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "st")
	cfg := writeCLIConfig(t, filepath.Join(root, "cfg"), stateDir, "127.0.0.1:1")
	pkg := filepath.Join(root, "site-0.1.0.tar.gz")
	if err := os.WriteFile(pkg, []byte("x"), 0o600); err != nil {
		t.Fatalf("写假包失败: %v", err)
	}
	var out, errOut bytes.Buffer
	_ = runPackageInstall(installOptions{config: cfg, packagePath: pkg}, &out, &errOut)
	text := out.String()
	if !strings.Contains(text, "配置: "+cfg) || !strings.Contains(text, "状态目录: "+stateDir) {
		t.Fatalf("应打印对齐后的绝对路径：\n%s\nstderr=%s", text, errOut.String())
	}
}

// TestInstallTargetsDifferByConfig 验证 c)：不同 --config → 打印不同 state_dir（是读到的，不是猜的）。
func TestInstallTargetsDifferByConfig(t *testing.T) {
	root := t.TempDir()
	pkg := filepath.Join(root, "site-0.1.0.tar.gz")
	if err := os.WriteFile(pkg, []byte("x"), 0o600); err != nil {
		t.Fatalf("写假包失败: %v", err)
	}
	cfgA := writeCLIConfig(t, filepath.Join(root, "a"), filepath.Join(root, "a", "st"), "127.0.0.1:1")
	cfgB := writeCLIConfig(t, filepath.Join(root, "b"), filepath.Join(root, "b", "st"), "127.0.0.1:1")
	var outA, errA, outB, errB bytes.Buffer
	_ = runPackageInstall(installOptions{config: cfgA, packagePath: pkg}, &outA, &errA)
	_ = runPackageInstall(installOptions{config: cfgB, packagePath: pkg}, &outB, &errB)
	if outA.String() == outB.String() {
		t.Fatalf("两份配置应打印不同状态目录：\n%s\n---\n%s", outA.String(), outB.String())
	}
	if !strings.Contains(outA.String(), filepath.Join(root, "a", "st")) ||
		!strings.Contains(outB.String(), filepath.Join(root, "b", "st")) {
		t.Fatalf("打印路径与配置不符：\nA=%s\nB=%s", outA.String(), outB.String())
	}
}

// TestStatusNotRunning 验证 d)：实例未启动时给明确"未运行"，不是报错堆栈。
func TestStatusNotRunning(t *testing.T) {
	root := t.TempDir()
	cfg := writeCLIConfig(t, filepath.Join(root, "cfg"), filepath.Join(root, "st"), "127.0.0.1:1")
	var out, errOut bytes.Buffer
	code := runStatus([]string{"--config", cfg}, &out, &errOut)
	if code != exitOK {
		t.Fatalf("status 退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	text := out.String()
	for _, want := range []string{"配置: " + cfg, "状态目录: ", "profile: ", "实例: 未运行"} {
		if !strings.Contains(text, want) {
			t.Fatalf("status 输出缺少 %q：\n%s", want, text)
		}
	}
	if strings.Contains(errOut.String(), "panic") || strings.Contains(text, "goroutine") {
		t.Fatalf("不应有堆栈：%s", errOut.String())
	}
}

// TestRunScenarioInstallOfflineBatch 验证 --scenario 走离线批量（不再是 E_UNSUPPORTED 桩）：
// 先如实提示停服 / bbolt 独占锁，缺预设目录时 fail-closed（exitConfig）。
func TestRunScenarioInstallOfflineBatch(t *testing.T) {
	// 清空指向真实目录的环境变量，确保规划期 fail-closed，不碰运行态。
	t.Setenv(envScenarioPresetsDir, "")
	t.Setenv(envScenarioPackagesDir, "")
	var stdout, stderr bytes.Buffer
	code := runInstall([]string{"--scenario", "web"}, &stdout, &stderr)
	if code != exitConfig {
		t.Fatalf("缺预设目录应返回 exitConfig(2)，实际 %d", code)
	}
	text := stderr.String()
	for _, want := range []string{
		"需先停止 Kore 服务", // 停服提示（G-33 A3）
		"bbolt",
		"独占",
		"state.db",
		"未提供预设目录", // fail-closed 说明可执行的下一步
		"--presets-dir",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("--scenario 输出缺少 %q：\n%s", want, text)
		}
	}
	for _, stale := range []string{
		"E_UNSUPPORTED",
		"未实现（M2 支持批量预设安装）",
		"替代路径（当前可用）",
	} {
		if strings.Contains(text, stale) {
			t.Fatalf("--scenario 仍残留旧桩文案 %q：\n%s", stale, text)
		}
	}
}

// TestInstallUsageMarksScenarioOfflineBatch 验证帮助文案如实说明 --scenario 可用与停服限制。
func TestInstallUsageMarksScenarioOfflineBatch(t *testing.T) {
	var buf bytes.Buffer
	printInstallUsage(&buf)
	text := buf.String()
	for _, want := range []string{
		"--scenario <预设id>",
		"离线批量",
		"需先停服",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("帮助文案缺少 %q：\n%s", want, text)
		}
	}
	for _, stale := range []string{
		"（--scenario 未实现，M2）",
		"--scenario 场景预设批量安装：未实现（M2）",
		"E_UNSUPPORTED",
	} {
		if strings.Contains(text, stale) {
			t.Fatalf("帮助文案仍残留旧桩文案 %q：\n%s", stale, text)
		}
	}
}
