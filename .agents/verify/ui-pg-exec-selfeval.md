# PG SQL 写入面板 · UI 自评与验收证据（G-28）

> 2026-11-27 · 执行者 `pg-exec`（task-176，持续目标 round 16）· 隔离实例 `127.0.0.1:<随机空闲端口>`（独立 config/state/run/log + 独立新编译二进制，非 8787，未碰 `.kore-local-*`）· Playwright（`/home/pt/.cache/pw-runner`，真实 headless chromium）· 收工已停实例并删 `.agents/verify/.pgtmp/` 临时目录。
> 实现：把 db-mysql 的受控写模式移植到 db-postgres——新增 `db-postgres.exec`（两级确认 + 写白名单 + `system:admin` + 审计），前端 `db.js` 的 SQL 写入折叠面板对 PG 开放，按需注入新增的 `web/db-postgres.js`（PG 语法预设，含 `RETURNING`）。`query` 保持 `system:read`，不放开只读操作员写权。

## 0. 交付概览

- 后端：`db-postgres.exec` 动词（`call.go` 分发 + `businessVerb` 白名单 + `types.go` 入参/结果 + `client.go` 写执行走 psql stdin）+ PG 方言 `ValidateWriteSQL`（首关键字白名单按 PG 调整：无 `REPLACE`、有 `MERGE`/`REINDEX`/`CLUSTER`/`VACUUM`；确认短语、多语句、64 KiB、NUL、反斜杠元命令、`COPY ... PROGRAM`、副作用函数全 fail-closed）。
- 授权：`info.json` 声明 `db-postgres.exec = system:admin`；插件侧 `requireAdmin` 纵深防御（缺 admin → `E_UNAUTHORIZED`）；内核 invoke 审计按 admin 类自动覆盖（不接内核 confirm-token，两级确认够用）。
- 前端：`db.js` 的 `ensureExec()` 按当前实例类型选择 `db-mysql.js` / `db-postgres.js`，同一折叠面板 UI；PG 预设 5 条（INSERT/UPDATE/DELETE 带 `RETURNING`，CREATE 用 PG identity 列，DROP），不展开就不注入，首屏预算不变。

## 1. 双端截图证据（G-28）

| 文件 | identify -format | 观察 |
| --- | --- | --- |
| `ui-pg-exec-desktop-01.png` | 1440x1884（PC full-page，宽 1440、高 ≥900） | 数据库页切到 PostgreSQL → 「SQL 写入」折叠区展开：`default` 连接、红色不可回滚警告、5 个常用示例、SQL 框内 `INSERT INTO demo (...) VALUES (...) RETURNING id`、已勾选确认、结果区 `执行完成 · 影响行数 1` 与 RETURNING 表 `id=42`。 |
| `ui-pg-exec-mobile-01.png` | 390x844（精确手机视口） | 窄屏单列排布：预设按钮换行、textarea 撑满宽度（≥120px 高）、确认框/执行按钮触摸目标、结果表 `id=42` 可见，底部 tab 条不遮挡关键内容。 |

两张图 sha256：桌面 `cd8865fe3b979df2fe05e...` / 手机 `35b0c832cb0c579e36efa...`，非同图缩放冒充。PC 取 full-page（高 1884 > 900），手机取精确 390×844 视口。

## 2. 自评三问

**问 1：本页解决什么用户问题？**
此前 PG 页只有只读 SQL 控制台（`query=system:read`），用户想写一行数据、建一张表只能找 DBA 或改配置里的 psql，面板根本没有入口。现在 PG 侧与 MySQL 一样有「SQL 写入」折叠区：一键填 PG 语法预设（含 `RETURNING` 回读）、勾选确认、（DDL）手打确认短语、执行后直接看到影响行数与返回行。错误提示给「怎么办」（未确认 → 勾确认框；白名单拒绝 → 按 message 改语句；无权限 → 找管理员），符合易用性四原则；写操作仍默认关闭、需显式确认两级，不会因为误点改数据。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 有完整的表数据浏览器（分页浏览、行内编辑、字段级类型提示、SQL 执行历史）。本实现有意克制：①只提供「写 SQL」面板，没有行级 CRUD 表格或可视化编辑器；②没有 SQL 历史/收藏/语法高亮；③没有细粒度按表白名单（靠首关键字白名单 + 管理员授权 + 两级确认兜底）。这些是有意边界（对齐 task-175 核实结论：复用现成门、不引入新设计面、不推翻 ADR），后续补齐需单独裁决。

**问 3：当前是"可用"还是"占位"？**
**可用（受控写范围）。** 判据：
1. UI 路径：隔离实例真实浏览器登录后，切 PG → 展开写入面板 → 点 INSERT 预设 → 未确认时前端本地拦截（无 RPC）→ 勾选确认 → 执行 → `影响行数 1` 与 RETURNING 表 `id=42` 在双端截图肉眼可见；页面 JS 错误 0。
2. 调用路径：面板走真实 `invoke('db-postgres.exec', {instance, sql, confirm, confirm_text})`，URL 按方法前缀自动选 `/api/v1/invoke/db-postgres/`；直接打 `exec` 且 `confirm=false` 经同一通道拿到 `E_INVALID`（HTTP 400，message 含 `confirm=true`）——后端守卫不是前端摆设。
3. 后端门禁：`go test -count=1 ./...` + `make check` 全绿（writeguard 单测覆盖正常写/多语句/DDL 确认短语/注入/COPY PROGRAM/副作用函数/无 admin→E_UNAUTHORIZED，fault 注入覆盖 exec 方法）；`node --check` 三个 js 文件 exit 0；`make frontend` exit 0，首屏 91092 B ≤ 307200 B（改的是懒加载视图+新增懒加载模块，不进首屏）；`usability-check` 可写 GOCACHE 下无新增 FAIL（仅存量 waf A1 e2e FAIL，与本改动无关）。

## 3. 隔离实例真跑/mock 断言（命令 + 退出码 + 关键输出）

一次性脚本：`.agents/verify/.pgtmp/pg-exec-verify.sh`（起独立 kored → 登录 → Playwright 路由 mock → 双端截图 → 停实例）；二进制：`.agents/verify/.pgtmp/kored`（工作区可写 GOCACHE/GOMODCACHE 从已授权本地缓存新编译，含新 `embed.go`→`dist/db-postgres.js`）。

```
$ bash .agents/verify/.pgtmp/pg-exec-verify.sh
[INFO] isolated port=43327 (not 8787)
[INFO] login OK
BACKEND_NO_CONFIRM={"status":400,"code":"E_INVALID","message":"写语句需要显式确认：请传 confirm=true"}
DOM={"view":"db","mode":"postgres","sql":"INSERT INTO demo (name, created_at) VALUES ('示例', NOW()) RETURNING id","err":"请先勾选「我已确认」...","ok":"执行完成：数据写入 · 目标 default · 影响行数 1","table":"id42","errors":[]}
[SHOT] desktop 1440 1884 ...
[SHOT] mobile 390 844 ...
[DONE] port=43327
EXIT=0
$ identify -format '%f %wx%h %b\n' .agents/verify/screenshots/ui-pg-exec-*.png
ui-pg-exec-desktop-01.png 1440x1884 228313B
ui-pg-exec-mobile-01.png 390x844 78936B
```

断言明细：
- PG 预设：`INSERT INTO demo (name, created_at) VALUES ('示例', NOW()) RETURNING id`（PG 语法，`RETURNING` 回读）——DOM 断言通过。
- 无 confirm：前端本地拦「请先勾选我已确认」（不发 RPC）；直接走 invoke 通道 `confirm=false` → HTTP 400 / `E_INVALID` / message 含 `confirm=true`。
- 有 confirm：mock 返回真实 `ExecResult` 形状 `{instance, kind:'data', executed:true, columns:['id'], rows:[{id:42}], row_count:1}` → UI 显示 `影响行数 1` 且 RETURNING 表渲染 `id=42`。
- 只读用户 `exec → E_UNAUTHORIZED`：单管理员模式无法在隔离实例上创建第二个只读 Kore 用户来实机验；由 Go 单测 `TestCallExec` 断言（cfg.Admin=false → E_UNAUTHORIZED）与方法级 `system:admin` + 内核审计口径覆盖，**此项标注为设计承诺/单测证据，非真机双用户实测**。

## 4. 诚实边界

- 本机没有 PostgreSQL 真服务端，`db-postgres.instances/status/databases/query/exec` 均由 Playwright 路由 mock 返回结构化数据（形状取自真实 `ExecResult`/`QueryResult`）；"`INSERT` 真的写进数据库"这一步未在真 DB 上执行。`invoke` 通道、CSRF、前端渲染、Mock 边界之外的 Go 插件写守卫均为真实代码执行，插件写守卫有独立 Go 单测覆盖。
- 截图与断言用新编译的隔离 kored（含新 embed 的 `db-postgres.js`），**未替换运行中的 `bin/kored`**、未重启 8787 主实例；`make build` 产物按发版 lead 流程另行组织。
- 本轮未改动主实例 8787 的 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`；未执行 install/upgrade；未联网业务（Go 依赖走已授权本地缓存/goproxy）；他人 dirty（`kore/scripts/usability-pending.txt`、`kore/.agents/verify/*`、`dist/`、`data/`、`kore-plugin-db-postgres/zeroparam_test.go` 等）原样保留。
- 收尾：停隔离实例、删除 `.agents/verify/.pgtmp/`（含 config/state/run/log/kored/一次性脚本与日志、独立 GOCACHE 在 workspace 根另清）；仅保留两张交付截图、本报告与代码改动。
