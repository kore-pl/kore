package installer

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// extractTarGz 安全解包（校验 step 3/4）：只接受普通文件与目录，
// 拒绝路径穿越、绝对路径、符号/硬链接与设备文件，并强制三类上限。
func extractTarGz(packagePath, dest string, limits Limits) error {
	file, err := os.Open(packagePath)
	if err != nil {
		return wrap(ErrInvalid, "打开包失败：%v", err)
	}
	defer func() { _ = file.Close() }()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return wrap(ErrInvalid, "gzip 头非法：%v", err)
	}
	defer func() { _ = gz.Close() }()
	reader := tar.NewReader(gz)
	var entries int
	var total int64
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			return nil
		}
		if nextErr != nil {
			return wrap(ErrInvalid, "读取 tar 条目失败：%v", nextErr)
		}
		if header.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		entries++
		if entries > limits.MaxFiles {
			return wrap(ErrInvalid, "解包条目数 %d 超过上限 %d", entries, limits.MaxFiles)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if _, err := mkdirEntry(dest, header.Name); err != nil {
				return err
			}
		case tar.TypeReg:
			nextTotal, err := writeEntry(reader, dest, header, total, limits)
			if err != nil {
				return err
			}
			total = nextTotal
		default:
			return wrap(ErrInvalid, "条目 %q 类型 %q 不允许（拒绝链接与设备文件）", header.Name, string(header.Typeflag))
		}
	}
}

// safePath 把 tar 条目名解析为 dest 内的绝对路径；越界一律拒绝。
func safePath(dest, name string) (string, error) {
	if name == "" || strings.ContainsRune(name, 0) {
		return "", wrap(ErrInvalid, "tar 条目名为空或含 NUL")
	}
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == "/" {
		return "", wrap(ErrInvalid, "tar 条目 %q 指向根目录", name)
	}
	if path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", wrap(ErrInvalid, "tar 条目 %q 路径越界", name)
	}
	target := filepath.Join(dest, filepath.FromSlash(cleaned))
	rel, err := filepath.Rel(dest, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", wrap(ErrInvalid, "tar 条目 %q 路径越界", name)
	}
	return target, nil
}

// mkdirEntry 建立目录条目；权限固定 0755，不采信包内 mode。
func mkdirEntry(dest, name string) (string, error) {
	target, err := safePath(dest, name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return "", wrap(ErrInvalid, "建立目录 %q 失败：%v", name, err)
	}
	if err := os.Chmod(target, 0o755); err != nil {
		return "", wrap(ErrInvalid, "设置目录 %q 权限失败：%v", name, err)
	}
	return target, nil
}

// writeEntry 写入普通文件条目并累计解包总量；返回新的累计值。
func writeEntry(src io.Reader, dest string, header *tar.Header, total int64, limits Limits) (int64, error) {
	if header.Size < 0 || header.Size > limits.MaxFileBytes {
		return total, wrap(ErrInvalid, "条目 %q 大小 %d 超过单文件上限 %d", header.Name, header.Size, limits.MaxFileBytes)
	}
	total += header.Size
	if total > limits.MaxExtractBytes {
		return total, wrap(ErrInvalid, "解包总量超过上限 %d 字节", limits.MaxExtractBytes)
	}
	target, err := safePath(dest, header.Name)
	if err != nil {
		return total, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return total, wrap(ErrInvalid, "建立 %q 的父目录失败：%v", header.Name, err)
	}
	// 先以 0600 落地，校验字节数后再按包内 mode 收紧/放开，避免半截可执行文件。
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return total, wrap(ErrInvalid, "写入 %q 失败：%v", header.Name, err)
	}
	written, copyErr := io.Copy(out, io.LimitReader(src, header.Size))
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil || written != header.Size {
		return total, wrap(ErrInvalid, "写入 %q 不完整（%d/%d）", header.Name, written, header.Size)
	}
	mode := os.FileMode(header.Mode).Perm() | 0o600
	if err := os.Chmod(target, mode); err != nil {
		return total, wrap(ErrInvalid, "设置 %q 权限失败：%v", header.Name, err)
	}
	return total, nil
}
