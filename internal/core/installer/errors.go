package installer

import (
	"errors"
	"fmt"
)

// 安装错误分类；调用方用 errors.Is 映射退出码（CLI：校验 2 / 状态目录 3 / 存储 4）。
var (
	// ErrInvalid 表示包校验失败（不存在、超限、路径越界、清单非法等）。
	ErrInvalid = errors.New("installer: 包校验失败")
	// ErrChecksum 表示 sha256 与声明值不符。
	ErrChecksum = errors.New("installer: sha256 校验失败")
	// ErrUnsupported 表示 requires_kore 区间不满足当前内核版本。
	ErrUnsupported = errors.New("installer: 内核版本不满足")
	// ErrConflict 表示同 id 同版本已安装。
	ErrConflict = errors.New("installer: 插件版本冲突")
	// ErrStateDir 表示状态目录或插件根目录不可用（映射退出码 3）。
	ErrStateDir = errors.New("installer: 状态目录不可用")
	// ErrStore 表示状态库未注入或写入失败（映射退出码 4）。
	ErrStore = errors.New("installer: 状态库写入失败")
	// ErrUpstream 表示包下载或下载内容与索引声明不一致（对外映射 E_UPSTREAM）。
	// 摘要不符时同时满足 errors.Is(err, ErrChecksum)：语义是"上游内容不可信"，不是请求非法。
	ErrUpstream = errors.New("installer: 上游包下载失败")
)

// wrap 给错误带上分类与可读上下文；保持 errors.Is 可判定。
func wrap(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: %s", kind, fmt.Sprintf(format, args...))
}
