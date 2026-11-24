package platform

import (
	"os/exec"
)

// 本文件是 ADR-0049 P1「进程树回收」的平台收口：内核只通过这两个函数接触
// 进程组 / 信号语义（G-16：syscall 不得进 internal/core）。
//
// 为什么必须收口：`Setpgid` 与 `kill(-pgid, SIGKILL)` 是 Unix 专有；Windows 没
// 有进程组语义（要等价的 Job Object，尚未实现）。**禁止静默降级**——非 Unix
// 返回 ErrUnsupported，调用方必须显式拒绝执行特权动作，而不是退化成「只杀直接
// 子进程」（那样 fork 出来的孙进程会留下来继续跑）。

// PrepareProcessGroup 把即将启动的子进程放进**独立进程组**（Unix：Setpgid）。
//
// 这是「按动作回收整棵进程树」的前半段：子进程成为组长，它 fork 的后代默认继承
// 同一 pgid，于是 KillProcessGroup 一次 kill(-pgid) 就能连根拔掉。
//
// 平台分支：Unix 设置 `SysProcAttr.Setpgid=true`；其它平台返回 ErrUnsupported。
func PrepareProcessGroup(cmd *exec.Cmd) error { return prepareProcessGroup(cmd) }

// KillProcessGroup 向 cmd 所在**整个进程组**发送 SIGKILL（Unix：kill(-pgid)）。
//
// 前置：cmd 已经过一次成功的 PrepareProcessGroup + Start（否则返回错误）。
// 组已不存在（ESRCH）视为成功：目标本来就不在了，不是失败。
func KillProcessGroup(cmd *exec.Cmd) error { return killProcessGroup(cmd) }
