package pluginapi

import (
	"encoding/json"
	"testing"
)

// hostWriteAction 是合法的写宿主动作基线（带 target + 结构化 purge_op）。
func hostWriteAction() RootAction {
	return RootAction{
		ID: "ufw-allow", Argv: []string{"ufw", "allow"}, TimeoutS: 30,
		Description: "放行 22/tcp", WritesHost: true, Target: "22/tcp",
		PurgeOp: &PurgeOp{Kind: PurgeKindFileRemove, Args: []string{"/etc/ufw/user.rules"}},
	}
}

// TestValidateRootActionWritesHost 锁定 writes_host 的 schema 边界：
// target 必填、purge_op 只跟 writes_host 一起出现、kind/路径受控。
func TestValidateRootActionWritesHost(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*RootAction)
		wantErr bool
	}{
		{name: "合法写宿主动作", mutate: func(*RootAction) {}},
		{name: "writes_host 缺 target", mutate: func(a *RootAction) { a.Target = "" }, wantErr: true},
		{name: "target 只有空白", mutate: func(a *RootAction) { a.Target = "   " }, wantErr: true},
		{name: "purge_op 不带 writes_host", mutate: func(a *RootAction) { a.WritesHost = false }, wantErr: true},
		{name: "未知 purge kind", mutate: func(a *RootAction) { a.PurgeOp.Kind = "shell.exec" }, wantErr: true},
		{name: "file.remove 参数个数错", mutate: func(a *RootAction) { a.PurgeOp.Args = []string{"/a", "/b"} }, wantErr: true},
		{name: "purge 路径非绝对", mutate: func(a *RootAction) { a.PurgeOp.Args = []string{"etc/ufw/user.rules"} }, wantErr: true},
		{name: "purge 路径是根", mutate: func(a *RootAction) { a.PurgeOp.Args = []string{"/"} }, wantErr: true},
		{name: "purge 路径含 ..", mutate: func(a *RootAction) { a.PurgeOp.Args = []string{"/etc/../passwd"} }, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			action := hostWriteAction()
			tc.mutate(&action)
			err := ValidateRootAction(action)
			if tc.wantErr && err == nil {
				t.Fatalf("期望校验失败，实际通过")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("期望通过，实际失败: %v", err)
			}
		})
	}
}

// TestRootActionPurgeOpJSON 锁定协议字段名（`writes_host` / `target` / `purge_op`）：
// 拼错会落成零值，等于插件声明了"可回滚"而内核看不见。
func TestRootActionPurgeOpJSON(t *testing.T) {
	raw := `{"id":"ufw-allow","argv":["ufw","allow"],"timeout_s":30,
		"writes_host":true,"target":"22/tcp",
		"purge_op":{"kind":"file.restore","args":["/etc/ufw/user.rules.bak","/etc/ufw/user.rules"]}}`
	var action RootAction
	if err := json.Unmarshal([]byte(raw), &action); err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if !action.WritesHost || action.Target != "22/tcp" || action.PurgeOp == nil ||
		action.PurgeOp.Kind != PurgeKindFileRestore || len(action.PurgeOp.Args) != 2 {
		t.Fatalf("协议字段未落位: %+v purge=%+v", action, action.PurgeOp)
	}
	if err := ValidateRootAction(action); err != nil {
		t.Fatalf("协议样例应合法: %v", err)
	}
	// 缺省不写 writes_host 时必须是 false（默认"不写宿主"，不是默认"写"）。
	var defaulted RootAction
	if err := json.Unmarshal([]byte(`{"id":"ufw-status","argv":["ufw","status"],"timeout_s":5}`), &defaulted); err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if defaulted.WritesHost || defaulted.PurgeOp != nil {
		t.Fatalf("未声明时 writes_host 必须为 false: %+v", defaulted)
	}
}
