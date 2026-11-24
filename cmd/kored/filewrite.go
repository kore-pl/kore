package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pengtang1024/kore/internal/core/filewrite"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// fileWriteAllowDirsEnv 是安装目录相关白名单（证书/口令文件目录，如
// `<install>/data/ssl/`）的**运行时注入点**：路径列表，`os.PathListSeparator` 分隔。
//
// 未设置 = 空 = 校验器继续拒绝 `ssl_certificate*` / `auth_basic_user_file`
// （fail-closed）。内核**不猜安装布局**：值由安装/运维侧注入，非法条目由
// `pluginapi.FileWriteOptionsWithDirs` 逐条丢弃。
const fileWriteAllowDirsEnv = "KORE_FILE_WRITE_ALLOW_DIRS"

// newFileWriteOptions 组装 file_write 执行面（K3）。
//
// 三件事：
//  1. `Policy` 按**文件种类**分配目录白名单（最小权限：证书只剩安装注入目录，
//     类别目录只给 vhost 写盘与口令文件）。分配必须经
//     `pluginapi.FileWriteOptionsWithDirs(certDirs, authDirs)`——`nginx`/`ssl` 是
//     薄壳门禁业务域词（G-01），不得在 `cmd`/`internal` 里给策略字段赋值；
//  2. `CopyRoot` = `<state>/backups`：写前备份 + `purge_op: file.restore` 的回滚源；
//  3. 属主复核走 `internal/platform`（`os/user` 与 `stat` 是平台专有 API，G-16）。
func newFileWriteOptions(stateDir string) *privilege.FileWriteOptions {
	classDirs := classPrefixDirs()
	envDirs := splitDirList(os.Getenv(fileWriteAllowDirsEnv))

	// 证书：**只**吃运行时注入的安装目录（`<install>/data/ssl/`）。
	// 类别目录 `/etc/nginx/conf.d/` 是 vhost drop-in 目录，不是证书目录——把它并进
	// `CertPrefixes` 等于允许 `ssl_certificate*` 指向任意 conf.d 片段，只是"nginx 解析
	// 失败"而非提权，但违反最小权限：证书面只应是安装目录。
	certDirs := envDirs

	// 口令文件：类别目录 + 安装注入目录。
	// 类别目录必须给：站点插件的 htpasswd 与 vhost 同目录写
	// （`<confDir>/kore-site-auth.<domain>.htpasswd`，见站点插件 password.go 的 authFilePath），
	// 不给就等于让 `auth_basic` 功能过不了内核校验。安装注入目录保留给"口令文件放在
	// `<install>/data/...`"的部署（`KORE_FILE_WRITE_ALLOW_DIRS` 的文档语义本就含口令目录）。
	// 注意新建切片：不与 classDirs / envDirs 共享底层数组，避免后续 append 互相污染。
	authDirs := make([]string, 0, len(classDirs)+len(envDirs))
	authDirs = append(authDirs, classDirs...)
	authDirs = append(authDirs, envDirs...)

	return &privilege.FileWriteOptions{
		CopyRoot: filepath.Join(stateDir, filewrite.CopyRootDirName),
		Policy:   pluginapi.FileWriteOptionsWithDirs(certDirs, authDirs),
		OwnerCheck: func(path string, mode os.FileMode) error {
			return platform.VerifyOwner(path, "root", "root", mode)
		},
	}
}

// newFileDeleteOptions 组装 file_delete 执行面（ADR-0053）。
//
// 与写共用同一个 CopyRoot：删除前的备份与写的备份落在同一棵树下，账本里的
// `purge_op: file.restore` 对两种动作是同一条恢复链路，运维只学一套。
// 属主复核同样走 internal/platform（删前复核，防「同名文件被替换后被我们删掉」）。
func newFileDeleteOptions(stateDir string) *privilege.FileDeleteOptions {
	return &privilege.FileDeleteOptions{
		CopyRoot: filepath.Join(stateDir, filewrite.CopyRootDirName),
		OwnerCheck: func(path string, mode os.FileMode) error {
			return platform.VerifyOwner(path, "root", "root", mode)
		},
	}
}

// classPrefixDirs 返回协议类别目录（如 `/etc/nginx/conf.d/`），按类别名排序。
//
// `FileWritePrefixClasses` 是 map，直接遍历会让白名单顺序抖动——校验器报
// 「允许：A、B」时运维看到的文案每次不一样。排序只影响文案稳定性，不影响判据。
//
// 这些目录**不**进 `CertPrefixes`（证书面最小），只进 vhost 写盘白名单
// （`internal/core/filewrite.AllowedPrefixes` 从同一张表派生）与 `AuthFilePrefixes`。
func classPrefixDirs() []string {
	classes := make([]string, 0, len(pluginapi.FileWritePrefixClasses))
	for name := range pluginapi.FileWritePrefixClasses {
		classes = append(classes, name)
	}
	sort.Strings(classes)
	dirs := make([]string, 0, len(classes))
	for _, name := range classes {
		dirs = append(dirs, pluginapi.FileWritePrefixClasses[name].Dir)
	}
	return dirs
}

// splitDirList 把注入值拆成目录列表：只做最粗的分隔与去空白，合法性（绝对路径、
// 无 `..`/控制字符、补尾斜杠、去重）全部交给 pluginapi 的注入 helper——门禁与
// 校验规则只有一份，装配层不再实现第二套。
//
// 注入值**不要加引号、不要用 `~`**：带引号的条目不是绝对路径，会被 helper 逐条丢弃，
// 结果是证书/口令指令继续被拒（fail-closed，不静默放行），但运维看不到"你引号多了"。
func splitDirList(raw string) []string {
	parts := strings.Split(raw, string(os.PathListSeparator))
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
