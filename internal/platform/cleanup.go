// 卸载链（ADR-0023 §3.5 豁免 #1/#2）的平台能力。
//
// 为什么独立成接口：卸载必须在"state 已被删"的前提下工作（按 /etc/passwd 前缀扫描用户），
// 且 systemctl / userdel 属平台专有动作（G-16：internal/core 不得直接 exec 平台命令）。
// 独立接口同时让 CLI 层能用假实现测试，测试里绝不触碰真实系统用户。
package platform

// UnitCleanup 描述一个 systemd unit 的清理计划或结果（幂等：不存在即跳过）。
type UnitCleanup struct {
	// UnitName 是 unit 名（如 kore.service）。
	UnitName string
	// UnitPath 是 unit 文件绝对路径。
	UnitPath string
	// Present 表示 unit 文件当前是否存在。
	Present bool
	// Active 表示服务当前是否在运行（探测不到时为 false）。
	Active bool
	// Actions 是本轮执行/将执行的动作（人类可读，按执行序）。
	Actions []string
}

// AccountCleanup 描述按前缀清理系统账户的计划或结果。
type AccountCleanup struct {
	// Prefix 是账户名前缀（kore-）。
	Prefix string
	// Matched 是按前缀扫到的账户名（升序）。
	Matched []string
	// Removed 是已删除（或 dry-run 下将删除）的账户名。
	Removed []string
	// Failed 是删除失败的账户名。
	Failed []string
}

// Cleanup 是卸载链需要的平台能力集合（便于测试注入假实现）。
type Cleanup interface {
	// RemoveServiceUnit 停用并删除 systemd unit：stop → disable → rm → daemon-reload。
	// dryRun 只做只读探测并返回计划，不做任何变更。幂等：unit 缺失不报错。
	RemoveServiceUnit(unitName, unitPath string, dryRun bool) (UnitCleanup, error)
	// ListAccountsByPrefix 扫描系统账户数据库，返回以 prefix 开头的账户名（升序）。
	ListAccountsByPrefix(prefix string) ([]string, error)
	// RemoveAccountsByPrefix 删除以 prefix 开头的系统账户（userdel -r）。
	// dryRun 只返回匹配清单，不执行 userdel。
	RemoveAccountsByPrefix(prefix string, dryRun bool) (AccountCleanup, error)
}

// NewCleanup 返回当前平台的卸载链实现（非 Linux 返回 ErrUnsupported）。
func NewCleanup() Cleanup { return systemCleanup() }
