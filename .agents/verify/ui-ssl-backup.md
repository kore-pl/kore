# SSL 证书 / 备份两页验收报告（真机 · 双端 · G-28）

> 元信息: 2026-11-23T00:14+08:00 · 执行者 ui-ssl-backup 子 agent · 隔离实例 18883 · 真实 chromium CDP · 报告 ≤90 行

## 1. 环境与隔离
- 实例 `127.0.0.1:18883`，state/run/log/证书/备份全在 `/tmp/kore-sb-18883`；**8787 全程未触碰**（PID 3208160，RSS 11.1 MiB，前后存活）。
- `make build` → `bin/kored`；本地包安装 ssl 0.2.0 + backup 0.2.0（`kored install --package` 两次均 exit 0），enable 均 HTTP 200（lazy）。
- 注入：`KORE_SSL_CERT_DIR=/tmp/kore-sb-18883/ssl`、`KORE_BACKUP_DIR=/tmp/kore-sb-18883/backups`、`KORE_BACKUP_ALLOW_ROOTS=/tmp/kore-sb-18883`。
- TLS 靶机：`openssl s_server -accept 19443 -cert ui.kore.local.crt -key ui.kore.local.key`，`ssl.verify` 走真实握手。

## 2. 实现要点
- `web/ssl.js`（274 行）：证书表 9 列（域名/有效期/剩余天数/issuer/RSA 2048 或 ECDSA 256/自签标签/链长/指纹前 16+title 全文/操作）；`<30` 黄、`<0` 红；验证、续期（自签回显新指纹）、自签表单（365 天默认，RSA/ECDSA）、导入表单（链可选）、ACME 按钮 disabled + 灰字说明、空态文案。
- 私钥输入框为 `type=password`：粘贴事件截获到内存变量、不回显不清求，提交后清空；提示“不会回显、不会记录”。
- `web/backups.js`（300 行）：备份表（name/创建时间/人类可读大小/条目数/sha 前 12/正常或 corrupted 红标）；创建表单（名称+多行路径+排除 glob+gzip/none）回显 size/entries/sha/duration；校验回显 sha_match/entries；恢复回显 restored_entries + failed 列表；空态文案。
- 接线：`shell.js` 第 13/14 项「SSL」「备份」（锁形/下箭头入方框，20×20 currentColor 1.5）；`index.html` 未加 script；`Makefile`/`embed.go` 16 文件；`FRONTEND.md`+`QUICKSTART.md` 同步 12 视图模块 / 16 文件。
- 移动端：证书/备份表容器 `overflow-x:auto`；两列表单在 <640px 改单列；按钮走全局 44px 触摸下限；实测 `scrollWidth == innerWidth`。

## 3. 破坏性操作二次确认（不用 window.confirm）
- `openConfirm()` 在页面内插入 `.bak-confirm` 面板，先展示完整参数，再允许提交；取消仅关闭面板。
- 恢复：展示 id/name/created_at/size_bytes/entries/sha256 + 目标目录输入 + 黄色警告「目标必须不存在或空目录；非空会被拒绝（E_CONFLICT），不会覆盖已有文件」。
- 删除：展示同一组完整参数 + 「同时移除 .sha256 / .meta.json sidecar，不可恢复」；确认后调 `backup.delete`。
- 截图 03/05 分别是恢复确认、删除确认；恢复结果 04 显示 restored_entries=4、failed 空。

## 4. SSL 真机证据
| 步骤 | 证据 |
| --- | --- |
| 自签 | `ui.kore.local`，`domains=["127.0.0.1","ui.kore.local"]`，`days_left=365`，`key_type=rsa/key_bits=2048`，`chain_length=1`，`self_signed=true` |
| 列表 | 截图 01：365 天、issuer、RSA 2048、自签标签、链 1、指纹前 16 位；页面状态“共 1 张证书” |
| 验证 | 输入 `127.0.0.1:19443` → `reachable=true`、`matched=true`、`days_left=365`、issuer=ui.kore.local（截图 01） |
| 续期 | 状态全文“已续期 ui.kore.local，新指纹 b5dfc2b8…（有效期至 2027/11/23 00:09:46）”，指纹与续期前不同（截图 03） |
| ACME 入口 | 按钮 disabled，灰字“ACME 自动申请未实现（v1.1 跟进），当前可用自签或导入”（截图 02） |
| ACME 续期 | 写 `<base>.acme` 标记后点续期 → `E_UNSUPPORTED：ACME 续期需要 ACME 客户端，当前版本未实现，请在 v1.1 跟进`（截图 04） |
| 导入 | 生成 `import.kore.local` 证书+私钥走 `ssl.import` → HTTP 200，列表 count=3、days_left=30、指纹 64 hex（表单同路径） |

## 5. 备份真机证据
| 步骤 | 证据 |
| --- | --- |
| 创建 | `ui-shot-20261122T160940Z`：size_bytes=333、entries=4、sha256=e670157269bc…、duration_ms=6，sidecar 落盘 |
| 列表 | 截图 01：ui-shot / 2026-11-23 00:09:40 / 333 B / 4 / e670157269bc / 绿色“正常” |
| 校验 | sha_match=true、entries=4、uncompressed_bytes=11、corrupted=false（截图 02） |
| 恢复 | target `/tmp/kore-sb-18883/restore-shot` → restored_entries=4、failed=[]、duration_ms=0（截图 04）；`diff -r sitecontent restore-shot/sitecontent` → `identical` |
| 删除 | 页面内确认 → deleted=true；列表回到空态“还没有备份；建议先备份站点目录”（截图 06） |
| UI 表单 | Playwright 填名称/路径/压缩后提交：SSL 行 1→2、备份行 1→2，状态均出现“已创建/备份已创建” |

## 6. 双端截图（`file` 实测宽高；每张前后 DOM 断言含「SSL」或「备份」、无 `#kore-password`）
| 文件 | 尺寸 | sha256 前12 | 断言 |
| --- | --- | --- | --- |
| ssl-desktop-01-list.png | 1440×1052 | 6dc7375e180e | SSL 证书 / ui.kore.local / matched=true |
| ssl-desktop-02-acme-disabled.png | 1088×32（元素） | 82819273c11f | 申请 Let's Encrypt 证书 / ACME 自动申请未实现 |
| ssl-desktop-03-renew-result.png | 1440×1052 | 6ec78b1e993f | 已续期 / 新指纹 |
| ssl-desktop-04-acme-renew-unsupported.png | 1440×1052 | e6597e1a4848 | E_UNSUPPORTED / v1.1 跟进 |
| ssl-mobile-01-list.png | 390×844 | 42c0d3b58b16 | SSL 证书 / ui.kore.local |
| ssl-mobile-02-nav-drawer.png | 390×844 | 735e45b642f5 | SSL / 备份（更多抽屉） |
| backup-desktop-01-list.png | 1440×900 | a2414171b87b | 备份 / ui-shot / 正常 |
| backup-desktop-02-verify.png | 1440×1060 | d92c8b67b22b | 校验结果 / sha_match=true |
| backup-desktop-03-restore-confirm.png | 1440×1450 | b9155a875233 | 恢复确认 / 目标目录必须不存在 / E_CONFLICT |
| backup-desktop-04-restore-result.png | 1440×994 | c9aa02930f45 | 恢复结果 / restored_entries=4 / failed=0 |
| backup-desktop-05-delete-confirm.png | 1440×1302 | 6638cdcada89 | 删除确认 / 不可恢复 / sha256 |
| backup-desktop-06-delete-result.png | 1440×935 | dc83e7927b90 | 备份 / 还没有备份 / 已删除 |
| backup-mobile-01-list.png | 390×844 | c90ae6e8156b | 备份 / ui-shot / 正常 |
| backup-mobile-02-restore-confirm.png | 390×844 | a65636e6e863 | 恢复确认 / 目标目录 |

- 14 张 sha256 两两去重：**14 unique / 0 重复**；桌面 1440 宽、手机 390×844 全部达标；两页移动端 `documentElement.scrollWidth == innerWidth`。
- console：登录前 401 探测、favicon 404、主壳 `/api/v1/events` 既有 501 各 1 条；`pageerror` 0，未捕获异常 0。

## 7. G-28 产品定位自评
- **SSL 页**：① 不登 SSH 即可盘点证书、看剩余天数与真实握手结果，并完成自签/导入/续期。② 与宝塔、1Panel 差距：无 ACME 自动签发（已明确置灰）、无证书下载/删除、无到期自动续期调度、无证书链编辑器。③ **可用**：自签/导入/列表/验证/续期真实落盘，ACME 如实拒绝，不是占位。
- **备份页**：① 浏览器内完成本地打包、完整性校验、恢复到空目录与删除，危险操作先看完整参数再确认。② 差距：无定时备份/保留策略、无 S3/下载、恢复无流式进度（仅完成后的 restored_entries/failed 汇总）、无增量备份。③ **可用**：真实 tar.gz、真实 sha、真实恢复 diff、真实删除，不是占位。

## 8. 门禁与清理
- `node --check web/ssl.js web/backups.js web/shell.js` → 0；`make frontend` → 0，首屏 gzip **35,458 B** / 307,200 B。
- `make docs-check` → 0（6 pass / 0 warn / 0 fail）；`make check` → 0（10/10 段，`[OK] 门禁全部通过`）。
- 提交使用 `scripts/safe-commit.sh`（私有索引 + CAS）；本任务只提交两页、接线、样式、embed/Makefile、两份文档与 14 张截图。
- 清理：18883 已停止（PID 3218325），TLS 靶机与 chromium 已退出；8787 未触碰；临时脚本只在 `/tmp/kore-sb-18883`，未留入工作区。
