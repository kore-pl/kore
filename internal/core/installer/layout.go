package installer

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/kore-project/kore/internal/core/registry"
)

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
func (in *Installer) commit(staging string, manifest *registry.Manifest, sum string) (*Result, error) {
	final := filepath.Join(in.pluginRoot, manifest.ID, manifest.Version)
	if _, err := os.Lstat(final); err == nil {
		return nil, wrap(ErrConflict, "%s@%s 已安装", manifest.ID, manifest.Version)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, wrap(ErrStateDir, "检查目标目录失败：%v", err)
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return nil, wrap(ErrStateDir, "建立插件目录失败：%v", err)
	}
	if err := os.Rename(staging, final); err != nil {
		return nil, wrap(ErrStateDir, "原子落位失败：%v", err)
	}
	if err := in.record(manifest, sum); err != nil {
		if rmErr := os.RemoveAll(final); rmErr != nil {
			in.logger.Error("回滚已落位目录失败，需人工清理", "dir", final, "err", rmErr)
		}
		return nil, err
	}
	return &Result{ID: manifest.ID, Version: manifest.Version, Dir: final, SHA256: sum}, nil
}
