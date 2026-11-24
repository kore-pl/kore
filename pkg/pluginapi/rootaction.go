package pluginapi

import (
	"fmt"
	"path"
	"path/filepath"
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
	// Description 面向用户的说明，启用时展示确认；写宿主动作同时作为变更账本的人话摘要。
	Description string `json:"description,omitempty"`
	// Irreversible 为 true 时必须携带一次性 confirm 令牌才能执行。
	Irreversible bool `json:"irreversible,omitempty"`
	// WritesHost 声明本动作会修改安装目录之外的宿主状态（ADR-0023 §3.5 #3）。
	// 为 true 时：Target 必填；成功后内核必须追加一条 changes.jsonl；未带 PurgeOp
	// 的写宿主动作按不可逆处理（需一次性 confirm 令牌）。
	WritesHost bool `json:"writes_host,omitempty"`
	// Target 是影响对象（人话，如 `/etc/nginx/conf.d/kore-a.conf` / `22/tcp`）；
	// WritesHost 为 true 时必填，写进变更账本供用户看懂"改了什么"。
	Target string `json:"target,omitempty"`
	// PurgeOp 是**结构化**回滚操作；账本不存 shell 命令字符串（ADR-0023 §3.4）。
	// 为 nil 时动作不可回滚：只能作为 confirmation 后的不可逆动作执行。
	PurgeOp *PurgeOp `json:"purge_op,omitempty"`
	// FileWrite 声明本动作是**受控文件写**而不是执行外部命令（ADR-0052 裁决 A）。
	//
	// 与 Argv 互斥：file_write 动作不声明 argv，请求体改用 `args[0]`（文件名）+
	// `content`（正文）。非 nil 时 WritesHost 必须为 true、Target 必须等于类别目录。
	FileWrite *FileWrite `json:"file_write,omitempty"`
}

// PurgeOp 是结构化回滚操作：白名单 kind + 参数，由内核分派执行，永不拼 shell。
//
// 为什么结构化：以 root 执行账本里的任意字符串等于把 RCE 面写进文件；结构化 op
// 只允许已知 kind + 受校验参数，未知 kind 一律拒绝（不猜、不兜底）。
type PurgeOp struct {
	// Kind 是白名单操作类型：file.remove / file.restore。
	Kind string `json:"kind"`
	// Args 是操作参数（file.remove: [path]；file.restore: [原文件, 目标]）。
	Args []string `json:"args"`
}

// 结构化回滚操作的白名单 kind（新增 kind 属安全边界调整，须同步 ADR-0023）。
const (
	// PurgeKindFileRemove 删除单个文件。
	PurgeKindFileRemove = "file.remove"
	// PurgeKindFileRestore 用备份覆盖目标文件（rename）。
	PurgeKindFileRestore = "file.restore"
)

// validatePurgeOp 校验结构化回滚操作：kind 白名单 + 参数个数 + 绝对路径（非根、无 ..）。
func validatePurgeOp(op *PurgeOp) error {
	if op == nil {
		return fmt.Errorf("purge_op 为空")
	}
	var args []string
	switch op.Kind {
	case PurgeKindFileRemove:
		args = op.Args
		if len(args) != 1 {
			return fmt.Errorf("purge_op kind=file.remove 需要 1 个参数（path），当前 %d 个", len(args))
		}
	case PurgeKindFileRestore:
		args = op.Args
		if len(args) != 2 {
			return fmt.Errorf("purge_op kind=file.restore 需要 2 个参数（原文件, 目标），当前 %d 个", len(args))
		}
	default:
		return fmt.Errorf("purge_op kind=%q 不在白名单内（允许：%s / %s）",
			op.Kind, PurgeKindFileRemove, PurgeKindFileRestore)
	}
	for index, arg := range args {
		if err := validatePurgePath(arg); err != nil {
			return fmt.Errorf("purge_op args[%d]: %w", index, err)
		}
	}
	return nil
}

// validatePurgePath 拒绝空路径 / 相对路径 / 根目录 / 含 .. 的路径，避免误删。
func validatePurgePath(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("路径为空")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("路径必须是绝对路径: %s", path)
	}
	cleaned := filepath.Clean(path)
	if cleaned == "/" || cleaned == "." {
		return fmt.Errorf("拒绝操作根路径: %s", path)
	}
	// Clean 会把 `..` 折叠掉（`/etc/../passwd` → `/passwd`），因此必须比对原串：
	// 非规范化路径一律拒绝，否则「含 ..」的路径能绕过字符串检查。
	if cleaned != path {
		return fmt.Errorf("路径必须是规范化绝对路径（不得含 .. 或重复分隔符）: %s", path)
	}
	return nil
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
	// file_write 动作与 exec 动作是**互斥的两种形状**：前者不执行外部命令（无 argv），
	// 后者必须有 argv。混在一起会让审计/confirm 口径分叉，因此逐字段拒绝。
	if action.FileWrite != nil {
		if err := validateFileWriteAction(action); err != nil {
			return err
		}
		// 写文件不跑子进程，timeout_s 无意义；允许缺省 0，填了就必须合法。
		if action.TimeoutS != 0 && (action.TimeoutS < MinRootTimeoutS || action.TimeoutS > MaxRootTimeoutS) {
			return fmt.Errorf("timeout_s=%d 超出 %d–%d", action.TimeoutS, MinRootTimeoutS, MaxRootTimeoutS)
		}
	} else {
		if len(action.Argv) == 0 {
			return fmt.Errorf("argv 不能为空")
		}
		if err := validateArgvSchema(action.Argv); err != nil {
			return err
		}
		if action.TimeoutS < MinRootTimeoutS || action.TimeoutS > MaxRootTimeoutS {
			return fmt.Errorf("timeout_s=%d 超出 %d–%d", action.TimeoutS, MinRootTimeoutS, MaxRootTimeoutS)
		}
	}
	if utf8.RuneCountInString(action.Description) > MaxRootActionDescriptionRunes {
		return fmt.Errorf("description 超过 %d 个字符", MaxRootActionDescriptionRunes)
	}
	// 写宿主动作必须能让用户看懂「改了什么」：target 是必填项，不是可选装饰。
	if action.WritesHost {
		if strings.TrimSpace(action.Target) == "" {
			return fmt.Errorf("writes_host=true 时 target 必填（影响对象，如 /etc/nginx/conf.d/x.conf）")
		}
		if utf8.RuneCountInString(action.Target) > MaxRootActionDescriptionRunes {
			return fmt.Errorf("target 超过 %d 个字符", MaxRootActionDescriptionRunes)
		}
	}
	if action.PurgeOp != nil {
		if !action.WritesHost {
			return fmt.Errorf("purge_op 仅在 writes_host=true 时有效（回滚信息必须绑定写宿主动作）")
		}
		if err := validatePurgeOp(action.PurgeOp); err != nil {
			return err
		}
	}
	return nil
}

// validateArgvSchema 校验 argv 的通用 schema 与受控形状（exec 动作专用）。
func validateArgvSchema(argv []string) error {
	if len(argv) > MaxRootArgs {
		return fmt.Errorf("argv 最多 %d 个元素（当前 %d）", MaxRootArgs, len(argv))
	}
	total := 0
	for index, arg := range argv {
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
	if err := validateArgv0(argv[0]); err != nil {
		return err
	}
	// 形状校验：声明 argv 必须整体落在受控命令形状内（子命令 + 参数形状）。
	// 追加参数在执行期由 privilege 用 ValidateRootAppendedArgv 另行校验。
	return ValidateRootArgv(argv)
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
