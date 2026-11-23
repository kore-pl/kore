// Package platform 收口 kore 的全部平台专有代码。
//
// 五个运行期接口（paths / service / signals / resource / transport）各自不超过 3 个
// 方法，另有插件低权身份用的 identity（4 个方法）与 access（2 个方法）；
// 内核只通过本包接触 syscall、os/signal、os/user、cgroup 与 AF_UNIX；Linux 实现见
// linux.go，非 Linux 仅保留返回 ErrUnsupported 的编译桩（见 stub.go）。
package platform

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
)

// 平台层错误分类，调用方用 errors.Is 判定后映射退出码。
var (
	// ErrUnsupported 表示当前构建目标未提供运行期实现。
	ErrUnsupported = errors.New("platform: 当前平台未提供实现")
	// ErrUnsupportedFS 表示状态目录落在不受支持的文件系统（网络盘 / 用户态盘）。
	ErrUnsupportedFS = errors.New("platform: 状态目录文件系统不受支持")
	// ErrAccount 表示插件低权系统账户不可用（不存在且无法创建 / 创建工具缺失）。
	ErrAccount = errors.New("platform: 插件系统账户不可用")
)

// DirKind 标识 kore 的四类运行期目录。
type DirKind int

// 四类运行期目录；Get 不到时返回空串，不做猜测。
const (
	// DirConfig 配置目录（Linux 为 /etc/kore）。
	DirConfig DirKind = iota
	// DirState 状态目录（Linux 为 /var/lib/kore）。
	DirState
	// DirRun 运行目录（Linux 为 /run/kore）。
	DirRun
	// DirLog 日志目录（Linux 为 /var/log/kore）。
	DirLog
)

// Config 是平台层所需的目录配置，由 cmd 层从配置与环境变量解析后注入。
type Config struct {
	// ConfigDir 配置目录。
	ConfigDir string
	// StateDir 状态目录；必须位于本地持久文件系统。
	StateDir string
	// RunDir 运行目录（socket 与锁文件）。
	RunDir string
	// LogDir 日志目录。
	LogDir string
}

// validate 校验四类目录都已给出，缺一即视为配置错误。
func (c Config) validate() error {
	for _, d := range []string{c.ConfigDir, c.StateDir, c.RunDir, c.LogDir} {
		if d == "" {
			return fmt.Errorf("platform: 运行期目录未配置（%w）", ErrUnsupported)
		}
	}
	return nil
}

// Paths 解析并创建运行期落点，并校验状态目录所在文件系统。
type Paths interface {
	// Dir 返回指定类别的目录路径。
	Dir(kind DirKind) string
	// Ensure 创建四类目录（0700），并拒绝网络 / 用户态文件系统上的状态目录。
	Ensure() error
	// StateFSType 返回状态目录（不存在时取最近存在祖先）的文件系统类型名。
	StateFSType() (string, error)
}

// HostInfo 是宿主服务环境的一次性只读探测结果。
type HostInfo struct {
	// InitSystem 服务管理器形态：systemd / openrc / none。
	InitSystem string
	// Kernel 内核 release 原文（uname -r）。
	Kernel string
	// KernelMajor 内核主版本。
	KernelMajor int
	// KernelMinor 内核次版本。
	KernelMinor int
	// OSVersion 发行版标识（/etc/os-release 的 PRETTY_NAME，缺失时回退内核 release）。
	OSVersion string
	// CgroupMode cgroup 形态：v1 / v2 / none。
	CgroupMode string
	// SELinux 强制状态：enforcing / permissive / disabled。
	SELinux string
	// AppArmor 是否可用。
	AppArmor bool
}

// Service 探测宿主服务环境（只读，不留残留）。
type Service interface {
	// Host 一次性采集 init、内核、OS、cgroup、SELinux、AppArmor 事实。
	Host() (HostInfo, error)
	// Delegated 通过一次真实写入探测 cgroup 委派是否可写（探测后回滚）。
	Delegated() bool
}

// Signals 把平台停止 / 重载信号统一成两个只读通道。
type Signals interface {
	// Shutdown 在收到 SIGTERM / SIGINT 后关闭。
	Shutdown() <-chan struct{}
	// Reload 在收到 SIGHUP 后投递一次。
	Reload() <-chan struct{}
	// Stop 停止信号监听并释放资源。
	Stop()
}

// Limits 是一次限额写入的取值，零值字段表示不设置该项。
type Limits struct {
	// MemoryBytes 内存上限（字节）。
	MemoryBytes int64
	// CPUQuota 单核百分比配额（100000 为 1 核）。
	CPUQuota int
	// PidsMax 进程数上限。
	PidsMax int
}

// Resource 负责限额写入与 RSS 观测；不可用时只读观测。
type Resource interface {
	// Enforced 报告当前宿主能否真正写入限额。
	Enforced() bool
	// Apply 把限额写入指定作用域（cgroup 目录名）。
	Apply(scope string, limits Limits) error
	// RSS 返回指定进程的常驻内存字节数。
	RSS(pid int) (uint64, error)
}

// Cred 是对端进程凭据（Linux 由 SO_PEERCRED 提供）。
type Cred struct {
	// PID 对端进程号。
	PID int32
	// UID 对端有效用户。
	UID uint32
	// GID 对端有效组。
	GID uint32
}

// Transport 负责 AF_UNIX 监听 / 拨号、socket 权限与对端凭据。
type Transport interface {
	// Listen 在给定路径监听（父目录须已存在，socket 权限 0600）。
	Listen(path string) (net.Listener, error)
	// Dial 连接到给定 UDS 路径。
	Dial(path string) (net.Conn, error)
	// PeerCred 读取对端凭据。
	PeerCred(conn net.Conn) (Cred, error)
}

// Account 是一个本地系统账户的 uid/gid 视图（插件低权身份的载体）。
type Account struct {
	// Name 账户名（Linux 为 kore-<id>）。
	Name string
	// UID 用户 id；负数表示未知（非 Linux）。
	UID int
	// GID 主组 id；负数表示未知（非 Linux）。
	GID int
	// Groups 是补充组 gid（不含主组）；Linux 降权时随 Credential 一起写入。
	// 用途：插件用户加入内核通道共享组后，才能 connect 0660 root:<group> 的通道 socket。
	Groups []int
}

// Identity 收口「插件进程以哪个 uid/gid 运行」的全部平台专有操作。
//
// Linux 实现见 linux.go（系统账户 + SysProcAttr.Credential）；非 Linux 返回
// ErrUnsupported，调用方按 Tier B 降级矩阵显式声明（同用户运行，不伪放假降权）。
// 内核只通过本接口接触 os/user 与 syscall，G-16：平台专有 API 不得进 internal/core。
type Identity interface {
	// Current 返回当前进程账户；非 Linux 返回 ErrUnsupported。
	Current() (Account, error)
	// Lookup 查询账户；不存在时返回 ok=false（不视为错误）。
	Lookup(name string) (Account, bool, error)
	// Ensure 确保系统账户存在（仅 root 可用）：不存在则创建无 home、
	// nologin shell、独立主组的系统账户，并把用户加入 extraGroups（不存在的组
	// 会按系统组创建）；已存在的用户只补组关系。创建失败返回 ErrAccount 包装错误。
	Ensure(name string, extraGroups []string) (Account, error)
	// Apply 把子进程身份写入 cmd（Linux 设置 SysProcAttr.Credential 并清空
	// 继承的补充组）；失败表示无法安全降权，调用方必须拒绝启动进程。
	Apply(cmd *exec.Cmd, acct Account) error
}

// Access 是插件降权所需的最小文件权限操作：属主与「可穿越」位。
//
// 只暴露两项能力（不提供任意 chmod 包装）：调用方无法借此放宽到 0777，
// 可穿越只补 o+x，不补读位与列举位。
type Access interface {
	// Own 把 path 属主改为 acct 并设置 mode；非 root 时只设置 mode。
	Own(path string, acct Account, mode os.FileMode) error
	// Traversable 给目录补「他人可穿越」位（o+x），保持不可列举。
	Traversable(path string) error
}

// SystemIdentity 返回宿主 Identity 实现（装配层未显式注入时的默认值）。
func SystemIdentity() Identity { return systemIdentity() }

// SystemAccess 返回宿主 Access 实现（装配层未显式注入时的默认值）。
func SystemAccess() Access { return systemAccess() }

// EnsureGroup 确保宿主系统组存在（仅 root 可用）；非 Linux 返回 ErrUnsupported。
//
// 用于插件 → 内核 root-action 通道的共享组（默认 kore）：通道 socket 为
// root:<group> 0660，插件用户加入该组后才能 connect（见 ADR-0018 实施记录）。
func EnsureGroup(name string) error { return ensureGroup(name) }

// OwnGroup 把 path 的属组改为 group 并设置 mode（属主不变）；非 Linux 返回
// ErrUnsupported。用于通道 socket：root:<group> 0660。
func OwnGroup(path, group string, mode os.FileMode) error { return ownGroup(path, group, mode) }

// Platform 聚合五接口，由 New 按构建目标返回。
type Platform struct {
	// Paths 运行期目录。
	Paths Paths
	// Service 宿主服务环境。
	Service Service
	// Signals 停止与重载通道。
	Signals Signals
	// Resource 限额与 RSS。
	Resource Resource
	// Transport AF_UNIX 传输。
	Transport Transport
}
