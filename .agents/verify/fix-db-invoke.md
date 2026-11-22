> 元信息: 2026-11-23T00:45+08:00 · 执行者 fix-db-invoke 子 agent · P1 数据库页整页不可用（E_NOTFOUND）修复 · 报告 ≤60 行

# fix-db-invoke 验收报告（真机 · 双端 · G-28）
- 根因：`web/db.js` 方法段写裸动词 `instances`；`kore-plugin-db-mysql/internal/mysqlop/call.go:40` 的 `methodPrefix="db-mysql."` 只剥该前缀，而内核 `handlers_invoke.go:38-48` 按 `PLUGIN-PROTOCOL §7.2` 原样转发 → 插件回 `E_NOTFOUND 未知方法: instances`，实例卡/库列表/SQL 控制台全不渲染。
- 隔离实例：`127.0.0.1:18882`（`/tmp/kore-dbfix` 源码副本重建 kored）；**8787 全程未触碰**（首尾 `/-/healthz` 均 200，未重启）。DB：`docker run -d --name kore-db-fix -e MYSQL_ROOT_PASSWORD=test123 -p 13308:3306 mysql:8` → `8.4.13`，库 `kore_fix`、表 `demo`（alpha/beta/gamma 3 行）。插件：`db-mysql 0.1.0` 经 `store/install package_path` 安装 + enable，实例走 `KORE_MYSQL_INSTANCES`，密码只走 `password_env=KORE_MYSQL_PASSWORD`。
## ① db.js 前后对比（同会话/同 CSRF 实测）
| 位置 | 改前（裸动词 → 实测 404） | 改后（限定名 → 实测 200） |
| --- | --- | --- |
| `web/db.js:270` | `/invoke/db-mysql/instances` → `E_NOTFOUND 未知方法: instances` | `/invoke/db-mysql/db-mysql.instances` |
| `web/db.js:259` | `/invoke/db-mysql/databases` → `E_NOTFOUND` | `/invoke/db-mysql/db-mysql.databases` |
| `web/db.js:234` | `/invoke/db-mysql/query` → `E_NOTFOUND` | `/invoke/db-mysql/db-mysql.query` |
| `web/db.js:247` | `/invoke/db-mysql/status` → `E_NOTFOUND` | `/invoke/db-mysql/db-mysql.status` |

页面真实请求侧：CDP `Network.requestWillBeSent` 抓到 4 条 `/api/v1/invoke/db-mysql/db-mysql.{instances,databases,query,status}`，无裸动词。
## ② 14 个视图 invoke 路径审计（判定以插件源码为准，不看 round1 页面表现）
| 视图 | 方法段 | 插件侧命名契约 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| db.js | instances/databases/query/status | `mysqlop/call.go:40` 仅认 `db-mysql.` | **裸动词 → 必 404** | 改 4 处 |
| logs.js | stats/tail/search/sources | `logs/methods.go:190` TrimPrefix 兼容 | 裸动词可用但违约 | 改 4 处 |
| process.js | list/detail/kill/tree | `process/methods.go:44` 兼容 | 裸动词可用但违约 | 改 4 处 |
| ssl.js | list/verify/renew/selfsign/import | `ssl/methods.go:54` 兼容 | 裸动词可用但违约 | 改 5 处 |
| backups.js | restore/delete/verify/list/create | `backupop/call.go:44` 兼容 | 裸动词可用但违约 | 改 5 处 |
| files.js | file.* | `fileop/call.go` 兼容 | 已限定 | 加调用形态注释 |
| sites.js | site.* | `site/methods.go:108` 兼容 | 已限定 | 加注释 |
| tasks.js | cron.* | `cron/methods.go` cronVerb 兼容 | 已限定 | 加注释 |
| terminal.js | terminal.* | `terminal/methods.go:121` 兼容 | 已限定 | 加注释 |
| app.js:541 | `ping` | echo 兼容裸 `ping`，其余插件无此动词 | 裸动词 | 改 `<id>.ping` |
| app.js:737 | `method.replace(':','.')` | 桥转 `echo.ping` | 已限定 | 加注释 |
| store.js / monitor.js / settings.js | 无 invoke（`store/*`、`plugins*`、`system/*`、`auth/*`） | — | N/A | 加注释说明 |

合计 **23 处裸动词 → 限定名**；13 个视图顶部均写明「调用形态：`POST /api/v1/invoke/<id>/<id>.<action>`」，`docs/FRONTEND.md` 同步该硬约束。
回归反证（同实例装 8 插件并 enable 后真调）：`logs.sources` / `process.list` / `ssl.list` / `backup.list` / `file.list` / `site.list` / `cron.list` / `terminal.list` **全部 200** —— 改限定名不会把原本可用的页面改坏。
## ③ 真机四步 + 双端截图（`identify` 实测宽高；每张前后各一次 DOM 断言）
| 步骤 | 页面证据 | 接口证据 | 截图（尺寸 · 字节 · sha256 前 12） |
| --- | --- | --- | --- |
| ① 实例卡 | `fix` + 可达徽章 + `127.0.0.1:13308` + `8.4.13` | `{"instances":[{"name":"fix","reachable":true,"version":"8.4.13"}],"count":1}` | [dbfix-desktop-01](screenshots/dbfix-desktop-01-instance.png) 1440×900 · 73877B · 74c45f7e66f1 |
| ② 库列表 | `kore_fix`，点击自动 `SHOW TABLES` → `demo` | `{"databases":["kore_fix"],"count":1}` | [dbfix-desktop-02](screenshots/dbfix-desktop-02-databases.png) 1440×900 · 73464B · e333edc4eb2d |
| ③ SQL 查询 | `SELECT * FROM kore_fix.demo` → 列 id/name/note、3 行、`3 行` | `{"row_count":3,"columns":["id","name","note"]}` | [dbfix-desktop-03](screenshots/dbfix-desktop-03-query.png) 1440×900 · 77511B · e1f3905858b1 |
| ④ 写操作拒绝 | 黄条 `E_INVALID：只读白名单拒绝: 语句必须以 SELECT/SHOW/DESCRIBE/EXPLAIN 开头`；`SHOW TABLES` 复核 `demo` 在、`COUNT(*)=3` | `400 {"code":"E_INVALID", …}` | [dbfix-desktop-04](screenshots/dbfix-desktop-04-rejected.png) 1440×900 · 80268B · fa35eea63c7b |
| 手机 ① | 实例卡可达 + 8.4.13；`scrollWidth==innerWidth==390`（无整页横向滚动） | 同 ① 接口 | [dbfix-mobile-01](screenshots/dbfix-mobile-01-instance.png) 390×844 · 50907B · 7a15c32aefeb |
| 手机 ② | 查询结果 3 行；`.db-result-scroll` 计算样式 `overflow-x:auto` | 同 ③ 接口 | [dbfix-mobile-02](screenshots/dbfix-mobile-02-query.png) 390×844 · 50690B · f407cbb596bb |

DOM 断言口径（每张截图前、后各一次）：`body.innerText` 含「数据库」、`#kore-password` 数 == 0、页内特征文案命中（可达 / `Tables_in_kore_fix` / alpha / 只读白名单拒绝）；6 张 sha256 两两不同（重复计数 0）。预期内 4xx 仅 `favicon.ico` 404（无图标资源）与 `db-mysql.query` 400（DROP 即被测行为），console error 仅此两条、无 JS 异常。
## ④ 门禁（命令 + 退出码）
| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check` 14 个 `web/*.js` | 0（逐个 `[OK]`） | 13 个改动视图 + `shell.js` 全通过 |
| `make frontend` | 0 | 首屏 35566 B / 307200 B（余量 271634 B） |
| `make docs-check` | 0 | 6 pass / 0 warn / 0 fail |
| `make check` | 0 | 10/10 段全绿，末行 `[OK] 门禁全部通过` |
## ⑤ G-28 产品定位自评
1. **解决什么用户问题**：不登 SSH、不记 mysql 客户端参数，在控制台确认实例可达/版本、列库并跑只读 SQL；写语句在触达数据库前被拒并给出完整原因。
2. **与宝塔 / 1Panel 差距**：对方有库表结构编辑、账号权限、备份恢复、导入导出、慢日志可视化、多实例聚合；本页只有只读查询 + 实例切换，结果表无分页/导出/历史。
3. **可用还是占位**：**可用**（真实实例、真实查询、真实拒绝；空态与不可达态前序已验收）；但只是"查看与只读调试"最小闭环，不是完整 DBA 面板。
## 清理（已执行）
`docker rm -f kore-db-fix` → 容器消失；kill 隔离 `kored`（PID 3407105）→ 18882 无监听；`rm -rf /tmp/kore-dbfix` → 副本/一次性 CDP 脚本/日志全删。8787 保持运行（首尾 `/-/healthz` 200，未重启）。
