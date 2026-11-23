package pluginapi

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// RootAction 是 info.json 的 root_actions 元素（ADR-0018）。
//
// 协议口径：argv 是**固定数组**，不经 shell；内核不认识 ufw/nginx 等业务语义，
// 只按本文件定义的 schema 校验——命令白名单是协议的一部分，不是内核的业务词表
// （G-01：内核不判断"这是防火墙动作"）。
type RootAction struct {
	// ID 动作标识，匹配 ^[a-z][a-z0-9-]*$，同一插件内唯一。
	ID string `json:"id"`
	// Argv 固定命令数组，argv[0] 必须是绝对路径或 RootCommandAllowlist 中的命令名。
	Argv []string `json:"argv"`
	// TimeoutS 单次执行上限（秒），范围 1–300。
	TimeoutS int `json:"timeout_s"`
	// Description 面向用户的说明，启用时展示确认。
	Description string `json:"description,omitempty"`
	// Irreversible 为 true 时必须携带一次性 confirm 令牌才能执行。
	Irreversible bool `json:"irreversible,omitempty"`
}

// root_actions schema 上限（协议常量；改值属协议变更，走 ADR）。
const (
	// MaxRootArgs 是单条动作 argv 的元素上限（含 argv[0]）。
	MaxRootArgs = 32
	// MaxRootArgRunes 是单个参数的最大字符数。
	MaxRootArgRunes = 256
	// MaxRootArgvRunes 是 argv 拼接后的总字符上限。
	MaxRootArgvRunes = 4096
	// MaxRootActionDescriptionRunes 是 description 的最大字符数。
	MaxRootActionDescriptionRunes = 200
	// MinRootTimeoutS / MaxRootTimeoutS 是 timeout_s 的协议区间。
	MinRootTimeoutS = 1
	MaxRootTimeoutS = 300
)

// rootActionIDPattern 是 root_actions[].id 的协议正则。
var rootActionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// RootCommandAllowlist 是 argv[0] 允许的**命令名集合**（协议数据，由
// RootCommandPolicies 派生，保持向后兼容的只读视图）。
//
// 只回答"允许执行哪些程序"已不够：真正的安全边界在 rootpolicy.go 的**形状**表
// （子命令 + 参数形状 + 追加参数形状）。新增命令必须同时给出形状，否则不放行。
var RootCommandAllowlist = derivedCommandAllowlist()

// derivedCommandAllowlist 从 RootCommandPolicies 派生命令名集合。
func derivedCommandAllowlist() map[string]struct{} {
	names := make(map[string]struct{}, len(RootCommandPolicies))
	for name := range RootCommandPolicies {
		names[name] = struct{}{}
	}
	return names
}

// ValidateRootAction 校验单条 root_actions 的 schema；错误信息面向插件作者。
//
// 本函数不查重（跨条目 id 唯一性由清单解析层负责），也不判断业务含义。
func ValidateRootAction(action RootAction) error {
	if !rootActionIDPattern.MatchString(action.ID) {
		return fmt.Errorf("id=%q 必须匹配 ^[a-z][a-z0-9-]*$", action.ID)
	}
	if len(action.Argv) == 0 {
		return fmt.Errorf("argv 不能为空")
	}
	if len(action.Argv) > MaxRootArgs {
		return fmt.Errorf("argv 最多 %d 个元素（当前 %d）", MaxRootArgs, len(action.Argv))
	}
	total := 0
	for index, arg := range action.Argv {
		if arg == "" {
			return fmt.Errorf("argv[%d] 不能为空", index)
		}
		if utf8.RuneCountInString(arg) > MaxRootArgRunes {
			return fmt.Errorf("argv[%d] 超过 %d 个字符", index, MaxRootArgRunes)
		}
		if strings.ContainsRune(arg, 0) || hasControlRune(arg) {
			return fmt.Errorf("argv[%d] 含 NUL/控制字符", index)
		}
		total += utf8.RuneCountInString(arg)
	}
	if total > MaxRootArgvRunes {
		return fmt.Errorf("argv 总长度超过 %d 个字符", MaxRootArgvRunes)
	}
	if err := validateArgv0(action.Argv[0]); err != nil {
		return err
	}
	// 形状校验：声明 argv 必须整体落在受控命令形状内（子命令 + 参数形状）。
	// 追加参数在执行期由 privilege 用 ValidateRootAppendedArgv 另行校验。
	if err := ValidateRootArgv(action.Argv); err != nil {
		return err
	}
	if action.TimeoutS < MinRootTimeoutS || action.TimeoutS > MaxRootTimeoutS {
		return fmt.Errorf("timeout_s=%d 超出 %d–%d", action.TimeoutS, MinRootTimeoutS, MaxRootTimeoutS)
	}
	if utf8.RuneCountInString(action.Description) > MaxRootActionDescriptionRunes {
		return fmt.Errorf("description 超过 %d 个字符", MaxRootActionDescriptionRunes)
	}
	return nil
}

// validateArgv0 校验 argv[0]：绝对路径（无 ..、非根）或白名单命令名。
func validateArgv0(program string) error {
	if strings.HasPrefix(program, "/") {
		cleaned := path.Clean(program)
		if cleaned == "/" || cleaned != program || strings.Contains(cleaned, "..") {
			return fmt.Errorf("argv[0]=%q 不是规范化的绝对路径", program)
		}
		return nil
	}
	if strings.ContainsAny(program, `/\`) {
		return fmt.Errorf("argv[0]=%q 既不是绝对路径也不是命令名", program)
	}
	if _, ok := RootCommandAllowlist[program]; !ok {
		return fmt.Errorf("argv[0]=%q 不在命令白名单内（允许：%s）", program, allowedCommandNames())
	}
	return nil
}

// hasControlRune 报告字符串是否含 ASCII 控制字符（含 \n、\t）。
func hasControlRune(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// allowedCommandNames 返回排序后的白名单命令名，用于错误提示。
func allowedCommandNames() string {
	names := make([]string, 0, len(RootCommandAllowlist))
	for name := range RootCommandAllowlist {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, "/")
}
