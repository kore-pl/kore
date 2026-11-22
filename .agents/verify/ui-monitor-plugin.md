# 监控页接 monitor 插件（真机 · 双端 · G-28）

> 元信息: 2026-11-23T06:16+08:00 · 执行者 ui-monitor-plugin 子 agent · 隔离实例 18860 · monitor 0.2.0 · chromium 156 headless CDP · 报告 ≤70 行

## 1. 实现与交互
- `web/monitor.js`（331 行，数据/编排）+ `web/monitor-cards.js`（189 行，纯渲染构件）：单文件超 400 行故拆分；cards 模块由 `monitor.js` 进入视图时才注入 `/assets/monitor-cards.js`，两者均不进首屏。
- 插件优先：`POST /api/v1/invoke/monitor/monitor.system` 成功 → 4 卡（CPU / 内存 / 负载 / 运行时长）+ 磁盘、网络、温度 3 面板 + 进程 Top10；失败（E_* / 超时 / 网络）→ `GET /api/v1/system/metrics` 降级，顶部灰字原文「当前使用内核基础指标，安装 monitor 插件可获得磁盘/网络/温度详情」+ 降级原因，不报错、不白屏。
- 温度单独调 `monitor.temperature`：`available=false` 或无 zone 只显示灰字「本机不支持温度读取」，不渲染空表。
- 进程：`monitor.processes {limit:10,sort:"cpu"}`；「按 CPU / 按内存」切换并按 `aria-pressed` 标记；表格 PID / 名称 / CPU% / 内存 / 线程。
- 刷新：仅手动按钮，页内无 `setInterval` / `setTimeout`（G-19）；显示「最后更新 HH:MM:SS」。
- 响应式：卡片复用 `.monitor-grid`（<640px 单列），表格 `.mon-scroll{overflow-x:auto}`，刷新/排序按钮 44px。

## 2. 数据来源对比（插件 vs 内核降级）
| 数据 | monitor 插件（/proc · /sys） | 内核 `/api/v1/system/metrics` |
| --- | --- | --- |
| CPU | usage_percent + cores + user/system/iowait/idle + sample_interval_ms | 仅 cpu_pct |
| 内存 | used/total/available/buffers/cached/swap + used_percent | 无系统内存（仅主壳 rss_kib） |
| 负载 | load1/5/15 + running/total | 仅 load1 |
| 运行时长 | uptime_s + idle_s | uptime_sec |
| 磁盘 | 逐挂载点 mount/fs_type/used/total/avail/percent | 根分区汇总 used/total |
| 网络 | 逐网卡 rx/tx/packets/errors + `*_human` | 无 |
| 温度 | available + zones（zone/temp_c/type） | 无 |
| 进程 | 10 条 pid/comm/state/cpu_percent/rss/threads | 无 |
| 其他 | warnings[] | goroutines / fds |

## 3. 真机证据（18860，monitor 0.2.0，allow_unsigned=true）
- 安装：`POST /api/v1/store/install {package_path:"…/monitor-0.2.0.tar.gz",force:true}` → `state=succeeded reload=reloaded`；enable → `ready`（pid 1074549）。
- 首屏（mon-desktop-full）：CPU 9.5% · 24 核 · 采样 200ms；内存 28.7 GiB / 61.3 GiB（46.9%），Swap 10.1 MiB / 16.0 GiB；负载 2.20（5m 2.48 / 15m 2.41，运行 3/5076）；运行时长「1 天 19 小时」（空闲 35 天 4 小时）；磁盘 3 个挂载点（/ 29.1%、/boot/efi 0.9%、/mnt/data 61.6%）；网络 13 张网卡；温度 3 zone（27.8 / 49.0 / 34.0°C）。
- 进程 Top10（mon-desktop-processes）：10 行真实进程（qemu-system-x86 35.5% / 12.3 GiB、dsh-desktop-nex、gnome-shell、monitor 14.2% / 9.5 MiB…），共 806 进程。
- 降级（mon-desktop-degraded）：停用 monitor 后重载，灰字提示 + 原因 `E_CONFLICT：插件 monitor 未启用…`；5 卡（CPU 0.0%、load1 2.51、uptime 2 分 20 秒、根分区 519.2 / 1875.7 GiB、主壳 VmRSS 15.0 MiB · goroutine 9 · fd 85）；无进程表、body 500 字无白屏。
- 交互断言（CDP）：6.5s 静置时间戳 `06:15:11` 不变（无轮询）；点刷新 → `06:15:18`；点「按内存」→ aria-pressed=true，首行 qemu-system-x86 12.3 GiB > 次行 2.0 GiB；请求计数 system=2（首载+刷新）、processes=3（首载+刷新+排序）、temperature=2、metrics=0（插件路径不碰内核）；uncaught 0。
- G-29：本轮未改 8787 运行态配置；主实例全程健康（`/-/healthz` ok，PID 1060905）。全部测试在 18860 + `/tmp/kore-mon-verify`。

## 4. 双端截图（G-28）
| 文件 | 尺寸 | bytes | sha256 前 12 | 页内断言 |
| --- | --- | --- | --- | --- |
| `screenshots/mon-desktop-full.png` | 1440×1992 | 187431 | 1f00c5b1de73 | 4 卡 + 磁盘/网络/温度/进程 4 面板；插件来源 |
| `screenshots/mon-desktop-processes.png` | 1440×900 | 96886 | d7a928efb3a7 | 10 行真实进程名；按 CPU 高亮 |
| `screenshots/mon-desktop-degraded.png` | 1440×900 | 103555 | 7eca6ece8188 | 灰字提示 + 内核指标 5 卡 + E_CONFLICT 原因 |
| `screenshots/mon-mobile-full.png` | 390×2392 | 139976 | 76c460e23a9e | 卡片单列、表格容器内横向滚动 |
- 移动端：`gridTemplateColumns=366px`（单列）、`scrollWidth/innerWidth=390/390`（无整页横向滚动）、`.mon-scroll` computed `overflow-x=auto`。

## 5. 产品定位自评（G-28 三问）
- 解决什么：不登 SSH 即可看到 CPU/内存/负载/uptime/磁盘/网络/温度与进程 Top10，手动刷新取当前快照；插件缺失自动降级到内核指标，能力缺失不导致白屏。
- 与宝塔 / 1Panel 差距：无历史曲线、阈值告警与自动刷新（G-19 明确禁止轮询）、无进程 kill 联动（由进程页负责）、磁盘无 SMART。
- 当前状态：**可用**——真实 `/proc` 数据、真实进程名、降级路径可见，非占位。

## 6. 门禁与清理
| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/monitor.js` / `web/monitor-cards.js` | 0 / 0 | 语法通过 |
| `make frontend` | 0 | 22 文件；首屏 gzip 43,381 B / 307,200 B |
| `make docs-check` | 0 | 5 pass / 1 warn（RELEASE.md 行数，既有）/ 0 fail |
| `make check` | 0 | 11/11 段，`[OK] 门禁全部通过` |
| `go build -o /tmp/…/kored ./cmd/kored` | 0 | 隔离实例二进制（未覆盖 `bin/kored`） |
| CDP 截图 / 交互脚本 | 0 / 0 | exceptions=0 |
- 清理：18860 已停；`/tmp/kore-mon-verify` 与 chromium profile、一次性脚本已删；工作区仅保留交付文件。未提交他人改动（`web/db.js`、`web/db-l2.js`、他人截图保持原样）。
