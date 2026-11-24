package supervisor

import (
	"io/fs"
	"os"
	"path/filepath"

	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// maxHandoverDepth 是属主移交的下潜深度上限（相对移交根的第几层）。
//
// 这不是业务判据，是一道安全阀：属于插件的真实目录树（站点根、证书目录）通常
// ≤20 层，超过 64 层只可能是病态嵌套或攻击者刻意构造；到达上限就停止下潜并
// WARN，不假装已经移交完整（日志给目录与 max_depth，人工 chown -R 可补齐）。
// 深度上限不参与「谁是内核的」判定——那条判据在 isInstallTreeEntry。
const maxHandoverDepth = 64

// currentLinkName 是安装器维护的稳定入口（<pluginDir>/<id>/current -> <version>）。
//
// 与 installer 的同名常量各自定义：内核不该为一次字符串比较 import 安装器
// （G-01 薄壳边界）。两边漂移会由 handover 用例先红——current 必须被跳过。
const currentLinkName = "current"

// handOverStateDir 把「插件自己的」状态落点交给插件用户，内核安装树保持 root。
//
// 背景（P0）：只移交状态目录顶层时，上一轮以 root / 运维身份运行留下的
// <state>/plugins/<id>/config.json（0600）在降权后插件读不到——进程启动成功却
// 加载不到自己的配置，属「装完就坏」的隐性故障。因此这里做两段式移交：
//
//  1. 状态目录本身：Own（属主 + 0700），插件要能在其中原子创建 config.json；
//  2. 状态目录下「非安装树」的条目：递归移交属主，不改 mode。
//
// 安装树（版本目录、.bak-* 暂存、current 链接）**不动**：属主必须留在内核一侧，
// 否则等于把「替换自己二进制」的能力交给插件；读取能力由 ensureTreeAccessible
// 补的 o+rx 负责，两件事互补而不重叠。
func (m *Manager) handOverStateDir(stateDir string, acct platform.Account) error {
	if err := m.access.Own(stateDir, acct, 0o700); err != nil {
		return errf(pluginapi.E_INTERNAL,
			"把插件状态目录 %s 交给 %s(%d:%d) 失败：%v（不允许为了可写而放宽为 0777）",
			stateDir, acct.Name, acct.UID, acct.GID, err)
	}
	return m.handOverTree(stateDir, acct, isInstallTreeEntry)
}

// handOverDataDir 把插件数据根（<plugin-data>/<id>）整棵交给插件用户。
//
// 数据根在契约上专属该插件（安装树在 <state>/plugins/<id>，两者分离），因此这里
// 不需要排除任何内核条目：树里的一切都是插件自己的数据。
func (m *Manager) handOverDataDir(dir string, acct platform.Account) error {
	if err := m.access.Own(dir, acct, 0o700); err != nil {
		return errf(pluginapi.E_INTERNAL,
			"把插件数据根 %s 交给 %s(%d:%d) 失败：%v", dir, acct.Name, acct.UID, acct.GID, err)
	}
	return m.handOverTree(dir, acct, nil)
}

// handOverTree 把 root 下（不含 root 自身）每个条目的属主交给 acct。
//
// skip 非空时，返回 true 的条目连整棵子树一起跳过（内核安装树）。
// 任一 chown / lchown 失败即返回错误：调用方（降权准备）据此拒绝启动——「启动
// 成功但读不到自己配置」比启动失败难查得多，不允许静默半移交。
func (m *Manager) handOverTree(root string, acct platform.Account, skip func(string, fs.DirEntry) bool) error {
	return m.handOverDir(root, acct, 1, skip)
}

// handOverDir 递归移交 dir 的直接子条目；depth 是子条目相对移交根的层级。
func (m *Manager) handOverDir(dir string, acct platform.Account, depth int, skip func(string, fs.DirEntry) bool) error {
	if depth > maxHandoverDepth {
		m.logger.Warn("属主移交到达深度上限，更深的子树保持原属主（插件可能写不进，可手工 chown -R 补齐）",
			"dir", dir, "max_depth", maxHandoverDepth, "account", acct.Name)
		return nil
	}
	// os.ReadDir 用 lstat 语义，不跟随符号链接；这里只是列目录，真正的
	// 「不跟随」保证在 handOverEntry 用 Lchown 落地。
	entries, err := os.ReadDir(dir)
	if err != nil {
		return errf(pluginapi.E_INTERNAL, "列举目录 %s 失败，属主移交无法继续：%v", dir, err)
	}
	for _, d := range entries {
		path := filepath.Join(dir, d.Name())
		if skip != nil && skip(path, d) {
			continue
		}
		if err := m.handOverEntry(path, d, acct, depth, skip); err != nil {
			return err
		}
	}
	return nil
}

// handOverEntry 移交单个条目；目录继续下潜。
func (m *Manager) handOverEntry(path string, d fs.DirEntry, acct platform.Account, depth int, skip func(string, fs.DirEntry) bool) error {
	// 符号链接：只改链接自身属主（Lchown），绝不跟随。跟随的后果是 chown 落到
	// 链接目标上——插件在自己目录里放一个 x -> /etc/shadow，内核就会把宿主文件
	// 交给它。链接的 mode 无意义，这里也不动 mode。
	if d.Type()&os.ModeSymlink != 0 {
		if err := m.access.Take(path, acct); err != nil {
			return errf(pluginapi.E_INTERNAL,
				"把符号链接 %s 的属主交给 %s 失败（不跟随链接目标）：%v", path, acct.Name, err)
		}
		return nil
	}
	info, err := d.Info()
	if err != nil {
		return errf(pluginapi.E_INTERNAL, "读取 %s 的文件信息失败，属主移交无法继续：%v", path, err)
	}
	if err := m.access.Take(path, acct); err != nil {
		return errf(pluginapi.E_INTERNAL,
			"把 %s 的属主交给 %s(%d:%d) 失败：%v（降权后插件读不到自己的数据；确认文件系统允许 chown，或手工 sudo chown -R %s:%d %s）",
			path, acct.Name, acct.UID, acct.GID, err, acct.Name, acct.GID, path)
	}
	if !info.IsDir() {
		return nil
	}
	return m.handOverDir(path, acct, depth+1, skip)
}

// isInstallTreeEntry 判断状态目录下的条目是否属于内核安装树（不许交给插件）。
//
// 判据全部来自安装器自己的落盘契约（internal/core/installer）：
//   - current：安装器维护的稳定链接，切版本时原子替换，属主必须留内核；
//   - 版本目录 <version>：内含 info.json——registry.Load 正是以 <dir>/info.json
//     认定「这是一个插件版本」；强制重装的暂存 <version>.bak-<ts> 是版本目录的
//     整体改名的副本，同样含 info.json。
//
// 因此用「目录内是否有 info.json」判定，不靠版本号正则（版本号不是判据，
// 且 .bak-<纳秒> 后缀会让正则在边界上漂移）。
func isInstallTreeEntry(path string, d fs.DirEntry) bool {
	if d.Name() == currentLinkName {
		return true
	}
	if !d.IsDir() {
		return false
	}
	info, err := os.Lstat(filepath.Join(path, "info.json"))
	return err == nil && info.Mode().IsRegular()
}
