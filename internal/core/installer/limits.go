package installer

// 解包上限（PLUGIN-PROTOCOL §2 / SECURITY §5.1）；测试可注入更小值。
const (
	// defaultMaxPackageBytes 是包文件大小上限 64 MiB。
	defaultMaxPackageBytes int64 = 64 << 20
	// defaultMaxExtractBytes 是解包总量上限 128 MiB。
	defaultMaxExtractBytes int64 = 128 << 20
	// defaultMaxFiles 是解包条目数上限。
	defaultMaxFiles = 2000
	// defaultMaxFileBytes 是单文件大小上限 64 MiB。
	defaultMaxFileBytes int64 = 64 << 20
	// stagingDirName 是原子落位前的临时目录名。
	stagingDirName = ".staging"
)

// Limits 是包与解包上限；零值字段取 DefaultLimits 的对应值。
type Limits struct {
	// MaxPackageBytes 是包文件字节上限。
	MaxPackageBytes int64
	// MaxExtractBytes 是解包总量字节上限。
	MaxExtractBytes int64
	// MaxFiles 是解包条目数上限。
	MaxFiles int
	// MaxFileBytes 是单文件字节上限。
	MaxFileBytes int64
}

// DefaultLimits 返回协议默认上限（64 MiB 包 / 128 MiB 解包 / 2000 条 / 64 MiB 单文件）。
func DefaultLimits() Limits {
	return Limits{
		MaxPackageBytes: defaultMaxPackageBytes,
		MaxExtractBytes: defaultMaxExtractBytes,
		MaxFiles:        defaultMaxFiles,
		MaxFileBytes:    defaultMaxFileBytes,
	}
}

// withDefaults 把零值字段补成默认值，便于测试只覆盖关心的一项。
func (l Limits) withDefaults() Limits {
	defaults := DefaultLimits()
	if l.MaxPackageBytes <= 0 {
		l.MaxPackageBytes = defaults.MaxPackageBytes
	}
	if l.MaxExtractBytes <= 0 {
		l.MaxExtractBytes = defaults.MaxExtractBytes
	}
	if l.MaxFiles <= 0 {
		l.MaxFiles = defaults.MaxFiles
	}
	if l.MaxFileBytes <= 0 {
		l.MaxFileBytes = defaults.MaxFileBytes
	}
	return l
}
