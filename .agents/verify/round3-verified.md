# Round 3 Verified · monitor 热升级 + 36 张双端证据（G-28 / G-29）

- 2026-11-23 06:30–06:43+08:00 · r3-final-verify · `/home/pt/Work/GolandProjects/kore`
- 主实例 PID **1266053** 全程未重启（升级走热重载）；未改源码、未提交、未改运行态配置；按 G-30 不写口令明文。

## 1. monitor 升级（先确认版本与 lifecycle，再 enable）

| 阶段 | version | lifecycle | enabled | state | supervisor.resident |
| --- | --- | --- | --- | --- | --- |
| 升级前 | 0.2.0 | resident | false | stopped | 2 |
| `POST /store/install` 后 | 0.2.1 | lazy | false | stopped | 2 |
| `POST /plugins/monitor/enable` 后 | 0.2.1 | lazy | true | stopped | 2 |
| 唤醒测试全部空闲后（3 次采样） | 0.2.1 | lazy | true | stopped | **2** |

- install **HTTP 200**：`state=succeeded`、`已从 v0.2.0 升级到 v0.2.1`、`previous_version=0.2.0`、`stale_versions=[0.2.0]`、`reload=reloaded`。
- 槽位：enable 前后都 **resident=2（不是 3）**；仅 lazy 插件被唤醒的窗口内短暂为 3，空闲退出（60s）后回到 2，`restarts=0`。
- G-29：`paths.index_dir=.../kore-plugins/index`；商店 24 条 == 索引 24 条；索引 monitor 0.2.1 sha `fb153e56482c` == 已装 0.2.1。

## 2. 12 个 lazy 插件唤醒（逐个顺序调用，全部非 429）

| 插件 | 调用方法 | HTTP | ms |
| --- | --- | --- | --- |
| db-mysql | db-mysql.instances | 200 | 34 |
| file | file.list | 200 | 28 |
| backup | backup.list | 200 | 25 |
| redis | redis.instances | 200 | 17 |
| logs | logs.sources | 200 | 22 |
| cron | cron.list | 200 | 23 |
| ssl | ssl.list | 200 | 13 |
| process | process.list | 200 | 48 |
| firewall | firewall.status | 200 | 29 |
| container | container.list | 200 | 191 |
| discover | discover.services | 200 | 392 |
| monitor | monitor.system | 200 | 227 |
| monitor | monitor.temperature | 200 | 9 |

- **13 次调用 / 12 个 lazy 插件 / 0 个 429 / 0 非 2xx**，返回均为真实 JSON（库版本、证书、容器、温度等实值）。
- `file.list` 需参数 `{"path":"."}`；空参会 400 `路径不能为空`（同样是进程已拉起的证据，带参 200）。

## 3. 36 张截图（32 双端 + 2 导航 + 2 重点页细节）

- 每张**截图前**断言：`.kore-shell` 存在、`#kore-password` 不存在、`kore_csrf`+`kore_session` cookie 存在；**截图后**断言页面特征文本。36/36 PASS。
- 尺寸为 PNG IHDR 实测；**36 张 sha256 两两唯一**（36/36）。

| # | 页 | desktop 尺寸 · sha12 | mobile 尺寸 · sha12 | 判定 |
| --- | --- | --- | --- | --- |
| 01 | 概览 | 1440x900 · `e001dfd3d238` | 390x844 · `314bfd1b073e` | 可用 |
| 02 | 监控 | 1440x1992 · `a8ff6f68074a` | 390x844 · `906e7b0e428a` | 可用 |
| 03 | 日志 | 1440x932 · `492c5d097d40` | 390x844 · `de010d09c668` | 可用 |
| 04 | 进程 | 1440x3973 · `1629c2dd6e17` | 390x844 · `086033cf6ef5` | 可用 |
| 05 | 终端 | 1440x901 · `f98a57809bba` | 390x844 · `e185a082295f` | 可用 |
| 06 | 网站 | 1440x900 · `7ab9e132fab6` | 390x844 · `3b709de4b418` | 可用 |
| 07 | 数据库 | 1440x1388 · `31e539562ffc` | 390x844 · `c7485205ca2e` | 可用 |
| 08 | Redis | 1440x9405 · `94db04f676f8` | 390x844 · `237e700f0340` | 可用 |
| 09 | 计划任务 | 1440x900 · `601a9efe5414` | 390x844 · `615cc4f05ac0` | 部分可用 |
| 10 | 文件 | 1440x900 · `b1053ff1fce9` | 390x844 · `74ce716a2960` | 可用 |
| 11 | 备份 | 1440x900 · `ed3c91793581` | 390x844 · `37e59ebc1f5a` | 可用 |
| 12 | SSL | 1440x1039 · `89d6d6f9f643` | 390x844 · `81de5c278089` | 可用 |
| 13 | 商店 | 1440x1876 · `55b5558de6ce` | 390x844 · `ebd07dc7418a` | 可用 |
| 14 | 已装插件 | 1440x1581 · `1d7c45edeee4` | 390x844 · `15ea91435a7c` | 可用 |
| 15 | 防火墙 | 1440x927 · `c94f7e896fce` | 390x844 · `d7366b403b38` | 部分可用 |
| 16 | 设置 | 1440x1043 · `2c16270481f9` | 390x844 · `94a7449e2e8b` | 可用 |

- 导航：`r3v-desktop-nav-groups.png` 1440x900 `f43a797473da`（运维/业务/资源/平台四组 + 16 项 + 更多）；`r3v-mobile-nav-drawer.png` 390x844 `f3d2f3ff86fa`（业务/资源/平台 11 项）。
- 细节：`r3v-desktop-monitor-detail.png` 1088x1567 `1c2ddf36f690`（磁盘/网络/温度实值）；`r3v-desktop-db-users.png` 1088x433 `bb1b26472db7`（用户与授权 7 账号）。
- 统计：**可用 14 · 部分可用 2 · 占位 0**，与对比基线 14/2/0 一致；部分可用 = 计划任务（非 root 只读 crontab）、防火墙（非 root ufw 只读降级）。

## 4. 三个重点页实际内容

- **监控**：顶部 `数据来源：monitor 插件 · /proc`（非降级）；CPU 8.2%/24 核、内存 28.8/61.3 GiB、负载 2.41；磁盘 3 挂载（/ 29.1%、/boot/efi 0.9%、/mnt/data 61.6%）；网络 14 接口收发；温度 3 区 27.8 / 49.0 / 33.0 ℃；进程 Top10 已加载。
- **数据库**：横幅「已连接 MySQL 9.7.1（127.0.0.1:3306）」；`新建数据库`+`导入`；5 个库每行 `导出`/`删除`；`用户与授权` 折叠区展开后 7 个账号（授权/删除，root 行显示「root 不可删除」）。
- **已装插件**：汇总 `已启用 14 · 运行中 2 · 空闲 12 · 未启用 1 · 共 15 个已安装，0 个可升级`；monitor 行 `0.2.1 / lazy / 空闲`，蓝点 `background: var(--kore-info)`（计算色 `rgb(88,166,255)`）；site/terminal 绿点运行中；runtime-php 灰点未启用。
- 与任务卡「14/2/11/0」差异：空闲 12 = 12 个已启用 lazy 全部空闲；未启用 1 = runtime-php 0.1.1 已安装且停用。口径为真实 API 数据，未调整。

## 5. 数据库 / Redis 横幅文案

- 数据库：**已连接 MySQL 9.7.1（127.0.0.1:3306）**（服务端版本，来源=已连通实例）。
- Redis：**已连接 Redis 7.4.12（127.0.0.1:6379）**（任务卡的 9.7.1 是 MySQL；Redis 服务端实为 7.4.12）。

## 6. 最直观的 3 个问题

1. `runtime-php` 仍以「未启用」挂在已装列表 → 汇总恒多一条 `未启用 1`，与验收期望 0 不符；应卸载或启用，别让状态账挂着。
2. 防火墙页把 root 缺失报成 **HTTP 401 `E_UNAUTHORIZED`**，又把 `ufw status numbered / ERROR: You need to be root` 原样铺在页面上；401 语义是登录失效，建议改 `E_NEED_ROOT` 并在 UI 折叠为一条提权指引。
3. 页面长度失控：Redis 页 **1440×9405**（≈11 屏）、进程 1440×3973、商店 1440×1876；键空间默认全量渲染、进程默认 100 行，缺分页/虚拟滚动。

## 7. 纪律与清理

- `kored` 未重启：PID 1266053 全程不变（06:40 etime 09:54，`restarts=0`）；升级由 install 热重载完成。
- 未改源码/未提交：`git status` 仅本报告与 `screenshots/r3v-*.png` 36 张；`web/`、`cmd/`、`internal/` 零改动。
- 已清理临时脚本 `/tmp/r3v-*.cjs`、cookie jar、中间 JSON；Playwright 用临时 profile，无持久 profile 残留。
