package httpapi

// 配置快照（时光机）核心逻辑单测：差异计算是回滚预览的数据源，必须可核对。
// 只测纯函数（diffSnapshots / snapshotIDRe / snapshotPath），不依赖装配层与写盘。

import (
	"strings"
	"testing"
)

func TestDiffSnapshots(t *testing.T) {
	snap := Snapshot{
		ID: "test", Name: "装 WordPress 前", CreatedAt: "2026-11-24T18:00:00+08:00",
		Plugins: []SnapshotPlugin{
			{ID: "aaa", Version: "0.1.0", Enabled: true, Desired: "enabled"},
			{ID: "bbb", Version: "0.2.0", Enabled: false, Desired: "disabled"},
			{ID: "ccc", Version: "1.0.0", Enabled: true, Desired: "enabled"}, // 当前已卸载
		},
	}
	current := []SnapshotPlugin{
		{ID: "aaa", Version: "0.1.1", Enabled: true, Desired: "enabled"}, // 仅版本变
		{ID: "bbb", Version: "0.2.0", Enabled: true, Desired: "enabled"}, // 仅启停变
		{ID: "ddd", Version: "0.3.0", Enabled: true, Desired: "enabled"}, // 新增
	}
	got := diffSnapshots(snap, current)
	if len(got) != 4 {
		t.Fatalf("差异项数应为 4（版本1+启停1+卸载1+新增1），实际 %d：%+v", len(got), got)
	}
	want := map[string]string{
		"aaa/version": "0.1.0→0.1.1",
		"bbb/enabled": "停用→启用",
		"ccc/removed": "1.0.0→",
		"ddd/added":   "→0.3.0",
	}
	for _, item := range got {
		key := item.PluginID + "/" + item.Kind
		val := item.From + "→" + item.To
		if want[key] != val {
			t.Errorf("%s：期望 %q，实际 %q", key, want[key], val)
		}
	}
}

func TestDiffSnapshotsNoChange(t *testing.T) {
	snap := Snapshot{ID: "x", Plugins: []SnapshotPlugin{{ID: "a", Version: "1", Enabled: true}}}
	cur := []SnapshotPlugin{{ID: "a", Version: "1", Enabled: true}}
	if got := diffSnapshots(snap, cur); len(got) != 0 {
		t.Fatalf("配置一致时差异应为空，实际 %+v", got)
	}
}

func TestSnapshotPathRejectsTraversal(t *testing.T) {
	dir := "/var/lib/kore/snapshots"
	cases := []string{"", "../etc/passwd", "a/b", "..", "a.json", "snapshot id", "a" + strings.Repeat("x", 70)}
	for _, id := range cases {
		if _, err := snapshotPath(dir, id); err == nil {
			t.Errorf("非法 id %q 应被拒绝，却通过校验", id)
		}
	}
	path, err := snapshotPath(dir, "20261124-180000-123")
	if err != nil {
		t.Fatalf("合法 id 应通过：%v", err)
	}
	if path != dir+"/20261124-180000-123.json" {
		t.Errorf("路径拼接错误：%q", path)
	}
}

func TestSnapshotIDRegex(t *testing.T) {
	if !snapshotIDRe.MatchString("20261124-180000-123") {
		t.Error("生成的 id 格式应合法")
	}
	if snapshotIDRe.MatchString("ab/cd") || snapshotIDRe.MatchString("..") {
		t.Error("含 / 或 .. 的 id 不应匹配")
	}
}
