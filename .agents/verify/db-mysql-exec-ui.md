> 元信息: 2026-11-25T10:05+08:00 · 执行者 feat-plugin-dbmysql · db-mysql 插件「后端已实现、前端无入口」能力补口 · 隔离实例真浏览器双端截图（G-28）· 报告 ≤90 行

# db-mysql 写入执行 UI 收口验收（db-mysql.exec 接线）

## 0. 结论

db-mysql 0.5.2 的 db-mysql.exec 后端早已真实实现（写语句二级确认 + 白名单 + 结构化结果，
internal/mysqlop/exec.go / writeguard.go），但 web/db.js 的 SQL 控制台只接 db-mysql.query（只读白名单），用户根本点不到 exec。
本次新建 web/db-mysql.js（exec 面板，db-mysql 插件懒加载视图），由 web/db.js 在 MySQL 页展开「SQL 写入」时按需注入
（同 db-l2.js 模式），把 exec 接成用户可点、可见结果的功能。真浏览器点选预设 → 填 SQL → 勾选确认 → 点「执行写入」，
触发真实 db-mysql.exec RPC（隔离实例无有效 DB 凭据，拿到后端 E_INVALID 原文并展示「怎么办」，证明整条调用链通）。
双端截图 file 实测 1440×900 / 390×844。声明完成。未做：DB 真机写入成功路径（本隔离实例无 MySQL 凭据，属环境限制，非 UI 缺口）。

## 1. 缺口清单（path:line 证据）

| 后端方法声明 | 位置 | 前端缺口 |
| --- | --- | --- |
| db-mysql.exec | kore-plugin-db-mysql/internal/mysqlop/call.go:33-35（case exec）；:69（businessVerb 白名单含 exec）；info.json:11 声明 system:admin；exec.go:34 实现（两级确认 + 结构化结果） | 改动前 grep -rn 'db-mysql.exec' kore/web/*.js 零命中（仅 container.js 有自己的 container.exec） |

改动前 web/db.js + web/db-l2.js + web/slow-query.js 实际调用的 db-mysql 方法完整集合：
instances / databases / query / status / slowlog / createDatabase / dropDatabase / createUser / changePassword /
dropUser / grant / export / import —— 共 13 个（info.json 16 条方法声明减去 config.get/set 两条与 exec 一条）。
exec 是唯一「后端已实现、前端零调用」的方法，也是最有用户价值的一条（SQL 控制台只读，写操作此前只能靠建库/用户表单，
任意 UPDATE/DDL 无入口）。不硬造无意义方法，故只补 exec 一条。

## 2. 补齐后的用户可见行为

- 入口：数据库页（#/db，MySQL）→ 页面下方「SQL 写入（INSERT / UPDATE / 结构变更）」折叠面板（默认收起，首屏零注入）。
- 交互：五个预设一键填入（新增一行 / 修改数据 / 删除数据 / 新建表 / 删除表）；选中后自动判断分级——普通写入勾选「我已确认」即可，
  DDL 还要手打确认短语（如 DROP TABLE，与后端 confirmPhrase 一致）；点「执行写入」调 db-mysql.exec {instance, sql, confirm:true,
  confirm_text}。执行中禁用按钮防重复；成功/失败有中文提示与结果表。
- 实证：隔离实例真浏览器点「新增一行」→ SQL 框填入 INSERT 示例、提示「检测到普通写入（INSERT）」→ 勾选确认 → 点「执行写入」→
  后端回 `E_INVALID：实例 "default" 的密码环境变量 KORE_MYSQL_PASSWORD 未设置或为空`，页面展示原文 + 「怎么办：连接不存在…选一个可达的 MySQL 连接再执行」。
  RPC 链 ctx.invoke → POST /api/v1/invoke/db-mysql/db-mysql.exec → 插件，全通。PAGE_ERRORS=[]（两视口零 JS 错误）。

## 3. 隔离实例真机验证（G-29）

本轮是否改动过主实例的运行态配置：否。未碰 .kore-local.yaml / .kore-local-state/ / .kore-local-run/ / 主 bin/kored；未重启 8787。
证据全来自隔离实例：独立 kored 二进制（本工作树源码 go build，CGO_ENABLED=0 + trimpath + -s -w，落 .tmp/dbmysql-iso/，gitignored），
独立 config/state/run/log（端口 18875），随机口令仅内存 + 0600 配置文件（验证后整目录删除，G-30）。
隔离实例装 db-mysql 0.5.2（POST /api/v1/store/install 本地包，state=succeeded / reload=reloaded）、enable 后 granted system:admin；
导出 KORE_MYSQL_HOST/PORT/USER 令默认实例成形。浏览器：headless chromium + playwright-core（缓存已有，零新依赖），登录后走
#/db 真路由、点真实折叠头、点真实预设与执行按钮。收尾：临时二进制/脚本/config-state-run-log/口令文件全删。

## 4. G-28 双端截图（file 实测宽高）

| 文件 | file 实测 | 证据点 |
| --- | --- | --- |
| screenshots/db-mysql-feature-exec-desktop.png | 1440 × 900 | SQL 写入面板：连接下拉（default 不可达）/ 红字风险提示 / 五个预设按钮 / SQL 示例 / 确认勾选 / 确认短语框 / 执行按钮 / 后端 E_INVALID 原文 + 「怎么办」 |
| screenshots/db-mysql-feature-exec-mobile.png | 390 × 844 | 同面板响应式：标题换行不挤压、预设按钮换行、输入框与触摸目标可用、底部 tab 导航可见 |

两张均来自同一次隔离实例真浏览器会话的不同 viewport（非同图缩放）；md5 不同（desktop f6df94a9… / mobile 9a32a345…）。

### 产品定位自评（G-28 三问）

① 解决什么问题：SQL 控制台以前只能读，任意写操作（改一行数据、删一张表、加字段）必须 SSH 上去敲 mysql。现在在面板里选预设、
填 SQL、两级确认即可完成；DDL 需手打确认短语，默认不误触，小白也能按提示安全操作。
② 与宝塔/1Panel 的差距：它们有完整的在线 SQL 编辑器 + 执行历史 + 可视化表编辑。本面板只有受控单条写语句（白名单 + 二级确认），
没有多语句事务、执行历史、可视化建表；但日常「改一条/删一条/建表/删表」已覆盖，且安全门与后端一致。
③ 可用还是占位：UI 可用（非占位）。真浏览器点击触发真实 exec RPC，后端 E_INVALID 原文回显证明调用链完整；本次隔离实例无有效 DB
凭据，未证写成功路径，但这是环境限制，不是 UI 缺口。

## 5. 门禁命令与退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| node --check web/db-mysql.js | 0 | 无输出（语法通过）；web/dist/db-mysql.js 同源 md5 一致 |
| make web-dist | 0 | db-mysql.js 拷入 web/dist |
| cd kore-plugin-db-mysql && GOWORK=off go test -timeout 200s ./... | 0 | 6 包全绿：根 / mysqlop / plugincfg / tests/{boundary,e2e,fault} |
| make secret-check | 0 | secret-check: 0 FAIL / 22 处匹配（占位写法均合规） |
| 真浏览器点击 + 双端截图 | 0 | EXEC_MODULE_LOADED=true / PRESET_SQL=INSERT INTO demo… / CONFIRM_CHECKED=true / EXEC_RESULT_MSG=E_INVALID… / PAGE_ERRORS=[] |
| file screenshots/db-mysql-feature-exec-*.png | 0 | 1440×900 / 390×844，与 G-28 一致 |

## 6. 写域与提交

- 源码：kore/web/db-mysql.js（新建 exec 面板）+ kore/web/db.js（+46 行按需注入接线）+ kore/Makefile（WEB_SRC_FILES +db-mysql.js）+
  kore/web/embed.go（embed 清单 +dist/db-mysql.js，构建前提）+ 本验收报告 + 2 张截图。
- 未改 web/shell.js / web/onboarding.js / 任何其它 web/<id>.js / kore 后端 internal/ / 其它插件仓 / 运行态资产。
- kore-plugin-db-mysql 仓零改动（后端方法本就齐备；开工前既有未跟踪文件 internal/mysqlop/zeroparam_test.go 为他人所有，本卡未碰）。
- 提交：精确 pathspec + [agent:feat-plugin-dbmysql] 前缀，commit 不 push。
