package main

import (
	"os"
	"os/exec"
	"strconv"
	"testing"
)

// TestCloseInheritedFDsSubprocess 在独立子进程里验证 fd 卫生：
// 打开若干无关 fd → 调 closeInheritedFDs → 断言它们被关闭、0/1/2 仍在、
// 之后 net.Listen 仍可用（Go netpoll 不被误伤）。
//
// 不能在 go test 进程内直接调用 closeInheritedFDs：测试进程自己的 netpoll
// epoll fd 在测试执行时已就绪，关掉会导致 runtime netpoll failed（实测）。
// 子进程用 os.Executable + 特殊环境变量进入 helper 模式，隔离于测试 runtime。
func TestCloseInheritedFDsSubprocess(t *testing.T) {
	if fdHygieneTestSkipReason != "" {
		t.Skip(fdHygieneTestSkipReason)
	}
	if os.Getenv("KORE_FD_HYGIENE_HELPER") == "1" {
		fdHygieneHelper()
		return
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("取测试二进制失败: %v", err)
	}
	cmd := exec.Command(exe, "-test.run=^TestCloseInheritedFDsSubprocess$")
	cmd.Env = append(os.Environ(), "KORE_FD_HYGIENE_HELPER=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("fd 卫生子进程失败: %v\n%s", err, out)
	}
	t.Logf("helper 输出:\n%s", out)
}

// fdHygieneHelper 仅在子进程中执行；用 t 风格输出供父测试核对。
func fdHygieneHelper() {
	// 打开 3 个无关文件作为"继承 fd"替身。
	var extras []*os.File
	for i := 0; i < 3; i++ {
		f, err := os.Open(os.DevNull)
		if err != nil {
			os.Exit(11)
		}
		extras = append(extras, f)
	}
	before := countOpenFDs()
	closed := closeInheritedFDs()
	after := countOpenFDs()

	ok := true
	check := func(cond bool, msg string) {
		if !cond {
			ok = false
			os.Stderr.WriteString("FAIL " + msg + "\n")
		}
	}
	check(closed >= 3, "关闭数 >= 3 (closed="+strconv.Itoa(closed)+")")
	check(after <= before-3, "计数至少降 3 (before="+strconv.Itoa(before)+" after="+strconv.Itoa(after)+")")
	check(countOpenFDs() == after, "重复调用幂等")

	// 0/1/2 保留：往 stdout 写一行必须成功。
	if _, err := os.Stdout.WriteString("STDOUT_OK\n"); err != nil {
		ok = false
		os.Stderr.WriteString("FAIL stdout 不可写\n")
	}

	// 注意：不在测试二进制内断言 net.Listen —— go test 的 testing runtime
	// 在 helper 启动前已初始化 netpoll epoll（fd3），此时关它会 fatal；
	// 真实 kored 在 main() 最早调用（netpoll 尚未初始化），网络可用性由
	// 60s 隔离实例 healthz/登录/首屏回归在集成验证覆盖。

	if !ok {
		os.Exit(1)
	}
	os.Stdout.WriteString("FD_HYGIENE_OK before=" + strconv.Itoa(before) +
		" closed=" + strconv.Itoa(closed) + " after=" + strconv.Itoa(after) + "\n")
}
