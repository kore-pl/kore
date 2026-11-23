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

// prepareDemotion 在 bind / exec 之前解析插件低权身份，并把相关落点收口到该身份。
//
// 返回零值 Account 表示「未启用降权」：kored 非 root（开发 / 预览 / 容器）是
// ADR-0018 的显式降级形态，此时插件与内核同 uid，不伪造 uid 隔离。
//
// root 内核下的顺序（任一步失败即拒绝启动，禁止降级为同 uid 运行）：
//  1. kore-<id> 不存在则按需创建（系统账户、无 home、nologin、独立主组）；
//  2. 插件状态目录 <pluginDir>/<id> 属主改为该账户、0700；
//  3. 状态根 / 运行根 / 运行目录补 o+x（可穿越不可列举），否则插件无法
//     到达自己的版本目录与 socket。
func (m *Manager) prepareDemotion(inst *instance) (platform.Account, error) {
	if !m.demote {
		return platform.Account{}, nil
	}
	if inst.manifest.Dir == "" {
		return platform.Account{}, errf(pluginapi.E_INTERNAL, "插件 %s 的安装目录为空，拒绝在未确认落点的情况下降权", inst.manifest.ID)
	}
	stateDir, err := filepath.Abs(filepath.Dir(inst.manifest.Dir))
	if err != nil {
		return platform.Account{}, errf(pluginapi.E_INTERNAL, "解析插件 %s 状态目录失败：%v", inst.manifest.ID, err)
	}
	name := pluginUserPrefix + inst.manifest.ID
	if len(name) > maxAccountName {
		return platform.Account{}, errf(pluginapi.E_INTERNAL,
			"插件 id %q 过长，无法生成系统用户名 %q（Linux 用户名上限 %d 字节）；请使用 ≤%d 字符的插件 id",
			inst.manifest.ID, name, maxAccountName, maxAccountName-len(pluginUserPrefix))
	}
	acct, ok, lookupErr := m.identity.Lookup(name)
	if lookupErr != nil {
		return platform.Account{}, errf(pluginapi.E_INTERNAL, "查询插件系统用户 %s 失败：%v", name, lookupErr)
	}
	created := false
	if !ok {
		acct, err = m.identity.Ensure(name, []string{m.opts.ChannelGroup})
		if err != nil {
			return platform.Account{}, errf(pluginapi.E_INTERNAL,
				"插件 %s 需要系统用户 %s，但创建失败：%v（需 root 启动 kored + shadow-utils/adduser，或预先手工创建该用户）",
				inst.manifest.ID, name, err)
		}
		created = true
	}
	if acct.UID <= 0 {
		return platform.Account{}, errf(pluginapi.E_INTERNAL,
			"插件 %s 的系统用户 %s 解析为 uid=%d，拒绝以 root 运行插件", inst.manifest.ID, name, acct.UID)
	}
	if created {
		m.logger.Info("已创建插件系统用户", "plugin_id", inst.manifest.ID,
			"user", name, "uid", acct.UID, "gid", acct.GID)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return platform.Account{}, errf(pluginapi.E_INTERNAL, "创建插件状态目录 %s 失败：%v", stateDir, err)
	}
	if err := m.access.Own(stateDir, acct, 0o700); err != nil {
		return platform.Account{}, errf(pluginapi.E_INTERNAL,
			"把插件状态目录 %s 交给 %s(%d:%d) 失败：%v（不允许为了可写而放宽为 0777）",
			stateDir, acct.Name, acct.UID, acct.GID, err)
	}
	// 版本目录 → 入口二进制必须对该用户可读可执行：安装器用 0700 落位
	// （MkdirTemp 的权限），属主是 root/内核用户，kore-<id> 属于 other 类。
	if err := ensureTreeAccessible(inst.manifest.Dir, filepath.Join(inst.manifest.Dir, inst.manifest.Entry)); err != nil {
		return platform.Account{}, errf(pluginapi.E_INTERNAL,
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
			return platform.Account{}, errf(pluginapi.E_INTERNAL,
				"设置目录 %s 为可穿越失败（插件用户 %s 需要经它到达自己的目录与 socket）：%v", dir, name, err)
		}
	}
	inst.setAccount(acct)
	return acct, nil
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
