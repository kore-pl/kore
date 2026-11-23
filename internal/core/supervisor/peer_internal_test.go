package supervisor

import (
	"testing"

	"github.com/pengtang1024/kore/internal/platform"
)

// TestVerifyPeer 验证 hello 阶段的对端校验：降权时 uid 必须一致，未降权只校验 pid。
func TestVerifyPeer(t *testing.T) {
	cred := platform.Cred{PID: 4242, UID: 1001}
	cases := []struct {
		name string
		cred platform.Cred
		acct platform.Account
		pid  int
		want bool
	}{
		{"pid 一致且未降权", cred, platform.Account{}, 4242, true},
		{"pid 不一致", cred, platform.Account{}, 4243, false},
		{"降权 uid 一致", cred, platform.Account{Name: "kore-echo", UID: 1001}, 4242, true},
		{"降权 uid 不一致", cred, platform.Account{Name: "kore-echo", UID: 1002}, 4242, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyPeer(tc.cred, tc.acct, tc.pid)
			if tc.want && err != nil {
				t.Fatalf("期望通过，实际 %v", err)
			}
			if !tc.want && err == nil {
				t.Fatal("期望拒绝，实际通过")
			}
		})
	}
}
