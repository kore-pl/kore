package pluginapi_test

import (
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fileDeleteAction 是合法的 file_delete 动作基线（无 argv、无静态 purge_op）。
func fileDeleteAction() pluginapi.RootAction {
	return pluginapi.RootAction{
		ID: "vhost-delete", WritesHost: true,
		Target:      "/etc/nginx/conf.d/",
		Description: "删除站点 nginx 片段",
		FileDelete:  &pluginapi.FileDelete{PrefixClass: "nginx.conf.d"},
	}
}

// TestValidateRootActionFileDelete 锁死 file_delete 声明的形状判据（放不放宽都在这里）。
func TestValidateRootActionFileDelete(t *testing.T) {
	if err := pluginapi.ValidateRootAction(fileDeleteAction()); err != nil {
		t.Fatalf("合法声明被拒：%v", err)
	}
	// 反例自证：每一种「想删更多」的写法都必须被拒。
	cases := []struct {
		name    string
		mutate  func(*pluginapi.RootAction)
		wantSub string
	}{
		{"未知类别", func(a *pluginapi.RootAction) { a.FileDelete.PrefixClass = "etc.all" }, "不在白名单类别内"},
		{"带 argv", func(a *pluginapi.RootAction) { a.Argv = []string{"/bin/rm"} }, "不得声明 argv"},
		{"不带 writes_host", func(a *pluginapi.RootAction) { a.WritesHost = false }, "必须 writes_host=true"},
		{"静态 purge_op", func(a *pluginapi.RootAction) {
			a.PurgeOp = &pluginapi.PurgeOp{Kind: pluginapi.PurgeKindFileRemove, Args: []string{"/etc/shadow"}}
		}, "不得声明静态 purge_op"},
		{"target 不是类别目录", func(a *pluginapi.RootAction) { a.Target = "/etc/" }, "必须是类别目录"},
		{"同时声明 file_write", func(a *pluginapi.RootAction) {
			a.FileWrite = &pluginapi.FileWrite{
				PrefixClass: "nginx.conf.d", Mode: pluginapi.FileWriteModeRoot0644,
				ContentPolicy: pluginapi.ContentPolicyNginxVHost,
			}
		}, "不能同时声明"},
		{"timeout 越界", func(a *pluginapi.RootAction) { a.TimeoutS = 999 }, "超出"},
	}
	for _, tc := range cases {
		action := fileDeleteAction()
		tc.mutate(&action)
		err := pluginapi.ValidateRootAction(action)
		if err == nil {
			t.Fatalf("%s：应被拒绝但通过了", tc.name)
		}
		if !strings.Contains(err.Error(), tc.wantSub) {
			t.Fatalf("%s：错误信息应含 %q，实际 %q", tc.name, tc.wantSub, err.Error())
		}
	}
}

// TestFileDeletePath 锁死「删谁的、删哪一层」：单层文件名 + 类别目录 + 归属前缀。
func TestFileDeletePath(t *testing.T) {
	decl := &pluginapi.FileDelete{PrefixClass: "nginx.conf.d"}
	got, err := pluginapi.FileDeletePath("site", decl, "kore-site-a.conf")
	if err != nil {
		t.Fatalf("合法路径被拒：%v", err)
	}
	if got != "/etc/nginx/conf.d/kore-site-a.conf" {
		t.Fatalf("路径不符：%q", got)
	}
	// 反例自证：横向越权 / 路径穿越 / 后缀伪装 / 目录型目标全部拒绝。
	bad := []string{
		"kore-ssl-a.conf",           // 别人的片段
		"../kore-site-a.conf",       // 路径穿越
		"kore-site-a.conf.disabled", // 后缀伪装
		"kore-site-.conf",           // 缺中间标识
		"kore-site-a.txt",           // 后缀不对
	}
	for _, name := range bad {
		if _, err := pluginapi.FileDeletePath("site", decl, name); err == nil {
			t.Fatalf("%q 应被拒绝但通过了", name)
		}
	}
}

// TestFileDeleteRejectsPurgeOpAsRequest 是设计判断的**代码化证据**：purge_op 不是删除请求。
//
// 复用 purge_op 做删除会让插件从「只能删类别目录下自己的片段」变成「能删任意绝对
// 路径」（validatePurgePath 只挡 `/` 与 `..`）。本用例锁定该路径不可达：file.remove
// 只能出现在 writes_host 动作的**回滚信息**里，不能作为执行语义。
func TestFileDeleteRejectsPurgeOpAsRequest(t *testing.T) {
	action := fileDeleteAction()
	action.PurgeOp = &pluginapi.PurgeOp{
		Kind: pluginapi.PurgeKindFileRemove, Args: []string{"/etc/shadow"},
	}
	if err := pluginapi.ValidateRootAction(action); err == nil {
		t.Fatalf("file_delete 声明静态 purge_op 必须被拒（否则等于任意路径删除器）")
	}
	// 对照：exec 动作带 purge_op 是合法的（那是回滚信息，不是执行语义）——判据没被放宽。
	exec := pluginapi.RootAction{
		ID: "x-exec", Argv: []string{"nginx", "-t"}, TimeoutS: 5, WritesHost: true,
		Target:  "/tmp/x",
		PurgeOp: &pluginapi.PurgeOp{Kind: pluginapi.PurgeKindFileRemove, Args: []string{"/tmp/x"}},
	}
	if err := pluginapi.ValidateRootAction(exec); err != nil {
		t.Fatalf("exec + purge_op 仍应合法（判据被误改）：%v", err)
	}
}
