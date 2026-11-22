# ui-l2 · 文件 / 网站两页 L2 全能力验收（真机 · 双端 · G-28）

> 元信息: 2026-11-23T01:25+08 · 执行 ui-file-site-l2 子 agent · 隔离实例 127.0.0.1:18880 · 8787 首尾均 200，全程未触碰

## 1. 环境与实现

- 插件：file 0.2.0 / site 0.1.0 / ssl 0.2.0 / discover 0.1.0 本地包 `kored install --package` 安装并 enable；file/site 实测 ready，ssl 懒加载（首次调用唤醒）。
- site 运行环境：`KORE_SITE_CONF_DIR=/tmp/kore-l2ui-18880/conf`；本机无 nginx 二进制，按插件文档设 `KORE_NGINX_TEST_CMD/RELOAD/DUMP=off`，页面如实展示「未检测（未配置 nginx）」，不把 skipped 说成 passed。
- 文件页：`web/files.js` 396 行（≤400）；L2 子模块 `web/files-l2.js` 301 行，首次 L2 动作才注入。覆盖 upload/download/compress(zip,tar.gz)/extract/chmod(递归)/move/批量删除。
- 网站页：`web/sites.js` 372 行（≤420）；向导 + SSL/伪静态/反代/重定向/默认文档编辑器在 `web/site-edit.js` 468 行，首次渲染向导/打开详情才注入。
- **内核集成修复**：`validateMethod` 原先只允许小写方法段，site 的 `site.bindSSL` / `site.setRewrite` 等 camelCase 方法经 `/api/v1/invoke` 被 400 拒绝；已放宽为「段首小写、段内允许 camelCase」，并新增 `internal/core/httpapi/invoke_method_test.go`（11 子用例全过），既有纯小写方法不受影响。
- 首屏：`make frontend` gzip **36758 B / 307200 B**，19 文件（4 首屏 + 12 视图 + 3 懒加载子模块）。

## 2. 文件页真机步骤（真实 file 插件写盘）

| 步骤 | 页面证据 | 落盘 / 返回证据 |
| --- | --- | --- |
| 上传 | 状态「已上传 1 个文件到 /」，列表出现 `l2-upload.txt` 12 B | `file.upload` 返回 path/filename/size=12/sha256；文件 `0644` |
| 下载 | 状态「已下载 /l2-upload.txt（12 B）」 | 浏览器下载文件内容 `hello l2 ui\n`，与上传字节逐字一致 |
| 压缩 | 状态「已生成 /root-20261123-012117.zip（176 B，1 项，zip）」 | 归档真实落盘；行内出现「解压」 |
| 解压 | 状态「已解压 1 项到 /root-20261123-012117（zip，12 B）」 | 目录内 `l2-upload.txt` 与原件同内容 |
| 改权限 | 状态「权限改为 0600（变更 1 项）」，行内权限 0600 | 文件树实际 `-rw-------` |
| 移动 | 状态「已移动 /l2-upload.txt → /renamed-l2.txt（rename）」 | 原路径消失、新路径出现，内容一致 |
| 5 MiB 拦截 | 「未上传：too-big.bin 超过 5 MiB。单帧上限 8 MiB，大文件请先压缩或用终端上传」 | 未发起 upload 请求（前端拦截） |
| 后端失败原文 | 解压恶意 zip（条目 `../evil.txt`）→ 弹层全文「E_INVALID：归档条目含 .. 段，整包拒绝」+ 提示「解压先整包校验路径安全」 | 目标目录 `evil-out` 未创建（整包拒绝、零残留） |
| 补充批量 | 多选 2 文件上传 → 「已上传 2 个文件」；全选 2 项 → 一次汇总确认 → 「已删除 2 项」 | 两文件从列表消失 |
| 补充 tar.gz | 选 `renamed-l2.txt` 压缩为 `l2-batch.tar.gz` → 解压回目录，状态含 `tar.gz` | tar.gz 真实归档 + 解压成功 |
| 补充递归 chmod | 对目录勾选「递归」改 0750 → 「权限改为 0750（变更 2 项）」 | 目录及其内文件实际 0750 |

## 3. 网站页真机步骤（真实 vhost 写盘）

| 步骤 | 页面证据 | 落盘证据 |
| --- | --- | --- |
| 向导默认值 | 输入域名后根目录自动填 `/var/www/l2ui.kore.test`，标「已自动填入」 | 表单 DOM 断言通过 |
| 建站三步 | 步骤条：create 成功 / bindSSL 成功（ssl_bound=true, force_https=true）/ setRewrite 成功（template=wordpress） | vhost 写入 `conf/kore-site-l2ui.kore.test.conf` |
| 详情摘要 | `site.get` 显示 root/port/index/ssl/rewrite/proxy/redirects/enabled；SSL 已绑定、伪静态 wordpress | 与 vhost 一致 |
| 伪静态 | 下拉 wordpress → 保存，当前值由 `getRewrite` 回显 | vhost 含 wordpress 伪静态块 |
| 反向代理 | upstream `http://127.0.0.1:3000` + WS；状态「已自动清除伪静态（互斥）」 | vhost 含 `proxy_pass http://127.0.0.1:3000`，rewrite 块移除 |
| 重定向 | `/old` → `https://example.com/new` 302；状态「共 1 条」 | vhost 含 `return 302 https://example.com/new` |
| 默认文档 | 保存 `index.html index.htm index.php default.html` | vhost 含 `index ... default.html` |
| 停用 | 行与详情灰标「已停用」，按钮变「启用」 | 文件改名为 `...conf.disabled`，配置保留 |
| 启用 | 状态「已启用站点：enabled=true」 | 文件名改回 `.conf` |
| 证书下拉 | 从 `ssl.list` 拉取 `l2ui.kore.test · l2ui.kore.test.crt（365 天）` | 证书目录 `/tmp/kore-l2ui-18880/ssl`（`ssl.list` 只给文件名，页面提供目录/手动路径兜底） |

## 4. 双端截图（21 张，sha256 两两不同；每张前后均做 DOM 断言）

| 文件 | 尺寸 | sha256 前 12 |
| --- | --- | --- |
| [l2-files-desktop-01-initial.png](screenshots/l2-files-desktop-01-initial.png) | 1440×900 | 3afb59a914e4 |
| [l2-files-desktop-02-upload.png](screenshots/l2-files-desktop-02-upload.png) | 1440×900 | 733ddd52bbe8 |
| [l2-files-desktop-03-download.png](screenshots/l2-files-desktop-03-download.png) | 1440×900 | c0ec5db0966e |
| [l2-files-desktop-04-compress.png](screenshots/l2-files-desktop-04-compress.png) | 1440×900 | 779b39e49309 |
| [l2-files-desktop-05-extract.png](screenshots/l2-files-desktop-05-extract.png) | 1440×900 | c9d4a5a28d61 |
| [l2-files-desktop-06-chmod.png](screenshots/l2-files-desktop-06-chmod.png) | 1440×900 | c3db6ac116ce |
| [l2-files-desktop-07-move.png](screenshots/l2-files-desktop-07-move.png) | 1440×900 | ef06be3444a1 |
| [l2-files-desktop-08-limit.png](screenshots/l2-files-desktop-08-limit.png) | 1440×900 | a25f02d4529a |
| [l2-files-desktop-09-batch-targz.png](screenshots/l2-files-desktop-09-batch-targz.png) | 1440×900 | 5b25d1c4c85d |
| [l2-files-desktop-10-error.png](screenshots/l2-files-desktop-10-error.png) | 1440×900 | 590ab2b7f850 |
| [l2-sites-desktop-01-wizard.png](screenshots/l2-sites-desktop-01-wizard.png) | 1440×900 | 8422dcdc398a |
| [l2-sites-desktop-02-wizard-result.png](screenshots/l2-sites-desktop-02-wizard-result.png) | 1440×2364 | 63bd5a450345 |
| [l2-sites-desktop-03-proxy.png](screenshots/l2-sites-desktop-03-proxy.png) | 1440×2476 | 2d15f8a31857 |
| [l2-sites-desktop-04-redirect.png](screenshots/l2-sites-desktop-04-redirect.png) | 1440×2520 | ad00fb832126 |
| [l2-sites-desktop-05-index.png](screenshots/l2-sites-desktop-05-index.png) | 1440×2520 | 48f31d94811b |
| [l2-sites-desktop-06-disabled.png](screenshots/l2-sites-desktop-06-disabled.png) | 1440×2520 | b370a2d8fa77 |
| [l2-sites-desktop-07-enabled.png](screenshots/l2-sites-desktop-07-enabled.png) | 1440×2520 | 9e816aca7029 |
| [l2-files-mobile-01-list.png](screenshots/l2-files-mobile-01-list.png) | 390×844 | 63ca29bb7f36 |
| [l2-files-mobile-02-compress.png](screenshots/l2-files-mobile-02-compress.png) | 390×844 | 1184b0de0fab |
| [l2-sites-mobile-01-wizard.png](screenshots/l2-sites-mobile-01-wizard.png) | 390×844 | aab5c6519ff5 |
| [l2-sites-mobile-02-detail.png](screenshots/l2-sites-mobile-02-detail.png) | 390×844 | 34c6f602b1af |

- 移动端四张 `scrollWidth == innerWidth == 390`；桌面端 `1440 == 1440`。移动端操作按钮换行、表格/表单单列，触摸目标走全局 `--kore-touch`（≥44px）。
- 原始断言 JSON：`/tmp/kore-l2ui-18880/evidence.json`（19 步）、`extra.json`（5 步）与 `error.json`（1 步）；每步均记录操作前后 `body.innerText`、modal 数、状态条与预期子串。

## 5. G-28 产品定位自评

**文件页**：① 不登 SSH 即可上传/下载/压缩/解压/改权限/移动/批量删除，失败保留后端 `code + message` 原文。② 与宝塔/1Panel 差距：无分片/断点续传、目录树/搜索、在线预览压缩包、拖拽上传；>5 MiB 单文件仍需终端或先压缩。③ **可用**：真实 base64 下载、真实 zip/tar.gz、真实 chmod/move；大文件限制已明确拦截，不是占位。

**网站页**：① 一个向导收齐域名、自动根目录、SSL、伪静态，再在详情里完成反代/重定向/默认文档/启停。② 与宝塔/1Panel 差距：无 ACME 自动签发、无多站点批量、无反代健康检查；本机无 nginx 时 `nginx -t`/reload 只能显示「未检测」。③ **可用**：真实 vhost 写入、反代/伪静态互斥清理、启停改名、`site.get` 回读；不伪装 nginx 生效。

## 6. 门禁与清理

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check` × 4 个 JS | 0 | files/files-l2/sites/site-edit 全部通过 |
| `make frontend` | 0 | 36758 B / 307200 B，19 文件 |
| `make docs-check` | 0 | 6 pass / 0 warn / 0 fail |
| `make check` | 0 | 10/10 段，门禁全部通过 |
| `gofmt -l` 两个 Go 文件 | 0 | 无输出 |
| `go vet ./...` | 0 | 无告警 |
| `go test -timeout 200s ./...` | 0 | 全包通过（含新增 11 子用例） |

- 首次 `go vet` 因并发 agent 重建 `web/dist` 时缺 `files-l2.js/site-edit.js` 报 embed 错误；`make web-dist` 补齐 19 文件后 vet/test 均 0。提交前已确认 dist 19 文件。
- 清理：18880 已停止（PID 见 `/tmp/kore-l2ui-18880/serve.pid`），临时脚本/证据只在 `/tmp/kore-l2ui-18880`，未留入工作区；8787 前后均 200。
