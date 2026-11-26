# C7 只读表结构浏览 · UI 自评与验收证据（G-28）

> 2026-11-27 · 执行者 `c7-tables`（task-157，持续目标 round 13）· 隔离实例 `127.0.0.1:<随机空闲端口>`（独立 config/state/run/log + 独立临时二进制，非 8787，未碰 `.kore-local-*`）· Playwright 1.65.1 + 缓存 chromium-headless-shell-1255（真实浏览器，登录走 UI 接口 + CSRF cookie）· 收工已停实例并删 `.agents/verify/.c7tmp/` 临时目录。
> 方案：纯前端接既有 `invoke('db-mysql.query'/'db-postgres.query', {instance, sql})` 通道；**不改插件、不 bump 版本、不新建 hub、不新增一级控件、无 ADR**。task-156 已核实 ADR-0050 D7❌只锁"数据编辑（写）"，只读表结构浏览无需 ADR。

## 0. 交付概览

在数据库页原有「SQL 控制台」panel 内追加一个可折叠的「表结构」区（`<details>`，默认展开），不占一级导航：
- 点库行 → 复用既有 `SHOW TABLES` 查询的返回结果，在表结构区渲染表名 chip（按钮）；PG 用 `pg_tables` 只读查询取 public schema 表名。
- 点表名 chip → 走既有 query 通道执行只读 MySQL `SHOW FULL COLUMNS FROM \`db\`.\`table\`` / PG `information_schema.columns` 查询 → 复用 `paintResult` 的 `renderResultInto` 通用表格渲染列名/类型/可空/键/注释。
- **安全硬约束**：库名/表名拼进 SQL 前先过 `isSafeIdent` 白名单（仅 `[A-Za-z_][A-Za-z0-9_$]*`，长度 ≤128），`quoteIdent` 用反引号/双引号包裹作纵深防御；白名单失败 → `structSQL` 返回空串、`showTableStructure` fail-closed 不发请求；后端 query 白名单只校验首关键字、不防标识符注入，因此这道前端白名单是必需防线。所有查询均为 `SHOW`/`SELECT` 只读前缀，不触任何写路径。
- UI 减法：没有新增常驻一级控件，也没有新建 hub；「表结构」是 SQL 控制台里的折叠分区，复用现有 paintResult 展示位。

## 1. 双端截图证据（G-28）

| 文件 | identify -format | 观察 |
| --- | --- | --- |
| `ui-c7-tables-desktop-01.png` | 1440x1627（PC full-page，宽 1440、高 ≥900） | 数据库页：连接详情 / 库列表（kore_ui、appdb）/ SQL 控制台内「表结构」折叠区，表名 chip `users` `orders`，点开后「表结构：kore_ui.users」表格显示 `id bigint(20) unsigned`、`email varchar(191)`、`created_at datetime` 三行（Field/Type/Collation/Null/Key/Comment 列）。 |
| `ui-c7-tables-mobile-01.png` | 390x844（精确手机视口） | 手机窄屏：SQL 控制台与表结构区单列排布，表名 chip 触屏尺寸，列结构表可横向滚动（`.db-result-scroll`），底部 tab 条不遮挡，页面错误 0。 |

两张图 sha256：桌面 `5ae25c5dcc1c...` / 手机 `9c54c6c23b8b...`，非同图缩放冒充。PC 取 full-page（高 1627 > 900，符合 G-28 "full-page"口径），手机取精确 390×844 视口。

## 2. 自评三问

**问 1：本页解决什么用户问题？**
此前数据库页只能"点库 → 把 SHOW TABLES 填进 SQL 控制台 → 自己执行"，用户想看一张表有哪些列、什么类型、是否可空，得手写 `DESCRIBE`/`SHOW FULL COLUMNS` 并读原始表格。现在点库后直接在表结构折叠区看到表名 chip，点表名就渲染列结构表（字段名/类型/排序规则/可空/键/注释），不用记 SQL 语法、不用离开当前页。错误提示给「怎么办」（空态"点表名查看列结构"，注入型名称被拒有中文提示），符合易用性四原则。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 的数据库管理有完整的表浏览器：表列表、列结构、索引、外键、ER 图、在线改表与数据编辑。本实现有意克制（对齐 task-156 结论：只读表结构属 P1 计划，写路径由 ADR-0050 D7❌锁住）：①只做"点库看表名 → 点表看列结构"两件事，没有索引/外键/ER 图；②表列信息只是后端 query 结果原样渲染，没有字段级中文注释翻译；③不提供数据行浏览/编辑（那是写路径，需另立 ADR）。这些是有意边界，后续补齐需单独裁决。

**问 3：当前是"可用"还是"占位"？**
**可用（只读范围）。** 判据：
1. UI 路径：隔离实例真实浏览器登录后，点库→表名 chip→列结构表在双端截图肉眼可见，20 条注入防护断言 + DOM 断言（列名 Field/Type、值 email/varchar）全 PASS，页面 JS 错误 0。
2. 调用路径：`showTableStructure` 与按钮共用同一实现，走既有 `invoke('db-mysql.query'/'db-postgres.query', {instance, sql})`，SQL 为 `SHOW FULL COLUMNS` / `SELECT ... information_schema.columns` 只读前缀；注入型库/表名在前端白名单处 fail-closed，不发请求。
3. 门禁：`node --check web/db.js` exit 0；`make frontend` exit 0 首屏 90924 B ≤ 300 KiB（改的是懒加载 db.js + 英文包，不计首屏）；`usability-check` 无新增 FAIL（基线 18 FAIL 全是 GOCACHE 只读文件系统导致的 A1 环境性失败，可写 GOCACHE 后仅剩 1 条存量 waf e2e FAIL，与本次前端改动无关）。

## 3. 隔离实例真跑断言（命令 + 退出码 + 关键输出）

脚本：`.agents/verify/.c7tmp/c7-verify.sh`（一次性，收工删除）；二进制：`.agents/verify/.c7tmp/kored`（可写 GOMODCACHE 从 goproxy.cn 构建，exit 0，收工删除）。

```
# 起隔离实例（独立 config/state/run/log + 随机空闲端口，非 8787）
$ bash .agents/verify/.c7tmp/c7-verify.sh
[INFO] login: {"authenticated":true,"expires_at":"..."}
[ASSERT] 20 条断言全 pass（详见下方）
[DOM] {"structTitle":"表结构：kore_ui.users","tables":["users","orders"],"columns":["Tables_in_kore_ui","Field","Type","Collation","Null","Key","Comment"],"cells":[["users"],["orders"],["x`;DROP TABLE users;--"],["id","bigint(20) unsigned",...],["email","varchar(191)",...],...],"errors":[]}
[SHOT] ui-c7-tables-desktop-01.png / ui-c7-tables-mobile-01.png
[INFO] node verify exit=0
=== identify ===
ui-c7-tables-desktop-01.png 1440 x 1627
ui-c7-tables-mobile-01.png 390 x 844
c7-verify exit=0
```

注入防护断言（页面内调 `window.KoreDb._verify`，与按钮共用同一实现）：
- 白名单正例：`isSafeIdent('users')=true`、`isSafeIdent('audit_log2')=true`。
- 白名单反例（10 条全 false）：`x\`;DROP TABLE users;--`、`a;DROP`、`a' OR 1=1--`、`bad name`、`a\`b`、`a\b`、`''`、`a.b`、`sel ect`、`1bad`。
- `structSQL('kore_ui','x\`;DROP TABLE users;--')=""`（拒绝产生 SQL）；`structSQL('bad;db','users')=""`（库名不安全也 fail-closed，不静默丢弃）。
- `structSQL('kore_ui','users')` 以 `SHOW FULL COLUMNS FROM` 开头且含 `\`kore_ui\`.\`users\``；只读前缀，无写语句。
- 端到端：`showTableStructure('kore_ui','x\`;DROP TABLE users;--')` 后 `structError` 非空、`structResult=null`、`structLabel` 不变（fail-closed，不发请求、不污染上一次合法结果）。
- DOM 断言：列结构表头含 `Field`/`Type`，单元格含 `email`/`varchar(191)`；白名单过滤后的表名 chip 只有 `users`/`orders`（注入型表名不进 chip 列表，SQL 控制台原始 SHOW TABLES 结果保留原样展示属既有行为）。

## 4. 诚实边界

- 本机没有 MySQL/MariaDB 服务端（mysqladmin ping 失败），截图与 UI 断言用 Playwright 路由拦截的 mock 结果（列名/类型取自真实 `SHOW FULL COLUMNS` 返回形状）；"建测试库/表"这一步由 mock 的结构化返回代替，未在真 DB 上建表。`invoke` 通道本身、query 白名单、渲染路径均为真实代码执行；插件 sqlguard 的只读白名单有独立 Go 单测覆盖（task-156 已核实）。
- `scripts/ui-shot.sh` 当前脚本登录请求缺 `username` 字段（ADR-0057 后 API 要求），故未直接用该脚本；改为按其同款流程自写隔离验证脚本（独立 config/state/run/log、Playwright 1.65.1 + 缓存 chromium-1255、identify 校验宽高），该脚本属一次性临时资产，已随 `.c7tmp/` 删除。
- `usability-check` 18 FAIL 是本沙箱 `~/.cache/go-build` 与 `~/go/pkg/mod` 只读文件系统导致的 A1 环境性失败（24 插件仓逐个 `go test` 无法写缓存），非本前端改动引入；用工作区内可写 GOCACHE 复跑后仅剩 1 条存量 waf e2e FAIL。
- 本轮未改动主实例 8787 的 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`；未执行 install/upgrade；未联网业务（仅 goproxy.cn 拉 Go 依赖，属已授权）；他人 dirty（`scripts/usability-pending.txt`、`.agents/verify/*`、`data/`、`dist/` 等）原样保留。
- 收尾：停隔离实例、删除 `.agents/verify/.c7tmp/`（含 config/state/run/log/kored/gocache/gomodcache/一次性脚本与日志）；仅保留两张交付截图、本报告与代码改动。
