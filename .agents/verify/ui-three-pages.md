# 三视图前端交付 · 文件管理 / 网站 / 计划任务

> 状态: 已交付（本地 commit，未 push）
> 日期: 2026-11-22 · 实例: `/tmp/kore-ui-pages` · `http://127.0.0.1:18896/`
> 插件: file 0.1.0 / cron 0.2.0 / site 0.1.0（真实插件二进制；隔离文件根、conf.d 与 fake nginx/crontab 命令）
> 截图: `.agents/verify/screenshots/three-pages-*.png`

## 1. 实现要点

| 文件 | 行数 | 能力 |
| --- | ---: | --- |
| `web/files.js` | 280 | 相对根路径面包屑、目录优先排序、名称/大小/时间/权限、文件预览编辑保存、二进制只提示不预览、新建目录/文件、删除二次确认、空目录引导、中文错误 |
| `web/sites.js` | 249 | 域名+可选 root 创建、站点列表、`exists/test_ok/reloaded` 三枚真实状态、创建/删除结果显示 `test_passed/reloaded/applied/backup_path`、`site.status` 详情含 nginx 输出、失败显示 message |
| `web/tasks.js` | 250 | `cron.list` 索引/表达式/命令/备注、4 个预设、新增、编辑走 `cron.replace`（备注保留且只读）、删除二次确认、每次写操作展示 `backup_path` |
| `web/shell.js` | +114 | 导航扩到 8 项、三个内联 SVG 图标、桌面全量 / 手机前 5 项 +「更多」抽屉、深链接 `#/files` 等 |
| `web/app.js` | +3 | `files/sites/tasks` 三路由继续走 `moduleView` 懒加载，不改登录/桥逻辑 |

- 所有 invoke 均为 `POST /api/v1/invoke/<plugin>/<method>`，统一带 `X-Kore-CSRF`；错误只显示中文 `message`。
- 文件路径对外始终是 `/docs` 形式；只有调用插件时转成相对路径（根目录传 `.`），不渲染宿主绝对路径。
- 手机方案选**前 5 项常驻 +「更多」抽屉**，不选横向滚动：360px 上 8 等分会把文字挤成不可读，横向滚动的后 3 项无滚动提示、难发现；抽屉只有一次点击，主 tab 仍保持 ≥56px 触摸区（裁决41）。

## 2. 真实操作证据（浏览器逐页点击，非 mock）

| 场景 | 实际操作 | 结果 | 截图 |
| --- | --- | --- | --- |
| 文件 | 根目录 → 新建 `docs` → 进入 → 新建 `hello.txt` → 写入 `hello kore` 保存 → 刷新并按 `#/files` 深链接读回 → 删除文件 → 删除目录 | 列表/编辑器/保存提示均来自真实 `file.*` 返回；删除后根目录恢复 2 项 | `three-pages-files-desktop-01..05` |
| 网站 | 创建 `demo.kore.test`（root=`/tmp/kore-ui-pages/www`）→ 查看状态 → 删除 | 创建结果 `test_passed=true`、`reloaded=true`、`applied=true`；删除结果含 `backup_path`；列表回到空状态 | `three-pages-sites-desktop-01..03` |
| 任务 | 新增 `*/5 * * * *` / `echo kore-ui` / `ui smoke` → 编辑为 `*/10 * * * *` → 删除 | 列表索引 0 正确；编辑后备注保留；`backup_path` 每次都显示；删除后空状态 | `three-pages-tasks-desktop-01..03` |
| 手机 | `#/files`、`#/sites`、`#/tasks`；再从「更多」抽屉点「计划任务」 | 390×844 三页可读；抽屉含计划任务/监控/设置并可跳转 | `three-pages-*-mobile-01`、`three-pages-nav-mobile-01..02` |

- 操作后状态：`www/` 只剩种子 `README.txt` 与 `notes/`；crontab 为空；`conf/kore-site-manifest.json` 无站点；`kored.log` 0 条 ERROR。
- 浏览器 `CONSOLE_ERRORS []`、`EXCEPTIONS []`；桌面截图 1440×900（长页 1440×1074），手机截图 390×844，尺寸已用 PIL 核对。

## 3. 门禁（命令 + 退出码 + 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | ---: | --- |
| `for f in web/*.js; do node --check "$f"; done` | 0 | 全部 JS 语法通过 |
| `make frontend` | 0 | 首屏 gzip **29,599 B** / 307,200 B（余 277,601） |
| `make docs-check` | 0 | 6 pass / 0 warn / 0 fail |
| `make check` | 0 | **10/10 段通过**，0 FAIL |
| `go vet ./...` | 0 | 无输出 |
| `go test -timeout 200s ./...` | 0 | 全部包 `ok`，`web` 无测试文件 |

- 懒加载实测：首屏资源仅 `style.css/shell.js/app.js`；点「文件管理」后才新增 `/assets/files.js`；`/assets/{files,sites,tasks}.js` 均 200，sha256 与 `web/` 源文件一致；`index.html` 未新增 script。
- 8 项导航顺序：概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置，图标为内联 SVG（20×20、currentColor、stroke-width 1.5）。

## 4. G-28 产品定位自评

- **解决什么用户问题**：把 file/cron/site 三个已能干活但只有 API 的能力变成可发现、可点击、可核对的入口；用户不需要知道 invoke 路径、CSRF 或插件参数。
- **与宝塔 / 1Panel 同类功能的差距**：文件页缺上传/下载/压缩/搜索/多选/语法高亮与断点续传；网站页只覆盖 vhost 创建/校验/重载，缺 SSL、PHP/运行时、伪静态、备份与一键部署；任务页缺“立即执行/执行日志/下次触发时间预览”。这些都是本次明确不做的范围，不用占位按钮假装支持。
- **当前状态**：**可用**，不是占位。三个页面的基础 CRUD 与状态回显已真实跑通；高级能力未提供且 UI 不虚构。

## 5. 边界与已知差异

- **embed 的必要改动**：`web/embed.go` 的 `//go:embed` 是显式文件名列表，新增三个模块必须加到该行，否则 `/assets/files.js` 在生产二进制中 404。本次只加 embed 清单与注释，未改 httpapi 逻辑；任务说明中“embed.go 无需改 Go”与现状不符，已同步 `docs/FRONTEND.md` 的说明。
- 隔离验证用 fake `nginx`（`-t`/`-s reload`/`-T`）与 fake `crontab`，因此页面上的 `test_passed/reloaded` 是插件对隔离命令的真实返回；**未触碰宿主 `/etc/nginx`、未改用户 crontab、未 restart 系统 nginx/cron**。
- `8787` 实例未装三插件，全程未使用；未改动 app.js 登录/桥、插件仓或 httpapi。无 rename 方法故未做重命名；上传为明确不做。
- 另：工作区里他人未提交的 `.agents/JOURNAL.md` 与 `nav-05/06` 截图未纳入本次提交；本次只 stage 三视图相关文件。

## 6. 提交

- commit: `15583e7491afa6ae201248e137d6857a0ac6e31e`
- message: `feat(web): 文件管理/网站管理/计划任务三视图`
