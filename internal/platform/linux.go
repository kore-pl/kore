//go:build linux

package platform

import (
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
)

// New 返回 Linux 平台实现（Tier A：全功能）。
func New(cfg Config) (*Platform, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &Platform{
		Paths:     linuxPaths{dirs: cfg},
		Service:   linuxService{},
		Signals:   newLinuxSignals(),
		Resource:  linuxResource{},
		Transport: linuxTransport{},
	}, nil
}

// linuxPaths 是 Paths 的 Linux 实现。
type linuxPaths struct {
	dirs Config
}

// Dir 返回指定类别的目录路径。
func (p linuxPaths) Dir(kind DirKind) string {
	switch kind {
	case DirConfig:
		return p.dirs.ConfigDir
	case DirState:
		return p.dirs.StateDir
	case DirRun:
		return p.dirs.RunDir
	case DirLog:
		return p.dirs.LogDir
	}
	return ""
}

// Ensure 先校验状态目录文件系统，再创建四类目录（0700）。
func (p linuxPaths) Ensure() error {
	fsType, err := p.StateFSType()
	if err != nil {
		return err
	}
	if isNetworkOrFuseFS(fsType) {
		return fmt.Errorf("%w: %s 位于 %s 文件系统", ErrUnsupportedFS, p.dirs.StateDir, fsType)
	}
	for _, dir := range []string{p.dirs.ConfigDir, p.dirs.StateDir, p.dirs.RunDir, p.dirs.LogDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("创建目录 %s: %w", dir, err)
		}
	}
	return nil
}

// StateFSType 返回状态目录（或最近存在祖先）的文件系统类型名。
func (p linuxPaths) StateFSType() (string, error) {
	dir, err := existingAncestor(p.dirs.StateDir)
	if err != nil {
		return "", err
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return "", fmt.Errorf("读取 %s 文件系统类型: %w", dir, err)
	}
	return fsName(uint32(st.Type)), nil
}

// linuxTransport 是 Transport 的 Linux 实现。
type linuxTransport struct{}

// Listen 清理陈旧 socket 后监听，并把 socket 权限收紧到 0600。
func (linuxTransport) Listen(path string) (net.Listener, error) {
	if err := removeStaleSocket(path); err != nil {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("监听 UDS %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("设置 UDS %s 权限: %w", path, err)
	}
	return ln, nil
}

// Dial 连接给定 UDS 路径。
func (linuxTransport) Dial(path string) (net.Conn, error) {
	conn, err := net.Dial("unix", path)
	if err != nil {
		return nil, fmt.Errorf("连接 UDS %s: %w", path, err)
	}
	return conn, nil
}

// PeerCred 通过 SO_PEERCRED 读取对端 pid / uid / gid。
func (linuxTransport) PeerCred(conn net.Conn) (Cred, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return Cred{}, errors.New("对端凭据: 不是 Unix 连接")
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return Cred{}, fmt.Errorf("对端凭据: 取底层连接: %w", err)
	}
	var (
		ucred   *syscall.Ucred
		credErr error
	)
	if err := raw.Control(func(fd uintptr) {
		ucred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return Cred{}, fmt.Errorf("对端凭据: 控制连接: %w", err)
	}
	if credErr != nil {
		return Cred{}, fmt.Errorf("对端凭据: SO_PEERCRED: %w", credErr)
	}
	return Cred{PID: ucred.Pid, UID: ucred.Uid, GID: ucred.Gid}, nil
}

// removeStaleSocket 只删除自身路径上的旧 socket；符号链接与普通文件一律拒绝。
func removeStaleSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("检查 UDS %s: %w", path, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("拒绝覆盖 %s: 已存在且不是 socket", path)
	}
	return os.Remove(path)
}
