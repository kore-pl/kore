# Round 2/3 收口 · 最终版全量双端截图（r2f）

> 2026-11-23T04:40+08:00 · 采集时实例 PID **481149**（lead 第十九次重签后重启）· 采集前后 `/-/healthz` 均 200 · **未重启 8787、未改源码** · 单浏览器上下文登录一次后复用

## 1. 数据基线（采集时 API 实测，非造数）

| 项 | 实测 |
| --- | --- |
| 网站 | 3 站点 demo/live/live2，`test_ok=true reloaded=true`，`nginx_mode=docker` |
| SSL | 2 张自签（demo.kore.local、live2.kore.test，各 365 天） |
| 备份 | 1 个（`r2-20261122T191011Z`，1261 B，gzip，corrupted=false） |
| 数据库 | 实例 default 可达，服务端 **9.7.1**，5 库：fees_china / fees_china_docker / iouf_lives / live_games / live_token |
| Redis | 实例 default 可达，**7.4.12**，内存 61.69M，命中率 72.8%，db0 keys=6574、db15=75、db5=9、db9=4 |
| 文件 | 根目录 6 项（docs/ live-l2-extract/ www/ readme.md live-l2-moved.txt live-l2-pack.zip） |
| 计划任务 | 0 条 + 警告「当前用户无 crontab 权限」 |
| 防火墙 | `available=false`、`backend=ufw`、错误原文 ufw 需 root —— **真实降级态** |
| 商店 | `GET /store/plugins` **200 · 24 条**（重启前为 401 见问题 3） |
| 已装插件 | 14 个；13 个版本低于索引 |

## 2. 34 张截图尺寸表（`.agents/verify/screenshots/`）

| # | 页 | desktop 文件 | 实测 | sha256 | mobile 文件 | 实测 | sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 概览 | `r2f-desktop-01-dashboard.png` | 1440×900 | `cc8292aabf52` | `r2f-mobile-01-dashboard.png` | 390×844 | `b6caece92a67` |
| 2 | 监控 | `r2f-desktop-02-monitor.png` | 1440×1579 | `cfe3cfd25ca8` | `r2f-mobile-02-monitor.png` | 390×844 | `d39db086b910` |
| 3 | 日志 | `r2f-desktop-03-logs.png` | 1440×932 | `803ca3163364` | `r2f-mobile-03-logs.png` | 390×844 | `ba77496cf763` |
| 4 | 进程 | `r2f-desktop-04-process.png` | 1440×3973 | `7e26d1f336da` | `r2f-mobile-04-process.png` | 390×844 | `dab9b1b486bc` |
| 5 | 终端 | `r2f-desktop-05-terminal.png` | 1440×901 | `2587ece5d2ec` | `r2f-mobile-05-terminal.png` | 390×844 | `5b0a77c24fb9` |
| 6 | 网站 | `r2f-desktop-06-sites.png` | 1440×900 | `527dbb3703bf` | `r2f-mobile-06-sites.png` | 390×844 | `11734738498e` |
| 7 | 数据库 | `r2f-desktop-07-db.png` | 1440×900 | `4db442edc9b9` | `r2f-mobile-07-db.png` | 390×844 | `1399e8384a3b` |
| 8 | Redis | `r2f-desktop-08-redis.png` | 1440×9386 | `8b79971903f2` | `r2f-mobile-08-redis.png` | 390×844 | `407240383674` |
| 9 | 计划任务 | `r2f-desktop-09-tasks.png` | 1440×900 | `b1e9041b5696` | `r2f-mobile-09-tasks.png` | 390×844 | `affa8bd46ca6` |
| 10 | 文件 | `r2f-desktop-10-files.png` | 1440×900 | `f0ab10a6396d` | `r2f-mobile-10-files.png` | 390×844 | `6756d863c0d0` |
| 11 | 备份 | `r2f-desktop-11-backup.png` | 1440×900 | `760c5f0d7c6d` | `r2f-mobile-11-backup.png` | 390×844 | `ba78262ce35d` |
| 12 | SSL | `r2f-desktop-12-ssl.png` | 1440×1039 | `7a39726246cc` | `r2f-mobile-12-ssl.png` | 390×844 | `1aa93cb7f557` |
| 13 | 商店 | `r2f-desktop-13-store.png` | 1440×1610 | `abe42aec6219` | `r2f-mobile-13-store.png` | 390×844 | `39e461f2c473` |
| 14 | 已装插件 | `r2f-desktop-14-plugins.png` | 1440×1398 | `8339e9f2ff05` | `r2f-mobile-14-plugins.png` | 390×844 | `490b80254a09` |
| 15 | 防火墙 | `r2f-desktop-15-firewall.png` | 1440×908 | `29d211a99bcc` | `r2f-mobile-15-firewall.png` | 390×844 | `49d8ab3535a0` |
| 16 | 设置 | `r2f-desktop-16-settings.png` | 1440×1043 | `a65d0c18dc00` | `r2f-mobile-16-settings.png` | 390×844 | `eec6db663c93` |
| — | 侧栏四组 / 抽屉 | `r2f-desktop-nav-groups.png` | 1440×1000 | `219fbaca008c` | `r2f-mobile-nav-drawer.png` | 390×844 | `8a7726d3c1ec` |

- 齐全性 **34/34**：16 页桌面 1440 宽 full-page（高 900–9386）+ 16 页手机 390×844 视口 + 桌面侧栏四组 + 手机抽屉（11 项）。
- 唯一性 **34 unique / 0 重复**（脚本内两两比对，重复即中止）；`identify` 与 PNG IHDR 双读一致。
- 侧栏四组用 **1440×1000 视口**（非 full-page）：概览页内容正好 900 高，同尺寸会与第 1 张像素级重复；抬高 100 像素让 17 项四组完整入画且不重复。

## 3. 断言结果（每张前 1 道 + 后 1 道，共 68 项）

- **前断言（已登录）**：`.kore-shell` 已挂载 + `kore_csrf` cookie 存在 + 顶栏含「退出」+ `#view[data-view]` 已渲染 → 68/68 通过。
- **后断言（页面特征）**：`#view[data-view]=<id>` 且页内特征文本命中（如数据库页「MySQL 实例」、网站页「站点列表/已加载」、防火墙页「只读降级」）→ 全通过。
- **console error**：34 张 **合计 0 条**（Runtime.exceptionThrown + console.error 全页采集）。
- **横向溢出**：34 张 `scrollWidth > innerWidth` **全为 false**。
- 失败即停：脚本任一处断言不过即 exit 1，不写报告。

## 4. 16 页最终状态判定（对比 round3-live）

| # | 页 | R3 | 本轮 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | 概览 | 可用 | **可用** | 14 插件 / 常驻 2 / 降级告警为真实 cgroup 值 |
| 2 | 监控 | 可用 | **可用** | CPU·VmRSS·磁盘·load 实时；goroutine 11 / fd 22 |
| 3 | 日志 | 可用 | **可用** | 2 来源，syslog 29.9 MB 可读可搜 |
| 4 | 进程 | 可用 | **可用** | 100/803 真实进程 + 详情/树/信号 |
| 5 | 终端 | 可用 | **可用** | 真实 bash 会话已连接（135×40） |
| 6 | 网站 | 部分可用 | **可用** | docker 模式 3 站点，均「已加载」 |
| 7 | 数据库 | 部分可用 | **可用** | 真实 9.7.1、5 库；横幅版本仍错（见问题 2） |
| 8 | Redis | 部分可用 | **可用** | 真实 7.4.12、命中率 72.8%、db0 6574 键 |
| 9 | 计划任务 | 部分可用 | **部分可用** | crontab 权限不足，0 条 + 受限提示 |
| 10 | 文件 | 可用 | **可用** | 根目录 6 项，操作齐全 |
| 11 | 备份 | 可用 | **可用** | 1 个真实备份，sha 可校验 |
| 12 | SSL | 可用 | **可用** | 2 张自签证书（365 天） |
| 13 | 商店 | 可用 | **可用** | 24 条索引、已装 14、无升级入口（见问题 1） |
| 14 | 已装插件 | 可用 | **可用** | 14 行真实版本/深度/状态 |
| 15 | 防火墙 | 部分可用 | **部分可用** | available=false（ufw 需 root）真实降级 |
| 16 | 设置 | 可用 | **可用** | 会话剩余 ~12h、CSRF 状态、退出 |

**统计**：可用 **14** · 部分可用 **2** · 占位 **0** —— 与 round3-live **一致（14/2/0），无页级升降**。变化在页内内容：商店从「24 条 + 无升级」、服务器换成新公钥后恢复；数据库/Redis 仍是同一真实实例（uptime 1 天 18 小时）。

## 5. 数据库 / Redis / 网站三页真实数据摘要

- **数据库**：横幅「检测到本机 MariaDB **11.8.6**（127.0.0.1:3306）」；实例卡片「默认连接 · 可达 · 127.0.0.1:3306 · **9.7.1**」；实例详情 连接线程 5 / 运行 1 天 18 小时 / 查询 138,545 / 慢查询 0 / 最大连接 151；**5 个真实库**逐个带 SHOW TABLES 入口；只读 SQL 控制台就位。
- **Redis**：实例「可达 · 127.0.0.1:6379 · 7.4.12 · 运行 1 天 18 小时」；服务版本 7.4.12 / 客户端 79 / 内存 61.69M（峰值 62.34M）/ 命中率 72.8% / keyspace db0 6574；**keys 列表 200 行**真实键（auction:round:clock、bid:session、rank:mode、game:match 等，含 TTL）。
- **网站**：docker 模式，**共 3 个站点**，每行「vhost 存在 / nginx -t 通过 / **已加载**」；向导 create→bindSSL→setRewrite 与 5 个伪静态模板在位。

## 6. 最直观的 3 个问题

1. **商店把「已安装」按 id 判定、用索引版本展示，掩盖了本机落后**：商店卡片写「备份插件 v0.2.1 · 已安装 ✅」，已装插件页同一插件写 **0.2.0**；14 个已装里 **13 个低于索引**（db-mysql 0.1.0→0.2.0、redis 0.2.0→0.3.0、firewall 0.2.0→0.2.2…），且两页都**只有「重装」没有「升级」**。版本已全 bump 的是索引与 dist，本机跑的还是旧包，用户看不出落后。
2. **数据库页同页两个版本号打架**：自动检测横幅用 `/usr/bin/mysql` 客户端报 **MariaDB 11.8.6**，实例卡片才是真实服务端 **9.7.1**。截图里同屏出现两个版本，等于告诉用户"你有两个库"。
3. **商店可用性绑死在「重启内核」上**：本机未重启前该页真实呈现「索引暂不可用 · 当前显示 0 个 + 索引已更新，需重启 kored 才能载入新公钥」，重启后才 24 条。公钥轮换没有热重载或兼容窗口，页面除提示文案外没有自助恢复入口（R3 的问题 1「只按版本号判断已最新」在 UI 层依然成立）。

## 7. 清理

- 采集脚本与临时 profile 全在 `/tmp/r2f`（Node 内置 WebSocket 直驱 CDP，无第三方依赖），已 `rm -rf /tmp/r2f`；无残留 chromium 进程；未动 `bin/kored`、未改源码、未提交。
