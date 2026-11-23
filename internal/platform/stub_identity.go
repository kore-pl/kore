//go:build !linux

package platform

import (
	"os"
	"os/exec"
)

// systemIdentity / systemAccess 返回非 Linux 桩实现：Tier B 降级为「插件与内核
// 同用户运行」，不得声称具备 uid 隔离（SECURITY §6.3）。调用方读到 ErrUnsupported
// 后必须显式声明降级，禁止把「没有实现」当成「已经降权」。
func systemIdentity() Identity { return stubIdentity{} }

func systemAccess() Access { return stubAccess{} }

// stubIdentity 是 Identity 的非 Linux 实现。
type stubIdentity struct{}

// Current 返回 ErrUnsupported（无法给出可信 uid）。
func (stubIdentity) Current() (Account, error) { return Account{}, ErrUnsupported }

// Lookup 返回 ErrUnsupported。
func (stubIdentity) Lookup(string) (Account, bool, error) { return Account{}, false, ErrUnsupported }

// Ensure 返回 ErrUnsupported。
func (stubIdentity) Ensure(string) (Account, error) { return Account{}, ErrUnsupported }

// Apply 返回 ErrUnsupported（不得伪造 SysProcAttr）。
func (stubIdentity) Apply(*exec.Cmd, Account) error { return ErrUnsupported }

// stubAccess 是 Access 的非 Linux 实现。
type stubAccess struct{}

// Own 返回 ErrUnsupported。
func (stubAccess) Own(string, Account, os.FileMode) error { return ErrUnsupported }

// Traversable 返回 ErrUnsupported。
func (stubAccess) Traversable(string) error { return ErrUnsupported }
