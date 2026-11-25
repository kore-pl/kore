package auth

import "testing"

// TestCheckAdminUsername 覆盖账号校验：默认账号、显式配置、空归一、错账号拒绝。
func TestCheckAdminUsername(t *testing.T) {
	cases := []struct {
		name      string
		username  string
		configured string
		want      bool
	}{
		{"默认账号/admin", "admin", "", true},
		{"显式配置一致", "admin", "admin", true},
		{"空白归一", "  admin  ", "", true},
		{"空账号拒绝", "", "", false},
		{"错账号拒绝", "root", "", false},
		{"大小写敏感", "Admin", "admin", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CheckAdminUsername(tc.username, tc.configured); got != tc.want {
				t.Fatalf("CheckAdminUsername(%q,%q)=%v want %v", tc.username, tc.configured, got, tc.want)
			}
		})
	}
}
