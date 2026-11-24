package main

import (
	"os"
	"path/filepath"

	"github.com/pengtang1024/kore/internal/core/filewrite"
	"github.com/pengtang1024/kore/internal/core/privilege"
	"github.com/pengtang1024/kore/internal/platform"
	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// newFileWriteOptions 组装 file_write 执行面（K3）。
//
// 三件事：
//  1. `Policy` 是内容策略的**运行时注入点**：证书/口令文件目录白名单只能运行时得到，
//     缺省（这里）为空 → 校验器拒绝 `ssl_certificate*` / `auth_basic_user_file`
//     （fail-closed，不猜安装路径，ADR-0052 §3.1.3.2）。注入的值必须由 `pkg/pluginapi`
//     产出——`nginx`/`ssl` 是薄壳门禁的业务域词（G-01），不得进 `cmd`/`internal`；
//  2. `CopyRoot` = `<state>/backups`：写前备份 + `purge_op: file.restore` 的回滚源；
//  3. 属主复核走 `internal/platform`（`os/user` 与 `stat` 是平台专有 API，G-16）。
func newFileWriteOptions(stateDir string) *privilege.FileWriteOptions {
	return &privilege.FileWriteOptions{
		CopyRoot: filepath.Join(stateDir, filewrite.CopyRootDirName),
		Policy:   pluginapi.DefaultFileWriteOptions(),
		OwnerCheck: func(path string, mode os.FileMode) error {
			return platform.VerifyOwner(path, "root", "root", mode)
		},
	}
}
