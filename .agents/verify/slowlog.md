> 元信息: 2026-11-23T19:28+08:00 · 执行者 kore-impl-container-view（implementer）· 只截图不改代码（UI = `874f473`，db.js +185）· 隔离实例 `127.0.0.1:18881`（`--config /tmp/kore-slow/config.yaml`，state/run/log 全在 `/tmp/kore-slow`）· 插件 db-mysql **0.3.2**（本地包 sha `3ad89d6bcf42` 与已签索引一致，离线安装）· 主实例 8787 零写入 · task-47 · 报告 ≤70 行

# slowlog 慢查询分析 G-28 双端截图（真机数据）

## 0. 结论

**真机档，非降级**：隔离实例连通本机 MySQL **9.7.1**（连接配置从主实例 `plugins/db-mysql/config.json` **只读**复制进隔离 state，口令不打印、不入档），`db-mysql.slowlog` 真实查回 `performance_schema` 数据，截图里是**点「分析」后的真结果表**（2 行 ≥500ms 聚合）。双端截图齐、`page_errors=0`。中途隔离实例进程静默退出过一次（原因未查明，日志无 panic），重启后续跑——状态库与会话持久，无返工成本。

## 1. 截图证据（`file` 实测 + 色标帧校验 attempt=1）

| 文件 | `file` 实际宽高 | sha256 前16 | 覆盖内容 |
| --- | --- | --- | --- |
| `slowlog-desktop-01.png` | **1440 x 1321**（full-page） | `e649703ba543aa16` | 数据库页 → 实例 `default (9.7.1)` 详情 → **慢查询分析折叠区展开 + 已查询**：结果表表头「SQL 摘要 / 执行次数 / 总耗时 / 平均 / 最大 / 扫描行数」，首行 `PREPARE SELECT id, game_code, COALESCE(platform,?) … 6,472 次 · 1.12 s · 0.2 ms · 6.4 ms`（`live_games` 库真实 digest 聚合）；表单三档 select（阈值 ≥100/500/1000 ms、条数 10/20/50、统计范围库下拉含 5 库 + 全部库）+「分析」按钮 |
| `slowlog-mobile-01.png` | **390 x 844** | `d97b788178b73d21` | 手机端同页：折叠区与表单/结果可读、**横向溢出 0**、控件 ≥44px |

DOM 断言（拍摄前回读，`shots.json` 随实例删除，关键值抄录）：`form.selects` 4 个（实例/统计范围/阈值/条数，阈值档 `≥100/≥500/≥1000 ms`、条数档 `10/20/50 条`，默认 `500`/`20`）、`result.table=true, rows=2`、`page_errors_total=0`。**注意点（如实记录）**：折叠区 `toggle` 只渲染表单、**不自动查询**，必须点「分析」才发 `db-mysql.slowlog`——第一轮截图拍到的是表单空态，点「分析」拿到真表后重拍才定稿。

## 2. 产品定位自评（G-28 三问）

**① 本页解决什么问题**：业务变慢时最贵的是「找哪条 SQL」——过去要登库开 `slow_query_log`、捞文件、肉眼排序。本页把这三步收成：选库（可全部库）→ 选阈值档（≥100/500/1000ms 预设，不让人手填大数字拉爆结果集）→ 点「分析」，直接给按总耗时倒序的 Top N：SQL 摘要、执行次数、总耗时/平均/最大、扫描行数——一眼定位「次数多」还是「单次慢」。

**② 与宝塔/1Panel 的差距**：它们有慢查询日志文件解析 + 历史趋势图 + 告警阈值推送；本页是**单次聚合查询、无历史曲线、无告警**，且依赖 `performance_schema=ON` 与账号读权限（不读 `slow_query_log` 文件——换来的是不用动服务端配置、只读安全）。也**没有**执行计划/explain 下钻与一键杀会话（杀会话属危险操作，未做是边界不是缺陷）。

**③ 当前是「可用」还是「占位」**：**可用（真机取证）**——真实 MySQL 9.7.1、真实 digest 数据入表、双端截图、Runtime 异常 0。边界如实声明：①`instance` 是 `db-mysql.slowlog` **必填参数**（漏传回 `E_INVALID 缺少必填参数 instance`，前端已带）；②依赖目标库 `performance_schema=ON` + 当前账号读权限，不满足时走 `slowlogHintFor` 的人话提示（本轮未触发该错误分支，未截图）；③阈值/条数仅三档预设、schema 单选，均为后端上限（100 条）内的产品取舍；④隔离实例进程曾静默退出一次，重启后复验通过，未影响数据真实性。

## 3. G-29 / 提交

**本轮未改动主实例运行态配置**：`.kore-local.yaml`/`.kore-local-state`/`.kore-local-run` 零写入（对主实例 db-mysql 配置仅**读取一次**复制到隔离态，未修改、未回写）；对 MySQL 只执行只读 digest 聚合查询；8787 仅 `ss` 只读探测。隔离实例 `/tmp/kore-slow` 验证完即删。索引为已验签 `kore-plugins/index`，本地包 sha 与索引一致走离线 `package_path`，未开 `allow_unsigned`。提交：`docs(verify): slowlog 慢查询分析 G-28 双端截图`（本报告 + 2 张截图，不 push、不碰代码）。
