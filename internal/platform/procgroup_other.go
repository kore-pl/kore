//go:build !unix

package platform

import (
	"fmt"
	"os/exec"
	"runtime"
)

// errNoProcessGroup 是「当前平台没有进程组回收」的显式错误。
//
// 这里刻意不退回「只杀直接子进程」：那会让超时后的孙进程继续跑，属于静默降级。
func errNoProcessGroup() error {
	return fmt.Errorf("%w: %s 无进程组语义（Windows 需 Job Object，尚未实现）", ErrUnsupported, runtime.GOOS)
}

func prepareProcessGroup(*exec.Cmd) error { return errNoProcessGroup() }

func killProcessGroup(*exec.Cmd) error { return errNoProcessGroup() }
