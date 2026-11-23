package privilege

import (
	"strings"
	"testing"
)

// TestBuildRestartArgvNoBlock 固定自重启 argv：必须带 --no-block（否则内核自己会被
// 同步 restart 的 SIGTERM 杀掉，调用方拿不到结果，表现为"升级报错但实际成功"）。
func TestBuildRestartArgvNoBlock(t *testing.T) {
	got := strings.Join(BuildRestartArgv("kore.service"), " ")
	want := "systemctl --no-block restart kore.service"
	if got != want {
		t.Fatalf("argv = %q，期望 %q", got, want)
	}
}

// TestSelfCtlCandidatesAbsolute 自管理用的 systemctl 必须是绝对路径候选（不查 PATH：
// 内核以 root 运行时，PATH 里的同名 systemctl 就是提权面）。
func TestSelfCtlCandidatesAbsolute(t *testing.T) {
	if len(selfCtlCandidates) == 0 {
		t.Fatal("selfCtlCandidates 为空")
	}
	for _, candidate := range selfCtlCandidates {
		if !strings.HasPrefix(candidate, "/") {
			t.Fatalf("候选 %q 不是绝对路径", candidate)
		}
	}
}

// TestRunSelfCtlWithoutSystemctl 找不到 systemctl 时必须报错，不静默成功。
func TestRunSelfCtlWithoutSystemctl(t *testing.T) {
	saved := selfCtlCandidates
	selfCtlCandidates = []string{"/nonexistent/systemctl"}
	defer func() { selfCtlCandidates = saved }()
	if err := RestartUnitNoBlock("kore.service"); err == nil {
		t.Fatal("找不到 systemctl 时 RestartUnitNoBlock 必须返回错误")
	}
	if _, err := UnitMainPID("kore.service"); err == nil {
		t.Fatal("找不到 systemctl 时 UnitMainPID 必须返回错误")
	}
}
