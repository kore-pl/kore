package pluginapi

import (
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

// 本文件是 ADR-0052 受控文件写的**协议层**（裁决 A：扩内核受控写，不做目录授权）。
//
// 分层：
//   - 声明（info.json root_actions[].file_write）：插件只说"写哪一类文件、什么内容策略"，
//     不说具体目录——目录由内核 filewrite 的**白名单类别**决定（ADR-0028 §8）。
//   - 请求（POST /plugins/{id}/root-action）：args[0] 是**单层文件名**，content 是正文。
//   - 内容策略：本文件只分派；nginx 片段的语法 allowlist 在 nginxconf.go，
//     sshd drop-in 的 allowlist 在 sshdconf.go（ADR-0060）。
//
// 为什么 none of this 放 internal/core：thin-shell-check.sh 的业务词表含 nginx，
// 写进 cmd/ internal/ 直接 G-01 FAIL；协议策略与 RootCommandPolicies 同层（ADR-0022 先例）。

// MaxFileWriteContentBytes 是单次 file_write 正文的**协议硬顶**（ADR-0052；等于 ADR-0028
// §2 表的上限）。动作声明只能用它或更小的 max_bytes，不能放大——上限是安全边界不是建议值。
const MaxFileWriteContentBytes = 256 * 1024

// MaxFileWriteNameRunes 是请求文件名的最大字符数（单层文件名，不含目录）。
const MaxFileWriteNameRunes = 128

// FileWriteModeRoot0644 是 file_write 唯一允许的落盘权限（root:root 0644）。
//
// 用**字符串**而不是整数：JSON 里写 `644` 是十进制 0o1204（sticky+setuid 位混进来），
// 权限位的八进制/十进制歧义是经典坑，字符串把写法钉死成 `"0644"`。
const FileWriteModeRoot0644 = "0644"

// ContentPolicyNginxVHost 是 nginx vhost 片段的内容策略名。
const ContentPolicyNginxVHost = "nginx.vhost.v1"

// ContentPolicySSHDropin 是 sshd drop-in 片段的内容策略名（ADR-0060 / C12）。
const ContentPolicySSHDropin = "sshd.dropin.v1"

// FileWrite 是 root_actions[] 的可选声明（ADR-0052 裁决 A）。
//
// 形状判断（与 ADR 一致，否决 `dir`+`suffix` 式形状）：
//   - 不用 `dir`：让插件自报目标目录，校验器就只有「信任插件」或「协议层再维护一份路径
//     白名单」两条路——前者等于没有白名单，后者制造第二份真源。`prefix_class` 是符号名，
//     具体目录只在 FileWritePrefixClasses 里定义一次。
//   - 不用 `suffix`：`.conf` 是类别属性（`sh`/`py` 可执行脚本必须进不来），让插件声明
//     后缀等于把「写什么类型的文件」交给被校验方。
//   - `mode` 保留：只能是 "0644"；放宽属于安全边界调整，须改 ADR。
//   - `max_bytes` 保留：允许插件**自我收紧**（如 64 KiB），但不得超过协议硬顶。
type FileWrite struct {
	// PrefixClass 是白名单类别名（如 nginx.conf.d），必须存在于 FileWritePrefixClasses。
	PrefixClass string `json:"prefix_class"`
	// Mode 是落盘权限，目前只接受 "0644"。
	Mode string `json:"mode"`
	// ContentPolicy 是内容策略名；必须与类别定义一致（声明与类别不一致直接拒绝，不静默取类别值）。
	ContentPolicy string `json:"content_policy"`
	// MaxBytes 是本动作的正文上限；0 表示用类别默认值，否则必须 1..协议硬顶。
	MaxBytes int `json:"max_bytes,omitempty"`
}

// FileWriteClass 是一个白名单类别的内核侧定义（目录/后缀/权限/内容策略）。
//
// 新增类别 = 扩内核写面：必须先改 ADR-0028 §8 白名单并新增 ADR（ADR-0028 §7#1）。
type FileWriteClass struct {
	// PrefixClass 是类别名（与声明里的 prefix_class 对应）。
	PrefixClass string
	// Dir 是固定目录，**带尾斜杠**；插件不能指定、只能在这一层里写。
	Dir string
	// Suffix 是强制后缀（含点），与 Dir 一起构成路径形状。
	Suffix string
	// Mode 是唯一允许的权限位。
	Mode string
	// ContentPolicy 是本类别必须使用的内容策略。
	ContentPolicy string
	// MaxBytes 是类别默认上限（≤ MaxFileWriteContentBytes）。
	MaxBytes int
	// Owner 是要求的属主（K3 在 internal/platform 做属主校验）。
	Owner string
	// PluginNamePrefix 为 true 时文件名必须是 `kore-<plugin>-*.conf`（防横向覆盖他人 vhost）。
	PluginNamePrefix bool
}

// FileWritePrefixClasses 是受控写类别的**唯一实现**（协议数据）。
//
// 只放当前有消费者的类别（与 ADR-0022「未使用的命令不进表」同口径）：多一个类别就多一条
// 被误用路径。`/etc/nginx/conf.d/` 本身由 K3 加入 kernel filewrite 的 AllowedPrefixes。
var FileWritePrefixClasses = map[string]FileWriteClass{
	"nginx.conf.d": {
		PrefixClass:      "nginx.conf.d",
		Dir:              "/etc/nginx/conf.d/",
		Suffix:           ".conf",
		Mode:             FileWriteModeRoot0644,
		ContentPolicy:    ContentPolicyNginxVHost,
		MaxBytes:         MaxFileWriteContentBytes,
		Owner:            "root:root",
		PluginNamePrefix: true,
	},
	// sshd.config.d 是 C12 / ADR-0060 的 sshd drop-in 类目（方案 DESIGN-SSH-DROPIN §2.1）。
	// 目录、后缀、属主、文件名前缀与路径逃逸防护完全复用通用层，不新增校验代码。
	"sshd.config.d": {
		PrefixClass:      "sshd.config.d",
		Dir:              "/etc/ssh/sshd_config.d/",
		Suffix:           ".conf",
		Mode:             FileWriteModeRoot0644,
		ContentPolicy:    ContentPolicySSHDropin,
		MaxBytes:         MaxFileWriteContentBytes,
		Owner:            "root:root",
		PluginNamePrefix: true,
	},
}

// 文件名允许的字符集：域名（小写字母数字、点、连字符）与插件 id（小写字母数字、连字符）。
var fileWriteNamePattern = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$`)

// ValidateFileWrite 校验 file_write 声明本身（不含 argv/target 的跨字段一致性）。
func ValidateFileWrite(decl *FileWrite) error {
	if decl == nil {
		return fmt.Errorf("file_write 为空")
	}
	class, ok := FileWritePrefixClasses[decl.PrefixClass]
	if !ok {
		return fmt.Errorf("file_write.prefix_class=%q 不在白名单类别内（允许：%s）",
			decl.PrefixClass, fileWriteClassNames())
	}
	if decl.Mode != class.Mode {
		return fmt.Errorf("file_write.mode=%q 非法（类别 %s 只允许 %q）",
			decl.Mode, class.PrefixClass, class.Mode)
	}
	if decl.ContentPolicy != class.ContentPolicy {
		return fmt.Errorf("file_write.content_policy=%q 与类别 %s 的策略 %q 不一致（不允许静默取类别值）",
			decl.ContentPolicy, class.PrefixClass, class.ContentPolicy)
	}
	if decl.MaxBytes < 0 {
		return fmt.Errorf("file_write.max_bytes=%d 不能为负", decl.MaxBytes)
	}
	if decl.MaxBytes > class.MaxBytes || decl.MaxBytes > MaxFileWriteContentBytes {
		return fmt.Errorf("file_write.max_bytes=%d 超过上限 %d（只能收紧，不能放大）",
			decl.MaxBytes, class.MaxBytes)
	}
	return nil
}

// fileWriteClassNames 返回排序后的类别名，用于错误提示。
func fileWriteClassNames() string {
	names := make([]string, 0, len(FileWritePrefixClasses))
	for name := range FileWritePrefixClasses {
		names = append(names, name)
	}
	// 只有一个类别也走排序路径，新增时提示稳定。
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && names[j] < names[j-1]; j-- {
			names[j], names[j-1] = names[j-1], names[j]
		}
	}
	return strings.Join(names, "/")
}

// ValidateFileWriteTarget 校验 writes_host 的 target：必须是类别目录本身。
//
// 为什么要求逐字相等：target 是变更账本里的人话影响对象（ADR-0023 §3.5 #3）。写文件的
// 实际路径由「类别目录 + 文件名」在**执行时**得到；声明里若能随便填目标，账本就会写一个
// 与真实写入无关的路径，用户按账本回滚会回滚错对象。
func ValidateFileWriteTarget(decl *FileWrite, target string) error {
	if decl == nil {
		return fmt.Errorf("file_write 为空")
	}
	class, ok := FileWritePrefixClasses[decl.PrefixClass]
	if !ok {
		return fmt.Errorf("file_write.prefix_class=%q 不在白名单类别内", decl.PrefixClass)
	}
	if target != class.Dir {
		return fmt.Errorf("file_write 动作的 target 必须是类别目录 %q（当前 %q）", class.Dir, target)
	}
	return nil
}

// ValidateFileWriteName 校验请求里的文件名：单层、在类别目录内、带类别后缀、
// 且（类别要求时）以 `kore-<plugin>-` 开头。
//
// 这一层挡的是**横向覆盖**：同目录下可能有其它插件/其它站点的片段，名字必须能被归属。
func ValidateFileWriteName(pluginID string, decl *FileWrite, name string) error {
	if decl == nil {
		return fmt.Errorf("file_write 为空")
	}
	class, ok := FileWritePrefixClasses[decl.PrefixClass]
	if !ok {
		return fmt.Errorf("file_write.prefix_class=%q 不在白名单类别内", decl.PrefixClass)
	}
	if name == "" {
		return fmt.Errorf("文件名不能为空")
	}
	if utf8.RuneCountInString(name) > MaxFileWriteNameRunes {
		return fmt.Errorf("文件名超过 %d 个字符", MaxFileWriteNameRunes)
	}
	if strings.ContainsAny(name, "/\\\x00\n\r\t") {
		return fmt.Errorf("文件名必须是单层名字（不得含路径分隔符/控制字符）：%q", name)
	}
	if name == "." || name == ".." || strings.Contains(name, "..") {
		return fmt.Errorf("文件名不得含 ..：%q", name)
	}
	if !fileWriteNamePattern.MatchString(name) {
		return fmt.Errorf("文件名含非法字符（只允许字母数字 . _ -）：%q", name)
	}
	if !strings.HasSuffix(name, class.Suffix) {
		return fmt.Errorf("文件名必须以 %q 结尾：%q", class.Suffix, name)
	}
	if class.PluginNamePrefix {
		prefix := "kore-" + pluginID + "-"
		if !strings.HasPrefix(name, prefix) {
			return fmt.Errorf("文件名必须以 %q 开头（防止覆盖其它插件的片段）：%q", prefix, name)
		}
		if len(name) == len(prefix)+len(class.Suffix) {
			return fmt.Errorf("文件名缺少中间标识：%q", name)
		}
	}
	return nil
}

// FileWriteOptions 是内容策略的运行时参数（安装路径相关，不能写进 info.json）。
type FileWriteOptions struct {
	// Nginx 是 nginx 片段策略；零值等于 DefaultNginxPolicy()。
	Nginx NginxPolicy
	// SSHD 是 sshd drop-in 策略；零值等于 DefaultSSHDPolicy()（首版无运行时注入需求）。
	SSHD SSHDPolicy
}

// DefaultFileWriteOptions 返回默认内容策略参数。
func DefaultFileWriteOptions() FileWriteOptions {
	return FileWriteOptions{Nginx: DefaultNginxPolicy(), SSHD: DefaultSSHDPolicy()}
}

// ValidateFileWriteContent 按声明的 content_policy 校验正文。
//
// 校验顺序：大小（动作上限与协议硬顶取小）→ UTF-8 → 控制字符 → 策略语法。
// NUL 与其它控制字符先拒，避免"解析器看到的字节"与"nginx 看到的字节"不一致。
func ValidateFileWriteContent(decl *FileWrite, content []byte, opts FileWriteOptions) error {
	if decl == nil {
		return fmt.Errorf("file_write 为空")
	}
	class, ok := FileWritePrefixClasses[decl.PrefixClass]
	if !ok {
		return fmt.Errorf("file_write.prefix_class=%q 不在白名单类别内", decl.PrefixClass)
	}
	limit := class.MaxBytes
	if decl.MaxBytes > 0 && decl.MaxBytes < limit {
		limit = decl.MaxBytes
	}
	if len(content) > limit {
		return fmt.Errorf("正文 %d 字节超过本动作上限 %d", len(content), limit)
	}
	if len(content) == 0 {
		return fmt.Errorf("正文不能为空")
	}
	if !utf8.Valid(content) {
		return fmt.Errorf("正文必须是合法 UTF-8")
	}
	for index, value := range content {
		if value == 0 {
			return fmt.Errorf("正文第 %d 字节是 NUL", index+1)
		}
		if value < 0x20 && value != '\n' && value != '\r' && value != '\t' {
			return fmt.Errorf("正文第 %d 字节是控制字符 %#x", index+1, value)
		}
		if value == 0x7f {
			return fmt.Errorf("正文第 %d 字节是 DEL", index+1)
		}
	}
	switch decl.ContentPolicy {
	case ContentPolicyNginxVHost:
		return ValidateNginxVHostFragment(content, opts.Nginx)
	case ContentPolicySSHDropin:
		return ValidateSSHDropinFragment(content, opts.SSHD)
	default:
		return fmt.Errorf("content_policy=%q 没有校验实现（fail-closed）", decl.ContentPolicy)
	}
}

// ValidateFileWriteRequest 是执行期的单一校验入口：文件名 + 正文。
//
// K3 的 root-action 分派应先调本函数，再进 filewrite 的备份/审计/原子写。
func ValidateFileWriteRequest(pluginID string, action RootAction, fileName string, content []byte, opts FileWriteOptions) error {
	if action.FileWrite == nil {
		return fmt.Errorf("动作 %q 没有 file_write 声明，不能写文件", action.ID)
	}
	// FileWritePath 内含文件名校验，并给出内核实际写盘路径（单一真源，不在这里重复拼）。
	if _, err := FileWritePath(pluginID, action.FileWrite, fileName); err != nil {
		return err
	}
	return ValidateFileWriteContent(action.FileWrite, content, opts)
}

// validateFileWriteAction 校验 file_write 动作的跨字段一致性（供 ValidateRootAction 调用）。
func validateFileWriteAction(action RootAction) error {
	if err := ValidateFileWrite(action.FileWrite); err != nil {
		return err
	}
	// 写文件不执行外部命令：声明 argv 一律拒绝，否则同一动作会同时具备两条执行语义，
	// 审计/confirm 口径无法收敛。
	if len(action.Argv) != 0 {
		return fmt.Errorf("file_write 动作不得声明 argv（写文件不执行外部命令，当前 %d 项）", len(action.Argv))
	}
	// 写安装目录之外的宿主状态是**定义**，不是可选：必须显式 writes_host=true，
	// 让「需要 confirm + 记 changes.jsonl」的既有链路生效。
	if !action.WritesHost {
		return fmt.Errorf("file_write 动作必须 writes_host=true（写宿主机文件要进变更账本）")
	}
	return ValidateFileWriteTarget(action.FileWrite, action.Target)
}

// FileWritePath 返回最终绝对路径（类别目录 + 文件名），供内核接线定位写盘目标。
//
// 目录只来自类别定义、文件名必须通过 ValidateFileWriteName——插件在任何环节都不提供目录。
func FileWritePath(pluginID string, decl *FileWrite, name string) (string, error) {
	if err := ValidateFileWriteName(pluginID, decl, name); err != nil {
		return "", err
	}
	class := FileWritePrefixClasses[decl.PrefixClass]
	full := class.Dir + name
	if path.Clean(full) != full {
		return "", fmt.Errorf("拼出的路径不是规范形式：%q", full)
	}
	return full, nil
}
