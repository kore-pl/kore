package credential

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeAuditor struct {
	events []AuditEvent
	fail   bool
}

func (a *fakeAuditor) Record(_ context.Context, ev AuditEvent) error {
	if a.fail {
		return errors.New("audit sink down")
	}
	a.events = append(a.events, ev)
	return nil
}

func testService(t *testing.T, auditor Auditor) *Service {
	t.Helper()
	svc, err := New(Options{Dir: filepath.Join(t.TempDir(), "credentials"), Auditor: auditor})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return svc
}

func TestSetGetGrantRevoke(t *testing.T) {
	auditor := &fakeAuditor{}
	svc := testService(t, auditor)
	ctx := context.Background()

	entry, err := svc.Set(ctx, "db-mysql", "db-mysql", "mysqlRoot", "MYSQL_PWD", []byte("s3cret"))
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got, err := svc.Get(ctx, "db-mysql", entry.ID); err != nil || string(got) != "s3cret" {
		t.Fatalf("owner Get = %q, %v", got, err)
	}
	// 越权：discover 未获授权。
	_, err = svc.Get(ctx, "discover", entry.ID)
	var apiErr interface{ Error() string }
	if !errors.As(err, &apiErr) || !strings.Contains(err.Error(), CodeNeedGrant) {
		t.Fatalf("越权 Get 应返回 %s，实际 %v", CodeNeedGrant, err)
	}
	// 授权后可见，且审计先落。
	if _, err := svc.Grant(ctx, "admin", entry.ID, "discover"); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if len(auditor.events) != 1 || auditor.events[0].Action != ActionGrant || auditor.events[0].Grantee != "discover" {
		t.Fatalf("审计事件不符：%+v", auditor.events)
	}
	if got, err := svc.Get(ctx, "discover", entry.ID); err != nil || string(got) != "s3cret" {
		t.Fatalf("grantee Get = %q, %v", got, err)
	}
	// 撤销后失效。
	if err := svc.Revoke(ctx, "admin", entry.ID, "discover"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, err := svc.Get(ctx, "discover", entry.ID); err == nil || !strings.Contains(err.Error(), CodeNeedGrant) {
		t.Fatalf("撤销后应 E_NEED_GRANT，实际 %v", err)
	}
}

func TestGrantAuditFailClosed(t *testing.T) {
	svc := testService(t, &fakeAuditor{fail: true})
	ctx := context.Background()
	entry, err := svc.Set(ctx, "db-mysql", "db-mysql", "mysqlRoot", "MYSQL_PWD", []byte("x"))
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if _, err := svc.Grant(ctx, "admin", entry.ID, "discover"); err == nil || !strings.Contains(err.Error(), CodeAudit) {
		t.Fatalf("审计失败应返回 %s，实际 %v", CodeAudit, err)
	}
	// 授权不生效。
	if _, err := svc.Get(ctx, "discover", entry.ID); err == nil || !strings.Contains(err.Error(), CodeNeedGrant) {
		t.Fatalf("审计失败后授权不应生效，实际 %v", err)
	}
	// 未装配 Auditor 也必须拒绝（fail-closed）。
	svc2 := testService(t, nil)
	entry2, err := svc2.Set(ctx, "db-mysql", "db-mysql", "mysqlRoot", "MYSQL_PWD", []byte("x"))
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	if _, err := svc2.Grant(ctx, "admin", entry2.ID, "discover"); err == nil || !strings.Contains(err.Error(), CodeAudit) {
		t.Fatalf("nil auditor 应 fail-closed，实际 %v", err)
	}
}

func TestPermissionsAndEnv(t *testing.T) {
	svc := testService(t, &fakeAuditor{})
	ctx := context.Background()
	dir := filepath.Join(filepath.Dir(svc.indexPath()))
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("目录权限 = %v, %v；期望 0700", info, err)
	}
	entry, err := svc.Set(ctx, "db-mysql", "db-mysql", "mysqlRoot", "MYSQL_PWD", []byte("pa$$"))
	if err != nil {
		t.Fatalf("Set: %v", err)
	}
	for _, path := range []string{svc.indexPath(), svc.secretPath(entry.ID)} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s 权限 = %o，期望 0600", path, info.Mode().Perm())
		}
	}
	// 只注入 owner；grantee 授权后才注入。
	env, err := svc.EnvFor(ctx, "db-mysql")
	if err != nil || len(env) != 1 || env[0] != "MYSQL_PWD=pa$$" {
		t.Fatalf("owner EnvFor = %v, %v", env, err)
	}
	if env, _ := svc.EnvFor(ctx, "discover"); len(env) != 0 {
		t.Fatalf("未授权插件不应注入：%v", env)
	}
	if _, err := svc.Grant(ctx, "admin", entry.ID, "discover"); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if env, err := svc.EnvFor(ctx, "discover"); err != nil || len(env) != 1 || env[0] != "MYSQL_PWD=pa$$" {
		t.Fatalf("grantee EnvFor = %v, %v", env, err)
	}
	// List 不含明文。
	entries, err := svc.List(ctx, "admin", "")
	if err != nil || len(entries) != 1 || entries[0].ID != entry.ID {
		t.Fatalf("List = %+v, %v", entries, err)
	}
	// 删除后密文消失。
	if err := svc.Delete(ctx, "db-mysql", entry.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(svc.secretPath(entry.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("删除后密文仍存在: %v", err)
	}
}

func TestSetValidation(t *testing.T) {
	svc := testService(t, &fakeAuditor{})
	ctx := context.Background()
	cases := []struct {
		name           string
		actor, owner   string
		env            string
		expectContains string
	}{
		{"actor 非 owner", "discover", "db-mysql", "MYSQL_PWD", "owner"},
		{"非法 envVar", "db-mysql", "db-mysql", "mysql_pwd", "envVar"},
		{"空 secret", "db-mysql", "db-mysql", "MYSQL_PWD", "secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var secret []byte
			if tc.expectContains != "secret" {
				secret = []byte("x")
			}
			_, err := svc.Set(ctx, tc.actor, tc.owner, "mysqlRoot", tc.env, secret)
			if err == nil || !strings.Contains(err.Error(), tc.expectContains) {
				t.Fatalf("期望错误含 %q，实际 %v", tc.expectContains, err)
			}
		})
	}
	// 缺省审计器的 EnvFor 在无条目时返回空且不报错。
	if env, err := svc.EnvFor(ctx, "nobody"); err != nil || len(env) != 0 {
		t.Fatalf("空库 EnvFor = %v, %v", env, err)
	}
	_ = time.Now
}
