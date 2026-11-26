package main

// M9 · 离线 B 路径 CLI：`--scenario` 从 E_UNSUPPORTED 补齐为真实离线批量。
//
// 只作离线 / 演练补充：只有显式给 --scenario 才进入本文件，不进静默主链；
// 不新增对外 API / schema（G-24：本文件所有结构体字段都显式列类型，禁 any）。
// 每条插件仍走现有单条 CLI 安装（runPackageInstall），因此同样受 bbolt 独占锁
// 约束（store.go:95-100），必须停服后执行；失败只记分诊并继续，不整批回滚。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 环境变量名：与现有 KORE_PRESETS_DIR（serve_boot.go）同口径，另两个为离线批量专用。
const (
	envScenarioPresetsDir  = "KORE_PRESETS_DIR"
	envScenarioPackagesDir = "KORE_PACKAGES_DIR"
	envScenarioIndexDir    = "KORE_INDEX_DIR"
)

// scenarioStopHint 停服提示必须给可执行的下一步（G-33 A3：文案 ≥8 字且含「请/应/需」）。
// 如实说明 bbolt 独占锁——CLI 与 serve 独占同一个 state.db，服务在跑就会撞锁 exit 3。
const scenarioStopHint = "离线批量安装需先停止 Kore 服务，请执行 systemctl --user stop kored-local" +
	"（或 sudo systemctl stop kore）；CLI 与 serve 独占同一个 state.db（bbolt 独占锁），" +
	"服务运行时逐条安装会撞锁并返回退出码 3。"

// scenarioIDPattern 同时用于预设 id 与插件 id：挡住 ../ 之类的路径穿越。
var scenarioIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// scenarioPreset 是 presets/<id>.json 的解析形状（字段显式，G-24）。
// 与 market.Preset 的同名字段保持一一对应，不另起对外 schema。
type scenarioPreset struct {
	SchemaVersion int                  `json:"schema_version"`
	ID            string               `json:"id"`
	Name          string               `json:"name"`
	Plugins       []scenarioPresetItem `json:"plugins"`
}

// scenarioPresetItem 是预设中的单条插件引用；Version 可为精确版本或版本区间。
type scenarioPresetItem struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Desired string `json:"desired"`
}

// scenarioIndex 是 index/plugins.json 中本命令唯一需要的字段（依赖序输入）。
type scenarioIndex struct {
	Plugins []scenarioIndexItem `json:"plugins"`
}

// scenarioIndexItem 是索引里的一条依赖声明。
type scenarioIndexItem struct {
	ID        string   `json:"id"`
	DependsOn []string `json:"depends_on"`
}

// scenarioVersionConstraint 是版本区间的解析结果（下界/上界均为三段数字版本）。
// 精确版本用 Exact 单字段表达；区间用 Lower/Upper 和各自的包含性表达，不用 any。
type scenarioVersionConstraint struct {
	Exact         string
	Lower         string
	Upper         string
	LowerIncluded bool
	UpperIncluded bool
}

// scenarioFailure 是一条失败分诊记录，汇总时逐条打印（不整批回滚）。
type scenarioFailure struct {
	ID       string
	Version  string
	ExitCode int
	Reason   string
}

// scenarioSingleInstall 是单条安装的注入点；生产恒为 runPackageInstall。
// 测试替换它以避免真实落盘 / 真实 install；不改任何对外接口。
var scenarioSingleInstall = runPackageInstall

// runScenarioBatch 离线批量入口：解析 → 依赖序 → 逐条单装 → 汇总。
//
// 规划失败（预设/区间/依赖环）返回 exitConfig 且不安装任何一条；
// 执行失败返回失败项中最高的单条退出码（2/3/4），逐条结果见 stdout/stderr。
func runScenarioBatch(opts installOptions, stdout, stderr io.Writer) int {
	// 无论后续是否成功，先把停服限制说在前面（G-06/G-33：不让人点了才发现不行）。
	fmt.Fprintln(stderr, scenarioStopHint)

	presetsDir, err := scenarioPresetsDir(opts)
	if err != nil {
		return scenarioPlanError(stderr, err)
	}
	packagesDir, err := scenarioPackagesDir(opts)
	if err != nil {
		return scenarioPlanError(stderr, err)
	}
	indexDir := scenarioIndexDir(opts)

	preset, err := loadScenarioPreset(presetsDir, opts.scenario)
	if err != nil {
		return scenarioPlanError(stderr, err)
	}
	if len(preset.Plugins) == 0 {
		fmt.Fprintf(stdout, "场景预设 %q 无插件引用，无需安装\n", preset.ID)
		return exitOK
	}

	deps, err := loadScenarioDependencies(indexDir)
	if err != nil {
		return scenarioPlanError(stderr, err)
	}
	if len(deps) == 0 {
		fmt.Fprintln(stderr, "提示: 未读到索引 depends_on（可用 --index-dir / KORE_INDEX_DIR 指定），按预设文件顺序安装")
	}
	ordered, err := orderScenarioPlugins(preset.Plugins, deps)
	if err != nil {
		return scenarioPlanError(stderr, err)
	}

	fmt.Fprintf(stdout, "场景预设 %q 离线批量安装：共 %d 项（按依赖序）\n", preset.ID, len(ordered))
	items := make([]scenarioResolvedItem, 0, len(ordered))
	for _, item := range ordered {
		items = append(items, resolveScenarioItem(packagesDir, item))
	}

	succeeded := 0
	failures := make([]scenarioFailure, 0)
	worst := exitConfig
	for index, item := range items {
		label := fmt.Sprintf("[%d/%d] %s %s", index+1, len(items), item.ID, item.Version)
		if item.ResolveErr != nil {
			failure := scenarioFailure{ID: item.ID, Version: item.Version, ExitCode: exitConfig, Reason: item.ResolveErr.Error()}
			failures = append(failures, failure)
			fmt.Fprintf(stderr, "%s 失败: %s\n", label, failure.Reason)
			if failure.ExitCode > worst {
				worst = failure.ExitCode
			}
			continue
		}

		var itemOut, itemErr bytes.Buffer
		code := scenarioSingleInstall(installOptions{
			config:      opts.config,
			stateDir:    opts.stateDir,
			packagePath: item.PackagePath,
		}, &itemOut, &itemErr)
		fmt.Fprintf(stdout, "%s\n%s", label, indentScenarioLines(itemOut.String(), "    "))
		fmt.Fprint(stderr, indentScenarioLines(itemErr.String(), "    "))
		if code == exitOK {
			succeeded++
			continue
		}
		failure := scenarioFailure{
			ID: item.ID, Version: item.Version, ExitCode: code,
			Reason: scenarioFailureReason(itemErr.String()),
		}
		failures = append(failures, failure)
		fmt.Fprintf(stderr, "%s 失败（退出码 %d）: %s\n", label, code, failure.Reason)
		if code > worst {
			worst = code
		}
	}

	fmt.Fprintf(stdout, "离线批量汇总: 共 %d 项，成功 %d 项，失败 %d 项\n", len(items), succeeded, len(failures))
	for _, failure := range failures {
		fmt.Fprintf(stderr, "  - %s %s: 退出码 %d，%s\n", failure.ID, failure.Version, failure.ExitCode, failure.Reason)
	}
	if len(failures) > 0 {
		fmt.Fprintln(stderr, "提示: 失败项可单独重跑（修好包或停服后），成功项不会被回滚。")
		return worst
	}
	return exitOK
}

// scenarioResolvedItem 是依赖序确定后每条的安装输入；解析失败也占位，保证汇总计数完整。
type scenarioResolvedItem struct {
	ID          string
	Version     string
	PackagePath string
	ResolveErr  error
}

// resolveScenarioItem 在离线包目录里按区间挑出最高满足版本；不满足则为该条记失败。
func resolveScenarioItem(packagesDir string, item scenarioPresetItem) scenarioResolvedItem {
	out := scenarioResolvedItem{ID: item.ID, Version: item.Version}
	constraint, err := parseScenarioVersionSpec(item.Version)
	if err != nil {
		out.ResolveErr = err
		return out
	}
	entries, err := os.ReadDir(packagesDir)
	if err != nil {
		out.ResolveErr = fmt.Errorf("读取离线包目录 %s 失败: %v，请检查 --packages-dir", packagesDir, err)
		return out
	}
	prefix := item.ID + "-"
	bestVersion := ""
	bestPath := ""
	found := make([]string, 0)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".tar.gz") {
			continue
		}
		version := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".tar.gz")
		parsed, parseErr := scenarioSemver(version)
		if parseErr != nil {
			continue
		}
		found = append(found, version)
		if !constraint.Matches(parsed) {
			continue
		}
		if bestVersion == "" || scenarioCompare(parsed, scenarioSemverMust(bestVersion)) > 0 {
			bestVersion = version
			bestPath = filepath.Join(packagesDir, name)
		}
	}
	if bestPath == "" {
		sort.Strings(found)
		if len(found) == 0 {
			out.ResolveErr = fmt.Errorf("离线包目录 %s 下没有 %s 的包，请把 <id>-<version>.tar.gz 放进去", packagesDir, item.ID)
		} else {
			out.ResolveErr = fmt.Errorf("离线包目录 %s 下 %s 的可用版本 %v 均不满足 %s", packagesDir, item.ID, found, item.Version)
		}
		return out
	}
	out.Version = bestVersion
	out.PackagePath = bestPath
	return out
}

// Matches 判断版本是否满足区间；精确版本必须完全相等。
func (c scenarioVersionConstraint) Matches(parsed [3]int) bool {
	if c.Exact != "" {
		return scenarioCompare(parsed, scenarioSemverMust(c.Exact)) == 0
	}
	cmpLower := scenarioCompare(parsed, scenarioSemverMust(c.Lower))
	if cmpLower < 0 || (cmpLower == 0 && !c.LowerIncluded) {
		return false
	}
	if c.Upper == "" {
		return true
	}
	cmpUpper := scenarioCompare(parsed, scenarioSemverMust(c.Upper))
	return cmpUpper < 0 || (cmpUpper == 0 && c.UpperIncluded)
}

// parseScenarioVersionSpec 支持精确 x.y.z、^ / ~ 与 >=/>/<=/</= 比较器（1–2 段）。
// 不支持的写法一律报错，绝不静默把它当精确版本（G-06/G-33）。
func parseScenarioVersionSpec(raw string) (scenarioVersionConstraint, error) {
	spec := strings.TrimSpace(raw)
	if spec == "" {
		return scenarioVersionConstraint{}, fmt.Errorf("版本区间为空：请写 x.y.z 或 >=x.y.z <a.b.c")
	}
	if _, err := scenarioSemver(spec); err == nil {
		return scenarioVersionConstraint{Exact: spec, Lower: spec, LowerIncluded: true}, nil
	}
	if strings.HasPrefix(spec, "^") || strings.HasPrefix(spec, "~") {
		base := strings.TrimSpace(spec[1:])
		parsed, err := scenarioSemver(base)
		if err != nil {
			return scenarioVersionConstraint{}, fmt.Errorf("版本区间 %q 非法: %v", raw, err)
		}
		// ^ 语义与 presets-check.sh 一致：主版本 >0 取下一个主版本；0.x 取下一个次版本。
		upper := [3]int{parsed[0] + 1, 0, 0}
		if strings.HasPrefix(spec, "~") || parsed[0] == 0 {
			upper = [3]int{parsed[0], parsed[1] + 1, 0}
		}
		return scenarioVersionConstraint{
			Lower: base, Upper: formatScenarioSemver(upper), LowerIncluded: true,
		}, nil
	}

	fields := strings.Fields(spec)
	if len(fields) < 1 || len(fields) > 2 {
		return scenarioVersionConstraint{}, fmt.Errorf("版本区间 %q 只支持 x.y.z / ^x.y.z / ~x.y.z / >=x.y.z <a.b.c", raw)
	}
	out := scenarioVersionConstraint{LowerIncluded: true, UpperIncluded: true}
	for _, field := range fields {
		operator, version := scenarioSplitComparator(field)
		if _, err := scenarioSemver(version); err != nil {
			return scenarioVersionConstraint{}, fmt.Errorf("版本区间 %q 非法: %v", raw, err)
		}
		switch operator {
		case "=":
			if len(fields) > 1 {
				return scenarioVersionConstraint{}, fmt.Errorf("版本区间 %q 的精确版本不能与比较器混用", raw)
			}
			return scenarioVersionConstraint{Exact: version, Lower: version, LowerIncluded: true}, nil
		case ">=":
			out.Lower, out.LowerIncluded = version, true
		case ">":
			out.Lower, out.LowerIncluded = version, false
		case "<=":
			out.Upper, out.UpperIncluded = version, true
		case "<":
			out.Upper, out.UpperIncluded = version, false
		default:
			return scenarioVersionConstraint{}, fmt.Errorf("版本区间 %q 含不支持的比较器 %q", raw, operator)
		}
	}
	if out.Lower == "" {
		return scenarioVersionConstraint{}, fmt.Errorf("版本区间 %q 缺下界", raw)
	}
	return out, nil
}

// scenarioSplitComparator 把 ">=0.1.0" 拆成 (">=", "0.1.0")；无运算符视为 "="。
func scenarioSplitComparator(field string) (string, string) {
	for _, operator := range []string{">=", "<=", ">", "<", "="} {
		if rest, ok := strings.CutPrefix(field, operator); ok {
			return operator, rest
		}
	}
	return "=", field
}

// scenarioSemver 解析三段数字版本；前导零 / 预发布一律拒绝（与 installer 同口径）。
func scenarioSemver(raw string) ([3]int, error) {
	var out [3]int
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return out, fmt.Errorf("版本 %q 不是三段数字", raw)
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return out, fmt.Errorf("版本 %q 第 %d 段非法", raw, index+1)
		}
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return out, fmt.Errorf("版本 %q 第 %d 段不是非负整数", raw, index+1)
		}
		out[index] = value
	}
	return out, nil
}

func scenarioSemverMust(raw string) [3]int {
	parsed, _ := scenarioSemver(raw) // 调用点已先校验，不能失败
	return parsed
}

func scenarioCompare(left, right [3]int) int {
	for index := range left {
		if left[index] < right[index] {
			return -1
		}
		if left[index] > right[index] {
			return 1
		}
	}
	return 0
}

func formatScenarioSemver(version [3]int) string {
	return fmt.Sprintf("%d.%d.%d", version[0], version[1], version[2])
}

// orderScenarioPlugins 按索引 depends_on 做拓扑排序；同层按预设文件顺序稳定输出。
// 只对预设内部的依赖计边（外部依赖不在本批安装集合，无需变更，不阻塞）。
func orderScenarioPlugins(plugins []scenarioPresetItem, deps map[string][]string) ([]scenarioPresetItem, error) {
	position := make(map[string]int, len(plugins))
	present := make(map[string]bool, len(plugins))
	for index, item := range plugins {
		if !scenarioIDPattern.MatchString(item.ID) {
			return nil, fmt.Errorf("预设中的插件 id=%q 非法", item.ID)
		}
		if present[item.ID] {
			return nil, fmt.Errorf("预设重复引用插件 %s", item.ID)
		}
		present[item.ID] = true
		position[item.ID] = index
	}

	indegree := make(map[string]int, len(plugins))
	dependents := make(map[string][]string, len(plugins))
	for _, item := range plugins {
		indegree[item.ID] = 0
		seen := make(map[string]bool)
		for _, dep := range deps[item.ID] {
			if dep == item.ID {
				return nil, fmt.Errorf("插件 %s 依赖自身，无法确定依赖序", item.ID)
			}
			if seen[dep] || !present[dep] {
				continue
			}
			seen[dep] = true
			indegree[item.ID]++
			dependents[dep] = append(dependents[dep], item.ID)
		}
	}

	queue := make([]string, 0, len(plugins))
	for id, degree := range indegree {
		if degree == 0 {
			queue = append(queue, id)
		}
	}
	sort.SliceStable(queue, func(i, j int) bool { return position[queue[i]] < position[queue[j]] })

	ordered := make([]scenarioPresetItem, 0, len(plugins))
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		ordered = append(ordered, plugins[position[id]])
		next := append([]string(nil), dependents[id]...)
		sort.SliceStable(next, func(i, j int) bool { return position[next[i]] < position[next[j]] })
		for _, child := range next {
			indegree[child]--
			if indegree[child] == 0 {
				queue = append(queue, child)
				sort.SliceStable(queue, func(i, j int) bool { return position[queue[i]] < position[queue[j]] })
			}
		}
	}
	if len(ordered) != len(plugins) {
		return nil, fmt.Errorf("%s: 预设插件存在循环依赖，无法确定依赖序", pluginapi.E_INVALID)
	}
	return ordered, nil
}

// loadScenarioPreset 读取并校验 presets/<id>.json；id 先过正则再拼路径，挡路径穿越。
func loadScenarioPreset(presetsDir, id string) (scenarioPreset, error) {
	var preset scenarioPreset
	if !scenarioIDPattern.MatchString(id) {
		return preset, fmt.Errorf("%s: 场景预设 id=%q 非法", pluginapi.E_INVALID, id)
	}
	data, err := os.ReadFile(filepath.Join(presetsDir, id+".json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return preset, fmt.Errorf("%s: 未找到预设 %s.json（目录 %s），请用 --presets-dir / KORE_PRESETS_DIR 指定",
				pluginapi.E_INVALID, id, presetsDir)
		}
		return preset, fmt.Errorf("读取预设 %s.json 失败: %v", id, err)
	}
	if err := json.Unmarshal(data, &preset); err != nil {
		return preset, fmt.Errorf("%s: 预设 %s.json 非法: %v", pluginapi.E_INVALID, id, err)
	}
	if preset.ID != id {
		return preset, fmt.Errorf("%s: 预设文件 %s.json 的 id=%q 与请求不一致", pluginapi.E_INVALID, id, preset.ID)
	}
	if preset.SchemaVersion != 1 {
		return preset, fmt.Errorf("%s: 预设 %s 的 schema_version=%d 不受支持（仅 1）", pluginapi.E_INVALID, id, preset.SchemaVersion)
	}
	return preset, nil
}

// loadScenarioDependencies 只读 plugins.json 的 id/depends_on；缺失索引时返回空图（按预设顺序）。
func loadScenarioDependencies(indexDir string) (map[string][]string, error) {
	deps := make(map[string][]string)
	if strings.TrimSpace(indexDir) == "" {
		return deps, nil
	}
	data, err := os.ReadFile(filepath.Join(indexDir, "plugins.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return deps, nil
		}
		return nil, fmt.Errorf("读取索引 plugins.json 失败: %v", err)
	}
	var index scenarioIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return nil, fmt.Errorf("%s: 索引 plugins.json 非法: %v", pluginapi.E_INVALID, err)
	}
	for _, item := range index.Plugins {
		if !scenarioIDPattern.MatchString(item.ID) {
			return nil, fmt.Errorf("%s: 索引中的插件 id=%q 非法", pluginapi.E_INVALID, item.ID)
		}
		deps[item.ID] = append([]string(nil), item.DependsOn...)
	}
	return deps, nil
}

func scenarioPresetsDir(opts installOptions) (string, error) {
	dir := strings.TrimSpace(opts.presetsDir)
	if dir == "" {
		dir = strings.TrimSpace(os.Getenv(envScenarioPresetsDir))
	}
	if dir == "" {
		return "", fmt.Errorf("未提供预设目录：请指定 --presets-dir 或设置 %s", envScenarioPresetsDir)
	}
	return dir, nil
}

func scenarioPackagesDir(opts installOptions) (string, error) {
	dir := strings.TrimSpace(opts.packagesDir)
	if dir == "" {
		dir = strings.TrimSpace(os.Getenv(envScenarioPackagesDir))
	}
	if dir == "" {
		return "", fmt.Errorf("未提供离线包目录：请指定 --packages-dir 或设置 %s", envScenarioPackagesDir)
	}
	return dir, nil
}

func scenarioIndexDir(opts installOptions) string {
	dir := strings.TrimSpace(opts.indexDir)
	if dir == "" {
		dir = strings.TrimSpace(os.Getenv(envScenarioIndexDir))
	}
	return dir
}

// scenarioPlanError 规划期失败：不安装任何一条，返回 exitConfig。
func scenarioPlanError(stderr io.Writer, err error) int {
	fmt.Fprintf(stderr, "场景预设安装失败: %v\n", err)
	return exitConfig
}

// scenarioFailureReason 从单条 stderr 抽一句可读原因（保留原始输出，另存在 stderr 里）。
func scenarioFailureReason(text string) string {
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.Contains(line, "失败") || strings.Contains(line, "错误") {
			return line
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return "单条安装返回非 0（详见上方输出）"
}

// indentScenarioLines 给单条安装的原始输出加缩进，保持证据原样同时可读。
func indentScenarioLines(text, indent string) string {
	if text == "" {
		return ""
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	var builder strings.Builder
	for _, line := range lines {
		builder.WriteString(indent)
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	return builder.String()
}
