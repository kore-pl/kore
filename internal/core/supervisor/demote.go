package supervisor

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// pluginUserPrefix 是插件系统用户前缀（SECURITY §6：每个插件一个 kore-<id>）。
const pluginUserPrefix = "kore-"

// maxAccountName 是 Linux 用户名字节上限（shadow-utils 的经典上限 32）。
const maxAccountName = 32

// Demotion 是「插件降权是否真的生效」的显式结论（ADR-0018 降级形态）。
//
// Enabled=false 时 Reason 必非空：内核非 root 不允许被表达成「零值 Account +
// 静默返回」——过去 prepareDemotion 直接返回零值，调用方无法区分「已降权」与
// 「内核根本没降权」，产品定位上的「插件低权运行」因此变成一句空话。
type Demotion struct {
	// Enabled 为 true 表示插件进程会以 kore-<id> 运行（判据：内核 uid == 0）。
	Enabled bool
	// KernelUID 是判定时读到的内核有效 uid（结论来源，排障用）。
	KernelUID int
	// Reason 是给人看的结论 + 可操作提示（Enabled=true 时也是肯定句）。
	Reason string
}

// demotionOutcome 是一次降权准备的显式结果。
//
// Demoted=false 时 Account 必为零值、Reason 必非空。调用方必须读 Demoted，
// 不能把「零值 Account」当成「降权成功但 uid 恰好为 0」——后者在 root 内核下
// 是明确拒绝启动的（见 prepareDemotion 的 uid<=0 检查）。
type demotionOutcome struct {
	// Account 是插件应切换到的低权身份；Demoted=false 时为零值。
	Account platform.Account
	// Demoted 表示本次启动确实降权。
	Demoted bool
	// Reason 说明未降权的原因（Demoted=false 时必非空）。
	Reason string
}

// prepareDemotion 在 bind / exec 之前解析插件低权身份，并把相关落点收口到该身份。
//
// root 内核下的完整序列（任一步失败即拒绝启动，禁止降级为同 uid 运行）：
//  1. 解析/校验：安装目录非空、状态目录绝对路径、用户名长度与语法；
//  2. 查账户 Lookup；不存在则 Ensure 按需创建（系统账户、无 home、nologin、
//     独立主组，并加入内核通道共享组）；
//  3. 把 <state>/plugins/<id> 属主改为该账户、0700（不允许放宽到 0777）；
//  4. 版本目录 → 入口二进制补 other r/rx（插件只读可执行，不能改自己的二进制）；
//  5. 状态根 / 插件根 / 运行根 / 运行目录补 o+x（可穿越不可列举）；
//  6. exec 时由 platform.Identity.Apply 写入 SysProcAttr.Credential 切 uid/gid，
//     并清空继承的补充组（否则换了 uid 仍等价 root，例如 docker 组）。
//
// 失败回滚（只在本次调用刚创建账户、且还没有任何文件交给它时执行）：
//   - 创建成功后、Own 成功前的失败 → 用 AccountRemover 删掉刚建的账户，
//     让失败的启动不在 /etc/passwd 里留垃圾（例如状态目录不可写时反复重试）；
//   - Own 成功之后的失败 → **保留账户**，只记 WARN。理由：状态目录已属该
//     uid，删用户会让目录挂在未分配的数字 uid 上；重试时新账户拿到另一个 uid，
//     就会读不到自己的状态目录（等价于丢数据）。账户本身幂等，重试直接复用。
func (m *Manager) prepareDemotion(inst *instance) (demotionOutcome, error) {
	if !m.demotion.Enabled {
		// 显式返回「未降权」，不返回静默零值：Reason 必非空，调用方据此可以
		// 在日志 / API 上把「同 uid 运行」讲清楚，而不是让人误以为已隔离。
		reason := m.demotion.Reason
		if reason == "" {
			reason = "未生效：内核未启用插件降权（判据缺失），插件与内核同 uid"
		}
		return demotionOutcome{Demoted: false, Reason: reason}, nil
	}
	if inst.manifest.Dir == "" {
		return demotionOutcome{Reason: "安装目录为空，未降权"},
			errf(pluginapi.E_INTERNAL, "插件 %s 的安装目录为空，拒绝在未确认落点的情况下降权", inst.manifest.ID)
	}
	stateDir, err := filepath.Abs(filepath.Dir(inst.manifest.Dir))
	if err != nil {
		return demotionOutcome{Reason: "状态目录解析失败，未降权"},
			errf(pluginapi.E_INTERNAL, "解析插件 %s 状态目录失败：%v", inst.manifest.ID, err)
	}
	name := pluginUserPrefix + inst.manifest.ID
	if len(name) > maxAccountName {
		return demotionOutcome{Reason: "插件 id 过长，无法生成系统用户名"},
			errf(pluginapi.E_INTERNAL,
				"插件 id %q 过长，无法生成系统用户名 %q（Linux 用户名上限 %d 字节）；请使用 ≤%d 字符的插件 id",
				inst.manifest.ID, name, maxAccountName, maxAccountName-len(pluginUserPrefix))
	}
	acct, ok, lookupErr := m.identity.Lookup(name)
	if lookupErr != nil {
		return demotionOutcome{Reason: "查询插件系统用户失败"},
			errf(pluginapi.E_INTERNAL, "查询插件系统用户 %s 失败：%v", name, lookupErr)
	}
	created := false
	if !ok {
		acct, err = m.identity.Ensure(name, []string{m.opts.ChannelGroup})
		if err != nil {
			return demotionOutcome{Reason: "创建插件系统用户失败"},
				errf(pluginapi.E_INTERNAL,
					"插件 %s 需要系统用户 %s，但创建失败：%v（需 root 启动 kored + shadow-utils/adduser，或预先手工创建该用户）",
					inst.manifest.ID, name, err)
		}
		created = true
	}
	if acct.UID <= 0 {
		return demotionOutcome{Reason: fmt.Sprintf("账户 %s 解析为 uid=%d，拒绝以 root 运行插件", name, acct.UID)},
			errf(pluginapi.E_INTERNAL,
				"插件 %s 的系统用户 %s 解析为 uid=%d，拒绝以 root 运行插件", inst.manifest.ID, name, acct.UID)
	}
	if created {
		m.logger.Info("已创建插件系统用户", "plugin_id", inst.manifest.ID,
			"user", name, "uid", acct.UID, "gid", acct.GID)
	}
	// handedOver 为 true 表示已经有文件交给了该账户：此后失败只保留账户不清账户。
	handedOver := false
	rollback := func(cause string) {
		if !created || handedOver {
			if created && handedOver {
				m.logger.Warn("降权准备失败但状态目录已交给插件用户，保留账户不清删（删了会让目录挂到未分配 uid）",
					"plugin_id", inst.manifest.ID, "user", name, "cause", cause)
			}
			return
		}
		remover, ok := m.identity.(platform.AccountRemover)
		if !ok {
			m.logger.Warn("降权准备失败，平台不支持回滚删除账户，保留该账户供重试复用",
				"plugin_id", inst.manifest.ID, "user", name, "cause", cause)
			return
		}
		if err := remover.Remove(name); err != nil {
			m.logger.Warn("降权准备失败，回滚删除插件系统用户失败，保留账户供重试复用",
				"plugin_id", inst.manifest.ID, "user", name, "err", err, "cause", cause)
			return
		}
		m.logger.Info("降权准备失败，已回滚删除本次创建的插件系统用户",
			"plugin_id", inst.manifest.ID, "user", name, "cause", cause)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		rollback("mkdir state dir")
		return demotionOutcome{Reason: "创建插件状态目录失败"},
			errf(pluginapi.E_INTERNAL, "创建插件状态目录 %s 失败：%v", stateDir, err)
	}
	if err := m.access.Own(stateDir, acct, 0o700); err != nil {
		rollback("own state dir")
		return demotionOutcome{Reason: "状态目录属主移交失败"},
			errf(pluginapi.E_INTERNAL,
				"把插件状态目录 %s 交给 %s(%d:%d) 失败：%v（不允许为了可写而放宽为 0777）",
				stateDir, acct.Name, acct.UID, acct.GID, err)
	}
	handedOver = true
	// 版本目录 → 入口二进制必须对该用户可读可执行：安装器用 0700 落位
	// （MkdirTemp 的权限），属主是 root/内核用户，kore-<id> 属于 other 类。
	if err := ensureTreeAccessible(inst.manifest.Dir, filepath.Join(inst.manifest.Dir, inst.manifest.Entry)); err != nil {
		rollback("grant tree access")
		return demotionOutcome{Reason: "版本目录对插件用户不可读/不可执行"},
			errf(pluginapi.E_INTERNAL,
				"插件 %s 的版本目录 %s 对 %s 不可读/不可执行：%v", inst.manifest.ID, inst.manifest.Dir, name, err)
	}
	// 可穿越只需要「父链上每一级目录的 o+x」：插件根（默认 <state>/plugins）与它的
	// 上一级（默认 /var/lib/kore）、运行目录（/run/kore/plugins）与它的上一级
	// （/run/kore）。只补 o+x，不补读位——目录仍不可列举，文件仍按各自 0600/0700 收口。
	pluginRoot := filepath.Dir(stateDir)
	for _, dir := range []string{
		filepath.Dir(pluginRoot), // 状态根（默认 /var/lib/kore；自定义 plugin_dir 时为其父目录）
		pluginRoot,               // 插件根（默认 /var/lib/kore/plugins）
		filepath.Dir(m.opts.RunDir),
		m.opts.RunDir,
	} {
		if err := m.access.Traversable(dir); err != nil {
			rollback("grant traversal")
			return demotionOutcome{Reason: "父链目录可穿越位设置失败"},
				errf(pluginapi.E_INTERNAL,
					"设置目录 %s 为可穿越失败（插件用户 %s 需要经它到达自己的目录与 socket）：%v", dir, name, err)
		}
	}
	inst.setAccount(acct)
	return demotionOutcome{
		Account: acct,
		Demoted: true,
		Reason:  fmt.Sprintf("已降权：插件进程以 %s 运行", describeAccount(acct)),
	}, nil
}

// ensureTreeAccessible 让插件用户能读/执行「版本目录 → 入口二进制」整条链。
//
// 只补 other 的 r（文件）与 rx（目录与可执行文件），属主与写权限不动：插件
// 看不到、也改不了自己的二进制（版本树仍属 root/内核用户）。符号链接不跟随——
// 否则 chmod 会落到版本目录之外，等于把任意路径交给插件包。
func ensureTreeAccessible(versionDir, entryPath string) error {
	// 入口跟随符号链接检查：exec 实际执行的是目标文件（单测 fixture 用符号链接
	// 复用假插件二进制）；目标必须是普通文件，否则拒绝降权启动。
	entry, err := os.Stat(entryPath)
	if err != nil {
		return fmt.Errorf("检查入口 %s: %w", entryPath, err)
	}
	if !entry.Mode().IsRegular() {
		return fmt.Errorf("入口 %s 不是普通文件（mode=%s），拒绝降权启动", entryPath, entry.Mode())
	}
	if entry.Mode().Perm()&0o005 != 0o005 {
		if err := os.Chmod(entryPath, entry.Mode().Perm()|0o005); err != nil {
			return fmt.Errorf("入口 %s 补 o+rx: %w", entryPath, err)
		}
	}
	return filepath.WalkDir(versionDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil // 不跟随符号链接
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode().Perm()
		want := mode
		if info.IsDir() {
			want |= 0o005 // o+rx：可穿越、可列举
		} else {
			want |= 0o004 // o+r
			if mode&0o100 != 0 {
				want |= 0o001 // 属主可执行 → 允许插件用户执行
			}
		}
		if want == mode {
			return nil
		}
		return os.Chmod(path, want)
	})
}

// describeAccount 返回降权身份的可读描述（日志用；未降权时为空）。
func describeAccount(acct platform.Account) string {
	if acct.UID <= 0 {
		return ""
	}
	return fmt.Sprintf("%s(uid=%d,gid=%d)", acct.Name, acct.UID, acct.GID)
}
