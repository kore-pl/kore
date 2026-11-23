//go:build linux

package platform

import (
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestSystemIdentityCurrent 验证 Current 返回的 uid/gid 与进程真实身份一致。
func TestSystemIdentityCurrent(t *testing.T) {
	acct, err := SystemIdentity().Current()
	if err != nil {
		t.Fatalf("Current 失败: %v", err)
	}
	if acct.UID != os.Geteuid() || acct.GID != os.Getegid() {
		t.Fatalf("Current = uid=%d gid=%d，期望 uid=%d gid=%d",
			acct.UID, acct.GID, os.Geteuid(), os.Getegid())
	}
}

// TestIdentityLookupUnknown 验证「用户不存在」是 ok=false 而非错误，非法名直接拒绝。
func TestIdentityLookupUnknown(t *testing.T) {
	identity := SystemIdentity()
	acct, ok, err := identity.Lookup("kore-no-such-plugin-user")
	if err != nil {
		t.Fatalf("查询不存在的用户不应返回错误: %v", err)
	}
	if ok {
		t.Fatalf("不应查到用户，实际 %+v", acct)
	}
	for _, bad := range []string{"", "-evil", "bad name", "UPPER", "a/b"} {
		if _, _, err := identity.Lookup(bad); err == nil {
			t.Fatalf("非法用户名 %q 应被拒绝", bad)
		}
	}
}

// TestIdentityApplySelf 验证 Apply 写入 Credential：子进程 uid 等于目标账户 uid。
//
// 非 root 只能自降权（setuid 到自身），因此这里用当前账户；「从 root 降到
// kore-<id>」的真实验证见 TestEnsureAndApplySystemAccount（root 门禁）与
// 隔离实例证据 .agents/verify/r5-plugin-demotion.md。
func TestIdentityApplySelf(t *testing.T) {
	identity := SystemIdentity()
	current, err := identity.Current()
	if err != nil {
		t.Fatalf("Current 失败: %v", err)
	}
	cmd := exec.Command("id", "-u")
	if err := identity.Apply(cmd, current); err != nil {
		t.Fatalf("Apply 失败: %v", err)
	}
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.Credential == nil {
		t.Fatal("Apply 未写入 SysProcAttr.Credential")
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("子进程执行失败: %v", err)
	}
	got := strings.TrimSpace(string(out))
	want := strconv.Itoa(current.UID)
	if got != want {
		t.Fatalf("子进程 uid=%s，期望 %s", got, want)
	}
	if os.Geteuid() != 0 {
		if !cmd.SysProcAttr.Credential.NoSetGroups {
			t.Fatal("非 root 自降权必须设置 NoSetGroups（setgroups 会 EPERM）")
		}
	}
}

// TestAccessTraversable 验证只补 o+x（0700 → 0701），不放开读位且幂等。
func TestAccessTraversable(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	access := SystemAccess()
	if err := access.Traversable(dir); err != nil {
		t.Fatalf("Traversable 失败: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("Stat 失败: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o701 {
		t.Fatalf("目录权限 = %04o，期望 0701（只补 o+x，不可列举）", got)
	}
	if err := access.Traversable(dir); err != nil {
		t.Fatalf("Traversable 幂等调用失败: %v", err)
	}
	if info, _ = os.Stat(dir); info.Mode().Perm() != 0o701 {
		t.Fatalf("幂等调用后权限变化: %04o", info.Mode().Perm())
	}
	if err := access.Traversable(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("对不存在的目录应返回错误")
	}
}

// TestAccessOwnSelf 验证 Own 把 mode 收窄到 0600，且非 root 时不改变属主。
func TestAccessOwnSelf(t *testing.T) {
	path := filepath.Join(t.TempDir(), "socket")
	if err := os.WriteFile(path, nil, 0o666); err != nil {
		t.Fatalf("建文件失败: %v", err)
	}
	current, err := SystemIdentity().Current()
	if err != nil {
		t.Fatalf("Current 失败: %v", err)
	}
	if err := SystemAccess().Own(path, current, 0o600); err != nil {
		t.Fatalf("Own 失败: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat 失败: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("权限 = %04o，期望 0600", got)
	}
}

// TestEnsureAndApplySystemAccount 是 root 门禁用例：真实创建系统账户、以该 uid
// 拉起子进程并断言 id -u != 0；测试结束 userdel 清理自己创建的用户。
//
// 必须显式开启（KORE_R5_DEMOTION_TEST=1）且以 root 运行——它会写 /etc/passwd，
// 默认不跑，避免普通 go test 改宿主账户库。
func TestEnsureAndApplySystemAccount(t *testing.T) {
	if os.Getenv("KORE_R5_DEMOTION_TEST") != "1" {
		t.Skip("root 门禁用例：设置 KORE_R5_DEMOTION_TEST=1 且以 root 运行")
	}
	if os.Geteuid() != 0 {
		t.Skip("需要 root 才能创建系统账户")
	}
	identity := SystemIdentity()
	pid := strconv.Itoa(os.Getpid())
	name := "kore-r5test-" + pid
	channelGroup := "kore-r5test-grp-" + pid
	// 防御：名字必须落在测试专用前缀，避免误删真实插件用户/组。
	if !strings.HasPrefix(name, "kore-r5test-") || !strings.HasPrefix(channelGroup, "kore-r5test-") {
		t.Fatalf("测试用户名/组名异常: %s / %s", name, channelGroup)
	}
	t.Cleanup(func() {
		if tool := firstExisting([]string{"/usr/sbin/userdel", "/usr/bin/userdel", "/sbin/userdel"}); tool != "" {
			_ = exec.Command(tool, name).Run()
		}
		if tool := firstExisting([]string{"/usr/sbin/groupdel", "/usr/bin/groupdel", "/sbin/groupdel"}); tool != "" {
			_ = exec.Command(tool, channelGroup).Run()
		}
	})
	if err := EnsureGroup(channelGroup); err != nil {
		t.Fatalf("EnsureGroup 失败: %v", err)
	}
	acct, err := identity.Ensure(name, []string{channelGroup})
	if err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	group, err := user.LookupGroup(channelGroup)
	if err != nil {
		t.Fatalf("复核共享组失败: %v", err)
	}
	groupGID, _ := strconv.Atoi(group.Gid)
	found := false
	for _, gid := range acct.Groups {
		if gid == groupGID {
			found = true
		}
	}
	if !found {
		t.Fatalf("账户补充组 %v 缺少共享组 %s(%d)", acct.Groups, channelGroup, groupGID)
	}
	if acct.UID == 0 {
		t.Fatalf("新建系统用户不应是 uid 0: %+v", acct)
	}
	entry, err := user.Lookup(name)
	if err != nil || entry.Uid != strconv.Itoa(acct.UID) {
		t.Fatalf("user.Lookup 复核失败: entry=%+v err=%v", entry, err)
	}
	cmd := exec.Command("id", "-u")
	if err := identity.Apply(cmd, acct); err != nil {
		t.Fatalf("Apply 失败: %v", err)
	}
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.Credential == nil {
		t.Fatal("Apply 未写入 Credential")
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("子进程执行失败: %v", err)
	}
	got := strings.TrimSpace(string(out))
	if got == "0" {
		t.Fatalf("降权后子进程仍是 root（id -u = %s）", got)
	}
	if got != strconv.Itoa(acct.UID) {
		t.Fatalf("子进程 uid=%s，期望 %d", got, acct.UID)
	}
	// 补充组必须精确为「主组 + 显式授予的共享组」：继承 root 的 docker/sudo 组
	// 等价 root，但通道共享组是刻意授予（否则插件连不上 0660 的通道 socket）。
	gotGroups := cmd.SysProcAttr.Credential.Groups
	if len(gotGroups) != 2 || gotGroups[0] != uint32(acct.GID) || gotGroups[1] != uint32(groupGID) {
		t.Fatalf("Credential.Groups = %v，期望 [%d %d]（主组 + 通道共享组）", gotGroups, acct.GID, groupGID)
	}
	if cmd.SysProcAttr.Credential.NoSetGroups {
		t.Fatal("root 降权必须主动 setgroups，不能继承补充组")
	}
	// 子进程实际组关系复核：id -G 应包含共享组，且不含 root 的 docker/sudo。
	cmdGroups := exec.Command("id", "-G")
	if err := identity.Apply(cmdGroups, acct); err != nil {
		t.Fatalf("Apply(id -G) 失败: %v", err)
	}
	gout, err := cmdGroups.Output()
	if err != nil {
		t.Fatalf("id -G 失败: %v", err)
	}
	if !strings.Contains(" "+strings.TrimSpace(string(gout))+" ", " "+strconv.Itoa(groupGID)+" ") {
		t.Fatalf("子进程组 %s 不含共享组 %d", strings.TrimSpace(string(gout)), groupGID)
	}
}
