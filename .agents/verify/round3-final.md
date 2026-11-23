# Round 3 Final · 重建 + 重启 8787 + 36 张双端证据（G-28 / G-29）

- 2026-11-23T05:05–05:15+08:00 · r3-rebuild-shots · 工作目录 `/home/pt/Work/GolandProjects/kore`
- 纪律：**未改任何源码、未提交**（`git status` 中 web/ 与 cmd/ 零改动）· 未改主实例运行态配置 · 临时脚本与浏览器 profile 已清理

## 1. 重建与重启（8787 主实例）

- 构建：`make build` → **exit 0**，`bin/kored` 8,900,770 B（05:07 生成，含 web-dist 步骤）。
- 前端入二进制：`strings bin/kored | grep -c 'config-panel.js'` = **4**（≥1 达标）。
- `web/dist` 四件套齐备：`app.js` 57,135 B / `store.js` 30,796 B / `db.js` 27,961 B / `redis.js` 31,947 B；`web/*` 无比 dist 更新的文件（无 stale）。
- 重启：旧 **PID 616168**（04:59:59 起）→ `kill` 后 0.4 s 退出 → 按同一套 4 个 `KORE_*` 环境变量、绝对路径 `--config` 重启 → 新 **PID 700480**，日志出现 `kore ready`（05:08:12）。
- 重启前后 `/api/v1/store/plugins` 均 **HTTP 200 · 24 条**（条数不变，内容随索引刷新）。

## 2. G-29 运行态写边界复核

- `GET /api/v1/system/info` → `paths.index_dir` = **`/home/pt/Work/GolandProjects/kore-plugins/index`**（== 配置值，前后两次复核一致）。
- 商店 `discover` = **0.2.0** == 索引 `plugins.json` 的 `discover` **0.2.0**（未指向任何 `signed-index` 快照）。
- 索引文件 24 条 == API 返回 24 条；`/tmp/kored-8787.log` 中 `level=ERROR` 计数 **0**。

## 3. 36 张截图（`.agents/verify/screenshots/`，宽度实测 + sha256 前 12 位）

断言：每张**截图前**断言已登录（`.kore-shell` 存在 + 无 `#kore-password` + `kore_csrf` cookie 存在），**截图后**断言页面特征文本；36×2 全 PASS。

| # | 页 | desktop 文件 / 尺寸 / sha | mobile 文件 / 尺寸 / sha |
| --- | --- | --- | --- |
| 1 | 概览 | `r3f-desktop-01-overview.png` 1440x900 `7430dcb35b34` | `r3f-mobile-01-overview.png` 390x844 `9f165710f945` |
| 2 | 监控 | `r3f-desktop-02-monitor.png` 1440x1579 `31b7800f8022` | `r3f-mobile-02-monitor.png` 390x844 `912e9f3dd363` |
| 3 | 日志 | `r3f-desktop-03-logs.png` 1440x932 `893090b0fac4` | `r3f-mobile-03-logs.png` 390x844 `d9fb0b9e1b37` |
| 4 | 进程 | `r3f-desktop-04-process.png` 1440x3973 `5efb7b452e7b` | `r3f-mobile-04-process.png` 390x844 `3caecd125ae2` |
| 5 | 终端 | `r3f-desktop-05-terminal.png` 1440x901 `043b00f7a835` | `r3f-mobile-05-terminal.png` 390x844 `c5a81f9d357b` |
| 6 | 网站 | `r3f-desktop-06-sites.png` 1440x900 `7ab9e132fab6` | `r3f-mobile-06-sites.png` 390x844 `3b709de4b418` |
| 7 | 数据库 | `r3f-desktop-07-db.png` 1440x912 `ffc5fd50ca3e` | `r3f-mobile-07-db.png` 390x844 `e106ac19c8e7` |
| 8 | Redis | `r3f-desktop-08-redis.png` 1440x9386 `e1376d08a333` | `r3f-mobile-08-redis.png` 390x844 `3d6b6f109e34` |
| 9 | 计划任务 | `r3f-desktop-09-tasks.png` 1440x900 `1b9a08604527` | `r3f-mobile-09-tasks.png` 390x844 `b72c5e7e9c19` |
| 10 | 文件 | `r3f-desktop-10-files.png` 1440x900 `a72690917000` | `r3f-mobile-10-files.png` 390x844 `74ce716a2960` |
| 11 | 备份 | `r3f-desktop-11-backup.png` 1440x900 `a7f030784336` | `r3f-mobile-11-backup.png` 390x844 `37e59ebc1f5a` |
| 12 | SSL | `r3f-desktop-12-ssl.png` 1440x1039 `89d6d6f9f643` | `r3f-mobile-12-ssl.png` 390x844 `81de5c278089` |
| 13 | 商店 | `r3f-desktop-13-store.png` 1440x2116 `c0c3c6a18659` | `r3f-mobile-13-store.png` 390x844 `a898c7e74625` |
| 14 | 已装插件 | `r3f-desktop-14-plugins.png` 1440x1480 `53dfc31e3aa6` | `r3f-mobile-14-plugins.png` 390x844 `4a87b7b81830` |
| 15 | 防火墙 | `r3f-desktop-15-firewall.png` 1440x908 `32ba38b5b498` | `r3f-mobile-15-firewall.png` 390x844 `15debdea1d8e` |
| 16 | 设置 | `r3f-desktop-16-settings.png` 1440x1043 `8d8bbcb33cc2` | `r3f-mobile-16-settings.png` 390x844 `1bbd8fbb0d1a` |
| — | 四组导航 / 抽屉 | `r3f-desktop-nav-groups.png` 1440x900 `ccdcb69f42e4`（运维/业务/资源/平台 4 组、27 项导航、含 hover 态） | `r3f-mobile-nav-drawer.png` 390x844 `0ed003deac63`（抽屉 3 组：业务/资源/平台） |
| +1 | 商店升级 | `r3f-desktop-store-upgrade.png` 1440x2116 `430b4cc4a7ad` | — |
| +2 | 已装插件最新版本 | `r3f-desktop-plugins-latest.png` 1440x1480 `1920af835e55` | — |

- 齐全性 **36/36**；桌面 16 页全 **1440 宽 full-page**（高 900–9386），手机 16 页全 **390x844**。
- 唯一性：36 个 sha256 **两两去重 36 unique / 0 重复**（脚本内比对 + `sha256sum | sort -u` 独立复核一致）。
- 末两行新增：商店页顶部 `共 24 个插件 · 已安装 14 个 · 10 个可升级 · 当前显示 24 个` + `14 个已安装，10 个可升级` 汇总条，卡片为 `可升级 v0.2.0 → v0.2.1` 徽标 + `升级到 v0.2.1` 按钮（实测 10 个）；已装插件页表头 `插件|版本|最新版本|深度|生命周期|状态|操作`，可升级行显示黄字 `0.2.0 → 0.2.1` 与「升级」按钮（实测 10 个）。

## 4. 16 页状态判定（对比 Round 3 的 14/2/0）

| # | 页 | R3 | 本轮 | 依据（本轮实测） |
| --- | --- | --- | --- | --- |
| 1 | 概览 | 可用 | 可用 | 14 插件 / 已启用 13 / 运行中 3 / 异常 0 |
| 2 | 监控 | 可用 | 可用 | 5s 采样：CPU 10.8%、RSS 12.5 MiB、磁盘 519.0 GiB、load 3.98 |
| 3 | 日志 | 可用 | 可用 | syslog 30.8 MB / 166,023 行真实尾读；journal 可读 |
| 4 | 进程 | 可用 | 可用 | 800 个真实进程，首帧无 CPU 基线已明示 |
| 5 | 终端 | 可用 | 可用 | 真实 bash 会话已连接（pid 730113） |
| 6 | 网站 | 可用 | 可用 | 3 站点均 vhost 存在 / nginx -t 通过 / 已加载 |
| 7 | 数据库 | 可用 | 可用 | 实例 9.7.1 可达、5 库、查询 139,948、只读 SQL 控制台 |
| 8 | Redis | 可用 | 可用 | 7.4.12、内存 61.73M、命中率 72.8%、4 个 db keyspace |
| 9 | 计划任务 | 部分可用 | 部分可用 | `crontab -l` 权限不足（非 root），列表只读、未写入真实 crontab |
| 10 | 文件 | 可用 | 可用 | 6 项真实文件/目录，上传/压缩/权限/移动齐全 |
| 11 | 备份 | 可用 | 可用 | 1 个备份 r2-20261122T191011Z、sha 可校验、恢复/删除齐全 |
| 12 | SSL | 可用 | 可用 | 2 张证书（demo.kore.local / live2.kore.test，365 天） |
| 13 | 商店 | 可用 | 可用 | 24 条索引、已装 14、10 可升级、一键升级入口 |
| 14 | 已装插件 | 可用 | 可用 | 14 行真实状态 + 新增「最新版本」列 + 10 个升级入口 |
| 15 | 防火墙 | 部分可用 | 部分可用 | `ufw status` 需 root（E_UNAUTHORIZED），只读降级并给出原因原文 |
| 16 | 设置 | 可用 | 可用 | 会话有效、到期 2026/11/23 17:13、CSRF 状态、退出登录真实 |

**统计：可用 14 · 部分可用 2 · 占位 0**（与 Round 3 的 14/2/0 持平；本轮变化集中在商店/已装插件的升级能力，不改变可用度分级）。

## 5. 数据库 / Redis 横幅：服务端版本还是客户端版本？

- **数据库页横幅 = 客户端版本**：`检测到本机 MySQL 客户端（未连上服务端，需要密码）` + `本机只探测到客户端版本 11.8.6-MariaDB`；**但同页实例卡**为 `可达 127.0.0.1:3306 · 9.7.1`、`版本 9.7.1`、5 个库 —— 服务端版本只在实例卡展示。
- **Redis 页横幅 = 客户端口径且未拿到版本号**：`检测到本机 Redis 客户端（未连上服务端，需要密码）` + `本机只探测到客户端，未拿到版本号`；**实例卡**为 `7.4.12 · 运行 1 天 18 小时`、`服务版本 7.4.12`。
- 结论：`ui-server-version` 在**实例卡**已生效（9.7.1 / 7.4.12 均为 `SELECT VERSION()` / `INFO` 的服务端值，未把客户端版本冒充服务端）；但**顶部自动检测横幅**仍按“仅探测到客户端”渲染，与下方已连上的实例自相矛盾（见问题 1）。

## 6. 升级检测（应按 sha/版本比对索引，而非只看版本号）

- `GET /api/v1/plugins` → 已装 **14**，`update_available=true` **10**：`cron 0.2.0→0.2.1`、`discover 0.1.0→0.2.0`、`file 0.2.0→0.2.1`、`firewall 0.2.0→0.2.2`、`logs 0.2.0→0.2.1`、`redis 0.2.0→0.3.0`、`runtime-php 0.1.0→0.1.1`、`site 0.1.0→0.2.0`、`ssl 0.2.0→0.2.1`、`terminal 0.1.0→0.1.1`；其余 4 个（backup/container/db-mysql/process）已是最新。
- 商店与已装插件页均显示 **10 个可升级**，与本条 API 口径一致；`r3f-desktop-store-upgrade` / `r3f-desktop-plugins-latest` 即为此证据。

## 7. 最直观的 3 个问题

1. **数据库/Redis 顶部横幅与实例卡自相矛盾**：横幅写「未连上服务端 / 只探测到客户端 11.8.6-MariaDB / 未拿到版本号」，正文实例卡却已 `可达` 并显示服务端 `9.7.1` / `7.4.12`；已连上时横幅应切「已连接 · 服务端版本 vX」或整条隐藏。
2. **14 个插件里 11 个是 `stopped`，只有 3 个 `ready`**：`/api/v1/plugins` 与「已装插件」页把 lazy 的 idle 退出显示成黄点 `stopped`，与概览「已启用 13 / 运行中 3」并列时极易被读成 11 个插件故障；建议 `stopped` 细分为「未启用 / 空闲（lazy 正常）」。
3. **计划任务页只能读不能写、防火墙页只读**：前者 `crontab -l` 报权限不足，后者 `ufw` 需 root，两页都属“非 root 降级”，但页面仍保留新增/执行表单，只在点击后才报错；非 root 时应直接禁用表单并给一条提权指引（与 ADR-0018 口径一致）。

补充（不计入 3 条）：页面上 `待支持`（商店已安装卡的卸载/更新旁）与 `未启用` 灰按钮无 tooltip 说明缺什么；商店页高 2116 px 已超过单屏 2.3 屏，筛选与升级汇总需滚动后才发现。
