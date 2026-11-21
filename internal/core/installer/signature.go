package installer

import (
	"fmt"
	"os"
	"path/filepath"
)

// signatureName 是包内签名文件名。
const signatureName = "signature"

// ReadSignature 读取包内 signature 文件内容；当前只读取、不验签。
//
// TODO(M4)：按 SECURITY §5.1 接入 ed25519 验签（签名对象为除 signature 外
// 所有文件的规范化清单）。返回 fs.ErrNotExist 表示包未带签名。
func ReadSignature(dir string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(dir, signatureName))
	if err != nil {
		return nil, fmt.Errorf("installer: 读取签名文件失败: %w", err)
	}
	return data, nil
}

// hasSignature 报告版本目录内是否存在签名文件（只记存在性，不验签）。
func hasSignature(dir string) bool {
	info, err := os.Lstat(filepath.Join(dir, signatureName))
	return err == nil && info.Mode().IsRegular()
}
