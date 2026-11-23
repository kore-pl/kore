# Round 6 收尾 · 真机验收报告（r6-closeout-retry）

> 日期 2026-11-23 · 实例 127.0.0.1:8787（`kored` pid 2645407，本轮**未重启**）· 口令 ***（本机配置，不入库）
> 前置事故：上一轮关停旧进程后未起新进程（10:19:05 `signal: terminated`）；本轮全程复用已恢复的 2645407，未复用其未完成结论。

## 1. scheduler 真机验证（真机闭环，非隔离实例）

| # | 动作 | HTTP | 关键返回 |
| --- | --- | --- | --- |
| 1 | `POST /api/v1/auth/login` | 200 | `{"authenticated":true}`；`kore_csrf` 43 字符，写操作带 `X-Kore-CSRF` |
| 2 | `GET /api/v1/scheduler/tasks`（初始） | 200 | 仅 1 条上轮遗留 `smoke-site`（`last_result=missed`） |
| 3 | `POST /store/install` echo 0.1.2（`id`+`version`+`package_path`） | 200 | `{"state":"succeeded","reload":"reloaded"}`；缺 `id/version` 时 400 `E_INVALID`「id/version 必填」 |
| 4 | `POST /plugins/echo/enable`（首试） | 429 | `E_RATELIMIT`：常驻上限 2（site+terminal 已占） |
| 5 | `POST /plugins/terminal/disable` → 再 enable echo | 200 / 200 | echo `state=ready` pid 2653727；`POST /invoke/echo/echo.ping` → 200 `{"pong":true}` |
| 6 | `POST /scheduler/tasks`（`smoke-test`/echo.ping/`*/2 * * * *`） | 200 | `tsk-7f108a7db87b2279`，`next_run_at=10:24:00` |
| 7 | `POST /scheduler/tasks/{id}/run` | 200 | `{"status":"ok","dur_ms":0}`（手动执行不计入 `next_run_at`） |
| 8 | **等 150s**（10:23:20→10:25:47）后 `GET` | 200 | `last_run_at=10:24:02.074`、`last_result=ok`、`next_run_at=10:26:00` |
| 9 | `DELETE /scheduler/tasks/{id}` | 200 | `{"deleted":true}`；再删遗留 `smoke-site` → 200；最终 `{"tasks":[]}` |

- 第 8 步的 `last_run_at`（10:24:02）晚于手动 run（10:23:09）且落在整分 +2s，证明**单 ticker 自动触发真实执行**，不是手动执行留痕；同 tick 上轮遗留的 `smoke-site` 也跑出 `last_result=ok`（第二个独立任务，交叉印证）。
- 恢复：`echo/disable` 200、`terminal/enable` 200 → terminal `ready` pid 2661935，`supervisor={resident:2,resident_max:2}` 回到基线。

## 2. 18 页双端截图（40 张，sha 全唯一）

每张截图前/后各断言一次（hash 命中 + `#view` 文案命中 + 无 `.login-card` + `scrollHeight` 不漂移）；`file`/IHDR 读实际像素；40 张 sha256 两两去重 **0 重复**。

| # | 页面 | PC 1440 full-page | 手机 390 | 手机 scrollHeight |
| --- | --- | --- | --- | --- |
| 01 | 概览 | 1440×900 | 390×844 | 845 |
| 02 | 监控 | 1440×1992 | 390×844 | 2392 |
| 03 | 日志 | 1440×932 | 390×844 | 1474 |
| 04 | 进程 | 1440×1085 | 390×844 | 1205 |
| 05 | 终端 | 1440×901 | 390×844 | 857 |
| 06 | 网站 | 1440×900 | 390×844 | 1385 |
| 07 | 数据库 | 1440×1045 | 390×844 | 1697 |
| 08 | Redis | 1440×3062 | 390×844 | 3898 |
| 09 | 计划任务 | 1440×900 | 390×844 | 971 |
| 10 | 文件 | 1440×900 | 390×844 | 1995 |
| 11 | 备份 | 1440×900 | 390×844 | 1022 |
| 12 | SSL | 1440×1039 | 390×844 | 1719 |
| 13 | 软件商店 | 1440×1210 | 390×844 | 3370 |
| 14 | 已装插件 | 1440×2079 | 390×844 | 6442 |
| 15 | 完整性 | 1440×900 | 390×844 | 844 |
| 16 | 运行环境 | 1440×900 | 390×844 | 1138 |
| 17 | 防火墙 | 1440×931 | 390×844 | 1439 |
| 18 | 设置 | 1440×1099 | 390×844 | 1737 |

命名：`r6f-desktop-NN-<slug>.png` / `r6f-mobile-NN-<slug>.png`；附件 `r6f-desktop-nav-groups.png`（200×973，四组 18 项侧栏裁切）、`r6f-mobile-nav-drawer.png`（390×844，抽屉 业务/资源/平台 13 项）、`r6f-desktop-integrity.png`（1108×495，基线状态卡内容区裁切）、`r6f-desktop-runtimes.png`（1440×900，Node tab 真实 24.21.0）。两张 `-integrity`/`-runtimes` 是**独立构图的重点图**（内容区裁切 / 视口），非整页缩放副本。

## 3. 三档状态判定（按"页面主打动作能否真实完成"，不混算）

| 档位 | 页数 | 页面 | 判据（本轮证据） |
| --- | --- | --- | --- |
| 全可用 | 15 | 概览、监控、日志、进程、终端、网站、数据库、Redis、文件、备份、SSL、软件商店、已装插件、完整性、运行环境 | 画面为真实后端数据：MySQL 9.7.1 五库/12768 查询、Redis 7.4.12 6574 键/内存 61.68M、751 进程、syslog 196,795 行、3 站点均 `nginx -t 通过`、备份 r2 校验正常、2 张自签证书可 TLS 验证、商店 24 插件 21 已装、完整性 10000 条基线校验通过、Node 24.21.0 已安装 |
| 只读可用 | 3 | 计划任务、防火墙、设置 | 计划任务「当前用户无 crontab 权限（`crontab -l` 报权限错误），表单已禁用」；防火墙「ufw 只读降级 / 不可读，非 root 读不到也改不了」；设置「修改口令：待支持」「运行参数未暴露」 |
| 受限 | 0 | — | 无整页不可用/纯占位页 |

- 口径变化：上一轮"14/16"把只读页与不可用页混算，本轮按**能力档位**分开：15 全可用 / 3 只读可用（均为 **kored 非 root** 的环境限制，非页面缺陷）/ 0 受限。
- 本轮实测写路径：scheduler 建/跑/删、integrity 基线+校验、插件装/启/停/调用、终端会话连接。**未逐页点击的写路径**（建站/建库/上传/备份创建/证书申请/进程信号）按"按钮在 + 依赖 ready + 插件方法可达"推断，标记为推断而非实测。

## 4. 本轮新增（相对上一轮）

- **scheduler 真机**：隔离实例结论已升级为 8787 真机证据链（自动 tick 10:24:02 执行 + 手动 run + 删除 + 初始/终态列表）。
- **完整性页**：真机建基线 10000 条 / 7.99 GiB（6.7s），`integrity.check` 返回 `ok:true`、0 新增/删除/修改；页面显示"上次校验通过"。
- **运行环境页**：Node 24.21.0（`/home/pt/.nvm/versions/node/v24.21.0/bin/node`）真实探测，npm 11.19.0，健康检查 4 项中 1 警告（`NODE_ENV` 未设）。

## 5. 运行态变更与回切（G-29）

- 未改 `.kore-local.yaml` / `state.db` / `bin/kored`；未重启进程（pid 2645407 全程不变，`/-/healthz` 200）。
- 临时变更，已回切：terminal 停→启（ready）、echo 装→停（`installed/disabled`，仍占磁盘不占常驻槽）、两条测试任务删除（`{"tasks":[]}`）。
- 残留：echo 0.1.2 保留在已装列表（禁用）；商店/插件页显示 21 个已装，属本轮真实状态。
- 基线副作用：integrity 基线由 3 条重建为 10000 条（本轮验收所需，非回切项，需知悉）。

## 6. 未覆盖 / 风险

- 进程页"信号投递"、计划任务/防火墙的 root 提权路径未在真机执行（需 root，属环境限制）。
- 手机截图按 390×844 视口采集（非整页），纵向内容以 scrollHeight 记录；超长页（插件 6442、Redis 3898）需滚动查看。
- `r6f-*` 40 张与上轮 `nav-05/06-*.png` 的改动互不覆盖；上轮两张已修改截图未纳入本轮提交。
