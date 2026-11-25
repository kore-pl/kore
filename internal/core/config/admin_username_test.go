package config

import (
	"strings"
	"testing"
)

// TestAdminUsernameDefaultsAndCompat 覆盖 ADR-0057 T1：缺省/空值归一 admin，
// 显式值按原样解析；错误类型格式拒绝启动。
func TestAdminUsernameDefaultsAndCompat(t *testing.T) {
	cases := []struct {
		name    string
		auth    string
		want    string
		wantErr bool
	}{
		{"缺省", "  session_ttl: 1h\n", "admin", false},
		{"显式 admin", "  admin_username: admin\n", "admin", false},
		{"显式自定义", "  admin_username: ops-admin\n", "ops-admin", false},
		{"空值归一", "  admin_username: \"\"\n", "admin", false},
		{"非法大写", "  admin_username: Admin\n", "", true},
		{"非法类型", "  admin_username: 123\n", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := "server:\n  socket: /tmp/kore.sock\npaths:\n  state_dir: /tmp/kore-state\n  log_dir: /tmp/kore-log\n  run_dir: /tmp/kore-run\n  index_dir: /tmp/kore-index\nauth:\n" + tc.auth
			path := writeConfig(t, t.TempDir(), body)
			snap, _, err := loadFile(t, path)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("非法账号 %q 应被拒绝", tc.auth)
				}
				if !strings.Contains(err.Error(), "auth.admin_username") {
					t.Fatalf("错误应指名字段: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("加载失败: %v", err)
			}
			if snap.Auth.AdminUsername != tc.want {
				t.Fatalf("AdminUsername=%q want %q", snap.Auth.AdminUsername, tc.want)
			}
		})
	}
}

// TestAdminUsernameIsColdField 覆盖 ADR-0057：账号变更不进 SIGHUP 热更白名单，
// 必须重启生效（避免账号在会话/限速主体上分叉）。
func TestAdminUsernameIsColdField(t *testing.T) {
	old := Default()
	old.Source = "/tmp/old.yaml"
	next := *old
	next.Auth.AdminUsername = "ops-admin"
	_, ignored := mergeHot(old, &next)
	found := false
	for _, k := range ignored {
		if k == "auth.admin_username" {
			found = true
		}
	}
	if !found {
		t.Fatalf("auth.admin_username 必须在冷字段列表，实际 %v", ignored)
	}
	if old.Auth.AdminUsername != "admin" {
		t.Fatalf("热更应该保留旧账号，实际 %q", old.Auth.AdminUsername)
	}
}
