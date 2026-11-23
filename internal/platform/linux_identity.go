//go:build linux

package platform

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

// accountNamePattern 是插件系统用户名的合法形态（kore-<id>，id 为插件 id 语法）。
// 用户名会拼进 useradd / adduser 的 argv，必须先校验，禁止以 - 开头或含空白。
var accountNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// nologinCandidates 是禁用登录 shell 的候选路径（按优先级）。
var nologinCandidates = []string{"/usr/sbin/nologin", "/sbin/nologin", "/bin/false"}

// useraddCandidates / adduserCandidates 是创建系统账户的工具固定候选路径。
// 刻意不查 PATH：kored 以 root 运行时 PATH 可能被环境改写，用固定路径避免
// 「PATH 里放一个同名 useradd」把 root 权限交给非可信二进制。
var (
	useraddCandidates  = []string{"/usr/sbin/useradd", "/usr/bin/useradd", "/sbin/useradd"}
	adduserCandidates  = []string{"/usr/sbin/adduser", "/usr/bin/adduser", "/sbin/adduser"}
	groupaddCandidates = []string{"/usr/sbin/groupadd", "/usr/bin/groupadd", "/sbin/groupadd"}
	usermodCandidates  = []string{"/usr/sbin/usermod", "/usr/bin/usermod", "/sbin/usermod"}
)

// systemIdentity / systemAccess 返回 Linux 宿主实现。
func systemIdentity() Identity { return linuxIdentity{} }

func systemAccess() Access { return linuxAccess{} }

// linuxIdentity 是 Identity 的 Linux 实现：系统账户 + SysProcAttr.Credential。
type linuxIdentity struct{}

// Current 返回当前进程的 uid/gid 与用户名。
func (linuxIdentity) Current() (Account, error) {
	uid, gid := os.Geteuid(), os.Getegid()
	name := ""
	if current, err := user.Current(); err == nil {
		name = current.Username
	}
	return Account{Name: name, UID: uid, GID: gid}, nil
}

// Lookup 查询系统账户；用户不存在返回 ok=false 而不是错误。
func (linuxIdentity) Lookup(name string) (Account, bool, error) {
	if err := validateAccountName(name); err != nil {
		return Account{}, false, err
	}
	entry, err := user.Lookup(name)
	if err != nil {
		var unknown user.UnknownUserError
		if errors.As(err, &unknown) {
			return Account{}, false, nil
		}
		return Account{}, false, fmt.Errorf("%w: 查询系统用户 %s: %v", ErrAccount, name, err)
	}
	uid, err := strconv.Atoi(entry.Uid)
	if err != nil {
		return Account{}, false, fmt.Errorf("%w: 用户 %s 的 uid %q 非法", ErrAccount, name, entry.Uid)
	}
	gid, err := strconv.Atoi(entry.Gid)
	if err != nil {
		return Account{}, false, fmt.Errorf("%w: 用户 %s 的 gid %q 非法", ErrAccount, name, entry.Gid)
	}
	groups, err := supplementaryGroups(entry, gid)
	if err != nil {
		return Account{}, false, err
	}
	return Account{Name: entry.Username, UID: uid, GID: gid, Groups: groups}, true, nil
}

// supplementaryGroups 返回用户除主组外的补充组 gid。
//
// 降权时这些组会随 Credential 写给子进程；通道共享组（默认 kore）就是靠它
// 让插件能 connect 0660 的 root-action 通道 socket。
func supplementaryGroups(entry *user.User, primary int) ([]int, error) {
	ids, err := entry.GroupIds()
	if err != nil {
		return nil, fmt.Errorf("%w: 读取用户 %s 的组关系: %v", ErrAccount, entry.Username, err)
	}
	out := make([]int, 0, len(ids))
	for _, id := range ids {
		gid, convErr := strconv.Atoi(id)
		if convErr != nil {
			return nil, fmt.Errorf("%w: 用户 %s 的组 id %q 非法", ErrAccount, entry.Username, id)
		}
		if gid == primary {
			continue
		}
		out = append(out, gid)
	}
	return out, nil
}

// Ensure 确保系统账户存在；不存在时用固定 argv 的 useradd / adduser 创建。
//
// 只允许 root 调用（创建系统账户需要 CAP_SETUID/SETGID 与 /etc/passwd 写权限）。
// 创建产物固定为：系统账户（--system）、无 home（--no-create-home）、
// nologin shell、与用户名同名的独立主组（不共享组，避免插件间横向访问）。
func (i linuxIdentity) Ensure(name string, extraGroups []string) (Account, error) {
	groups, err := validateGroupNames(extraGroups)
	if err != nil {
		return Account{}, err
	}
	for _, group := range groups {
		if err := ensureGroup(group); err != nil {
			return Account{}, err
		}
	}
	if _, ok, lookupErr := i.Lookup(name); lookupErr != nil {
		return Account{}, lookupErr
	} else if ok {
		// 已存在的用户：只补组关系（降权后要让插件进入通道共享组）。
		if err := ensureMembership(name, groups); err != nil {
			return Account{}, err
		}
		acct, found, lookupErr := i.Lookup(name)
		if lookupErr != nil || !found {
			return Account{}, fmt.Errorf("%w: 补组后重新查询用户 %s 失败：%v", ErrAccount, name, lookupErr)
		}
		return acct, nil
	}
	if os.Geteuid() != 0 {
		return Account{}, fmt.Errorf("%w: 创建系统用户 %s 需要 root", ErrAccount, name)
	}
	if err := validateAccountName(name); err != nil {
		return Account{}, err
	}
	shell := nologinShell()
	// 组可能已存在（管理员删了用户却留下组）：复用既有 gid，避免 useradd
	// 因「group already exists」永久失败；不存在才让 useradd 建同名主组。
	groupArgs := []string{"--user-group"}
	adduserGroupArgs := []string{"--group"}
	if group, err := user.LookupGroup(name); err == nil {
		if _, convErr := strconv.Atoi(group.Gid); convErr == nil {
			groupArgs = []string{"--gid", group.Gid}
			adduserGroupArgs = []string{"--gid", group.Gid}
		}
	}
	var attempts []string
	if tool := firstExisting(useraddCandidates); tool != "" {
		// 显式 --no-create-home：不能依赖「不传 -m 就不建 home」——/etc/login.defs
		// 的 CREATE_HOME=yes 时 useradd 默认仍会创建 home，会把 --home-dir /nonexistent
		// 真建出来；home 字段只作为 /etc/passwd 里的占位路径。
		argv := append([]string{tool, "--system", "--no-create-home", "--home-dir", "/nonexistent",
			"--shell", shell}, groupArgs...)
		argv = append(argv, name)
		if err := runAccountTool(argv); err == nil {
			if err := ensureMembership(name, groups); err != nil {
				return Account{}, err
			}
			if acct, ok, lookupErr := i.Lookup(name); lookupErr == nil && ok {
				return acct, nil
			}
		} else {
			attempts = append(attempts, err.Error())
		}
	}
	if tool := firstExisting(adduserCandidates); tool != "" {
		// Debian/Ubuntu adduser（perl 版）：--group 建同名组，--system 系统账户。
		// Debian adduser 的 --system 本身不建 home；home 字段显式指向 /nonexistent。
		argv := append([]string{tool, "--system", "--home", "/nonexistent",
			"--shell", shell, "--disabled-login"}, adduserGroupArgs...)
		argv = append(argv, name)
		if err := runAccountTool(argv); err == nil {
			if err := ensureMembership(name, groups); err != nil {
				return Account{}, err
			}
			if acct, ok, lookupErr := i.Lookup(name); lookupErr == nil && ok {
				return acct, nil
			}
		} else {
			attempts = append(attempts, err.Error())
		}
	}
	if len(attempts) == 0 {
		return Account{}, fmt.Errorf("%w: 系统用户 %s 不存在，且未找到 useradd / adduser（请安装 shadow-utils 或 adduser，或预先手工创建）", ErrAccount, name)
	}
	return Account{}, fmt.Errorf("%w: 创建系统用户 %s 失败：%s", ErrAccount, name, strings.Join(attempts, "；"))
}

// Apply 把子进程身份写入 cmd。
//
// root 启动低权插件时必须显式设置补充组为「仅目标 gid」：否则子进程会继承
// root 的 docker / sudo 等补充组，等于换了 uid 却仍然等价 root（例如 docker 组
// 可读写 docker.sock）。非 root 场景（自降权测试、非 root 内核的显式降级形态）
// 只能切到自身 uid，setgroups 会 EPERM，因此置 NoSetGroups。
func (linuxIdentity) Apply(cmd *exec.Cmd, acct Account) error {
	if cmd == nil {
		return errors.New("platform: Apply 需要非空 cmd")
	}
	if acct.UID < 0 || acct.GID < 0 {
		return fmt.Errorf("platform: 非法账户 %+v", acct)
	}
	attr := &syscall.SysProcAttr{}
	if os.Geteuid() == 0 && acct.UID != 0 {
		groups := make([]uint32, 0, 1+len(acct.Groups))
		seen := map[uint32]struct{}{}
		for _, gid := range append([]int{acct.GID}, acct.Groups...) {
			if gid <= 0 {
				continue
			}
			if _, dup := seen[uint32(gid)]; dup {
				continue
			}
			seen[uint32(gid)] = struct{}{}
			groups = append(groups, uint32(gid))
		}
		attr.Credential = &syscall.Credential{
			Uid:    uint32(acct.UID),
			Gid:    uint32(acct.GID),
			Groups: groups,
		}
	} else {
		attr.Credential = &syscall.Credential{
			Uid:         uint32(acct.UID),
			Gid:         uint32(acct.GID),
			NoSetGroups: true,
		}
	}
	cmd.SysProcAttr = attr
	return nil
}

// Remove 删除系统账户（userdel，刻意不带 -r）。
//
// 只用于「刚创建、尚未接管任何文件」的回滚场景：插件账户 home 是 /nonexistent，
// 带 -r 只会让 userdel 去动 /nonexistent，语义上没有收益、还多一次误删风险。
// 账户已接管目录时的删除属卸载链（Cleanup.RemoveAccountsByPrefix），不在这里做。
func (linuxIdentity) Remove(name string) error {
	if err := validateAccountName(name); err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("%w: 删除系统用户 %s 需要 root", ErrAccount, name)
	}
	tool := firstExisting(userdelCandidates)
	if tool == "" {
		return fmt.Errorf("%w: 未找到 userdel，无法回滚删除系统用户 %s", ErrAccount, name)
	}
	if out, err := exec.Command(tool, name).CombinedOutput(); err != nil {
		return fmt.Errorf("%w: 删除系统用户 %s 失败：%v（%s）",
			ErrAccount, name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// linuxAccess 是 Access 的 Linux 实现。
type linuxAccess struct{}

// Own 先把属主改为 acct（仅 root 会成功），再设置 mode。
func (linuxAccess) Own(path string, acct Account, mode os.FileMode) error {
	if os.Geteuid() == 0 {
		if err := os.Chown(path, acct.UID, acct.GID); err != nil {
			return fmt.Errorf("%w: chown %s → %s(%d:%d): %v", ErrAccount, path, acct.Name, acct.UID, acct.GID, err)
		}
	}
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("platform: chmod %s %04o: %w", path, mode.Perm(), err)
	}
	return nil
}

// Traversable 只补 o+x（0700 → 0701），不放开读位，目录仍不可列举。
func (linuxAccess) Traversable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("platform: 检查目录 %s: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("platform: %s 不是目录，不能设置可穿越位", path)
	}
	mode := info.Mode().Perm()
	if mode&0o001 != 0 {
		return nil
	}
	if err := os.Chmod(path, mode|0o001); err != nil {
		return fmt.Errorf("platform: 设置目录 %s 可穿越: %w", path, err)
	}
	return nil
}

// validateGroupNames 校验并去重组名（空列表返回 nil）。
func validateGroupNames(names []string) ([]string, error) {
	out := make([]string, 0, len(names))
	seen := map[string]struct{}{}
	for _, name := range names {
		if name == "" {
			continue
		}
		if err := validateAccountName(name); err != nil {
			return nil, fmt.Errorf("组名 %q: %w", name, err)
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out, nil
}

// ensureGroup 确保系统组存在（仅 root 可用），存在时直接返回。
func ensureGroup(name string) error {
	if _, err := user.LookupGroup(name); err == nil {
		return nil
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("%w: 创建系统组 %s 需要 root", ErrAccount, name)
	}
	tool := firstExisting(groupaddCandidates)
	if tool == "" {
		return fmt.Errorf("%w: 系统组 %s 不存在，且未找到 groupadd（shadow-utils）", ErrAccount, name)
	}
	if err := runAccountTool([]string{tool, "--system", name}); err != nil {
		return fmt.Errorf("%w: 创建系统组 %s 失败：%v", ErrAccount, name, err)
	}
	if _, err := user.LookupGroup(name); err != nil {
		return fmt.Errorf("%w: 系统组 %s 创建后仍不可查：%v", ErrAccount, name, err)
	}
	return nil
}

// ensureMembership 确保用户属于给定组；缺哪个补哪个（usermod -aG）。
func ensureMembership(name string, groups []string) error {
	entry, err := user.Lookup(name)
	if err != nil {
		return fmt.Errorf("%w: 查询系统用户 %s: %v", ErrAccount, name, err)
	}
	ids, err := entry.GroupIds()
	if err != nil {
		return fmt.Errorf("%w: 读取用户 %s 的组关系: %v", ErrAccount, name, err)
	}
	current := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		current[id] = struct{}{}
	}
	for _, groupName := range groups {
		group, err := user.LookupGroup(groupName)
		if err != nil {
			return fmt.Errorf("%w: 查询系统组 %s: %v", ErrAccount, groupName, err)
		}
		if _, ok := current[group.Gid]; ok {
			continue
		}
		tool := firstExisting(usermodCandidates)
		if tool == "" {
			return fmt.Errorf("%w: 把 %s 加入组 %s 需要 usermod（shadow-utils）", ErrAccount, name, groupName)
		}
		if err := runAccountTool([]string{tool, "-aG", groupName, name}); err != nil {
			return fmt.Errorf("%w: 把 %s 加入组 %s 失败：%v", ErrAccount, name, groupName, err)
		}
	}
	return nil
}

// ownGroup 把 path 的属组改为 group 并设置 mode（属主不变，需 root）。
func ownGroup(path, group string, mode os.FileMode) error {
	entry, err := user.LookupGroup(group)
	if err != nil {
		return fmt.Errorf("%w: 查询系统组 %s: %v", ErrAccount, group, err)
	}
	gid, err := strconv.Atoi(entry.Gid)
	if err != nil {
		return fmt.Errorf("%w: 组 %s 的 gid %q 非法", ErrAccount, group, entry.Gid)
	}
	if err := os.Chown(path, -1, gid); err != nil {
		return fmt.Errorf("%w: chgrp %s → %s(%d): %v", ErrAccount, path, group, gid, err)
	}
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("platform: chmod %s %04o: %w", path, mode.Perm(), err)
	}
	return nil
}

// validateAccountName 校验用户名语法（防 argv 注入：禁止 - 开头与空白）。
func validateAccountName(name string) error {
	if !accountNamePattern.MatchString(name) {
		return fmt.Errorf("%w: 用户名 %q 不合法（只允许小写字母/数字/连字符/下划线，且不以 - 开头）", ErrAccount, name)
	}
	return nil
}

// nologinShell 返回存在的 nologin 路径；都没有时退回 /bin/false。
func nologinShell() string {
	if path := firstExisting(nologinCandidates); path != "" {
		return path
	}
	return "/bin/false"
}

// firstExisting 返回候选路径中第一个存在的普通文件。
func firstExisting(paths []string) string {
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	return ""
}

// runAccountTool 执行账户工具；不使用 shell，环境固定为最小集合。
func runAccountTool(argv []string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = []string{"LC_ALL=C", "LANG=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stderr, &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %v（%s）", strings.Join(argv, " "), err, strings.TrimSpace(stderr.String()))
	}
	return nil
}
