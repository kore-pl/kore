package main

// M9 自测：--scenario 离线批量的解析 / 依赖序 / 部分失败汇总 / 停服提示。
// 全部走注入的假单条安装，不执行真实 install / serve / upgrade，不联网。

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// scenarioFixture 隔离测试目录：预设 + 离线包 + 索引各自独立，不碰运行态资产（G-29）。
type scenarioFixture struct {
	root        string
	presetsDir  string
	packagesDir string
	indexDir    string
}

func newScenarioFixture(t *testing.T, preset scenarioPreset, deps map[string][]string, packages map[string][]string) scenarioFixture {
	t.Helper()
	fixture := scenarioFixture{
		root:        t.TempDir(),
		presetsDir:  filepath.Join(t.TempDir(), "presets"),
		packagesDir: filepath.Join(t.TempDir(), "packages"),
		indexDir:    filepath.Join(t.TempDir(), "index"),
	}
	for _, dir := range []string{fixture.presetsDir, fixture.packagesDir, fixture.indexDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
	}
	data, err := json.Marshal(preset)
	if err != nil {
		t.Fatalf("编码预设失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(fixture.presetsDir, preset.ID+".json"), data, 0o600); err != nil {
		t.Fatalf("写预设失败: %v", err)
	}
	for id, versions := range packages {
		for _, version := range versions {
			path := filepath.Join(fixture.packagesDir, id+"-"+version+".tar.gz")
			if err := os.WriteFile(path, []byte("fake-package"), 0o600); err != nil {
				t.Fatalf("写包失败: %v", err)
			}
		}
	}
	index := scenarioIndex{Plugins: make([]scenarioIndexItem, 0, len(deps))}
	for id, dependsOn := range deps {
		index.Plugins = append(index.Plugins, scenarioIndexItem{ID: id, DependsOn: dependsOn})
	}
	indexData, err := json.Marshal(index)
	if err != nil {
		t.Fatalf("编码索引失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(fixture.indexDir, "plugins.json"), indexData, 0o600); err != nil {
		t.Fatalf("写索引失败: %v", err)
	}
	return fixture
}

// scenarioOptions 把 fixture 目录塞进 installOptions，并把停服提示所需路径对齐到临时目录。
func (f scenarioFixture) scenarioOptions(id string) installOptions {
	return installOptions{
		scenario:    id,
		presetsDir:  f.presetsDir,
		packagesDir: f.packagesDir,
		indexDir:    f.indexDir,
	}
}

// stubScenarioInstall 替换单条安装：记录调用顺序与返回码，绝不落盘。
func stubScenarioInstall(t *testing.T, results map[string]int) *[]string {
	t.Helper()
	calls := make([]string, 0)
	previous := scenarioSingleInstall
	scenarioSingleInstall = func(opts installOptions, stdout, stderr io.Writer) int {
		id, version := scenarioIDVersion(filepath.Base(opts.packagePath))
		calls = append(calls, id+"@"+version)
		code := results[id]
		if code == exitOK {
			_, _ = io.WriteString(stdout, "installed "+id+" "+version+"\n")
			return exitOK
		}
		_, _ = io.WriteString(stderr, "安装失败: 模拟的失败\n")
		return code
	}
	t.Cleanup(func() { scenarioSingleInstall = previous })
	return &calls
}

// scenarioIDVersion 从 <id>-<version>.tar.gz 还原 id/版本，供假安装器记录。
func scenarioIDVersion(base string) (string, string) {
	stem := strings.TrimSuffix(base, ".tar.gz")
	index := strings.LastIndex(stem, "-")
	if index < 0 {
		return stem, ""
	}
	return stem[:index], stem[index+1:]
}

// TestScenarioBatchDependencyOrder 验证按 depends_on 拓扑序逐条安装，且条目数正确。
func TestScenarioBatchDependencyOrder(t *testing.T) {
	preset := scenarioPreset{
		SchemaVersion: 1, ID: "web", Plugins: []scenarioPresetItem{
			{ID: "site", Version: "0.1.0"}, // 依赖 ssl，但在文件最前 → 拓扑序必须把它后移
			{ID: "ssl", Version: "0.2.0"},
			{ID: "echo", Version: "0.3.0"},
		},
	}
	deps := map[string][]string{
		"site": {"ssl"}, // site 依赖 ssl → ssl 必须先装
		"ssl":  {},
		"echo": {},
	}
	packages := map[string][]string{
		"site": {"0.1.0"}, "ssl": {"0.2.0"}, "echo": {"0.3.0"},
	}
	fixture := newScenarioFixture(t, preset, deps, packages)
	calls := stubScenarioInstall(t, map[string]int{"site": 0, "ssl": 0, "echo": 0})

	var out, errOut bytes.Buffer
	code := runScenarioBatch(fixture.scenarioOptions("web"), &out, &errOut)
	if code != exitOK {
		t.Fatalf("全成功退出码 = %d，期望 0；stderr=%s", code, errOut.String())
	}
	got := strings.Join(*calls, ",")
	// 核心约束：site 依赖 ssl，ssl 必须先装；三项都必须各装一次。
	sslIndex, siteIndex := strings.Index(got, "ssl@"), strings.Index(got, "site@")
	if sslIndex < 0 || siteIndex < 0 || sslIndex > siteIndex {
		t.Fatalf("依赖序 = %q，期望 ssl 在 site 之前", got)
	}
	if len(*calls) != 3 {
		t.Fatalf("应逐条安装全部 3 项，实际 %v", *calls)
	}
	for _, want := range []string{"echo@0.3.0", "ssl@0.2.0", "site@0.1.0"} {
		if !strings.Contains(got, want) {
			t.Fatalf("依赖序 %q 缺 %q", got, want)
		}
	}
	if !strings.Contains(out.String(), "成功 3 项，失败 0 项") {
		t.Fatalf("汇总缺成功计数：%s", out.String())
	}
}

// TestScenarioBatchPartialFailureSummary 验证部分失败时继续安装后续项、汇总成功/失败、返回非 0。
func TestScenarioBatchPartialFailureSummary(t *testing.T) {
	preset := scenarioPreset{
		SchemaVersion: 1, ID: "mixed", Plugins: []scenarioPresetItem{
			{ID: "echo", Version: "0.1.0"},
			{ID: "site", Version: "0.2.0"},
			{ID: "ssl", Version: "0.3.0"},
		},
	}
	packages := map[string][]string{
		"echo": {"0.1.0"}, "site": {"0.2.0"}, "ssl": {"0.3.0"},
	}
	fixture := newScenarioFixture(t, preset, map[string][]string{}, packages)
	calls := stubScenarioInstall(t, map[string]int{"echo": 0, "site": exitStore, "ssl": 0})

	var out, errOut bytes.Buffer
	code := runScenarioBatch(fixture.scenarioOptions("mixed"), &out, &errOut)
	if code != exitStore {
		t.Fatalf("部分失败退出码 = %d，期望最高失败码 %d；stderr=%s", code, exitStore, errOut.String())
	}
	if len(*calls) != 3 {
		t.Fatalf("失败后应继续装后续项，实际调用 %v", *calls)
	}
	summary := out.String()
	for _, want := range []string{"共 3 项", "成功 2 项", "失败 1 项"} {
		if !strings.Contains(summary, want) {
			t.Fatalf("汇总缺 %q：%s", want, summary)
		}
	}
	if !strings.Contains(errOut.String(), "site 0.2.0") || !strings.Contains(errOut.String(), "退出码 4") {
		t.Fatalf("失败分诊缺失败项：%s", errOut.String())
	}
	if !strings.Contains(errOut.String(), "成功项不会被回滚") {
		t.Fatalf("应明确不整批回滚：%s", errOut.String())
	}
}

// TestScenarioStopHintMeetsG33A3 验证停服提示文案 ≥8 字且含「请/应/需」之一。
func TestScenarioStopHintMeetsG33A3(t *testing.T) {
	runes := []rune(scenarioStopHint)
	if len(runes) < 8 {
		t.Fatalf("停服提示不足 8 字：%d", len(runes))
	}
	if !strings.ContainsAny(scenarioStopHint, "请应需") {
		t.Fatalf("停服提示缺引导词（请/应/需）：%s", scenarioStopHint)
	}
	// 必须如实说明 bbolt 独占锁与 serve 冲突。
	for _, want := range []string{"bbolt", "独占", "state.db", "systemctl --user stop"} {
		if !strings.Contains(scenarioStopHint, want) {
			t.Fatalf("停服提示缺 %q：%s", want, scenarioStopHint)
		}
	}
	preset := scenarioPreset{SchemaVersion: 1, ID: "empty", Plugins: []scenarioPresetItem{}}
	fixture := newScenarioFixture(t, preset, map[string][]string{}, map[string][]string{})
	var out, errOut bytes.Buffer
	if code := runScenarioBatch(fixture.scenarioOptions("empty"), &out, &errOut); code != exitOK {
		t.Fatalf("空预设应成功返回，code=%d", code)
	}
	if !strings.Contains(errOut.String(), "需先停止 Kore 服务") {
		t.Fatalf("入口未先给停服提示：%s", errOut.String())
	}
}

// TestScenarioVersionSpec 验证精确/区间解析与选取最高满足版本。
func TestScenarioVersionSpec(t *testing.T) {
	tests := []struct {
		spec    string
		version string
		want    bool
	}{
		{"0.1.0", "0.1.0", true},
		{"0.1.0", "0.1.1", false},
		{"^0.1.0", "0.1.9", true},
		{"^0.1.0", "0.2.0", false},
		{"~0.1.2", "0.1.9", true},
		{"~0.1.2", "0.2.0", false},
		{">=0.1.0 <0.2.0", "0.1.9", true},
		{">=0.1.0 <0.2.0", "0.2.0", false},
		{">0.1.0 <=0.2.0", "0.1.0", false},
		{">0.1.0 <=0.2.0", "0.2.0", true},
		{"=0.1.0", "0.1.0", true},
	}
	for _, test := range tests {
		constraint, err := parseScenarioVersionSpec(test.spec)
		if err != nil {
			t.Errorf("解析 %q 失败: %v", test.spec, err)
			continue
		}
		got := constraint.Matches(scenarioSemverMust(test.version))
		if got != test.want {
			t.Errorf("%q 匹配 %v = %v，期望 %v", test.spec, test.version, got, test.want)
		}
	}
	for _, bad := range []string{"", "latest", "1.x", "*", "0.1.0 || 0.2.0", ">=0.1"} {
		if _, err := parseScenarioVersionSpec(bad); err == nil {
			t.Errorf("非法区间 %q 未被拒绝", bad)
		}
	}
}

// TestScenarioResolvesHighestSatisfyingVersion 验证多个可用包时挑最高满足版本。
func TestScenarioResolvesHighestSatisfyingVersion(t *testing.T) {
	preset := scenarioPreset{
		SchemaVersion: 1, ID: "range", Plugins: []scenarioPresetItem{
			{ID: "echo", Version: "^0.1.0"},
		},
	}
	packages := map[string][]string{"echo": {"0.1.0", "0.1.7", "0.1.2"}}
	fixture := newScenarioFixture(t, preset, map[string][]string{}, packages)
	calls := stubScenarioInstall(t, map[string]int{"echo": 0})

	var out, errOut bytes.Buffer
	if code := runScenarioBatch(fixture.scenarioOptions("range"), &out, &errOut); code != exitOK {
		t.Fatalf("区间批量退出码 = %d，stderr=%s", code, errOut.String())
	}
	if got := strings.Join(*calls, ","); got != "echo@0.1.7" {
		t.Fatalf("应满足 ^0.1.0 并取最高版本 0.1.7，实际 %q", got)
	}
}

// TestScenarioMissingPackageFailsItemOnly 验证缺包只失败该条、不阻塞其它项、计入汇总。
func TestScenarioMissingPackageFailsItemOnly(t *testing.T) {
	preset := scenarioPreset{
		SchemaVersion: 1, ID: "missing", Plugins: []scenarioPresetItem{
			{ID: "echo", Version: "0.1.0"},
			{ID: "site", Version: "0.2.0"},
		},
	}
	fixture := newScenarioFixture(t, preset, map[string][]string{}, map[string][]string{"site": {"0.2.0"}})
	calls := stubScenarioInstall(t, map[string]int{"site": 0})

	var out, errOut bytes.Buffer
	code := runScenarioBatch(fixture.scenarioOptions("missing"), &out, &errOut)
	if code != exitConfig {
		t.Fatalf("缺包退出码 = %d，期望 2；stderr=%s", code, errOut.String())
	}
	if len(*calls) != 1 || (*calls)[0] != "site@0.2.0" {
		t.Fatalf("缺包项不应调用安装，实际 %v", *calls)
	}
	if !strings.Contains(errOut.String(), "没有 echo 的包") || !strings.Contains(out.String(), "失败 1 项") {
		t.Fatalf("缺包失败未如实汇总：stdout=%s stderr=%s", out.String(), errOut.String())
	}
}

// TestScenarioCycleFailsBeforeInstalling 验证依赖成环在规划期拒绝，一条都不装。
func TestScenarioCycleFailsBeforeInstalling(t *testing.T) {
	preset := scenarioPreset{
		SchemaVersion: 1, ID: "cycle", Plugins: []scenarioPresetItem{
			{ID: "echo", Version: "0.1.0"},
			{ID: "site", Version: "0.2.0"},
		},
	}
	fixture := newScenarioFixture(t, preset, map[string][]string{
		"echo": {"site"}, "site": {"echo"},
	}, map[string][]string{"echo": {"0.1.0"}, "site": {"0.2.0"}})
	calls := stubScenarioInstall(t, map[string]int{"echo": 0, "site": 0})

	var out, errOut bytes.Buffer
	code := runScenarioBatch(fixture.scenarioOptions("cycle"), &out, &errOut)
	if code != exitConfig {
		t.Fatalf("成环退出码 = %d，期望 2；stderr=%s", code, errOut.String())
	}
	if len(*calls) != 0 {
		t.Fatalf("规划期失败不应安装任何一条，实际 %v", *calls)
	}
	if !strings.Contains(errOut.String(), "循环依赖") {
		t.Fatalf("成环未给出原因：%s", errOut.String())
	}
}

// TestScenarioRejectsPathTraversal 验证 id 带路径穿越被拒，且不读越界文件。
func TestScenarioRejectsPathTraversal(t *testing.T) {
	fixture := newScenarioFixture(t, scenarioPreset{SchemaVersion: 1, ID: "safe"}, map[string][]string{}, map[string][]string{})
	opts := fixture.scenarioOptions("../etc/passwd")
	var out, errOut bytes.Buffer
	code := runScenarioBatch(opts, &out, &errOut)
	if code != exitConfig || !strings.Contains(errOut.String(), "非法") {
		t.Fatalf("路径穿越未被拒：code=%d stderr=%s", code, errOut.String())
	}
}

// TestRunInstallScenarioRouting 验证 runInstall 把 --scenario 路由到批量实现（文案与停服提示出现）。
func TestRunInstallScenarioRouting(t *testing.T) {
	preset := scenarioPreset{SchemaVersion: 1, ID: "routed"}
	fixture := newScenarioFixture(t, preset, map[string][]string{}, map[string][]string{})
	var out, errOut bytes.Buffer
	code := runInstall([]string{
		"--scenario", "routed",
		"--presets-dir", fixture.presetsDir,
		"--packages-dir", fixture.packagesDir,
		"--index-dir", fixture.indexDir,
	}, &out, &errOut)
	if code != exitOK {
		t.Fatalf("路由退出码 = %d，stderr=%s", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "需先停止 Kore 服务") {
		t.Fatalf("runInstall 未走离线批量（缺停服提示）：%s", errOut.String())
	}
}
