// Package pluginapitest 提供插件清单的公开自检入口，供插件作者在测试中
// 一次性校验自己的 info.json 与公开 SDK / 协议声明是否一致。
//
// 用法（在插件仓的 *_test.go 里）：
//
//	func TestInfoJSON(t *testing.T) {
//		pluginapitest.CheckInfoJSON(t, "info.json")
//	}
//
// 校验范围是协议里**由公开 SDK 定义**的三块声明，不重复内核安装期的全量清单校验
// （必填字段、resources 区间、triggers 语法等仍由内核 registry.Parse 负责）：
//
//  1. root_actions：条目数 ≤16、id 唯一、requires_root 与 root_actions 一致、
//     每条通过 pluginapi.ValidateRootAction（ADR-0018 schema + ADR-0022 命令形状）；
//  2. method_capabilities：≤64 条、键域必须是插件自身 id、动作段语法、值必须是
//     6 项特权能力之一、且**不得强于**插件级 capabilities 的声明（方法级只收窄、不放大：
//     同域 read < write < admin，跨域视为放大；协议 §3.1.2.1 的示例
//     capabilities=["system:admin"] + 方法级 "system:read" 属合法收窄）；
//  3. capabilities：1–16 项、去重、语法、特权能力或插件自有 <id>:<action> 域。
//
// 未知字段按 encoding/json 默认行为忽略（向前兼容）；但 method_capabilities 的
// **重复键**会被拒绝——标准库对重复键是「后者覆盖」，对权限声明等价于静默提权/降权。
package pluginapitest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 协议常量（与 PLUGIN-PROTOCOL §3.1.2 / §3.1.3 一致；改值属协议变更，走 ADR）。
const (
	// MaxCapabilities 是插件级能力声明上限。
	MaxCapabilities = 16
	// MaxMethodCapabilities 是方法级能力覆盖条数上限。
	MaxMethodCapabilities = 64
	// MaxRootActions 是 root_actions 条目上限。
	MaxRootActions = 16
)

var (
	// capabilityPattern 是能力项语法：<域>:<动作>，两段均为小写短横线标识符。
	capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}:[a-z][a-z0-9-]{0,30}$`)
	// methodActionPattern 是方法级能力键的动作段：小写字母开头，允许点分。
	// 字符集与内核 internal/core/registry 的 methodActionPattern **逐字一致**（ADR-0047）：
	// 段内允许字母/数字/下划线（camelCase | snake_case），段首限小写字母，不接受连字符。
	// 两处必须同一变更集同改，否则「插件自检通过、内核装不上」或反之。
	methodActionPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$`)
	// privilegedCapabilities 是内核唯一认识的 6 项宿主级能力。
	privilegedCapabilities = map[string]struct{}{
		"system:read": {}, "system:admin": {},
		"net:read": {}, "net:write": {},
		"proc:read": {}, "proc:write": {},
	}
)

// infoJSON 是自检关心的 info.json 子集；其余字段不解析（未知字段忽略）。
type infoJSON struct {
	ID                 string                 `json:"id"`
	Capabilities       []string               `json:"capabilities"`
	MethodCapabilities json.RawMessage        `json:"method_capabilities"`
	RequiresRoot       bool                   `json:"requires_root"`
	RootActions        []pluginapi.RootAction `json:"root_actions"`
}

// ValidateInfoFile 读取 info.json 并校验，等价于 ValidateInfoJSON(文件内容)。
func ValidateInfoFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取 %s: %w", path, err)
	}
	if err := ValidateInfoJSON(data); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// CheckInfoJSON 是测试用适配器：校验失败时调用 t.Fatalf 并带上完整错误清单。
//
// 用 testing.TB 而不是 *testing.T，便于在子测试、基准与自定义断言里复用。
func CheckInfoJSON(t testing.TB, path string) {
	t.Helper()
	if err := ValidateInfoFile(path); err != nil {
		t.Fatalf("info.json 自检失败：\n%v", err)
	}
}

// ValidateInfoJSON 校验 info.json 的公开协议声明；返回 nil 表示全部通过，
// 否则用 errors.Join 汇总**所有**违规项（不是遇到第一条就返回），便于一次修完。
func ValidateInfoJSON(data []byte) error {
	var doc infoJSON
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("info.json 不是合法 JSON：%w", err)
	}

	var problems []error
	if doc.ID == "" {
		problems = append(problems, errors.New("info.json 缺 id：method_capabilities / capabilities 的域校验需要它"))
	}
	problems = append(problems, validateCapabilities(doc.ID, doc.Capabilities)...)

	methodCaps, decodeProblems := decodeMethodCapabilities(doc.MethodCapabilities)
	problems = append(problems, decodeProblems...)
	problems = append(problems, validateMethodCapabilities(doc.ID, methodCaps, doc.Capabilities)...)

	problems = append(problems, validateRootActions(doc.RequiresRoot, doc.RootActions)...)

	return errors.Join(problems...)
}

// validateCapabilities 校验插件级能力声明。
func validateCapabilities(pluginID string, capabilities []string) []error {
	if len(capabilities) == 0 {
		return []error{fmt.Errorf("capabilities 不能为空（至少 1 项，上限 %d）", MaxCapabilities)}
	}
	var problems []error
	if len(capabilities) > MaxCapabilities {
		problems = append(problems, fmt.Errorf("capabilities 最多 %d 项，当前 %d", MaxCapabilities, len(capabilities)))
	}
	seen := make(map[string]struct{}, len(capabilities))
	for index, capability := range capabilities {
		if _, ok := seen[capability]; ok {
			problems = append(problems, fmt.Errorf("capabilities[%d]=%q 重复", index, capability))
			continue
		}
		seen[capability] = struct{}{}
		if !capabilityPattern.MatchString(capability) {
			problems = append(problems, fmt.Errorf("capabilities[%d]=%q 语法非法，应为 <域>:<动作>", index, capability))
			continue
		}
		if _, ok := privilegedCapabilities[capability]; ok {
			continue
		}
		domain, _, _ := strings.Cut(capability, ":")
		if pluginID != "" && domain != pluginID {
			problems = append(problems, fmt.Errorf(
				"capabilities[%d]=%q 的能力域 %q 必须等于插件 id %q（或使用 6 项特权能力）",
				index, capability, domain, pluginID))
		}
	}
	return problems
}

// decodeMethodCapabilities 解析 method_capabilities：必须是 JSON 对象、键唯一。
//
// 不用 map[string]string 直接 Unmarshal，因为标准库对重复键「后者覆盖」——对权限
// 声明等价于静默提权/降权，必须 fail-closed（与内核 MethodCapabilities.UnmarshalJSON
// 的口径一致）。
func decodeMethodCapabilities(raw json.RawMessage) (map[string]string, []error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, []error{fmt.Errorf("method_capabilities 解析失败：%w", err)}
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, []error{errors.New("method_capabilities 必须是 JSON 对象（键为 <id>.<action>，值为能力字符串）")}
	}

	declared := make(map[string]string)
	var problems []error
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, append(problems, fmt.Errorf("method_capabilities 键解析失败：%w", err))
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, append(problems, errors.New("method_capabilities 的键必须是字符串"))
		}
		if _, exists := declared[key]; exists {
			problems = append(problems, fmt.Errorf("method_capabilities 含重复键 %q（重复键会导致静默覆盖）", key))
		}
		var capability string
		if err := decoder.Decode(&capability); err != nil {
			return nil, append(problems, fmt.Errorf("method_capabilities[%q] 的值必须是字符串：%w", key, err))
		}
		declared[key] = capability
	}
	if _, err := decoder.Token(); err != nil {
		return nil, append(problems, fmt.Errorf("method_capabilities 解析失败：%w", err))
	}
	return declared, problems
}

// validateMethodCapabilities 校验方法级能力覆盖。
//
// 一致性规则（只收窄、不放大）：方法级能力按「域 + 强度」与插件级声明比较，
// 同域内 read < write < admin；域必须已在插件级声明，强度不得超过该域的最高声明。
// 例：capabilities=["system:admin"] + 方法级 "system:read" 合法（收窄）；
// capabilities=["system:read"] + 方法级 "system:admin" 非法（放大，用户启用时
// 只确认了 read）。内核当前解析不阻止放大，但那样会让「用户确认的能力清单」小于
// 「实际生效能力」——等于隐藏提权，自检入口按更严口径拒绝并给出修复建议。
func validateMethodCapabilities(pluginID string, methodCaps map[string]string, capabilities []string) []error {
	if len(methodCaps) == 0 {
		return nil
	}
	var problems []error
	if len(methodCaps) > MaxMethodCapabilities {
		problems = append(problems, fmt.Errorf(
			"method_capabilities 最多 %d 条，当前 %d", MaxMethodCapabilities, len(methodCaps)))
	}

	// 插件级每个宿主域的声明强度：system/net/proc → read < write < admin。
	declaredStrength := make(map[string]int, 3)
	declaredName := make(map[string]string, 3)
	for _, capability := range capabilities {
		domain, rank, privileged := capabilityDomainRank(capability)
		if !privileged {
			continue
		}
		if existing, ok := declaredStrength[domain]; !ok || rank > existing {
			declaredStrength[domain] = rank
			declaredName[domain] = capability
		}
	}

	// map 遍历顺序随机；排序保证错误清单可复现。
	methods := make([]string, 0, len(methodCaps))
	for method := range methodCaps {
		methods = append(methods, method)
	}
	sort.Strings(methods)

	prefix := pluginID + "."
	for _, method := range methods {
		capability := methodCaps[method]
		if pluginID == "" {
			// 缺 id 已单独报错，这里不重复刷屏。
			continue
		}
		action, ok := strings.CutPrefix(method, prefix)
		if !ok || action == "" {
			problems = append(problems, fmt.Errorf(
				"method_capabilities 的键 %q 必须以插件自身 id 为域（应为 %s<action>）", method, prefix))
			continue
		}
		if !methodActionPattern.MatchString(action) {
			problems = append(problems, fmt.Errorf(
				"method_capabilities 的键 %q 动作段 %q 非法：应为小写字母开头的点分标识符（段内可含下划线，如 config.get / verify_file；不接受连字符）",
				method, action))
			continue
		}
		if _, ok := privilegedCapabilities[capability]; !ok {
			problems = append(problems, fmt.Errorf(
				"method_capabilities[%q]=%q 必须是 6 项特权能力之一（system:read|system:admin|net:read|net:write|proc:read|proc:write）",
				method, capability))
			continue
		}
		domain, rank, _ := capabilityDomainRank(capability)
		declaredRank, declared := declaredStrength[domain]
		if !declared {
			problems = append(problems, fmt.Errorf(
				"method_capabilities[%q]=%q 的域 %q 未在插件级 capabilities 中声明："+
					"方法级只能收窄、不能跨域放大；如需该能力请加入 capabilities（启用时用户会确认）",
				method, capability, domain))
			continue
		}
		if rank > declaredRank {
			problems = append(problems, fmt.Errorf(
				"method_capabilities[%q]=%q 强于插件级声明 %q：方法级只能收窄、不能放大；"+
					"如需更高权限请把它加入 capabilities（启用时用户会确认），否则删除该条",
				method, capability, declaredName[domain]))
		}
	}
	return problems
}

// capabilityDomainRank 拆出宿主特权能力的域与强度：read=0 < write=1 < admin=2。
//
// 非宿主能力（插件自有 <id>:<action>）返回 privileged=false；宿主域里的未知动作
// 返回 rank=-1，调用方据此 fail-closed（本包只接受 6 项特权能力）。
func capabilityDomainRank(capability string) (domain string, rank int, privileged bool) {
	for _, candidate := range []string{"system", "net", "proc"} {
		action, ok := strings.CutPrefix(capability, candidate+":")
		if !ok {
			continue
		}
		switch action {
		case "read":
			return candidate, 0, true
		case "write":
			return candidate, 1, true
		case "admin":
			return candidate, 2, true
		default:
			return candidate, -1, true
		}
	}
	return "", -1, false
}

// validateRootActions 校验 ADR-0018 的 requires_root / root_actions 声明。
func validateRootActions(requiresRoot bool, actions []pluginapi.RootAction) []error {
	var problems []error
	if len(actions) == 0 {
		return nil
	}
	if !requiresRoot {
		problems = append(problems, errors.New(
			"声明了 root_actions 必须同时设置 requires_root:true（协议 §3.1.3）"))
	}
	if len(actions) > MaxRootActions {
		problems = append(problems, fmt.Errorf(
			"root_actions 最多 %d 条，当前 %d", MaxRootActions, len(actions)))
	}
	seen := make(map[string]int, len(actions))
	for index, action := range actions {
		if previous, ok := seen[action.ID]; ok {
			problems = append(problems, fmt.Errorf(
				"root_actions[%d].id=%q 与 root_actions[%d] 重复（同一插件内 id 必须唯一）",
				index, action.ID, previous))
		} else {
			seen[action.ID] = index
		}
		if err := pluginapi.ValidateRootAction(action); err != nil {
			problems = append(problems, fmt.Errorf(
				"root_actions[%d]（id=%q）非法：%w", index, action.ID, err))
		}
	}
	return problems
}
