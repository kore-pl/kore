//go:build unix

package platform

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
)

// prepareProcessGroup 在 Unix 上开新进程组（pgid == 子进程 pid）。
func prepareProcessGroup(cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	return nil
}

// killProcessGroup 用 kill(-pgid, SIGKILL) 杀掉整个进程组。
//
// 只杀组长是不够的：动作命令常常自己 fork（包管理器、nginx -s reload 派生、
// shell 片段……），组长先退、后代活着就等于「超时没回收」。systemd-run 时代
// 这层由 unit cgroup 兜底，直接执行后必须由这里保住（ADR-0049 P1）。
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return fmt.Errorf("platform: 进程未启动，无法按进程组 kill")
	}
	pgid := cmd.Process.Pid
	if pgid <= 1 {
		return fmt.Errorf("platform: 非法进程组 id %d", pgid)
	}
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return fmt.Errorf("platform: kill(-%d, SIGKILL) 失败: %w", pgid, err)
	}
	return nil
}
