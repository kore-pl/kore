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
	useraddCandidates = []string{"/usr/sbin/useradd", "/usr/bin/useradd", "/sbin/useradd"}
	adduserCandidates = []string{"/usr/sbin/adduser", "/usr/bin/adduser", "/sbin/adduser"}
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
	return Account{Name: entry.Username, UID: uid, GID: gid}, true, nil
}

// Ensure 确保系统账户存在；不存在时用固定 argv 的 useradd / adduser 创建。
//
// 只允许 root 调用（创建系统账户需要 CAP_SETUID/SETGID 与 /etc/passwd 写权限）。
// 创建产物固定为：系统账户（--system）、无 home（--no-create-home）、
// nologin shell、与用户名同名的独立主组（不共享组，避免插件间横向访问）。
func (i linuxIdentity) Ensure(name string) (Account, error) {
	if acct, ok, err := i.Lookup(name); err != nil {
		return Account{}, err
	} else if ok {
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
		attr.Credential = &syscall.Credential{
			Uid:    uint32(acct.UID),
			Gid:    uint32(acct.GID),
			Groups: []uint32{uint32(acct.GID)},
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
