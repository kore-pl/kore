package installer

import (
	"os"
	"path/filepath"

	"github.com/pengtang1024/kore/internal/core/registry"
)

// loadManifest 复用 registry 的解析/校验（12 个必填字段、capabilities 两段模型等），
// 并把 registry 错误统一归到 ErrInvalid，便于调用方按「校验失败」映射。
//
// TODO(M1-07)：registry 尚未导出独立的校验入口，此处通过 Load 间接复用；
// 待 M1-07 统一后改为直接调用其导出函数，避免两处口径。
func loadManifest(dir string) (*registry.Manifest, error) {
	manifest, err := registry.Load(dir)
	if err != nil {
		return nil, wrap(ErrInvalid, "info.json 校验失败：%v", err)
	}
	return manifest, nil
}

// checkManifest 做 registry 之外的三项安装期校验（校验 step 6/7）：
// requires_kore 区间、id/version 与包名一致、bin/<id> 存在且可执行。
func (in *Installer) checkManifest(ref pkgRef, manifest *registry.Manifest) error {
	if manifest.ID != ref.ID || manifest.Version != ref.Version {
		return wrap(ErrInvalid, "info.json 的 %s@%s 与包名 %s@%s 不一致",
			manifest.ID, manifest.Version, ref.ID, ref.Version)
	}
	if err := CheckRequiresKore(manifest.RequiresKore, in.koreVersion); err != nil {
		return err
	}
	entry := filepath.Join(manifest.Dir, "bin", manifest.ID)
	info, err := os.Lstat(entry)
	if err != nil {
		return wrap(ErrInvalid, "包内缺少可执行文件 bin/%s：%v", manifest.ID, err)
	}
	if !info.Mode().IsRegular() {
		return wrap(ErrInvalid, "bin/%s 不是普通文件", manifest.ID)
	}
	if info.Mode().Perm()&0o111 == 0 {
		return wrap(ErrInvalid, "bin/%s 没有执行位", manifest.ID)
	}
	return nil
}
