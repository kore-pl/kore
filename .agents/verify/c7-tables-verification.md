# C7 只读表结构浏览 · 独立验收报告（G-09 / task-158）

> 验收人：`c7-tables-verifier`（独立 verifier，非 `c7-tables` 实现者）
> 时间：2026-11-27 · 对象：commit `335fa83657d92e834e97e8417aed98e038bd03fc`
> 口径：只读复核；唯一写入 = 本报告；未改代码、未连真实 DB、未联网业务、未碰 `.kore-local-*`、未执行主流程 CLI、未 push。
> 总评：**PASS**

## 0. 结论速览

| # | 复核项 | 结论 |
| --- | --- | --- |
| 1 | 读码：表结构折叠区 / chip / invoke / 渲染复用 / en-US 8 文案 + zh fallback / dist 逐字节 | PASS |
| 2 | 注入防护：isSafeIdent 白名单 + ≤128 / quoteIdent / structSQL 空串 / fail-closed / 不安全库名拒绝 / 20 断言 | PASS（本机独立复跑 25/25，0 次 fetch） |
| 3 | 门禁：node --check / frontend 首屏 ≤300KiB / secret-check 0 FAIL / usability 无新增 FAIL | PASS（usability 存量 1 FAIL 与前端无关） |
| 4 | 隔离断言 20+DOM + mock 边界诚实标注 / 非 8787 / .c7tmp 删净 | PASS |
| 5 | G-28 双端截图实读 + identify 宽高 + 三问原文 + UI 减法 | PASS |
| 6 | git：335fa83 精确 5 文件 + DCO / 未 push / 仅主树 / 他人 dirty 原样 | PASS |

## 1. 读码复核（web/db.js / i18n / dist）

- `web/db.js` 在既有「SQL 控制台」panel 内追加 `<details class="db-tables">`（默认展开），挂 `summary`「表结构」，**不新增一级导航控件、不新建 hub**。`SHELL_ROUTES` 未改，一级菜单仍 10 项。
- 点库 `useDb(name)` 复用既有 `runQuery(onSuccess)` 的 `SHOW TABLES FROM <quoted>` 结果，`parseTableNames` 取第一列且只放行白名单名生成 chip；PG 走 `pg_tables` 只读查询。
- 点 chip → `showTableStructure(db, table)` → `invoke(methodFor('query'), {instance, sql})`，`methodFor` 拼 `db-mysql.query` / `db-postgres.query`，走既有 invoke 通道；SQL 为 `SHOW FULL COLUMNS FROM \`db\`.\`table\`` / `SELECT ... information_schema.columns`（只读前缀）。
- 渲染复用：`paintResult` 已重构为 `renderResultInto(host, r, emptyText)`，结构列信息与查询结果共用同一表格渲染器；标题与结果分两个子节点（避免 `renderResultInto` 清空 host 抬掉标题）。
- i18n：`web/i18n/en-US.js` 新增 8 条（`db.struct.invalidName`、`db.tables.{count,empty,hint,loading,structHint,structOf,title}`），`tr(key, fallback)` 在 i18n 缺键时回退第 2 参数中文；`zh-CN.js` 无这些键 → 中文态走 fallback，无裸键。
- **dist 逐字节**：`cmp -s web/db.js web/dist/db.js` → IDENTICAL；SHA256 两边同为 `70310b0f…5274ba`。i18n 英文包亦由 Makefile `frontend` 拷入 dist。embed 生效前提成立。

## 2. 注入防护复核（重点）

源码证据（`web/db.js`）：
- `IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/`，`isSafeIdent` 要求 string、非空、长度 ≤128 且全匹配。
- `quoteIdent(name, pg)` 仅接受白名单名，否则返回空串；用反引号/双引号包裹。
- `parseTableNames` 只把白名单表名放进 chip（注入型名称不进列表、点不到）。
- `structSQL`：表名或库名不安全 → 返回空串；PG 必须提供安全库名；MySQL 用 `db.\`table\`` 形式。
- `showTableStructure`：先校验表名，再校验 `structSQL` 结果，任一失败即设 `structError`、`structResult=null`、`paintStruct()` 后 return，**不发请求**（fail-closed）；不污染上一次合法 `structResult`、`structLabel`。
- 不安全库名也在 `useDb` 与 `showTableStructure` 两处被拒（worker 修过的缺陷已修）。
- 只读白名单未绕：新增 SQL 全部 `SHOW`/`SELECT` 前缀，未触 `db-l2` 写路径（写操作仍在独立 `db-l2.js`，需二级确认）。

**本机独立复跑**（Node + vm 加载真实提交源码，桩 fetch 计数，零 DB/网络/文件写）：25 条断言全 PASS、0 FAIL、`fetchCalls=0`：
- 正例 2 条（`users`/`audit_log2`）；
- 10 条注入/异常表名全 false：`x\`;DROP TABLE users;--`、`a;DROP`、`a' OR 1=1--`、`bad name`、`a\`b`、`a\b`、`''`、`a.b`、`sel ect`、`1bad`；
- 长度边界（129 false / 128 true）、非字符串 false；
- `structSQL` 注入表名 / 注入库名 / 空表名均返回 `""`；正常 `structSQL('kore_ui','users')` 以 `SHOW FULL COLUMNS FROM` 开头、含 `` `kore_ui`.`users` ``、无写关键字；
- `showTableStructure` 注入表名与不安全库名两次调用 **fetch 计数均为 0**，`structError` 非空、`structResult=null`。

实现者报告（`ui-c7-tables-selfeval.md` §3）的 20 条断言（含 DOM chip 过滤：`users`/`orders` 之外注入行不进 chip，`errors=[]`）与本次独立复跑结论一致；DOM 断言证据为报告内记录的真实浏览器输出，本机未重复起浏览器（按只读纪律，不重建一次性隔离实例）。

## 3. 门禁复核

| 命令 | 结果 |
| --- | --- |
| `node --check web/db.js` | exit 0 |
| `node --check web/i18n/en-US.js` | exit 0 |
| `bash scripts/frontend-check.sh`（`make frontend` 的判据本体；未跑 `make frontend` 以免 `rm -rf web/dist` 改动他人产物） | exit 0；首屏 90924 B ≤ 307200 B（300 KiB），余量 216276 B；i18n 增量 2941 B ≤ 3072 B。另有体积**漂移 WARN**（基线+5%/绝对线），非 FAIL，且 C7 改的是懒加载 db.js + 英文包，不计首屏。 |
| `bash scripts/secret-check.sh` | exit 0；`0 FAIL / 23 处匹配（占位写法均合规）` |
| `bash scripts/usability-check.sh --no-run-tests` | exit 0；`0 pass, 502 warn, 0 fail, 187 unverified` |
| 全量 `bash scripts/usability-check.sh`（隔离 `GOCACHE=/tmp/c7verify-gocache`，跑完删除） | exit 1；`0 pass, 502 warn, 1 fail, 187 unverified`。唯一 FAIL 为 `A1 waf: ZeroParam 真跑失败`（`kore-plugin-waf/tests/e2e`），与自评记录的存量基线（1 条 waf e2e FAIL）吻合，与本次前端改动无关；无新增 FAIL。 |

默认 GOCACHE 只读时 A1 会产生 18 条环境性 FAIL（本仓口径已记录），可写 GOCACHE 复跑后仅剩上述 1 条存量 FAIL，与任务卡基线一致。

## 4. 隔离断言与 mock 边界诚实标注

- 自评报告 §1/§3/§4 明确写明：本机无 MySQL/MariaDB 服务端（`mysqladmin ping` 失败），截图与 UI 断言使用 Playwright 路由拦截的 **mock** `SHOW FULL COLUMNS` 返回形状（列名/类型取自真实返回形状）；`invoke` 通道、query 白名单、`renderResultInto` 渲染路径均为**真实代码执行**；插件 sqlguard 只读白名单有独立 Go 单测（task-156 核实）。**未把 mock 说成真机 DB 验证**——边界诚实，符合任务卡重点要求。
- 隔离实例用独立 config/state/run/log + 随机空闲端口，**非 8787**；未碰 `.kore-local.yaml`/`.kore-local-state`/`.kore-local-run`/`bin/kored`；未执行 install/upgrade；仅 goproxy.cn 拉 Go 依赖（已授权）。
- `.agents/verify/.c7tmp/` 已删净（`ls` 确认不存在）；`.agents/verify/iso-monitor/` 为 11-25 既有目录，时间戳早于本次（11-27），非本轮残留。
- DOM 证据（自评记录）：`structTitle="表结构：kore_ui.users"`、`tables=["users","orders"]`、`columns` 含 `Field/Type/...`、单元格含 `email`/`varchar(191)`、`errors=[]`。

## 5. G-28 双端截图实读

本机用 `read_image` **实读**两张 PNG，并用 `identify` 核宽高/sha256：

| 文件 | identify | sha256 | 实读观察 |
| --- | --- | --- | --- |
| `ui-c7-tables-desktop-01.png` | 1440 × 1627（PC full-page，高 > 900） | `5ae25c5d…6d624` | 数据库页 SQL 控制台内「表结构」折叠区可见；库 chip `kore_ui`/`appdb`；表 chip `users`/`orders`；点开后「表结构：kore_ui.users」表格 `id bigint(20) unsigned`、`email varchar(191)`、`created_at datetime`，列头 Field/Type/Collation/Null/Key/Comment 清晰。左侧一级导航仍为原 10 项，未新增常驻控件。 |
| `ui-c7-tables-mobile-01.png` | 390 × 844（精确手机视口） | `9c54c6c2…37a5` | 窄屏单列排布，同一表结构表可见，chip 触屏尺寸，结果区可横向滚动，底部 tab 条不遮挡；无伪造/同图缩放迹象（尺寸与 sha256 均不同）。 |

三问原文在 `.agents/verify/ui-c7-tables-selfeval.md` §2：问1（解决"看列结构要手写 SQL"的问题）、问2（与宝塔/1Panel 差距：有意克制，只读范围内，不做索引/外键/ER/写路径）、问3（"可用（只读范围）"，给出 UI 路径/调用路径/门禁三条判据）。原文完整、未敷衍。UI 减法成立：未新增一级控件、未建 hub。

## 6. git / 工作树复核

- `git rev-parse HEAD` = `335fa8365…`；`git show -s`：`[agent:c7-tables] feat(db): 只读表结构浏览接既有 query 通道（C7，含标识符白名单注入防护）`，含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`，**DCO 合规**。
- `git diff-tree --name-status 335fa83` 精确 5 文件：2 张截图（A）、`ui-c7-tables-selfeval.md`（A）、`web/db.js`（M）、`web/i18n/en-US.js`（M）——与任务卡一致，无夹带。
- **未 push**：`origin/main` = `64e43f3`，`git merge-base --is-ancestor 335fa83 origin/main` 为假（UNPUSHED）；本地 main 领先 32。
- `git worktree list` 仅 `/home/pt/Work/GolandProjects/kore-pl/kore [main]`，无额外 worktree。
- 他人 dirty 原样保留：`scripts/usability-pending.txt`（M），`.agents/.agents/`、`.agents/verify/e2e-*.md` 等未跟踪文件、`data/`、`dist/` 均未触碰；本次复核前后 `git status --short` 完全一致。

## 7. 硬纪律自检

- 只读：除本报告外未写任何仓库文件；未 `git add` 任何其他文件；未 push；未联网业务；未执行主流程 CLI；未碰 `.kore-local-*`；未连真实 DB。
- 隔离 GOCACHE 在 `/tmp`（不落工作区），跑完已 `rm -rf` 删除；`/tmp` 中间物不跨调用保留，符合记忆约束。
- 唯一可写文件 = 本报告；精确 `git add .agents/verify/c7-tables-verification.md` + `git commit -s`（DCO）。

## 8. 总评

**PASS。** 六项复核全部成立；注入防护独立复跑 25/25 且 0 次 fetch；门禁无新增 FAIL；mock 边界诚实标注；双端截图实读通过；git 状态合规。无 BLOCKED 项。
