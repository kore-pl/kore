package installer

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// pkgRef 是从包文件名解析出的 id 与版本（也是校验 step 7 的比对基准）。
type pkgRef struct {
	ID      string
	Version string
}

// packageNamePattern 是包内插件 id 的临时正则。
//
// TODO(M1-07)：registry 的 id 规则尚未导出，此处最小复刻；待 registry 暴露
// 统一校验函数后删除，避免两份规则漂移。
var packageNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}[a-z0-9]$`)

// packageSuffix 是协议固定的包后缀。
const packageSuffix = ".tar.gz"

// parsePackageName 校验并拆分 `<id>-<version>.tar.gz`。
//
// id 允许连字符（如 foo-bar），因此按最后一个连字符切分版本。
func parsePackageName(path string) (pkgRef, error) {
	base := filepath.Base(path)
	if !strings.HasSuffix(base, packageSuffix) {
		return pkgRef{}, wrap(ErrInvalid, "包名 %q 必须为 <id>-<version>%s", base, packageSuffix)
	}
	stem := strings.TrimSuffix(base, packageSuffix)
	index := strings.LastIndex(stem, "-")
	if index <= 0 || index == len(stem)-1 {
		return pkgRef{}, wrap(ErrInvalid, "包名 %q 必须为 <id>-<version>%s", base, packageSuffix)
	}
	ref := pkgRef{ID: stem[:index], Version: stem[index+1:]}
	if !packageNamePattern.MatchString(ref.ID) {
		return pkgRef{}, wrap(ErrInvalid, "包名中的 id=%q 不合法", ref.ID)
	}
	if _, err := parseSemver(ref.Version); err != nil {
		return pkgRef{}, wrap(ErrInvalid, "包名中的版本 %q 不是 MAJOR.MINOR.PATCH", ref.Version)
	}
	return ref, nil
}

// ValidatePackage 做无副作用的前置校验：文件名形态、存在性、常规文件、包大小。
//
// CLI 在打开状态库前调用它，保证「包不存在」这类错误不会先撞上状态目录权限。
func ValidatePackage(path string) error {
	if _, err := statPackage(path, DefaultLimits()); err != nil {
		return err
	}
	_, err := parsePackageName(path)
	return err
}

// statPackage 校验包文件存在、是常规文件且不超过包大小上限（校验 step 1）。
func statPackage(path string, limits Limits) (os.FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, wrap(ErrInvalid, "包不存在：%s", path)
		}
		return nil, wrap(ErrInvalid, "读取包状态失败：%v", err)
	}
	if !info.Mode().IsRegular() {
		return nil, wrap(ErrInvalid, "包 %s 不是普通文件", path)
	}
	if info.Size() > limits.MaxPackageBytes {
		return nil, wrap(ErrInvalid, "包大小 %d 字节超过上限 %d", info.Size(), limits.MaxPackageBytes)
	}
	return info, nil
}
