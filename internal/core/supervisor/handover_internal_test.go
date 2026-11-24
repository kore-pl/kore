package supervisor

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pengtang1024/kore/internal/platform"
)

// handoverTestAccess 记录 Own / Take / Traversable。
//
// Take 走真实 lchown（属主 = 当前进程身份，非 root 下也能成功）：这样「不改 mode」
// 与「不跟随符号链接」都是被真实系统调用验证过的，而不只是记账。
type handoverTestAccess struct {
	mu         sync.Mutex
	owned      []string
	taken      []string
	traversed  []string
	ownErrFor  map[string]error
	takeErrFor map[string]error
}

func (f *handoverTestAccess) Own(path string, acct platform.Account, mode os.FileMode) error {
	f.mu.Lock()
	f.owned = append(f.owned, path)
	err, has := f.ownErrFor[path]
	f.mu.Unlock()
	if has {
		return err
	}
	return os.Chmod(path, mode)
}

func (f *handoverTestAccess) Take(path string, acct platform.Account) error {
	f.mu.Lock()
	f.taken = append(f.taken, path)
	err, has := f.takeErrFor[path]
	f.mu.Unlock()
	if has {
		return err
	}
	return os.Lchown(path, acct.UID, acct.GID)
}

func (f *handoverTestAccess) Traversable(path string) error {
	f.mu.Lock()
	f.traversed = append(f.traversed, path)
	f.mu.Unlock()
	return nil
}

func (f *handoverTestAccess) snapshot() (owned, taken []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.owned...), append([]string(nil), f.taken...)
}

// newHandoverManager 造一个只用于属主移交的 Manager（logger 写进 buffer）。
func newHandoverManager(access platform.Access, buf *bytes.Buffer) *Manager {
	handler := slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	return &Manager{access: access, logger: slog.New(handler)}
}

// currentAccount 返回当前进程身份：非 root 测试只能把属主移交「给自己」。
func currentAccount() platform.Account {
	return platform.Account{Name: "kore-test", UID: os.Getuid(), GID: os.Getgid()}
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("创建目录 %s 失败: %v", dir, err)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	mustMkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写文件 %s 失败: %v", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil { // WriteFile 受 umask 影响，显式收口
		t.Fatalf("chmod %s 失败: %v", path, err)
	}
}

// buildStateDir 造一套真实形态的状态目录：版本目录 + 暂存 + current 链接 + 插件私有数据。
func buildStateDir(t *testing.T) (stateDir string, kernel []string, plugin []string) {
	t.Helper()
	stateDir = filepath.Join(t.TempDir(), "plugins", "site")

	version := filepath.Join(stateDir, "0.4.3")
	mustWrite(t, filepath.Join(version, "info.json"), `{"id":"site"}`)
	mustWrite(t, filepath.Join(version, "bin", "site"), "binary")
	stash := filepath.Join(stateDir, "0.4.3.bak-20261124T000000000")
	mustWrite(t, filepath.Join(stash, "info.json"), `{"id":"site"}`)
	if err := os.Symlink("0.4.3", filepath.Join(stateDir, "current")); err != nil {
		t.Fatalf("创建 current 链接失败: %v", err)
	}

	config := filepath.Join(stateDir, "config.json")
	mustWrite(t, config, `{"root":"sites"}`)
	mustWrite(t, filepath.Join(stateDir, "backups", "nightly.tar.gz"), "tar")
	mustWrite(t, filepath.Join(stateDir, "probe", "report.json"), "{}")

	return stateDir,
		[]string{version, filepath.Join(version, "info.json"), filepath.Join(version, "bin"),
			filepath.Join(version, "bin", "site"), stash, filepath.Join(stash, "info.json"),
			filepath.Join(stateDir, "current")},
		[]string{config, filepath.Join(stateDir, "backups"),
			filepath.Join(stateDir, "backups", "nightly.tar.gz"),
			filepath.Join(stateDir, "probe"), filepath.Join(stateDir, "probe", "report.json")}
}

// TestHandOverStateDirChownsPluginOwnedEntries 覆盖「插件自己的目录被 chown」：
// 顶层 + config.json + 插件自建子目录（含树内文件）全部移交。
func TestHandOverStateDirChownsPluginOwnedEntries(t *testing.T) {
	access := &handoverTestAccess{}
	m := newHandoverManager(access, &bytes.Buffer{})
	stateDir, _, pluginPaths := buildStateDir(t)

	if err := m.handOverStateDir(stateDir, currentAccount()); err != nil {
		t.Fatalf("handOverStateDir 失败: %v", err)
	}
	owned, taken := access.snapshot()
	if len(owned) != 1 || owned[0] != stateDir {
		t.Fatalf("状态目录本身必须移交且只移交一次：owned=%v", owned)
	}
	for _, want := range pluginPaths {
		if !containsPath(taken, want) {
			t.Fatalf("插件私有条目未被移交：%s（taken=%v）", want, taken)
		}
	}
}

// TestHandOverStateDirKeepsKernelInstallTree 是本次修复的**关键断言**：
// 内核安装树（版本目录、暂存目录、current 链接）绝不能被 chown 给插件。
//
// 若把实现改成「无脑递归全 chown」，本用例必然 FAIL——那等于把「替换自己二进制」
// 的能力交给插件用户。
func TestHandOverStateDirKeepsKernelInstallTree(t *testing.T) {
	access := &handoverTestAccess{}
	m := newHandoverManager(access, &bytes.Buffer{})
	stateDir, kernelPaths, _ := buildStateDir(t)

	if err := m.handOverStateDir(stateDir, currentAccount()); err != nil {
		t.Fatalf("handOverStateDir 失败: %v", err)
	}
	_, taken := access.snapshot()
	for _, banned := range kernelPaths {
		if containsPath(taken, banned) {
			t.Fatalf("内核安装树条目被交给了插件：%s（taken=%v）", banned, taken)
		}
	}
	// current 仍是链接、版本目录内容未被改动：不跟随链接才有这个结果。
	fi, err := os.Lstat(filepath.Join(stateDir, "current"))
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("current 必须是符号链接且未被替换：fi=%v err=%v", fi, err)
	}
	if target, err := os.Readlink(filepath.Join(stateDir, "current")); err != nil || target != "0.4.3" {
		t.Fatalf("current 指向被改动：target=%q err=%v", target, err)
	}
}

// TestHandOverStateDirKeepsFileMode 验证 Take 不改 mode：config.json 移交后仍是 0600
// （插件自己定的权限不被内核顺手放宽或收紧）。
func TestHandOverStateDirKeepsFileMode(t *testing.T) {
	access := &handoverTestAccess{}
	m := newHandoverManager(access, &bytes.Buffer{})
	stateDir, _, _ := buildStateDir(t)

	if err := m.handOverStateDir(stateDir, currentAccount()); err != nil {
		t.Fatalf("handOverStateDir 失败: %v", err)
	}
	info, err := os.Stat(filepath.Join(stateDir, "config.json"))
	if err != nil {
		t.Fatalf("Stat config.json 失败: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("config.json 权限 = %04o，期望 0600（Take 不替插件改 mode）", got)
	}
}

// TestHandOverTreeDoesNotFollowSymlink 覆盖「插件目录里的符号链接指向内核/宿主路径」：
// 只移交链接自身，链接目标与目标的子树一个都不碰。
func TestHandOverTreeDoesNotFollowSymlink(t *testing.T) {
	access := &handoverTestAccess{}
	m := newHandoverManager(access, &bytes.Buffer{})
	root := t.TempDir()

	kernelDir := filepath.Join(root, "kernel")
	kernelFile := filepath.Join(kernelDir, "state.db")
	mustWrite(t, kernelFile, "db")

	dataDir := filepath.Join(root, "plugin-data", "site")
	mustMkdir(t, dataDir)
	evil := filepath.Join(dataDir, "evil")
	if err := os.Symlink(kernelDir, evil); err != nil {
		t.Fatalf("创建符号链接失败: %v", err)
	}

	if err := m.handOverDataDir(dataDir, currentAccount()); err != nil {
		t.Fatalf("handOverDataDir 失败: %v", err)
	}
	_, taken := access.snapshot()
	if !containsPath(taken, evil) {
		t.Fatalf("链接自身应被移交（lchown）：taken=%v", taken)
	}
	for _, banned := range []string{kernelDir, kernelFile} {
		if containsPath(taken, banned) {
			t.Fatalf("符号链接被跟随，链接目标被移交：%s（taken=%v）", banned, taken)
		}
	}
	if _, err := os.Stat(kernelFile); err != nil {
		t.Fatalf("链接目标不应被改动: %v", err)
	}
}

// TestHandOverDataDirChownsWholeTree 覆盖「插件数据目录（含既有文件）被递归移交」：
// 上一轮以 root/运维身份跑出来的 www 根必须整棵交给插件用户。
func TestHandOverDataDirChownsWholeTree(t *testing.T) {
	access := &handoverTestAccess{}
	m := newHandoverManager(access, &bytes.Buffer{})
	dataDir := filepath.Join(t.TempDir(), "plugin-data", "site")
	mustWrite(t, filepath.Join(dataDir, "sites", "example.com", "index.html"), "<h1>hi</h1>")

	if err := m.handOverDataDir(dataDir, currentAccount()); err != nil {
		t.Fatalf("handOverDataDir 失败: %v", err)
	}
	_, taken := access.snapshot()
	for _, want := range []string{
		filepath.Join(dataDir, "sites"),
		filepath.Join(dataDir, "sites", "example.com"),
		filepath.Join(dataDir, "sites", "example.com", "index.html"),
	} {
		if !containsPath(taken, want) {
			t.Fatalf("数据根子树未完整移交：%s（taken=%v）", want, taken)
		}
	}
}

// TestHandOverTreeFailsClosed 验证失败策略：树内任一 chown 失败 → 返回错误（拒绝启动），
// 错误里带可操作的修复提示，不静默半移交。
func TestHandOverTreeFailsClosed(t *testing.T) {
	stateDir, _, _ := buildStateDir(t)
	config := filepath.Join(stateDir, "config.json")
	access := &handoverTestAccess{takeErrFor: map[string]error{config: os.ErrPermission}}
	m := newHandoverManager(access, &bytes.Buffer{})

	err := m.handOverStateDir(stateDir, currentAccount())
	if err == nil {
		t.Fatal("树内移交失败必须拒绝启动，实际返回 nil")
	}
	if !strings.Contains(err.Error(), config) || !strings.Contains(err.Error(), "chown -R") {
		t.Fatalf("错误必须指出路径并给可操作修复提示：%v", err)
	}
}

// TestHandOverTreeDepthLimit 验证深度上限：超过上限停止下潜并 WARN，不报错、
// 不假装已移交完整。上限是安全阀（防病态嵌套），不是正常路径。
func TestHandOverTreeDepthLimit(t *testing.T) {
	access := &handoverTestAccess{}
	buf := &bytes.Buffer{}
	m := newHandoverManager(access, buf)

	root := t.TempDir()
	deep := root
	for i := 0; i < maxHandoverDepth+5; i++ {
		deep = filepath.Join(deep, "d")
	}
	mustWrite(t, filepath.Join(deep, "leaf.txt"), "x")

	if err := m.handOverDataDir(root, currentAccount()); err != nil {
		t.Fatalf("到达深度上限不应报错: %v", err)
	}
	_, taken := access.snapshot()
	if containsPath(taken, filepath.Join(deep, "leaf.txt")) {
		t.Fatal("深度上限之外的条目不应被移交")
	}
	if !strings.Contains(buf.String(), "深度上限") {
		t.Fatalf("到达深度上限必须 WARN，日志：%s", buf.String())
	}
}

// containsPath 判断 taken 是否包含精确路径（避免前缀误判）。
func containsPath(paths []string, want string) bool {
	for _, p := range paths {
		if p == want {
			return true
		}
	}
	return false
}
