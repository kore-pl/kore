package envprobe

import (
	"fmt"
	"runtime"

	"github.com/pengtang1024/kore/internal/platform"
)

// Collect 通过 platform 五接口采集探测事实。
//
// 只读、不联网、不起 goroutine、不留定时器；任一探测源不可读即按"硬要求不满足"返回。
func Collect(p *platform.Platform) (Facts, error) {
	facts := Facts{GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
	host, err := p.Service.Host()
	if err != nil {
		return facts, fmt.Errorf("%w: 宿主信息不可读: %w", ErrUnsupportedEnv, err)
	}
	facts.OSVersion = host.OSVersion
	facts.Kernel = host.Kernel
	facts.KernelMajor = host.KernelMajor
	facts.KernelMinor = host.KernelMinor
	facts.CgroupMode = host.CgroupMode
	facts.InitSystem = host.InitSystem
	facts.SELinux = host.SELinux
	facts.AppArmor = host.AppArmor
	facts.Delegation = p.Service.Delegated()
	fsType, err := p.Paths.StateFSType()
	if err != nil {
		return facts, fmt.Errorf("%w: 状态目录文件系统不可读: %w", ErrUnsupportedEnv, err)
	}
	facts.FSType = fsType
	return facts, nil
}
