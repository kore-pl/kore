package registry

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

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
		m.validateResources,
		m.validateTriggers,
		m.validateExtras,
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
