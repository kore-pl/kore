//go:build linux

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withPasswd 用临时账户库替换 /etc/passwd，测试结束恢复。
func withPasswd(t *testing.T, body string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "passwd")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("写临时账户库失败: %v", err)
	}
	old := passwdPath
	passwdPath = path
	t.Cleanup(func() { passwdPath = old })
}

// fakeTool 在临时目录造一个可执行文件（userdel / systemctl 的替身）。
func fakeTool(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("造替身 %s 失败: %v", name, err)
	}
	return path
}

// TestListAccountsByPrefix 验证按前缀扫描账户库（不依赖 state）。
func TestListAccountsByPrefix(t *testing.T) {
	withPasswd(t, "root:x:0:0:root:/root:/bin/bash\nkore-site:x:990:990::/nonexistent:/usr/sbin/nologin\nkore-db-mysql:x:991:991::/nonexistent:/usr/sbin/nologin\npt:x:1000:1000::/home/pt:/bin/bash\n")
	got, err := linuxCleanup{}.ListAccountsByPrefix("kore-")
	if err != nil {
		t.Fatalf("扫描失败: %v", err)
	}
	want := []string{"kore-db-mysql", "kore-site"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("命中 = %v，期望 %v", got, want)
	}
	if got, err := (linuxCleanup{}).ListAccountsByPrefix("kore-absent-"); err != nil || len(got) != 0 {
		t.Fatalf("无匹配应为空，实际 %v err=%v", got, err)
	}
}

// TestRemoveAccountsDryRun 验证 dry-run 不执行 userdel。
func TestRemoveAccountsDryRun(t *testing.T) {
	withPasswd(t, "kore-a:x:1:1::/nonexistent:/bin/false\nkore-b:x:2:2::/nonexistent:/bin/false\n")
	called := false
	old := cleanupExec
	cleanupExec = func(string, ...string) ([]byte, error) { called = true; return nil, nil }
	t.Cleanup(func() { cleanupExec = old })
	out, err := linuxCleanup{}.RemoveAccountsByPrefix("kore-", true)
	if err != nil {
		t.Fatalf("dry-run 失败: %v", err)
	}
	if called {
		t.Fatal("dry-run 不得执行 userdel")
	}
	if len(out.Matched) != 2 || len(out.Removed) != 2 || len(out.Failed) != 0 {
		t.Fatalf("dry-run 结果不对: %+v", out)
	}
}

// TestRemoveAccountsExecutesUserdel 验证真实删除只调用固定路径 userdel -r，且先做名字校验。
func TestRemoveAccountsExecutesUserdel(t *testing.T) {
	withPasswd(t, "kore-a:x:1:1::/nonexistent:/bin/false\nbad name:x:2:2::/nonexistent:/bin/false\n")
	tool := fakeTool(t, "userdel")
	oldCandidates, oldExec := userdelCandidates, cleanupExec
	userdelCandidates = []string{tool}
	var calls [][]string
	cleanupExec = func(name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return nil, nil
	}
	t.Cleanup(func() { userdelCandidates, cleanupExec = oldCandidates, oldExec })

	out, err := linuxCleanup{}.RemoveAccountsByPrefix("kore-", false)
	if err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if len(out.Removed) != 1 || out.Removed[0] != "kore-a" {
		t.Fatalf("应只删合法用户 kore-a: %+v", out)
	}
	if len(calls) != 1 || strings.Join(calls[0], " ") != tool+" -r kore-a" {
		t.Fatalf("userdel 调用不对: %v", calls)
	}
}

// TestRemoveAccountsIdempotent 验证 "does not exist" 视为成功。
func TestRemoveAccountsIdempotent(t *testing.T) {
	withPasswd(t, "kore-gone:x:1:1::/nonexistent:/bin/false\n")
	tool := fakeTool(t, "userdel")
	oldCandidates, oldExec := userdelCandidates, cleanupExec
	userdelCandidates = []string{tool}
	cleanupExec = func(string, ...string) ([]byte, error) {
		return nil, errors.New("userdel: user 'kore-gone' does not exist")
	}
	t.Cleanup(func() { userdelCandidates, cleanupExec = oldCandidates, oldExec })
	out, err := linuxCleanup{}.RemoveAccountsByPrefix("kore-", false)
	if err != nil {
		t.Fatalf("幂等场景不应报错: %v", err)
	}
	if len(out.Removed) != 1 || len(out.Failed) != 0 {
		t.Fatalf("幂等结果不对: %+v", out)
	}
}

// TestRemoveServiceUnitOrder 验证 stop → disable → rm → daemon-reload 顺序。
func TestRemoveServiceUnitOrder(t *testing.T) {
	unitPath := filepath.Join(t.TempDir(), "kore.service")
	if err := os.WriteFile(unitPath, []byte("[Unit]\n"), 0o644); err != nil {
		t.Fatalf("写 unit 失败: %v", err)
	}
	systemctl := fakeTool(t, "systemctl")
	oldCandidates, oldExec := systemctlCandidates, cleanupExec
	systemctlCandidates = []string{systemctl}
	var calls [][]string
	cleanupExec = func(name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return []byte("active"), nil
	}
	t.Cleanup(func() { systemctlCandidates, cleanupExec = oldCandidates, oldExec })

	out, err := linuxCleanup{}.RemoveServiceUnit("kore.service", unitPath, false)
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if !out.Present || !out.Active {
		t.Fatalf("探测结果不对: %+v", out)
	}
	wantOrder := []string{"is-active", "stop", "disable", "daemon-reload"}
	if len(calls) != len(wantOrder) {
		t.Fatalf("systemctl 调用 = %v，期望 %v", calls, wantOrder)
	}
	for i, sub := range wantOrder {
		if len(calls[i]) < 2 || calls[i][1] != sub {
			t.Fatalf("第 %d 次调用应为 %s，实际 %v", i, sub, calls[i])
		}
	}
	if _, err := os.Stat(unitPath); !os.IsNotExist(err) {
		t.Fatalf("unit 文件应已删除，stat err=%v", err)
	}
}

// TestRemoveServiceUnitDryRun 验证 dry-run 只做只读探测、不删文件。
func TestRemoveServiceUnitDryRun(t *testing.T) {
	unitPath := filepath.Join(t.TempDir(), "kore.service")
	if err := os.WriteFile(unitPath, []byte("[Unit]\n"), 0o644); err != nil {
		t.Fatalf("写 unit 失败: %v", err)
	}
	var calls [][]string
	oldExec := cleanupExec
	cleanupExec = func(name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return nil, errors.New("inactive")
	}
	t.Cleanup(func() { cleanupExec = oldExec })
	out, err := linuxCleanup{}.RemoveServiceUnit("kore.service", unitPath, true)
	if err != nil {
		t.Fatalf("dry-run 失败: %v", err)
	}
	for _, call := range calls {
		if len(call) < 2 || call[1] != "is-active" {
			t.Fatalf("dry-run 只能做只读探测，实际调用 %v", calls)
		}
	}
	if _, err := os.Stat(unitPath); err != nil {
		t.Fatalf("dry-run 不得删 unit：%v", err)
	}
	if len(out.Actions) == 0 {
		t.Fatal("dry-run 应返回计划动作")
	}
}

// TestRemoveServiceUnitMissing 验证 unit 缺失时幂等跳过。
func TestRemoveServiceUnitMissing(t *testing.T) {
	out, err := linuxCleanup{}.RemoveServiceUnit("kore.service", filepath.Join(t.TempDir(), "absent.service"), false)
	if err != nil {
		t.Fatalf("缺失 unit 不应报错: %v", err)
	}
	if out.Present {
		t.Fatalf("不应判定为存在: %+v", out)
	}
	if len(out.Actions) != 1 || !strings.Contains(out.Actions[0], "跳过") {
		t.Fatalf("应给出跳过动作，实际 %v", out.Actions)
	}
}
