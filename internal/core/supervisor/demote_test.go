package supervisor_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/pengtang1024/kore/internal/core/supervisor"
	"github.com/pengtang1024/kore/internal/platform"
)

// fakeIdentity 模拟「root 内核 + 低权系统账户」：Current 报 uid 0 以启用降权，
// 账户 uid 固定为本进程 uid（非 root 测试只能自降权，真正的 root→kore-<id>
// 由 root 门禁用例与隔离实例证据覆盖）。
type fakeIdentity struct {
	current   platform.Account
	existing  bool
	ensureErr error
	account   platform.Account
	ensured   []string
	groups    []string
	// removed 记录回滚删除的账户名；log 记录跨替身的调用序（可为 nil）。
	removed []string
	log     *callLog
}

// Remove 记录回滚删除（实现 platform.AccountRemover）。
func (f *fakeIdentity) Remove(name string) error {
	f.removed = append(f.removed, name)
	f.record("remove:" + name)
	return nil
}

// record 写跨替身调用序（log 为 nil 时不记）。
func (f *fakeIdentity) record(event string) {
	if f.log != nil {
		f.log.add(event)
	}
}

// Current 返回伪造的内核身份。
func (f *fakeIdentity) Current() (platform.Account, error) { return f.current, nil }

// Lookup 按 existing 返回账户是否存在。
func (f *fakeIdentity) Lookup(name string) (platform.Account, bool, error) {
	if !f.existing {
		return platform.Account{}, false, nil
	}
	acct := f.account
	acct.Name = name
	return acct, true, nil
}

// Ensure 记录创建请求与通道组；ensureErr 非空时模拟 useradd 失败。
func (f *fakeIdentity) Ensure(name string, groups []string) (platform.Account, error) {
	if f.ensureErr != nil {
		return platform.Account{}, f.ensureErr
	}
	f.ensured = append(f.ensured, name)
	f.groups = append(f.groups, groups...)
	f.record("ensure:" + name)
	acct := f.account
	acct.Name = name
	return acct, nil
}

// Apply 复用真实平台实现（非 root 下是自降权），确保 Credential 真的写进 cmd。
func (f *fakeIdentity) Apply(cmd *exec.Cmd, acct platform.Account) error {
	f.record("apply:" + acct.Name)
	return platform.SystemIdentity().Apply(cmd, acct)
}

// fakeAccess 记录降权涉及的属主 / 可穿越调用；Own 只改 mode（测试不 chown）。
type fakeAccess struct {
	mu        sync.Mutex
	owned     []string
	traversed []string
	// ownErr 模拟属主移交失败（触发回滚删账户路径）。
	ownErr error
	// traverseErr 模拟「属主已移交之后」的可穿越失败（触发保留账户路径）。
	traverseErr error
	log         *callLog
}

// Own 记录路径并收紧 mode。
func (f *fakeAccess) Own(path string, _ platform.Account, mode os.FileMode) error {
	f.mu.Lock()
	f.owned = append(f.owned, path)
	f.mu.Unlock()
	if f.log != nil {
		f.log.add("own:" + path)
	}
	if f.ownErr != nil {
		return f.ownErr
	}
	return os.Chmod(path, mode)
}

// Traversable 只记录路径（测试目录在 /tmp，无需真的改 o+x）。
func (f *fakeAccess) Traversable(path string) error {
	f.mu.Lock()
	f.traversed = append(f.traversed, path)
	f.mu.Unlock()
	if f.log != nil {
		f.log.add("traverse:" + path)
	}
	return f.traverseErr
}

// newDemotionIdentity 造一个「root 内核、kore-<id> 账户 uid=当前进程 uid」的假身份。
func newDemotionIdentity() *fakeIdentity {
	return &fakeIdentity{
		current: platform.Account{Name: "root", UID: 0, GID: 0},
		account: platform.Account{UID: os.Getuid(), GID: os.Getgid()},
	}
}

// TestStartDemotesPluginProcess 验证 root 内核下插件进程 uid 被降到 kore-<id>：
// 子进程 id -u != 0、等于目标账户 uid，且目录收口/可穿越调用发生。
func TestStartDemotesPluginProcess(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("需要非 root 运行：用真实平台 Apply 做自降权，root 下用例见 TestEnsureAndApplySystemAccount")
	}
	identity := newDemotionIdentity()
	access := &fakeAccess{}
	pidFile := filepath.Join(t.TempDir(), "plugin.pid")
	env := newTestEnv(t, "demote", map[string]string{"pid_file": pidFile}, func(o *supervisor.Options) {
		o.Identity = identity
		o.Access = access
	})
	if err := env.manager.Start(context.Background(), "demote"); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	if view, ok := env.manager.Snapshot("demote"); !ok || view.State != supervisor.StateReady {
		t.Fatalf("插件未就绪: view=%+v ok=%v", view, ok)
	}
	if len(identity.ensured) != 1 || identity.ensured[0] != "kore-demote" {
		t.Fatalf("应按需创建系统用户 kore-demote，实际 %v", identity.ensured)
	}
	if len(identity.groups) != 1 || identity.groups[0] != "kore" {
		t.Fatalf("降权应把插件加入通道共享组 kore，实际 %v", identity.groups)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("读取插件 pid 失败: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("插件 pid 非法: %v", err)
	}
	status, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "status"))
	if err != nil {
		t.Fatalf("读取 /proc/%d/status 失败: %v", pid, err)
	}
	uid := procStatusUID(t, string(status))
	if uid == 0 {
		t.Fatalf("插件进程仍是 root：\n%s", firstLine(string(status), "Uid:"))
	}
	if uid != identity.account.UID {
		t.Fatalf("插件进程 uid=%d，期望 %d", uid, identity.account.UID)
	}
	// 状态目录必须交给插件身份并收窄到 0700；运行与状态父链必须可穿越。
	stateDir := filepath.Join(env.root, "demote")
	if len(access.owned) == 0 || access.owned[0] != stateDir {
		t.Fatalf("状态目录未交给插件身份: owned=%v 期望含 %s", access.owned, stateDir)
	}
	info, err := os.Stat(stateDir)
	if err != nil {
		t.Fatalf("Stat 状态目录失败: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("状态目录权限 = %04o，期望 0700（不许放宽到 0777）", got)
	}
	if len(access.traversed) < 2 {
		t.Fatalf("可穿越目录调用不足: %v", access.traversed)
	}
	found := false
	for _, dir := range access.traversed {
		if dir == env.runDir {
			found = true
		}
	}
	if !found {
		t.Fatalf("运行目录未设置可穿越: %v", access.traversed)
	}
}

// TestStartFailsWhenUserCreationFails 验证「用户建不出来就启动失败」，不退回同 uid。
func TestStartFailsWhenUserCreationFails(t *testing.T) {
	identity := newDemotionIdentity()
	identity.ensureErr = errors.New("useradd: command not found")
	env := newTestEnv(t, "demote", nil, func(o *supervisor.Options) {
		o.Identity = identity
		o.Access = &fakeAccess{}
	})
	err := env.manager.Start(context.Background(), "demote")
	if err == nil {
		t.Fatal("创建系统用户失败时应拒绝启动")
	}
	if !strings.Contains(err.Error(), "创建失败") || !strings.Contains(err.Error(), "kore-demote") {
		t.Fatalf("错误信息应包含用户与原因: %v", err)
	}
	if view, ok := env.manager.Snapshot("demote"); !ok || view.State != supervisor.StateFailed {
		t.Fatalf("启动失败后状态应为 failed: %+v ok=%v", view, ok)
	}
}

// TestStartRefusesRootAccount 验证账户 uid=0 时拒绝启动（防配置把插件跑成 root）。
func TestStartRefusesRootAccount(t *testing.T) {
	identity := newDemotionIdentity()
	identity.account = platform.Account{UID: 0, GID: 0}
	env := newTestEnv(t, "demote", nil, func(o *supervisor.Options) {
		o.Identity = identity
		o.Access = &fakeAccess{}
	})
	err := env.manager.Start(context.Background(), "demote")
	if err == nil || !strings.Contains(err.Error(), "拒绝以 root 运行插件") {
		t.Fatalf("uid=0 账户应被拒绝，实际 err=%v", err)
	}
}

// procStatusUID 解析 /proc/<pid>/status 的 Uid 行，返回 real uid。
func procStatusUID(t *testing.T, status string) int {
	t.Helper()
	for _, line := range strings.Split(status, "\n") {
		if !strings.HasPrefix(line, "Uid:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		uid, err := strconv.Atoi(fields[1])
		if err != nil {
			t.Fatalf("Uid 行非法: %q", line)
		}
		return uid
	}
	t.Fatalf("/proc/<pid>/status 缺少 Uid 行")
	return -1
}

// firstLine 返回以 prefix 开头的首行（证据输出用）。
func firstLine(text, prefix string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, prefix) {
			return line
		}
	}
	return ""
}
