# PG 业务库选库 · UI 双端证据与自评（G-28 / task-195）

> 2026-11-27 · 执行者 `pg-dbselect` · 隔离实例 `kored` 端口 **18897**（非 8787；独立 config/state/run/log + 独立新编译二进制，全落 `.agents/verify/.pgdbselect-ui/`；未改 `.kore-local-*`，未读写 8787 运行态）· Playwright（`/home/pt/.cache/pw-runner`，真实 headless chromium）· invoke 端点路由 mock（返回真实形状的结构化结果，口令 mock 不涉及）· 收工已停实例并删除临时目录（脚本 / 二进制 / 配置 / 状态 / 日志）。
> 交付：`db.js` 点库后把 `database=S.selectedDb` 传进 query/exec invoke；表列表 `pg_tables` 与表结构 `information_schema.columns` 追加 `table_catalog='<库>'` 过滤；`db-postgres.js` 写入面板用实时 getter 跟随点选。**UI 不新增一级控件**——复用既有库列表点选入口，只改传参与 SQL 过滤。

## 1. 双端截图与尺寸实测

| 文件 | `identify -format '%f %wx%h %b'` | 目视核对 |
| --- | --- | --- |
| [ui-pg-dbselect-desktop-01.png](screenshots/ui-pg-dbselect-desktop-01.png) | `1440x1487 180009B`（宽 1440；full-page 高 1487 ≥ 900） | 数据库页切 PostgreSQL → 默认连接可达 → 库列表「myapp」被点选 → SQL 控制台显示针对 myapp 的库大小查询、结果 `myapp 7.3 MB` → 表结构折叠区显示 `myapp · 1 张表`、`demo` chip、`表结构：myapp.demo` 与 id/name 两列 → 底部「SQL 写入」折叠区未展开（不注入、首屏零成本） |
| [ui-pg-dbselect-mobile-01.png](screenshots/ui-pg-dbselect-mobile-01.png) | `390x844 56535B`（精确手机视口，非同图缩放） | 窄屏单列：`myapp` / `SHOW TABLES` / 备份 / 删除 一行紧凑排布；SQL textarea 撑满宽度、执行按钮 44px 触摸目标；`myapp · 1 张表` 与 `表结构：myapp.demo` 两列可见；底部 tab 条不遮挡关键内容 |

- 两图 sha256 不同：桌面 `902fae7b…` / 手机 `b607cc9e…`，非同图缩放冒充。PC 取 full-page（高 1487 > 900），手机取精确 390×844 视口。
- `read_image` 已逐张目视确认：布局、文案、列结构在两端都正确渲染（不是只看 DOM 断言）。

## 2. 自动化 DOM 断言（真实浏览器，非设计稿）

隔离实例登录后导航 `#/db` → 关掉 onboarding → 切 PostgreSQL → 选默认连接 → 点业务库 `myapp` → 点 `demo` 表，实测：

| 断言 | PC | 手机 |
| --- | --- | --- |
| 页面库上下文 | `myapp · 1 张表` | `myapp · 1 张表` |
| SQL 控制台预填 | `SELECT … pg_database WHERE datname = 'myapp'` | 同 |
| 表结构标题 | `表结构：myapp.demo` | 同 |
| 结构表行数 | 3（表头 + id + name） | 3 |
| 横向溢出 | docW=1440 = winW=1440 | docW=390 = winW=390 |
| JS 错误 | `[]` | `[]` |
| 带 `database=myapp` 的 query 调用数 | 3/3 | 3/3 |

三次 query invoke 的实际 params（`ui-result.json`，临时已删，日志摘要见下）：
1. `loadPgTables`：`{instance:'default', database:'myapp', sql:"SELECT tablename FROM pg_tables WHERE table_catalog = 'myapp' AND schemaname = 'public' ORDER BY tablename"}`
2. `useDb → runQuery`：`{instance:'default', database:'myapp', sql:"SELECT datname AS database, … WHERE datname = 'myapp'"}`
3. `showTableStructure`：`{instance:'default', database:'myapp', sql:"SELECT column_name … FROM information_schema.columns WHERE table_catalog = 'myapp' AND table_schema = 'public' AND table_name = 'demo' …"}`

> 说明：invoke 响应用路由 mock 提供（真实结构化形状：`Columns/Rows/RowCount`），用于验证**前端传参与渲染**；真实 DB 读写由 `pg-dbselect-live.md` 的真机报告覆盖（真插件 + 真 postgres:16）。二者互补，不互相冒充。

## 3. 产品定位自评（三问）

**问 1：本页解决什么用户问题？**
此前 PG 页点库后，只读控制台、表列表、表结构查询都固定连接维护库 `postgres`——用户建了业务库 `myapp` 却在面板里看不到它的表、也查不到列结构；想改数据只能找 DBA 或绕到命令行 `psql -d myapp`，与 MySQL 侧能操作的体验不对等。现在点一次库名就切到业务库：控制台 SQL、表列表、表结构、SQL 写入面板都带 `database=myapp`，操作前不需要填任何高级参数，也不需要新增一级控件——沿用「库列表点选」这个用户已经会的入口（易用性原则③：操作步骤尽量少），且数据库名过白名单后只作为 `database` 参数传递、不拼进可执行 SQL 字符串。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 的数据库页有完整的库级切换 + 可视化表浏览（分页看数据、行内编辑、字段级类型提示、SQL 历史）。本实现有意克制：①选库只是把既有 `database` 参数接进 query/exec，没有独立的「当前库」一级控件或跨库导航树；②表结构只读（列清单），没有数据行浏览器 / 行内 CRUD；③没有 SQL 历史 / 收藏 / 语法高亮。这些是有意边界（对齐 G-11 明确不做清单与项目 UI 减法口径），后续补齐需单独裁决，不在本卡范围。

**问 3：当前是「可用」还是「占位」？**
**可用（受控范围）。** 判据：
1. 前端路径：隔离实例真浏览器点库后，PC/手机两端都把 `database=myapp` 传进 3/3 次 query（见上方 params），表列表与表结构按 `table_catalog='myapp'` 过滤，`表结构：myapp.demo` 与两列肉眼可见；SQL 写入面板用实时 getter 跟随点选（单测/代码核对 + 真机报告覆盖 exec 写入落库），JS 错误 0。
2. 后端闭环：`pg-dbselect-live.md` 真机报告 6/6 PASS——`database=myapp` 的 query 读到业务库 demo 行、exec 写入落 myapp（容器内直读 count=2）、缺省回落 postgres、非法库名 E_INVALID 且不触达 DB。
3. 门禁：`go test -count=1 ./...` + `make check` exit 0；`node --check web/db.js|web/db-postgres.js` exit 0；`make frontend` exit 0 首屏 91092 B ≤ 300 KiB；`usability-check` 无新增 FAIL；`validate-index` + `build-market --check` exit 0；dist sha 四处一致。
4. 诚实边界：G-28 双端 UI 验证的 invoke 响应用 mock（只验前端传参/渲染），不冒充真库读取；真库语义另由真机报告覆盖。多实例 / 远程 PG 下选库未在本卡实测。

## 4. 收尾

一次性资产全部删除：`.agents/verify/.pgdbselect-ui/`（脚本 `ui-verify.js` / `genhash.go` / 二进制 `kored` / config / state / run / log / kored.log / ui-result.json / ui-err.log），隔离 kored 已停（18897 回读无监听）。仅保留本报告与两张 G-28 截图。
