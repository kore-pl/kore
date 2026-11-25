> 元信息: 2026-11-25T12:55+08:00 · 执行者 feat-global-search · 隔离实例真实浏览器点击（Playwright/CDP）· 全局搜索跨资源面板 · 报告 ≤100 行

# 全局搜索（跨资源命令面板）验收报告

## 0. 本次交付
`web/search.js` 从「四源（页面/已装插件/商店/操作）+ 站点 + 文件」扩到 **11 源**：站点 / 文件 / 库表 / 容器 / 进程 / 端口 / 日志 / 页面 / 插件 / 商店 / 操作。
commit `9ffbf18`（`[agent:feat-global-search]`，未 push）。未改内核、未引依赖、未新增 `web/*.js`（故 Makefile `WEB_SRC_FILES` 与 `web/embed.go` 无需登记）。

## 1. 来源与契约（全部复用既有插件方法，path:line 为后端真源）
| 分组 | 调用 | 结果字段 | 跳转 |
| --- | --- | --- | --- |
| 站点 | `site/site.list` | `sites[].domain/enabled` | `#/sites/sites` + `button.site-link[data-site]` |
| 文件 | `file/file.search` | `entries[].path/is_dir` | `#/files/files` + 填入 `.files-search-input` 并触发搜索 |
| 数据库 | `db-mysql|db-postgres` 的 `instances/databases/query` | `databases[]` + `query.rows[{db,tbl}]` | `#/db/db` + 点同名库（触发 `SHOW TABLES`）+ 高亮表名 |
| 容器 | `container/container.list` | `containers[].id/name/image/state/ports` | `#/sites/container` + 高亮 `tr[data-id]` |
| 进程 | `process/process.list` | `items[].pid/name/cmdline/user` | `#/monitor/process` + 填 `.proc-search` + 打开详情 |
| 端口 | `process/process.ports` | `listeners[].pid/name/protocol/address/port` | 同进程（跳监听者 PID） |
| 日志 | `logs/logs.sources` + `logs/logs.search` | `matches[].line_no/text/level` | `#/monitor/logs` + 填关键字并触发搜索 |
| 页面 | 本地路由表（与 `app.js` HUB_DEFS 对齐 41 项） | — | 直达二级 tab，如 `#/security/sshguard` |
| 插件 / 商店 / 操作 | `/api/v1/plugins`、`/api/v1/store/plugins`、本地 ACTIONS | — | 商店/插件定位、动作预填 |

逐源状态机 `idle→loading→ok/err`；某源失败只在该源上显示一句人类可读原因（「X 来源未启用（插件未安装或未启用）」/「X 来源读取失败：…」），其它源照常可用。

## 2. 门禁命令 + 退出码
| 命令 | 结果 |
| --- | --- |
| `node --check web/search.js` | exit 0 |
| `go vet ./web/... ./internal/core/httpapi/...` | exit 0 |
| `go test -timeout 200s ./...` | exit 0（18 包全 ok，含 `cmd/kored` 8.27s、`httpapi` 3.70s） |
| `bash scripts/secret-check.sh` | exit 0（0 FAIL / 22 处占位写法合规） |
| `bash scripts/frontend-check.sh` | exit 0；首屏 gzip **81528B ≤ 307200B**（search.js 不在首屏六件套，懒加载，预算零增长） |
| 真实浏览器 e2e（隔离实例） | exit 0；**44 断言全绿** |

## 3. 真机运行证据
- 隔离实例：`/home/pt/Work/GolandProjects/kore-pl/.tmp/search-e2e/kored`（从**工作树**构建，非 HEAD；含本次 search.js），config/state/run/log 全在同一临时目录，随机端口，`/-/healthz` 200 后经 `POST /api/v1/auth/login` 拿会话；跑完即停实例并删目录。
- 浏览器：`~/.npm/_npx/*/node_modules/playwright` 的 chromium（未装新依赖）。
- **G-29 声明**：本轮未读写主实例 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`；只在临时目录构建；`web/dist` 是 `make web-dist` 的 gitignored 产物。
- 44 项断言覆盖：Ctrl/Cmd+K 唤起 · 8 个前缀 chip 引导 · 数字「8080」端口优先（提示条 + 端口/容器/日志三组）· ↑↓ 选中位移与回位 · `db:` 作用域与 scope 提示 · 库名/表名命中 · **Enter 跳转**（db→`#/db/db`+`SHOW TABLES FROM \`blog\``、file→`#/files/files` 且搜索框带入 `nginx.conf`、pid→`#/monitor/process` 且过滤框 `4242`、log→`#/monitor/logs` 且关键字 `timeout`）· 最近搜索记录与复搜 · 域名优先站点 · Esc 关闭 · 手机 390×844 面板宽 374px、触摸目标 44px · 三端 `pageerror` = 0。
- 降级实测（不 mock，插件全未装）：面板底部逐条列出「文件搜索没成功（插件 file 未安装）…」「数据库来源未启用」「容器来源未启用」「进程来源未启用」「日志来源未启用」，且页面无 JS 报错。

## 4. G-28 双端截图
| 文件 | 实测尺寸 | 内容 |
| --- | --- | --- |
| `search-panel-desktop-01.png` | 1440×900 | 「8080」→ 端口 8080·nginx / web-proxy / 日志命中，首行选中 |
| `search-empty-desktop-01.png` | 1440×900 | 空输入引导：可以搜什么 + 8 个前缀 chip + 一句话规则 |
| `search-multi-desktop-01.png` | 1440×900 | 「blog」→ 站点 1 / 数据库 3 / 日志 1 分组同屏 |
| `search-panel-mobile-01.png` | 390×844 | 手机同款结果，面板未溢出，44px 触摸行 |

## 5. 产品定位自评（G-28 第三问）
- **解决什么用户问题**：不用记住「哪个功能在哪个 tab」——输一次关键词就能从域名找到站点、从 8080 找到监听进程、从表名找到库、从关键字找到日志行，并直接落到该行。对标 1Panel 命令面板「一处搜索、跨资源命中」。
- **与宝塔/1Panel 差距**：宝塔是「站点/文件/功能」三类搜索且不跨进程与端口；1Panel 全局搜索偏文件与容器。本实现把「谁在监听这个端口 / 这张表在哪个库 / 这行日志在哪个来源」串起来，并在插件未装时**如实说明该来源未启用**（不假装搜到了空结果）。
- **当前状态**：**可用**（44 项真机断言全绿）。已知边界：库表来自单条 `information_schema` 只读查询（上限 500 行，超限只少列不报错）；日志每次最多查 2 个可读来源、每来源 3 行，且非 `log:` 前缀下要求关键词 ≥3 字符；端口扫描只在纯数字/IP/`port:` 时触发（避免每次输入都扫全系统 fd）。

## 6. 留给 lead 的同步项
- `.agents/HANDOFF.md:249` 仍写「接入站点 + 文件数据源」、`docs/PLUGIN-MATURITY.md` 已在本次提交内同步为跨 11 源；HANDOFF 属多 agent 共用文件，本卡未动，请 scribe/lead 收口时一并更新。
- 本次 commit message 因 shell 转义把换行写成了字面 `\n`（内容完整可读）；按 G-12 禁 amend/reset，未改写历史。
