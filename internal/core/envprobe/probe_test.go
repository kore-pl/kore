package envprobe

import (
	"errors"
	"strings"
	"testing"
)

// healthyFacts 返回一份"全部达标"的 Linux 事实基线，用例只改需要变化的字段。
func healthyFacts() Facts {
	return Facts{
		GOOS: "linux", GOARCH: "amd64", OSVersion: "Ubuntu 24.04", Kernel: "6.8.0-45-generic",
		KernelMajor: 6, KernelMinor: 8, CgroupMode: "v2", Delegation: true,
		InitSystem: "systemd", SELinux: "enforcing", AppArmor: true, FSType: "ext4",
	}
}

// TestProbeHardRequirements 覆盖 exit 6 的硬要求判定。
func TestProbeHardRequirements(t *testing.T) {
	cases := []struct {
		name string
		edit func(f *Facts)
	}{
		{"架构 386", func(f *Facts) { f.GOARCH = "386" }},
		{"平台 windows", func(f *Facts) { f.GOOS = "windows" }},
		{"平台 unknown", func(f *Facts) { f.GOOS = "plan9" }},
		{"内核不可读", func(f *Facts) { f.Kernel = "" }},
		{"内核 4.17", func(f *Facts) { f.Kernel, f.KernelMajor, f.KernelMinor = "4.17.0", 4, 17 }},
		{"状态目录 nfs", func(f *Facts) { f.FSType = "nfs" }},
		{"状态目录 smb", func(f *Facts) { f.FSType = "smb" }},
		{"状态目录 fuse", func(f *Facts) { f.FSType = "fuse" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			facts := healthyFacts()
			tc.edit(&facts)
			if _, err := Probe(facts); !errors.Is(err, ErrUnsupportedEnv) {
				t.Fatalf("期望 ErrUnsupportedEnv，实际 err=%v", err)
			}
		})
	}
}

// TestProbeHealthy 验证达标环境无错误、无告警，字段如实进入 Report。
func TestProbeHealthy(t *testing.T) {
	report, err := Probe(healthyFacts())
	if err != nil {
		t.Fatalf("达标环境不应报错: %v", err)
	}
	if len(report.Warnings) != 0 {
		t.Fatalf("达标环境不应有告警: %v", report.Warnings)
	}
	if report.Systemd != true || report.CgroupMode != "v2" || report.FSType != "ext4" {
		t.Fatalf("Report 字段与事实不一致: %+v", report)
	}
	if report.Kernel != "6.8.0-45-generic" || report.Arch != "amd64" {
		t.Fatalf("Report 内核 / 架构不一致: %+v", report)
	}
}

// TestProbeKernelBoundary 验证 4.18 是闭区间下限。
func TestProbeKernelBoundary(t *testing.T) {
	at := healthyFacts()
	at.Kernel, at.KernelMajor, at.KernelMinor = "4.18.0", 4, 18
	if _, err := Probe(at); err != nil {
		t.Fatalf("内核 4.18 应通过: %v", err)
	}
}

// TestProbeSoftWarnings 验证软要求缺失只告警、不阻断。
func TestProbeSoftWarnings(t *testing.T) {
	facts := healthyFacts()
	facts.CgroupMode = "v1"
	facts.Delegation = false
	facts.InitSystem = "openrc"
	facts.SELinux = "disabled"
	facts.AppArmor = false
	facts.FSType = "tmpfs"
	report, err := Probe(facts)
	if err != nil {
		t.Fatalf("软要求缺失不应阻断: %v", err)
	}
	joined := strings.Join(report.Warnings, "\n")
	for _, want := range []string{"cgroup v2", "委派", "systemd", "SELinux", "AppArmor", "tmpfs"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("告警缺少 %q: %v", want, report.Warnings)
		}
	}
}
