package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 宿主特权能力前缀与动作分级（G-01：内核只认这三个前缀，不维护业务名词表）。
const (
	capPrefixSystem = "system:"
	capPrefixNet    = "net:"
	capPrefixProc   = "proc:"
)

// capabilityActionRead / Write / Admin 是宿主特权能力的动作分级词。
// 只有这三类语义，不对"这是删库还是删用户"做任何判断——那是插件自治范围。
const (
	capabilityActionRead  = "read"
	capabilityActionWrite = "write"
	capabilityActionAdmin = "admin"
)

// invokeCapRequirement 是一次 invoke 对调用方的最低授权要求。
type invokeCapRequirement struct {
	// name 是触发该要求的能力名（用于错误 message 与审计 reason）。
	name string
	// needAdmin 为 true 表示需要 system:admin（或会话能力集含该能力）。
	needAdmin bool
	// unsupported 为 true 表示插件声明了内核不认识的宿主特权动作（fail-closed）。
	unsupported bool
}

// requiredInvokeCapability 从插件声明的能力集推导 invoke 的最低授权要求。
//
// 规则（与 docs/PLUGIN-PROTOCOL.md §3.1.2 逐字一致）：
//   - 只解释 system:/net:/proc: 三个宿主前缀；插件自有 <id>:<action> 归插件自治，
//     内核不解释、也不要求会话具备它（G-01 薄壳红线）；
//   - read 动作（system:read / net:read / proc:read）→ 任意已登录会话可调；
//   - write/admin 动作（system:write / system:admin / net:write / proc:write）→ 需 admin；
//   - 宿主前缀下的其它动作内核不认识 → unsupported（不降级为只读，fail-closed）。
//
// 多项声明取最高要求：unsupported > admin > 只读 > 无要求。
func requiredInvokeCapability(declared []string) invokeCapRequirement {
	requirement := invokeCapRequirement{}
	for _, capability := range declared {
		action, isHost := hostCapabilityAction(capability)
		if !isHost {
			continue // 插件自有能力，内核不解释
		}
		switch action {
		case capabilityActionRead:
			// 只读：不提升要求（已有更高要求时保持不变）。
		case capabilityActionWrite, capabilityActionAdmin:
			if !requirement.unsupported && !requirement.needAdmin {
				requirement.needAdmin = true
				requirement.name = capability
			}
		default:
			// 未知宿主动作：内核不猜语义，整次调用 fail-closed；
			// 清掉已累积的 admin 要求，让 unsupported 成为唯一判定。
			requirement.unsupported = true
			requirement.needAdmin = false
			requirement.name = capability
		}
	}
	return requirement
}

// hostCapabilityAction 判断能力是否属于宿主特权前缀；是则返回动作段，否则 isHost=false。
func hostCapabilityAction(capability string) (action string, isHost bool) {
	for _, prefix := range [...]string{capPrefixSystem, capPrefixNet, capPrefixProc} {
		if rest, ok := strings.CutPrefix(capability, prefix); ok {
			return rest, true
		}
	}
	return "", false
}

// invokeAuth 是一次 invoke 鉴权结果，供审计层复用（避免二次读插件清单）。
type invokeAuth struct {
	// subject 是调用方会话 subject；未装配鉴权时为空。
	subject string
	// needAdmin 为 true 表示该方法按**最终生效能力**需要 admin（写/管理类），
	// 也是"默认写审计"的判据：方法级 read 覆盖后不再审计。
	needAdmin bool
}

// authorizeInvoke 是 /api/v1/invoke 的目标操作鉴权：先验会话，再按目标插件声明的
// 能力做调用校验（docs/PLUGIN-PROTOCOL §3.1.2「调用校验」）。方法级
// method_capabilities[<id>.<action>] 优先，未声明回退插件级 capabilities。
//
// 失败口径：
//   - 未登录 / 会话无 subject → 401 E_UNAUTHORIZED；
//   - 能力不足 → 403 E_UNAUTHORIZED，message 写明「该方法需要 <capability> 权限」；
//   - 插件声明了内核不认识的宿主特权能力 → 501 E_UNSUPPORTED（fail-closed）。
//
// 拒绝一律写 capability.denied 审计（subject / 插件 id / 方法 / 原因）。
// 返回的 invokeAuth 携带 subject 与 needAdmin，供调用方决定是否写 invoke.* 审计。
//
// 当前单管理员模式的诚实披露：auth.Session 未携带 capability 字段，默认
// CapabilityResolver 对任意有效会话返回 6 项全权，因此检查在生产路径恒通过；
// 多用户接入后注入 CapabilityResolver 即可生效（降级时会打一次 WARN）。
func (s *Server) authorizeInvoke(w http.ResponseWriter, r *http.Request) (invokeAuth, bool) {
	if s.auth == nil {
		return invokeAuth{}, true // M0 探活骨架未装配鉴权
	}
	subject, granted := s.capResolver(r)
	if subject == "" {
		writeError(w, http.StatusUnauthorized, pluginapi.E_UNAUTHORIZED, "未授权", "")
		return invokeAuth{}, false
	}
	if s.opts.CapabilityResolver == nil {
		s.warnCapabilityDegraded()
	}
	plugin, method := r.PathValue("plugin"), r.PathValue("method")
	requirement, known, err := s.effectiveInvokeRequirement(r.Context(), plugin, method)
	if err != nil {
		slog.Error("读取插件能力声明失败", "plugin", plugin, "err", err)
		writeError(w, http.StatusInternalServerError, pluginapi.E_INTERNAL, "读取插件能力声明失败", plugin)
		return invokeAuth{subject: subject}, false
	}
	if !known {
		// 插件不存在：不在鉴权层伪造 404，交给 Invoke 统一返回 E_NOTFOUND（无执行面）。
		return invokeAuth{subject: subject}, true
	}
	result := invokeAuth{subject: subject, needAdmin: requirement.needAdmin}
	if requirement.unsupported {
		s.auditDenied(subject, plugin, method, "插件声明了内核不支持的特权能力 "+requirement.name)
		writeError(w, http.StatusNotImplemented, pluginapi.E_UNSUPPORTED,
			"插件 "+plugin+" 声明了内核不支持的特权能力 "+requirement.name, requirement.name)
		return result, false
	}
	if requirement.needAdmin &&
		!hasCapability(granted, requirement.name) && !hasCapability(granted, "system:admin") {
		s.auditDenied(subject, plugin, method, "调用该插件需要 "+requirement.name+" 能力")
		writeError(w, http.StatusForbidden, pluginapi.E_UNAUTHORIZED,
			"该方法需要 "+requirement.name+" 权限", requirement.name)
		return result, false
	}
	return result, true
}

// pluginCapabilityDeclaration 是目标插件的完整能力声明（插件级 + 方法级）。
type pluginCapabilityDeclaration struct {
	// pluginLevel 是插件级 capabilities（未声明方法级时回退到这里）。
	pluginLevel []string
	// methodLevel 是 method_capabilities（完整方法名 → 6 项特权能力之一）；nil 表示未声明。
	methodLevel map[string]string
	// known 为 false 表示插件不存在（由 Invoke 统一返回 E_NOTFOUND）。
	known bool
}

// effectiveInvokeRequirement 解析本次 invoke 的最终生效能力要求。
//
// 取用顺序（PLUGIN-PROTOCOL §3.1.2）：
//  1. method_capabilities[<id>.<action>] 命中 → 只按该能力判定；
//  2. 未命中 → 回退插件级 capabilities（向后兼容，取最高要求）；
//
// 内核只比较能力字符串，不维护「方法 → 业务能力」映射表（G-01）。路径方法段可能是
// 裸动作（instances）或完整限定名（db-mysql.instances），统一归一成完整方法名再查表。
func (s *Server) effectiveInvokeRequirement(ctx context.Context, plugin, method string) (invokeCapRequirement, bool, error) {
	declaration, err := s.pluginCapabilityDeclaration(ctx, plugin)
	if err != nil {
		return invokeCapRequirement{}, false, err
	}
	if !declaration.known {
		return invokeCapRequirement{}, false, nil
	}
	if capability, ok := declaration.methodLevel[fullMethodName(plugin, method)]; ok {
		return requiredInvokeCapability([]string{capability}), true, nil
	}
	return requiredInvokeCapability(declaration.pluginLevel), true, nil
}

// fullMethodName 把路径中的方法段归一为协议完整方法名 `<plugin-id>.<action>`。
func fullMethodName(plugin, method string) string {
	if strings.HasPrefix(method, plugin+".") {
		return method
	}
	return plugin + "." + method
}

// pluginCapabilityDeclaration 读取目标插件的能力声明（插件级 + 方法级）。
//
// 首选装配层可选实现：PluginCapabilityLookup（插件级）与 PluginMethodCapabilityLookup
// （方法级），只读内存清单、无副作用；两者都未实现时回退 Backend.Plugin 的
// GrantedCapabilities + MethodCapabilities（与 info.json 同源）。
// 本层不读插件目录、不 import registry 内部实现（G-01）。
func (s *Server) pluginCapabilityDeclaration(ctx context.Context, id string) (pluginCapabilityDeclaration, error) {
	if s.opts.Backend == nil || id == "" {
		return pluginCapabilityDeclaration{}, nil
	}
	if lookup, ok := s.opts.Backend.(PluginCapabilityLookup); ok {
		pluginLevel, known, err := lookup.PluginCapabilities(ctx, id)
		if err != nil || !known {
			return pluginCapabilityDeclaration{}, err
		}
		declaration := pluginCapabilityDeclaration{pluginLevel: pluginLevel, known: true}
		if methodLookup, ok := s.opts.Backend.(PluginMethodCapabilityLookup); ok {
			methodLevel, _, err := methodLookup.PluginMethodCapabilities(ctx, id)
			if err != nil {
				return pluginCapabilityDeclaration{}, err
			}
			declaration.methodLevel = methodLevel
		}
		return declaration, nil
	}
	status, known, err := s.opts.Backend.Plugin(ctx, id)
	if err != nil || !known {
		return pluginCapabilityDeclaration{}, err
	}
	return pluginCapabilityDeclaration{
		pluginLevel: status.GrantedCapabilities,
		methodLevel: status.MethodCapabilities,
		known:       true,
	}, nil
}

// warnCapabilityDegraded 在未注入 CapabilityResolver（session 无 capability 字段）时
// 打一次 WARN，说明 capability 检查降级为 admin 模式。每进程一次，避免 invoke 热路径刷屏。
func (s *Server) warnCapabilityDegraded() {
	s.capDegradeOnce.Do(func() {
		slog.Warn("capability 检查降级为 admin 模式",
			"reason", "session 未携带 capability 字段",
			"mode", "single-admin",
			"impact", "当前全部有效会话视为 admin；多用户接入须注入 CapabilityResolver")
	})
}
