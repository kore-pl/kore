package installer

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
)

// stashSuffix 是强制重装时旧版本目录的暂存后缀（同一父目录内，成功后即删除）。
const stashSuffix = ".bak-"

// currentLinkName 是插件的稳定入口：<pluginRoot>/<id>/current -> <version>。
//
// 为什么需要它：插件要把自己的二进制路径写进**宿主**计划任务（如 cron 的 crontab），
// 而宿主条目的生命周期长于插件版本。若写 <root>/<id>/<version>/bin/<id>，升级后
// 旧条目会继续执行旧版本且没有任何提示。稳定链接由安装器维护，升级时原子切到新版本，
// 条目只写 <root>/<id>/current/bin/<id> 即可自动跟随。
//
// 链接目标是**相对路径**（版本目录名），因此整个状态目录可搬迁；更新用临时链接 +
// rename 覆盖，不存在“链接短暂消失”的窗口（那个窗口里 cron 到点会失败）。
const currentLinkName = "current"

// newStaging 在插件根目录的 .staging 下建唯一临时目录并收紧权限。
func (in *Installer) newStaging(ref pkgRef) (string, error) {
	root := filepath.Join(in.pluginRoot, stagingDirName)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", wrap(ErrStateDir, "建立暂存目录失败：%v", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return "", wrap(ErrStateDir, "设置暂存目录权限失败：%v", err)
	}
	dir, err := os.MkdirTemp(root, ref.ID+"-"+ref.Version+"-")
	if err != nil {
		return "", wrap(ErrStateDir, "建立安装临时目录失败：%v", err)
	}
	return dir, nil
}

// commit 原子落位并落库（校验 step 8）：rename 成功后才写 plugins / plugin_state；
// 落库失败则删除刚落位的目录回滚，保证不留「有目录无记录」的半装态。
//
// Force 模式：目标版本目录已存在时先原子改名为 .bak-<时间戳>，安装/落库任一步
// 失败都把备份改回原名；成功才删除备份。配置文件位于 <root>/<id>/config.json
// （版本目录的父目录），不随版本目录替换而丢失。
func (in *Installer) commit(staging string, manifest *registry.Manifest, sum string) (*Result, error) {
	final := filepath.Join(in.pluginRoot, manifest.ID, manifest.Version)
	stash, err := in.stashTarget(final, manifest)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		in.restoreStash(final, stash)
		return nil, wrap(ErrStateDir, "建立插件目录失败：%v", err)
	}
	if err := os.Rename(staging, final); err != nil {
		in.restoreStash(final, stash)
		return nil, wrap(ErrStateDir, "原子落位失败：%v", err)
	}
	// 版本目录本身是 MkdirTemp 的 0700：root 安装后非 root kored 连目录都进不去
	// （"插件未安装"）。与文件 mode 归一保持一致，版本目录固定 0755。
	if err := os.Chmod(final, 0o755); err != nil {
		in.restoreStash(final, stash)
		return nil, wrap(ErrStateDir, "设置版本目录权限失败：%v", err)
	}
	prevCurrent, linkErr := in.updateCurrentLink(final, manifest.Version)
	if linkErr != nil {
		// 不阻断安装：符号链接在部分平台（Tier B Windows）需要额外权限。
		// 但绝不留下指向旧版本的稳定链接——那正是本机制要消灭的“静默跑旧版本”；
		// 移除后 cron.list 会报 missing，降级可见。
		in.logger.Warn("维护插件稳定路径失败，安装继续（cron 等插件会退化为版本路径并依赖启动迁移）",
			"plugin_id", manifest.ID, "version", manifest.Version,
			"stable", filepath.Join(filepath.Dir(final), currentLinkName), "err", linkErr)
		if rmErr := in.replaceCurrentLink(filepath.Dir(final), ""); rmErr != nil {
			in.logger.Error("移除指向旧版本的稳定链接失败，稳定路径可能仍指向旧版本",
				"plugin_id", manifest.ID, "err", rmErr)
		}
		prevCurrent = ""
	}
	if err := in.record(manifest, sum); err != nil {
		if rmErr := os.RemoveAll(final); rmErr != nil {
			in.logger.Error("回滚已落位目录失败，需人工清理", "dir", final, "err", rmErr)
		}
		in.restoreStash(final, stash)
		in.restoreCurrentLink(final, prevCurrent)
		return nil, err
	}
	in.dropStash(stash)
	return &Result{ID: manifest.ID, Version: manifest.Version, Dir: final, SHA256: sum}, nil
}

// stashTarget 处理目标版本目录已存在的情况：非 Force 返回 ErrConflict，
// Force 时把旧目录原子改名为同父目录下的 .bak-<纳秒时间戳> 并返回暂存路径。
func (in *Installer) stashTarget(final string, manifest *registry.Manifest) (string, error) {
	_, err := os.Lstat(final)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", wrap(ErrStateDir, "检查目标目录失败：%v", err)
	}
	if !in.force {
		return "", wrap(ErrConflict, "%s@%s 已安装", manifest.ID, manifest.Version)
	}
	stash := final + stashSuffix + time.Now().UTC().Format("20060102T150405.000000000")
	if err := os.Rename(final, stash); err != nil {
		return "", wrap(ErrStateDir, "暂存旧版本目录失败：%v", err)
	}
	return stash, nil
}

// restoreStash 在安装失败时把暂存目录改回原名；暂存为空表示无需回滚。
func (in *Installer) restoreStash(final, stash string) {
	if stash == "" {
		return
	}
	if err := os.Rename(stash, final); err != nil {
		in.logger.Error("回滚旧版本目录失败，需人工清理", "stash", stash, "dir", final, "err", err)
	}
}

// updateCurrentLink 把 <id>/current 原子指向 version（相对链接），返回更新前目标
// （"" 表示原先没有链接），供落库失败时回滚。
func (in *Installer) updateCurrentLink(final, version string) (string, error) {
	dir := filepath.Dir(final)
	current := filepath.Join(dir, currentLinkName)
	prev := ""
	if target, err := os.Readlink(current); err == nil {
		prev = target
		if prev == version {
			return prev, nil
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", wrap(ErrStateDir, "读取插件稳定链接失败：%v", err)
	}
	if err := in.replaceCurrentLink(dir, version); err != nil {
		return "", err
	}
	return prev, nil
}

// replaceCurrentLink 用临时链接 + rename 原子替换 <id>/current；target 为空表示移除。
// rename 覆盖保证任何时刻 current 要么指向旧版本、要么指向新版本，不会短暂缺失。
func (in *Installer) replaceCurrentLink(dir, target string) error {
	current := filepath.Join(dir, currentLinkName)
	if target == "" {
		if err := os.Remove(current); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return wrap(ErrStateDir, "移除插件稳定链接失败：%v", err)
		}
		return nil
	}
	temp := filepath.Join(dir, fmt.Sprintf(".current.%d.%d", os.Getpid(), time.Now().UnixNano()))
	if err := os.Symlink(target, temp); err != nil {
		return wrap(ErrStateDir, "创建插件稳定链接失败：%v", err)
	}
	if err := os.Rename(temp, current); err != nil {
		_ = os.Remove(temp)
		return wrap(ErrStateDir, "更新插件稳定链接失败：%v", err)
	}
	return nil
}

// restoreCurrentLink 在安装失败时把稳定链接还原到更新前的目标；失败只记 ERROR。
func (in *Installer) restoreCurrentLink(final, prev string) {
	dir := filepath.Dir(final)
	if err := in.replaceCurrentLink(dir, prev); err != nil {
		in.logger.Error("回滚插件稳定链接失败", "plugin_id", filepath.Base(dir), "target", prev, "err", err)
	}
}

// dropStash 在安装成功后删除旧目录暂存；失败只 WARN，不影响已完成的安装。
func (in *Installer) dropStash(stash string) {
	if stash == "" {
		return
	}
	if err := os.RemoveAll(stash); err != nil {
		in.logger.Warn("删除旧版本暂存失败", "dir", stash, "err", err)
	}
}
