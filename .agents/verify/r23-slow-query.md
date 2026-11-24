# R23 · 跨实例慢查询分析看板（r23-slowlog）交付与 G-28 证据

> 日期 2026-11-24 19:10–19:35（Asia/Shanghai）｜Owner `r23-slowlog`（🔵 美团味）｜新 HEAD `3fcf520`（含接线提交）｜隔离实例 **18891**（`--config /tmp/kore-r23-slowlog/config.yaml`，state/run/log 全落 `/tmp`）｜写域 `web/slow-query.js`（唯一代码交付）+ 本报告 + 3 张截图｜**未 push**。

## 0. 结论

纯增量新看板交付完成，硬验收 5 项全绿，G-28 双端截图齐（真机渲染、非 mock）。隔离实例未安装 db-mysql/db-postgres 插件，故页面呈现**真实空态 + 人话引导**（"插件未安装"）；本轮不伪造数据，也不把空态截图说成有数表。产品定位自评：**可用骨架**（连接/聚合/排序/建议/导出逻辑齐备，需装 db 插件才有真实数据）。

## 1. 硬验收（5 项）

| 项 | 判据 | 命令 / 来源 | 结果 |
| --- | --- | --- | --- |
| ① grep | 确认新增看板、无等价重复 | `grep -rniE '慢查询分析\|slowlog.*analy\|慢SQL' web/` | PASS：`web/slow-query.js:1,24,551` 命中；web/ 下原有命中均是 db.js 单实例展示（非跨实例看板），确认新增 |
| ② 语法 | node --check exit 0 | `node --check web/slow-query.js` | PASS exit 0 |
| ③ 首屏 | frontend-check ≤307200 | `bash scripts/frontend-check.sh` | PASS：首屏 77763 / 307200 字节（余量 229437）；i18n 增量 2922/3072；dist 无 source map |
| ④ slowlog 契约 | 从源码核对字段，不猜 | `mysqlop/slowlog.go` / `pgop/slowlog.go` / `types.go` / `sqlguard.go` | PASS：双端字段逐项对齐，见下 §2 |
| ⑤ commit | 不 push、首行带 agent 前缀 | `git show --stat --format='%h %s'` | PASS：`2b6022e` feat（新文件 560 行）+ `37bce6b` fix（A4 文案，8 增 8 删），均为 `[agent:r23-slowlog]`，仅 web/slow-query.js，无夹带 |

## 2. 契约核对（源码逐字段，非猜测）

| 方法 | 入参 | 返回字段（源码位置） | 看板用途 |
| --- | --- | --- | --- |
| `db-mysql.slowlog` | `{instance,schema?,min_ms,limit}` | `SlowLogResult{instance,source,count,queries:[{schema,digest,sql_text,executions,total_ms,avg_ms,max_ms,rows_examined_avg,rows_sent_avg,first_seen,last_seen}],warnings,hint}`（mysqlop/slowlog.go:41-66） | MySQL 归一化源；时间范围按 `last_seen` 前端过滤 |
| `db-postgres.slowlog` | 同上（`schema` 在 PG 表示库名） | `SlowLogResult{instance,source,available,count,queries:[{schema,digest,query,executions,total_time,mean,max,rows}],warnings,hint}`（pgop/slowlog.go:43-67） | PG 归一化源；`available=false` 作"扩展未就绪"空态；PG 视图无时间列/无 `rows_sent` → 时间范围对其不生效、`rowsReturned` 诚实记 null |
| `db-mysql.instances` / `db-postgres.instances` | `{}` | `InstancesResult{instances:[{name,host,port,reachable,version,error,credential_source}],count}`（两侧 types.go InstanceStatus） | 实例多选，不可达自动禁选、可达默认勾选 |
| `db-*.query`（执行计划入口） | `{instance,sql:'EXPLAIN '+SQL,limit}` | `QueryResult{columns,rows,row_count,truncated}`（两侧 types.go） | 只读 EXPLAIN（两侧 sqlguard.go 白名单允许）；SQL 摘要含 `?` 时**不给假计划**，引导去数据库页用完整 SQL |

**归一化统一结构**（一处收口，G-24）：`{instance,engine,schema,sql,digest,executions,totalMs,avgMs,maxMs,rowsExamined,rowsReturned,firstSeen,lastSeen}`；两份来源字段形状不同（MySQL `total_ms/sql_text/rows_examined_avg`，PG `total_time/query/rows`），在 `normalizeMysql`/`normalizePg` 显式转换，不向 UI 泄漏原始差异。

## 3. G-28 截图证据（隔离实例 18891，真实登录 + 导航）

| 文件 | `file` / PIL 实测宽高 | 覆盖内容 |
| --- | --- | --- |
| `slow-query-desktop-01.png` | **1440 × 900**（full-page） | 数据库 hub → 慢查询分析 tab 高亮 → 工具栏（数据库连接多选/时间范围/TopN/阈值/开始分析/导出 CSV）→ 失败态红条人话 → 来源说明 → 空态引导 |
| `slow-query-mobile-01.png` | **390 × 992**（full-page） | 同页手机全貌：控件全宽纵向堆叠、触摸目标 ≥44px、无横向溢出 |
| `slow-query-mobile-01-viewport.png` | **390 × 844**（视口，非 fullPage） | 严格命中 G-28 手机尺寸；首屏内表单/按钮/tab 全部可读 |

拍法：真实 chromium headless（`playwright` 1.65.1 + chromium headless shell 1255）→ 登录页真实填 `#kore-password` + 点「登录」→ 关闭新手引导 → 深链接 `#/db/slowquery` 直达 → 断言 `.sq-wrap` 存在（非 tab 文字，避免拍到空壳）→ `page.screenshot`。桌面/手机均 `sqCount=1`、`hash=#/db/slowquery`。截图前只读核验新 HEAD `3fcf520` 含 `slowquery` 注册（`web/app.js:2190` SHELL_VIEWS + `:2209` db hub）与 `web/dist/slow-query.js`，避免拍到 404。

**空态如实说明**：隔离实例未装 db-mysql/db-postgres 插件（`E_NOTFOUND`），页面显示"MySQL 连接列表读取失败：插件 db-mysql 未安装；PostgreSQL …未安装"+ 来源/空态引导。这是真实降级，不是 mock 数据。有数据的 TopN 表/执行计划面板逻辑由纯函数自检覆盖（§4），未在本次截图取证。

## 4. 纯函数自检（node 级，10/10 PASS）

`window.KoreSlowQuery._test` 钩子（复用 report.js 同款范式，不参与渲染、不新增网络 API）：MySQL/PG 归一化字段映射、`rowsReturned=null` 诚实空值、启发式建议含"检查 WHERE/JOIN 索引"且**不臆造具体索引名**、耗时/次数/行数带单位、CSV 带 UTF-8 BOM + RFC4180 逗号转义 + 表头带 `(ms)` 单位。命令 `node -e '…'` exit 0，10 条全 PASS。

## 5. G-28 产品定位自评（三问）

1. **本页解决什么用户问题**：业务变慢时最贵的是"找哪条 SQL、哪台库"。过去要逐台登录数据库、开 `slow_query_log` 或查 pg_stat_statements、肉眼排序。本看板一次勾选多台 MySQL/PG 连接，把各库聚合慢查询归一到同一张表，按总耗时/次数/扫描行数 TopN 排序，SQL 摘要 + 带单位指标 + 启发式"检查 WHERE/JOIN 索引"建议 + 执行计划入口 + CSV 导出，一眼定位"哪台库、哪条 SQL、为什么慢"。
2. **与宝塔/1Panel 同类功能的差距**：宝塔/1Panel 以单实例慢日志浏览为主，缺跨 MySQL/PG 的归一化聚合与排序。本看板补的是"跨库 TopN + 优化建议"这一层。局限/差距：①来源依赖 `performance_schema=ON` / `pg_stat_statements` 扩展，不满足走人话空态；②无历史趋势曲线与阈值告警（不是本卡范围）；③PG 视图无时间列，时间范围对 PG 不生效并在界面明确说明；④建议是启发式方向，**不臆造具体索引名**，需 DBA 结合实际执行计划判断。
3. **当前是"可用"还是"占位"**：**可用骨架**。连接发现/聚合/排序/建议/执行计划入口/CSV 导出均为真实逻辑、无 mock；当前隔离环境未装 db 插件故截图呈空态，装上插件即可见真实数据。边界如实声明：`instance` 为 slowlog 必填参数（前端必带）；双来源字段差异在归一化层一处收口；阈值/条数为后端上限（100）内的预设档。

## 6. A4 修复闭环（本轮前置）

接线后 `usability-check.sh` 抓到 6 处用户字符串含内部术语"实例"（L180/272/333/349/364/521）→ 按语境改白话"数据库连接/数据库/数据库服务"，注释两处一并统一。复核：`grep -n '实例' web/slow-query.js` → **ZERO**；`bash scripts/usability-check.sh` → **exit 0 / 0 fail**（剩余 523 WARN 为存量 pending 豁免，非本文件）；commit `37bce6b`。r23-integration 与 r23-certlife 独立交叉验证一致，确认非误报。

## 7. G-29 / 提交 / 收尾

**本轮未改动主实例运行态配置**：本 agent 对 `.kore-local.yaml` / `.kore-local-state` / `.kore-local-run` / 主 `bin/kored` 全程零写入，未执行任何重启 8787 的动作；只做只读 `healthz` 探测与 `index_dir` grep。复核：开工基线 `8787 health=200` / 主 PID `2396602`，收尾 `8787 health=200` / 主 PID `2493081`、主配置 `index_dir` 字面仍正确。**PID 变化如实披露**：这是同批并发 restart 卡的操作（lead 另行派发），非本 agent 所为——本 agent 唯一启停的是隔离 unit `kore-r23-slowlog`（18891），从未 touch 主进程。隔离实例端口 18891 与 peer（certlife 18890 等）不冲突。隔离目录 `/tmp/kore-r23-slowlog` 与两个一次性截图脚本（`/tmp/kore-r23-slowlog-shot*.js`）、临时日志/探针文件在收尾时全部删除；隔离 unit `kore-r23-slowlog` 已 stop（18891 healthz 回 000）。workaround 无（未用替身）；过期条件不涉及。

提交：`2b6022e` feat + `37bce6b` fix，**均未 push**。本报告与 3 张截图随本轮一并提交（若 integration 已代为接线提交，本报告作增量检查点单独提交）。
