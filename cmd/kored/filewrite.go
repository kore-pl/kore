package main

import (
	"os"
	"path/filepath"
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
//  1. `Policy` 注入目录白名单：协议类别目录（唯一真源，如 `/etc/nginx/conf.d/`）
//     + 环境注入的安装路径目录（如 `<install>/data/ssl/`）。注入必须经
//     `pluginapi.FileWriteOptionsWithDirs`——`nginx`/`ssl` 是薄壳门禁业务域词（G-01），
//     不得在 `cmd`/`internal` 里给策略字段赋值；
//  2. `CopyRoot` = `<state>/backups`：写前备份 + `purge_op: file.restore` 的回滚源；
//  3. 属主复核走 `internal/platform`（`os/user` 与 `stat` 是平台专有 API，G-16）。
func newFileWriteOptions(stateDir string) *privilege.FileWriteOptions {
	dirs := make([]string, 0, len(pluginapi.FileWritePrefixClasses)+2)
	for _, class := range pluginapi.FileWritePrefixClasses {
		dirs = append(dirs, class.Dir)
	}
	dirs = append(dirs, splitDirList(os.Getenv(fileWriteAllowDirsEnv))...)
	return &privilege.FileWriteOptions{
		CopyRoot: filepath.Join(stateDir, filewrite.CopyRootDirName),
		Policy:   pluginapi.FileWriteOptionsWithDirs(dirs, dirs),
		OwnerCheck: func(path string, mode os.FileMode) error {
			return platform.VerifyOwner(path, "root", "root", mode)
		},
	}
}

// splitDirList 把注入值拆成目录列表：只做最粗的分隔与去空白，合法性（绝对路径、
// 无 `..`/控制字符、补尾斜杠、去重）全部交给 pluginapi 的注入 helper——门禁与
// 校验规则只有一份，装配层不再实现第二套。
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
