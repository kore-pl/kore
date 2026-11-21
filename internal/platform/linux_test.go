//go:build linux

package platform

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestParseKernelRelease 覆盖发行版后缀与非法输入。
func TestParseKernelRelease(t *testing.T) {
	cases := []struct {
		release      string
		major, minor int
		wantErr      bool
	}{
		{"6.8.0-45-generic", 6, 8, false},
		{"4.18.0", 4, 18, false},
		{"5.14.0-427.el9.x86_64", 5, 14, false},
		{"6.8", 6, 8, false},
		{"", 0, 0, true},
		{"no-digits", 0, 0, true},
	}
	for _, tc := range cases {
		major, minor, err := parseKernelRelease(tc.release)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%q 期望报错", tc.release)
			}
			continue
		}
		if err != nil || major != tc.major || minor != tc.minor {
			t.Fatalf("%q 解析为 %d.%d err=%v，期望 %d.%d", tc.release, major, minor, err, tc.major, tc.minor)
		}
	}
}

// TestFSName 覆盖状态目录文件系统识别（含硬拒绝集合）。
func TestFSName(t *testing.T) {
	cases := map[uint32]string{
		magicNFS: "nfs", magicCIFS: "smb", magicSMB: "smb", magicSMB2: "smb",
		magicFUSE: "fuse", magicTmpfs: "tmpfs", magicExt: "ext4",
		magicXFS: "xfs", magicBtrfs: "btrfs", 0xDEAD: "unknown(0xdead)",
	}
	for magic, want := range cases {
		if got := fsName(magic); got != want {
			t.Fatalf("fsName(%#x) = %q，期望 %q", magic, got, want)
		}
	}
	for _, name := range []string{"nfs", "smb", "cifs", "fuse"} {
		if !isNetworkOrFuseFS(name) {
			t.Fatalf("%s 应被拒绝", name)
		}
	}
	if isNetworkOrFuseFS("ext4") || isNetworkOrFuseFS("tmpfs") {
		t.Fatal("本地文件系统不应被拒绝")
	}
}

// TestEnsureCreatesDirs 验证四类目录按 0700 创建且返回真实文件系统类型。
func TestEnsureCreatesDirs(t *testing.T) {
	root := t.TempDir()
	dirs := Config{
		ConfigDir: filepath.Join(root, "etc"),
		StateDir:  filepath.Join(root, "state"),
		RunDir:    filepath.Join(root, "run"),
		LogDir:    filepath.Join(root, "log"),
	}
	paths := linuxPaths{dirs: dirs}
	if err := paths.Ensure(); err != nil {
		t.Fatalf("Ensure 失败: %v", err)
	}
	for _, dir := range []string{dirs.ConfigDir, dirs.StateDir, dirs.RunDir, dirs.LogDir} {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			t.Fatalf("%s 未创建为目录: %v", dir, err)
		}
		if perm := info.Mode().Perm(); perm != 0o700 {
			t.Fatalf("%s 权限 = %o，期望 700", dir, perm)
		}
	}
	fsType, err := paths.StateFSType()
	if err != nil || fsType == "" {
		t.Fatalf("StateFSType = %q err=%v", fsType, err)
	}
}

// TestTransportUnixSocket 验证 UDS 监听 0600、拨号与 SO_PEERCRED 自证。
func TestTransportUnixSocket(t *testing.T) {
	dir, err := os.MkdirTemp("", "kore")
	if err != nil {
		t.Fatalf("建临时目录: %v", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	socket := filepath.Join(dir, "kore.sock")
	transport := linuxTransport{}
	listener, err := transport.Listen(socket)
	if err != nil {
		t.Fatalf("Listen 失败: %v", err)
	}
	defer func() { _ = listener.Close() }()
	info, err := os.Stat(socket)
	if err != nil {
		t.Fatalf("socket 未创建: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("socket 权限 = %o，期望 600", perm)
	}
	conn, err := transport.Dial(socket)
	if err != nil {
		t.Fatalf("Dial 失败: %v", err)
	}
	defer func() { _ = conn.Close() }()
	cred, err := transport.PeerCred(conn)
	if err != nil {
		t.Fatalf("PeerCred 失败: %v", err)
	}
	if cred.UID != uint32(os.Getuid()) || cred.PID <= 0 {
		t.Fatalf("对端凭据 = %+v，期望 uid=%d 且 pid>0", cred, os.Getuid())
	}
}

// TestTransportRejectsRegularFile 验证不会覆盖同名普通文件。
func TestTransportRejectsRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kore.sock")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("准备普通文件: %v", err)
	}
	if _, err := (linuxTransport{}).Listen(path); err == nil {
		t.Fatal("同名普通文件应被拒绝")
	}
}

// TestSignalsChannels 验证 SIGHUP → Reload、SIGTERM → Shutdown 的归一化。
func TestSignalsChannels(t *testing.T) {
	signals := newLinuxSignals()
	defer signals.Stop()
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatalf("发送 SIGHUP: %v", err)
	}
	select {
	case <-signals.Reload():
	case <-signals.Shutdown():
		t.Fatal("SIGHUP 不应触发 Shutdown")
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("发送 SIGTERM: %v", err)
	}
	<-signals.Shutdown()
}

// TestResourceRSS 验证 RSS 采样对本进程可用。
func TestResourceRSS(t *testing.T) {
	rss, err := (linuxResource{}).RSS(os.Getpid())
	if err != nil {
		t.Fatalf("RSS 失败: %v", err)
	}
	if rss == 0 {
		t.Fatal("RSS 不应为 0")
	}
}

// TestServiceHost 验证宿主探测返回可用事实（不假设值，只校验形状）。
func TestServiceHost(t *testing.T) {
	host, err := (linuxService{}).Host()
	if err != nil {
		t.Fatalf("Host 失败: %v", err)
	}
	if host.Kernel == "" || host.KernelMajor < MinKernelForTest {
		t.Fatalf("内核事实异常: %+v", host)
	}
	switch host.CgroupMode {
	case "v1", "v2", "none":
	default:
		t.Fatalf("cgroup 形态异常: %q", host.CgroupMode)
	}
	switch host.InitSystem {
	case "systemd", "openrc", "none":
	default:
		t.Fatalf("init 形态异常: %q", host.InitSystem)
	}
}

// MinKernelForTest 是本测试对内核主版本的最低要求（测试机不会低于该值）。
const MinKernelForTest = 4
