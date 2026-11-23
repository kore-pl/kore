# Round 4 收尾验收报告

> 执行：r4-closeout ｜ 2026-11-23 08:3x ｜ 主实例 PID 1726888（未重启）｜ docs-check exit 0、secret-check 0 FAIL

## 1. 端点计数（文档一致性）

真实统计（`internal/core/httpapi/handlers.go` 26 行 + `server.go` 2 行 `mux.HandleFunc`）：

```
$ grep -h 'mux.HandleFunc' internal/core/httpapi/{handlers,server}.go | wc -l   # 28
# 28 − 3 条兜底（"/"、"/api/v1/store/"、"/api/v1/auth/"）− 2 条静态（GET /{$}、GET /assets/*）= 23 条路由
# 23 − GET /-/healthz = 22 个 /api/v1 端点 = 15 业务 + 7 store（其中 POST /plugins、/events 为 501 占位）
```

- **修正前后**：AGENTS.md 与 docs/CORE.md 均 `23 个端点（16 业务 + 7 store）` → **22 个（15 业务 + 7 store）**。
- **原 16 业务的账是错的**：把 3 条不存在路径算进去了（`DELETE /plugins/{id}`、`POST /plugins/{id}/upgrade`、`GET /self`，curl 实测 404），又漏了 `GET /auth/session`、`GET /store/plugins/{id}`、`GET /api/v1/audit`（5 条实测 200）。
- **新增 `/api/v1/audit` 已写入两处**：M4-C 操作审计查询，`since` 必填、`limit` ≤ 1000、支持 `order=desc`、`action`/`result` 过滤。
- **静态前缀 3 → 2**：`/plugin-assets/*` 代码未注册（实测 404），实际仅 `GET /{$}` 与 `GET /assets/*`。
- **模块列表一致**：CORE.md §2 共 14 小节 = 10 个内核模块（config/store/auth/httpapi/registry/supervisor/bus/installer/market/privilege）+ 4 个支撑小节（logger/static/sse/envprobe），与 AGENTS.md 一致，无需改。
- `make docs-check` → **5 pass / 1 warn（docs/RELEASE.md 行数）/ 0 fail，exit 0**。

## 2. 推送

| 仓库 | 本地 HEAD | origin/main | 结果 |
| --- | --- | --- | --- |
| kore | `14ab7a4` | `14ab7a4` | `247a4f5..14ab7a4  main -> main` |
| kore-plugins | `42d2fe7` | `42d2fe7` | `Everything up-to-date`（本地 == 远端，无待推提交） |

- kore 推送 3 个提交：`38a299f` 成熟度重判、`b0078bc` 端点计数、`14ab7a4` 40 张截图；`git ls-remote origin refs/heads/main` 回读与本地 HEAD 逐字一致。
- `make secret-check` → **0 FAIL / 7 处匹配（占位写法均合规）**。
- 报告自身提交随后单独推送；最终 HEAD 回读见交付终答。

## 3. 截图（40 张，SHA-256 两两不重复 40/40）

32 张页面（16 页 × 双端）+ 8 张专项（导航 2、搜索 3、审计 3）。尺寸由 PNG IHDR 实读，非缩放冒充。

| # | 页面 | 桌面 1440×H | 手机 390×H | 判定 |
| --- | --- | --- | --- | --- |
| 01 | 概览 | 900 | 845 | ✅ 系统/插件概览真实 |
| 02 | 监控 | 1992 | 2392 | ✅ CPU/内存/负载实时 |
| 03 | 日志 | 932 | 1474 | ✅ syslog/journal 双源 |
| 04 | 进程 | 1085 | 1205 | ✅ 802 进程真实列表 |
| 05 | 终端 | 901 | 857 | ✅ 真实 bash 会话 |
| 06 | 网站 | 900 | 1385 | ✅ 建站向导 + 现有站点 |
| 07 | 数据库 | 1003 | 1637 | ✅ 已连 MySQL 9.7.1 |
| 08 | Redis | 3062 | 3898 | ✅ 已连 Redis 7.4.12 |
| 09 | 计划任务 | 900 | 971 | ⚠️ 非 root 读不到 crontab（页面给提权指引） |
| 10 | 文件 | 900 | 1995 | ✅ 6 项目录真实 |
| 11 | 备份 | 900 | 1022 | ✅ 1 个备份 + 新建表单 |
| 12 | SSL | 1039 | 1719 | ✅ 2 张证书；ACME 子功能 v1.1（页面明示） |
| 13 | 商店 | 1210 | 3370 | ✅ 24 条 / 15 已装 / 1 可升级 |
| 14 | 已装插件 | 1581 | 4723 | ✅ 15 个，版本/状态/操作齐全 |
| 15 | 防火墙 | 931 | 1439 | ⚠️ 非 root 只读降级（ufw 不可读） |
| 16 | 设置 | 1099 | 1737 | ✅ 常规设置 + 操作审计 tab |

8 张专项：`r4-desktop-nav-groups`（168×900，四组：运维/业务/资源/平台）、`r4-mobile-nav-drawer`（390×844，11 项分组抽屉）、`r4-search-desktop`（1440×900）、`r4-search-mobile`（390×844）、`r4-search-result-desktop`（1440×1003）、`r4-audit-desktop`（1440×2168）、`r4-audit-denied-desktop`（1440×1650）、`r4-audit-mobile`（390×9205）。
每张截图前断言 `#view[data-view]` 命中且正文 >30 字，后断言文件落盘 + 尺寸 + SHA；每页 `document.body.scrollHeight` 已记入上表。

## 4. 搜索 / 审计 / 已装插件（实际内容）

- **搜索**：`Ctrl+K` 唤起 → 输入「数据」→ 四组齐全：页面（跳转到 数据库）、插件（db-mysql、redis）、商店（db-postgres）、操作（新建数据库）；`Enter` 跳转 `#/db`（数据库页），非空跳转成立。
- **审计**：设置 → 操作审计，`login.success` 有 5 条（含本次登录）、`invoke.*` 大量（db-mysql/firewall/ssl 等插件只读方法，如 `invoke.site.site.list`）、`denied` 37 条（`root.action ufw-status denied`，结果徽标为「被拒」），三类记录均在同一接口与页面可见。
- **已装插件**：15 个（启用 14 / 运行中 2–3 / 停用 1），版本与最新版本两列齐全，1 个可升级。
- **商店**：索引 24 条，已安装 15、可升级 1（`runtime-php` 0.1.1 → 0.2.0）；`update_available` 由前端按 latest_version 与已装版本比对得出，内核不下发该字段。

## 5. 本轮 6 个 L1.5 插件版本确认

| 插件 | info.json | 索引 | 已安装 | 结论 |
| --- | --- | --- | --- | --- |
| db-postgres | 0.2.0 | 0.2.0 | 未安装 | 上架 ✅ / 未装 |
| app-deploy | 0.2.0 | 0.2.0 | 未安装 | 上架 ✅ / 未装 |
| integrity | 0.2.0 | 0.2.0 | 未安装 | 上架 ✅ / 未装 |
| runtime-node | 0.2.0 | 0.2.0 | 未安装 | 上架 ✅ / 未装 |
| runtime-php | 0.2.0 | 0.2.0 | 0.1.1 | 可升级（商店显示 1 个可升级） |
| runtime-python | 0.2.0 | 0.2.0 | 未安装 | 上架 ✅ / 未装 |

结论：6 个插件仓库与索引版本全部 0.2.0（第二十七次重签已入索引）；**已装侧为 0/6**，任务书「已装插件应有 6 个新版本」与实际不符（runtime-php 仍是 0.1.1）。

## 6. 最直观 3 个问题

1. **已装插件 ≠ 任务书预期**：6 个 L1.5 插件只在商店上架，未安装；已装 15 个里只有 runtime-php 可升级。若收口要求「已装 6 个新版本」，需先逐个 `POST /store/install`。
2. **非 root 运行让两页核心能力降级**：tasks 读不到 crontab、firewall 读不到 ufw；页面给了提权指引，但 v1 的「可用」在这两页只是只读/引导级。
3. **成熟度文档自身滞后**：`docs/PLUGIN-MATURITY.md` §3.5 第 10 条仍写「runtime-php / runtime-python 0.2.0 未入索引」，而索引与商店已是 0.2.0——下一轮需按事实改判。

## 7. 运行态与清理

- 未重启 kored、未改 `.kore-local.yaml` 与主 state；`paths.index_dir` == `kore-plugins/index`，商店 24 == 索引 24（G-29 复核通过）。
- 为让审计页出现真实 `invoke.*`，调用过一次只读 `site.list`（无写操作）；未做安装/升级/启停。
- chrome profile（/tmp）与临时脚本已删除；r3 遗留未提交证据（r3c/r3f/nav-05/06）非本轮产物，未混入提交。
