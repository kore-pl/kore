package installer

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/pengtang1024/kore/internal/core/registry"
)

// stashSuffix 是强制重装时旧版本目录的暂存后缀（同一父目录内，成功后即删除）。
const stashSuffix = ".bak-"

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
	if err := in.record(manifest, sum); err != nil {
		if rmErr := os.RemoveAll(final); rmErr != nil {
			in.logger.Error("回滚已落位目录失败，需人工清理", "dir", final, "err", rmErr)
		}
		in.restoreStash(final, stash)
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

// dropStash 在安装成功后删除旧目录暂存；失败只 WARN，不影响已完成的安装。
func (in *Installer) dropStash(stash string) {
	if stash == "" {
		return
	}
	if err := os.RemoveAll(stash); err != nil {
		in.logger.Warn("删除旧版本暂存失败", "dir", stash, "err", err)
	}
}
