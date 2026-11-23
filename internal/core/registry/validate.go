package registry

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 字段规则常量集中在此，避免散落魔法值。
const (
	// maxNameRunes 是 name 的最大字符数（协议 1–64）。
	maxNameRunes = 64
	// 资源预算区间（PLUGIN-PROTOCOL §3.1 / RESOURCE-MODEL §3.3）。
	minMemoryMB = 4
	maxMemoryMB = 12
	minPidsMax  = 16
	maxPidsMax  = 512
	minCPUQuota = 10
	maxCPUQuota = 100
	// lazy 空闲退出区间；其它 lifecycle 传值忽略。
	minIdleSec = 60
	maxIdleSec = 1800
	// maxCapabilities 是单插件能力声明数量上限。
	maxCapabilities = 16
	// maxMethodCapabilities 是方法级能力覆盖条数上限（防清单膨胀）。
	maxMethodCapabilities = 64
	// maxRootActions 是单个插件 root_actions 条目上限（协议常量）。
	maxRootActions = 16
)

var (
	// idPattern 是插件 id 的协议正则；连续连字符另由 validateIdentity 拒绝。
	idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}[a-z0-9]$`)
	// semverPattern 是 M1 接受的版本形态：纯数字三段，预发布号 M1 不支持。
	semverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	// cpuQuotaPattern 是 resources.cpu_quota 的形态：整数百分比。
	cpuQuotaPattern = regexp.MustCompile(`^([0-9]{1,3})%$`)
	// privilegedCapabilities 是内核唯一认识的宿主级能力（6 项，仅 system/net/proc 前缀）。
	// 内核不维护任何业务域名词表：其它能力一律走 <plugin-id>:<action> 通用语法。
	privilegedCapabilities = map[string]struct{}{
		"system:read": {}, "system:admin": {},
		"net:read": {}, "net:write": {},
		"proc:read": {}, "proc:write": {},
	}
	// capabilityPattern 是能力项语法：<域>:<动作>，两段均为小写短横线标识符。
	capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}:[a-z][a-z0-9-]{0,30}$`)
	// methodActionPattern 是方法级能力键的动作段语法：单段动词或点分多段（如
	// createDatabase / config.get / verify_file）；域由插件 id 单独比对，不进本正则。
	//
	// 字符集 = camelCase | snake_case：段内允许字母、数字、下划线（ADR-0047）。
	// 两处刻意的边界，改前先读 ADR-0047 §3.1：
	//   - 段首仍限小写字母 → `_leading` / `1status` 依旧非法；
	//   - **不接受连字符**（`verify-file` 仍拒）。这是显式接受的不对称，勿顺手放开。
	//
	// 切分规则（ADR-0047 §3.2）：动作段**不切分**。整条 method_capabilities 键只有唯一
	// 分割点——`<id>` 与 `<action>` 之间的那个「.」（见 validateMethodCapabilities 的
	// strings.CutPrefix(method, m.ID+".")）；idPattern 不含下划线与点，域/动作边界唯一
	// 无歧义，故 a_b.c 只有一种读法：一个整体动作名。内核从不按 '.' 或 '_' 分解动作
	// 层级——用命名切分层级表达业务结构属插件业务逻辑，内核做即违反 G-01。
	methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$`)
	// eventNamePattern 是 event 触发的匹配名语法：<域>.<事件>，如 cert.renew_due。
	eventNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$`)
	// invokeNamePattern 是 invoke 触发的匹配名语法：允许单段动词（如 run）
	// 或多段名（如 status.check）。
	invokeNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$`)
	// scenarioTagWhitelist 是 scenario_tags 的合法取值（商店分类用）。
	scenarioTagWhitelist = map[string]struct{}{
		"web": {}, "data": {}, "ops": {}, "sec": {}, "app": {},
	}
	// depthLevels 是 depth_level 的合法取值（G-20）。
	depthLevels = map[string]struct{}{"production": {}, "basic": {}}
)

// validate 依次校验四组规则；任一失败立即返回带字段名的错误。
func (m *Manifest) validate() error {
	for _, check := range []func() error{
		m.validateIdentity,
		m.validateRuntime,
		m.validateMethodCapabilities,
		m.validatePostUpgrade,
		m.validateResources,
		m.validateTriggers,
		m.validateExtras,
		m.validateRootActions,
	} {
		if err := check(); err != nil {
			return err
		}
	}
	return nil
}

// validateIdentity 校验 id / name / version / entry。
func (m *Manifest) validateIdentity() error {
	if !idPattern.MatchString(m.ID) || strings.Contains(m.ID, "--") {
		return errf(pluginapi.E_INVALID,
			"id=%q 不合法：须匹配 ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ 且不含连续连字符", m.ID)
	}
	if m.Name == "" || utf8.RuneCountInString(m.Name) > maxNameRunes {
		return errf(pluginapi.E_INVALID, "name 必须为 1–%d 个字符（当前 %q）", maxNameRunes, m.Name)
	}
	if !semverPattern.MatchString(m.Version) {
		return errf(pluginapi.E_INVALID, "version=%q 不是 MAJOR.MINOR.PATCH 形态", m.Version)
	}
	if m.Entry != "bin/"+m.ID {
		return errf(pluginapi.E_INVALID, "entry=%q 必须固定为 bin/%s", m.Entry, m.ID)
	}
	return nil
}

// validateRuntime 校验 protocol / requires_kore / lifecycle / capabilities / idle_timeout_s。
func (m *Manifest) validateRuntime() error {
	if m.Protocol != pluginapi.Protocol {
		return errf(pluginapi.E_UNSUPPORTED, "protocol=%q 与内核协议 %q 不匹配", m.Protocol, pluginapi.Protocol)
	}
	if strings.TrimSpace(m.RequiresKore) == "" {
		return errf(pluginapi.E_INVALID, "requires_kore 不能为空（如 \">=0.1.0 <0.2.0\"）")
	}
	switch m.Lifecycle {
	case LifecycleResident, LifecycleLazy, LifecycleOneshot:
	default:
		return errf(pluginapi.E_INVALID, "lifecycle=%q 必须是 resident|lazy|oneshot", m.Lifecycle)
	}
	if m.IdleTimeoutS != 0 && (m.IdleTimeoutS < minIdleSec || m.IdleTimeoutS > maxIdleSec) {
		return errf(pluginapi.E_INVALID, "idle_timeout_s=%d 超出 %d–%d", m.IdleTimeoutS, minIdleSec, maxIdleSec)
	}
	return m.validateCapabilities()
}

// validateCapabilities 校验能力声明：数量 → 去重 → 语法 → 特权集或自有域。
//
// 两类能力：① 6 项特权能力（system/net/proc 前缀，内核唯一认识的宿主级能力）；
// ② 插件自有能力 <plugin-id>:<action>，其域必须等于声明它的插件 id——内核只校验
// 「域名 == 插件 id + 合法字符集」，不维护业务名词表（G-01 薄壳红线）。
func (m *Manifest) validateCapabilities() error {
	if len(m.Capabilities) == 0 {
		return errf(pluginapi.E_INVALID, "capabilities 不能为空（至少 1 项，上限 %d）", maxCapabilities)
	}
	if len(m.Capabilities) > maxCapabilities {
		return errf(pluginapi.E_INVALID, "capabilities 最多 %d 项，当前 %d", maxCapabilities, len(m.Capabilities))
	}
	seen := make(map[string]struct{}, len(m.Capabilities))
	for _, capability := range m.Capabilities {
		if _, ok := seen[capability]; ok {
			return errf(pluginapi.E_INVALID, "capabilities 含重复项 %q", capability)
		}
		seen[capability] = struct{}{}
		if !capabilityPattern.MatchString(capability) {
			return errf(pluginapi.E_INVALID, "capability=%q 语法非法，应为 <域>:<动作>", capability)
		}
		if _, ok := privilegedCapabilities[capability]; ok {
			continue
		}
		domain, _, _ := strings.Cut(capability, ":")
		if domain != m.ID {
			return errf(pluginapi.E_INVALID,
				"capability=%q 的能力域 %q 必须等于插件 id %q，或使用 6 项特权能力", capability, domain, m.ID)
		}
	}
	return nil
}

// validatePostUpgrade 校验可选的升级后置动作声明：完整方法名 `<id>.<action>`。
//
// 只校验形态与归属（域必须等于自身 id），不校验动作是否已实现——内核不持有
// 插件方法清单，也不维护业务动词表（G-01）；"声明了却没实现"由插件自带测试守护。
func (m *Manifest) validatePostUpgrade() error {
	if m.PostUpgrade == "" {
		return nil
	}
	prefix := m.ID + "."
	action, ok := strings.CutPrefix(m.PostUpgrade, prefix)
	if !ok {
		return errf(pluginapi.E_INVALID,
			"post_upgrade=%q 必须以本插件 id 前缀 %q 开头", m.PostUpgrade, prefix)
	}
	if !methodActionPattern.MatchString(action) {
		return errf(pluginapi.E_INVALID,
			"post_upgrade=%q 的动作段 %q 不合法（段首小写字母，段内字母/数字/下划线，可点分）",
			m.PostUpgrade, action)
	}
	return nil
}

// validateMethodCapabilities 校验方法级能力覆盖（method_capabilities，可选字段）。
//
// 规则（fail-closed，任一不合即整份清单加载失败）：
//   - 条数 ≤ maxMethodCapabilities；
//   - 键必须是插件自身域：`<info.json.id>.<action>`，域不等于自身 id 视为越权声明；
//   - 动作段匹配 methodActionPattern（小写字母开头，可点分、段内可含下划线，
//     如 config.get / verify_file；连字符仍非法）；
//   - 值只能是 6 项特权能力之一——插件自有 `<id>:<action>` 不在此表（内核不解释其语义）。
//
// 未声明的方法不在本函数校验范围：运行期回退插件级 capabilities（向后兼容）。
func (m *Manifest) validateMethodCapabilities() error {
	if len(m.MethodCapabilities) == 0 {
		return nil
	}
	if len(m.MethodCapabilities) > maxMethodCapabilities {
		return errf(pluginapi.E_INVALID, "method_capabilities 最多 %d 条，当前 %d",
			maxMethodCapabilities, len(m.MethodCapabilities))
	}
	prefix := m.ID + "."
	methods := make([]string, 0, len(m.MethodCapabilities))
	for method := range m.MethodCapabilities {
		methods = append(methods, method)
	}
	sort.Strings(methods) // 固定错误顺序：map 遍历随机，门禁与回显需要可复现
	for _, method := range methods {
		capability := m.MethodCapabilities[method]
		// 唯一分割点：<id> 与 <action> 之间的那个「.」。idPattern 不含下划线与点，
		// 边界唯一无歧义；action 此后只做整段正则匹配，不再按 '.' / '_' 切分。
		action, ok := strings.CutPrefix(method, prefix)
		if !ok || action == "" {
			return errf(pluginapi.E_INVALID,
				"method_capabilities 的键 %q 必须以插件自身 id 为域（应为 %s<action>）", method, prefix)
		}
		if !methodActionPattern.MatchString(action) {
			return errf(pluginapi.E_INVALID,
				"method_capabilities 的键 %q 动作段 %q 非法：应为小写字母开头的点分标识符（段内可含下划线，如 config.get / verify_file；不接受连字符）",
				method, action)
		}
		if _, ok := privilegedCapabilities[capability]; !ok {
			return errf(pluginapi.E_INVALID,
				"method_capabilities[%q]=%q 必须是 6 项特权能力之一（system:read|system:admin|net:read|net:write|proc:read|proc:write）",
				method, capability)
		}
	}
	return nil
}

// validateResources 校验 resources 三项的取值区间与 cpu_quota 形态。
func (m *Manifest) validateResources() error {
	r := m.Resources
	if r.MemoryMB < minMemoryMB || r.MemoryMB > maxMemoryMB {
		return errf(pluginapi.E_INVALID, "resources.memory_mb=%d 超出 %d–%d", r.MemoryMB, minMemoryMB, maxMemoryMB)
	}
	if r.PidsMax < minPidsMax || r.PidsMax > maxPidsMax {
		return errf(pluginapi.E_INVALID, "resources.pids_max=%d 超出 %d–%d", r.PidsMax, minPidsMax, maxPidsMax)
	}
	match := cpuQuotaPattern.FindStringSubmatch(r.CPUQuota)
	if match == nil {
		return errf(pluginapi.E_INVALID, "resources.cpu_quota=%q 必须是 \"N%%\" 形态", r.CPUQuota)
	}
	percent, err := strconv.Atoi(match[1])
	if err != nil || percent < minCPUQuota || percent > maxCPUQuota {
		return errf(pluginapi.E_INVALID, "resources.cpu_quota=%q 超出 %d%%–%d%%", r.CPUQuota, minCPUQuota, maxCPUQuota)
	}
	return nil
}

// validateTriggers 校验字符串数组触发声明：空数组合法，元素为 "<type>:<name>"。
//
// 三类触发：event 的 name 必须是 <域>.<事件>（如 cert.renew_due）；invoke 允许单段
// 动作词（如 run）；schedule 交给宿主调度器（M2 生效），M1 只做非空校验。
func (m *Manifest) validateTriggers() error {
	for index, trigger := range m.Triggers {
		if err := validateTrigger(trigger); err != nil {
			return errf(pluginapi.E_INVALID, "triggers[%d]=%q：%s", index, trigger, err.Error())
		}
	}
	return nil
}

// validateTrigger 校验单条 "<type>:<name>"：先切第一个 ":"，再按 type 校验 name。
func validateTrigger(trigger string) error {
	kind, name, ok := strings.Cut(trigger, ":")
	if !ok {
		return fmt.Errorf("缺少 \"<type>:\" 前缀（应为 event|schedule|invoke）")
	}
	switch kind {
	case "event":
		if !eventNamePattern.MatchString(name) {
			return fmt.Errorf("event 的 name=%q 应为 <域>.<事件>（如 cert.renew_due）", name)
		}
	case "invoke":
		if !invokeNamePattern.MatchString(name) {
			return fmt.Errorf("invoke 的 name=%q 应为小写动词或 <域>.<事件>", name)
		}
	case "schedule":
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("schedule 缺少 name")
		}
	default:
		return fmt.Errorf("type=%q 不在 event|schedule|invoke 内", kind)
	}
	return nil
}

// validateRootActions 校验 ADR-0018 的 requires_root / root_actions。
//
// 内核只校验 schema（id 语法、argv 固定且非空、argv[0] 白名单、timeout 区间），
// 不判断"这是防火墙动作"——业务语义留在插件自己的 id 与 description（G-01）。
func (m *Manifest) validateRootActions() error {
	if len(m.RootActions) > maxRootActions {
		return errf(pluginapi.E_INVALID, "root_actions 最多 %d 条，当前 %d", maxRootActions, len(m.RootActions))
	}
	if len(m.RootActions) > 0 && !m.RequiresRoot {
		return errf(pluginapi.E_INVALID, "声明了 root_actions 必须同时设置 requires_root:true")
	}
	seen := make(map[string]struct{}, len(m.RootActions))
	for index, action := range m.RootActions {
		if _, ok := seen[action.ID]; ok {
			return errf(pluginapi.E_INVALID, "root_actions[%d].id=%q 重复", index, action.ID)
		}
		seen[action.ID] = struct{}{}
		if err := privilege.ValidateAction(action); err != nil {
			return errf(pluginapi.E_INVALID, "root_actions[%d]（id=%q）非法：%v", index, action.ID, err)
		}
	}
	return nil
}

// validateExtras 校验可选字段：依赖/冲突 id、场景标签、深度等级、体积。
func (m *Manifest) validateExtras() error {
	for _, id := range append(append([]string{}, m.DependsOn...), m.Conflicts...) {
		if !idPattern.MatchString(id) || strings.Contains(id, "--") {
			return errf(pluginapi.E_INVALID, "depends_on/conflicts 中的 id=%q 不合法", id)
		}
	}
	for _, tag := range m.ScenarioTags {
		if _, ok := scenarioTagWhitelist[tag]; !ok {
			return errf(pluginapi.E_INVALID, "scenario_tags 取值 %q 不在 web/data/ops/sec/app 内", tag)
		}
	}
	if m.DepthLevel != "" {
		if _, ok := depthLevels[m.DepthLevel]; !ok {
			return errf(pluginapi.E_INVALID, "depth_level=%q 必须是 production|basic", m.DepthLevel)
		}
	}
	if m.SizeBytes < 0 {
		return errf(pluginapi.E_INVALID, "size_bytes=%d 不能为负", m.SizeBytes)
	}
	return nil
}

// RuntimeSupported 报告当前内核能否运行该 lifecycle。
//
// 三种取值全部运行期支持：resident 常驻、lazy 按需冷启+空闲退出、oneshot
// 每次 invoke 拉起且执行完立即退出（空闲 0 进程）。未知取值仍 E_INVALID，
// 不做静默降级——非法清单必须在 enable 阶段就被拦下并原样回显。
func (m *Manifest) RuntimeSupported() error {
	switch m.Lifecycle {
	case LifecycleResident, LifecycleLazy, LifecycleOneshot:
		return nil
	default:
		return errf(pluginapi.E_INVALID, "插件 %s 的 lifecycle=%q 非法", m.ID, m.Lifecycle)
	}
}
