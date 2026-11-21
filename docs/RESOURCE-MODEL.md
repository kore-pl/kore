# 资源模型（预算 · 隔离 · 度量）

> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

kore 的资源预算是**门禁**，不是建议值：超了等于没做完。本文件定义每个组件的预算、cgroup v2 落地方式、度量口径与 CI 判定。协议侧字段与错误语义见 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md)，状态落盘与日志落盘见 [DATA-MODEL.md](./DATA-MODEL.md)。

## 1. 为什么资源是第一优先级

因果链只有四步，但每一步都会把 kore 从「底座」变成「负担」：

1. **常驻开销**：主壳与常驻插件按设计 24×7 在内存里。主壳多 20 MiB、每插件多 30 MiB，一个装 3 个插件的机器就多出 100+ MiB。
2. **宿主被挤占**：运维底座的宿主往往同时跑业务进程；被挤占的内存会变成 OOM killer 的选择题，底座自己成了故障源。
3. **成本上升**：为了跑底座而加内存，等于用硬件成本补贴软件膨胀；云上按 GiB 计费，这笔钱每年都在付。
4. **信任崩塌**：用户装 kore 是为了「零侵占」，一旦发现它比被替代的面板还重，卸载是唯一理性选择。

因此资源是架构约束而非优化项：**超预算的实现不进里程碑**，不接受「先上线后优化」。

## 2. 预算表

| 组件 | 常驻形态 | 预算 | 目标实测 | 测量命令 | 超了怎么办 |
| --- | --- | --- | --- | --- | --- |
| 主壳 `kored` | 常驻，空载 | RSS ≤ 8 MiB | 5–6 MiB | `ps -o rss= -p <pid>`（KiB/1024），60s 中位数 | 查 goroutine/缓冲/依赖，再调 GC；不得靠隐藏功能达标 |
| 主壳空闲 CPU | 常驻 | 60s CPU 时间 ≤ 60ms（≤0.1%） | 10–40ms | `/proc/<pid>/stat` 的 `utime+stime` 两次差值（tick 通常 10ms） | 查定时器/轮询/GC；按 §2.3 门禁定位 |
| 空载 goroutine | 常驻 | ≤ 20 | 8–16 | `/system/info.goroutines`（`runtime.NumGoroutine`） | 查泄漏 goroutine，禁止每插件一循环 |
| 同时常驻插件数 | 进程 | ≤ 3（resident + 活跃 lazy） | 1–2 | supervisor 配额 + `pgrep -f '/plugins/<id>/'` | 超配额时最久未用 resident 降级为 lazy，或拒绝启用并提示 |
| resident 插件（单个） | 常驻 | RSS ≤ 12 MiB | 6–10 MiB | 按插件 pid，60s 中位数 | 定位泄漏或缓存；仍超则拒绝该版本上架 |
| 常驻插件合计（含活跃 lazy） | 常驻 | RSS ≤ 24 MiB（3 × 12 顶格） | ≤ 20 MiB | 各插件 RSS 求和 | 停用或降级；内核不代偿 |
| lazy 插件（活跃时） | 按需 | RSS ≤ 12 MiB | 6–10 MiB | 按插件 pid | 同 resident |
| lazy 空闲退出 | 进程不存在 | `idle_timeout_s` 默认 300s（60–1800） | 300s | 日志 `lazy_stopped` + `pgrep` 无输出 | 查内部 ticker/长连接未释放 |
| 插件冷启动 | — | 拉起→hello→ready p95 ≤ 300ms | 80–200ms | 日志 `started_at`→`ready` 差值取 p95 | 查 init 阶段网络/DB/目录扫描 |
| oneshot 插件 | 空闲不存在 | 空闲 RSS = 0 | 0 | `pgrep -f '/plugins/<id>/'` 必须无输出 | 有空闲进程即判失败，查回收路径 |
| 单二进制 `kored` | 静态文件 | ≤ 25 MiB（26,214,400 B） | 18–22 MiB | `stat -c%s bin/kored` | 砍依赖、去除未用 embed |
| 插件二进制（单插件仓库产物） | 静态文件 | 建议 ≤ 10 MiB（非硬门禁） | 6–10 MiB | `stat -c%s kore-plugin-<id>/bin/<id>` | `-ldflags="-s -w"`、`CGO_ENABLED=0`、砍依赖 |
| 插件包 `tar.gz` | 发布产物 | ≤ 15 MiB（硬） | 8–15 MiB | `du -b kore-plugin-<id>/dist/<id>-<version>.tar.gz` | 包内不放源码/`node_modules`，前端只留产物 |
| 前端首屏 | 静态资源 | ≤ 300 KiB gzip（307,200 B） | 180–250 KiB | 见 §8 的 gzip 统计口径 | 路由拆包、按需引入、删第三方库 |
| 空载 fd | 常驻 | ≤ 64 | 12–32 | `ls /proc/<pid>/fd | wc -l` | 查泄漏 fd 与未关闭连接 |
| 空载出站连接 | 常驻 | 0 | 0 | `ss -tnp state established | grep -c kored` | 禁止隐藏上报/心跳；出网只在插件 |
| 后台定时器 | 常驻 | 0 个（唯一例外：证书续期 `cert_renew.enabled`，默认关） | 0 或 1 | 代码审查 `time.NewTicker`/`time.AfterFunc` 全量清点 | 删除或改事件驱动 |

度量固定口径：`ps -o rss= -p PID` 输出 KiB，除以 1024 得 MiB；进程启动后**稳定 60s**再取中位数，禁止用峰值或首次采样值对外声明。二进制与前端用字节数直接比对，不做四舍五入。

### 2.1 场景预设合计预算（v1）

首次安装按场景预设装插件；预设合计必须落在「同时常驻 ≤3、目标 ≤19.2 MiB（红线 24 MiB）」内。预设定义由 `kore-plugins/presets/*.json` 承载（G-18 校验），本表是预算基线：

| 预设 | 常驻插件（memory_mb） | 合计常驻 MiB | 目标 ≤19.2 MiB | 余量 = 24 − 目标 | 常驻进程数 | 合计 pids |
| --- | --- | --- | --- | --- | --- | --- |
| minimal | 无 | 0 | 通过 | 24 | 0 | 0 |
| web-lite | site(10) | 10 | 通过 | 14 | 1 | 128 |
| web-pro | site(10) + monitor(6) | 16 | 通过 | 8 | 2 | 256 |
| db-only | 无（db 全 lazy） | 0 | 通过 | 24 | 0 | 0 |
| gateway | site(10) | 10 | 通过 | 14 | 1 | 128 |
| security | 无（全 lazy） | 0 | 通过 | 24 | 0 | 0 |
| dev | site(10) | 10 | 通过 | 14 | 1 | 128 |
| full | site(10) + monitor(6) | 16 | 通过 | 8 | 2 | 256 |

预算余量规则：预设的常驻合计**目标 ≤ 24 MiB × 80% = 19.2 MiB**；24 MiB 是「绝不越过」的红线，不是设计目标。**余量 = 24 − 目标；余量为 0 的预设判 FAIL**，必须把某个 resident 改 lazy 或压缩预算。留 20% 的原因：单插件 RSS 有波动（GC 峰值、连接缓冲）、插件升级会增重、用户可能有临时启用第 3 个 resident 的需求——顶格设计在第一次升级就会破防。因此 db/security 类一律 lazy，不进常驻。

结论：8 个预设目标全部 ≤19.2 MiB（最大 16），最小余量 8 MiB，全部通过；无余量为 0 的预设。常驻插件配额：**硬上限同时 3 个，推荐 ≤2 个**（`site` + `monitor`，16 MiB）；第 3 个槽位留给用户临时启用，不作设计目标。预设只使用 `PLUGIN-CATALOG` 的真实插件 id（`site`/`monitor`/`cron`/`ssl`/`db-mysql`/`db-postgres` 等），`cron` 为 lazy 并由宿主调度器触发，`db`/`security` 类全按 lazy 计 0 常驻。

### 2.2 三种生命周期与资源占用

| lifecycle | 语义 | 空闲时 | 单插件上限 | 冷启动 |
| --- | --- | --- | --- | --- |
| resident | 随 kore 启停的常驻进程，用于事件订阅/长连接 | 进程存在 | RSS ≤ 12 MiB | 首次 hello ≤ 300ms |
| lazy（默认） | 按需拉起，空闲 `idle_timeout_s`（默认 300s）退出 | 进程不存在，RSS=0 | 活跃时 ≤ 12 MiB | p95 ≤ 300ms |
| oneshot | 每次调用拉起、执行完退出 | 进程不存在 | 活跃时 ≤ 12 MiB | p95 ≤ 300ms |

`lazy` 是默认：18–22 个插件里大多数不应常驻；`resident` 只在确需持续订阅/长连接时声明；`oneshot` 用于批处理。

### 2.3 空闲行为门禁（空载 60s）

- CPU 时间：`a=$(awk '{print $14+$15}' /proc/$PID/stat); sleep 60; b=$(awk '{print $14+$15}' /proc/$PID/stat); echo $((b-a))` 必须 ≤ 60（tick，100Hz 下 60 tick = 60ms = 0.1%）。
- goroutine：`/system/info.goroutines` ≤ 20；`ls /proc/$PID/task | wc -l`（OS 线程）仅作旁证，两者不可互相替代。
- fd：`ls /proc/$PID/fd | wc -l` ≤ 64。
- 出站连接：`ss -tnp state established | grep -c kored` 必须为 0。
- 定时器：仅 `cert_renew`；`grep -rn "time.NewTicker\|time.AfterFunc" internal/` 只允许命中证书续期一处。
- **禁止轮询**：主壳不得有「每 N 秒拉一次插件状态」的循环；状态变化由插件推 `plugin.health`/`plugin.state` 事件，配置变化走 SIGHUP。

### 2.4 为什么 22 个插件不会变成 22 个进程

绝大多数插件默认 `lazy`/`oneshot`：空闲即无进程、RSS=0。同时常驻 ≤3 由 supervisor 配额强制——启用第 4 个 resident 时，按 `last_active_at` 把最久未用的 resident 降级为 lazy（先 draining 再 idle），或拒绝启用并提示用户停用其它插件。lazy 唤醒源：业务方法调用、事件订阅命中、显式 `POST /api/v1/plugins/{id}/enable`；唤醒同样受冷启动 300ms 门禁约束。定时任务由**宿主调度器**（systemd timer / cron.d / launchd / Task Scheduler）触发 `kored invoke`，kore 不自带 scheduler；`cron` 插件是 lazy。

## 3. cgroup v2 落地

### 3.1 目录结构

```text
/sys/fs/cgroup/kore/                     # 委派给主壳的根（kore.service Delegate=yes）
├── cgroup.controllers                   # memory cpu pids（宿主可用集合）
├── cgroup.subtree_control               # "+memory +cpu +pids"
├── kore-site.slice/                     # 每个插件一个，id=site
│   ├── cgroup.procs                     # 插件进程 pid 写入处
│   ├── memory.max                       # 硬限，超过触发 OOM kill
│   ├── memory.high                      # 软限，超过触发回收/节流
│   ├── memory.swap.max                  # 0，禁止换出掩盖膨胀
│   ├── cpu.max                          # "<quota> 100000"
│   └── pids.max                         # 进程/线程数上限
└── kore-backup.slice/                   # oneshot 同样建 slice，进程退出后目录保留、计数清零
```

### 3.2 需要的 controller

只需三个：`memory`（硬限与回收）、`cpu`（配额）、`pids`（防 fork 炸弹）。不启用 `io`（日志与 bbolt 的 IO 由内核自控，MVP 不做 IO 限速）、不启用 `cpuset`（跨宿主核数不可移植）。

### 3.3 写入值

| 文件 | 写入值 | 说明 |
| --- | --- | --- |
| `cgroup.subtree_control`（根） | `+memory +cpu +pids` | 让子 slice 可用三个 controller；若返回 `EBUSY`/`ENOSPC` 说明该层级仍有进程，先确认委派生效 |
| `memory.max` | `memory_mb × 1048576` 字节，如 12 → `12582912` | 硬限；超过由内核 OOM killer 杀进程，supervisor 按协议 §6 记 failed |
| `memory.high` | `memory.max` 的 90%，如 12 MiB → `11324620` | 软限；超过触发内存回收，进程变慢但不杀 |
| `memory.swap.max` | `0` | 不允许 swap 掩盖真实占用 |
| `cpu.max` | `<pct×1000> 100000`，如 `50%` → `50000 100000` | 周期 100ms 内的配额；100% → `100000 100000` |
| `pids.max` | `pids_max`，如 `128` | 同时限制线程数；Go runtime 线程数通常 < 32，128 足够 |

### 3.4 delegation 前置与降级

前置检查（部署时执行一次，失败不阻断启动但要记录）：

```bash
systemctl show kore -p Delegate            # 必须 Delegate=yes
cat /sys/fs/cgroup/cgroup.controllers      # 必须含 memory cpu pids
test -w /sys/fs/cgroup/kore                # 主壳需可写委派子树
```

`kore.service` 需要 `Delegate=yes`、`KillMode=control-group`，主壳以 root 或具备委派权限的用户启动；主壳自身写入 `cgroup.procs` 后不再向该层级添加其它进程。

降级路径（满足任一条件即进入监控模式）：`/sys/fs/cgroup` 只读、controller 缺失、写入 `*`.max 返回 `EPERM`/`ENOSYS`、配置 `resources.enforce: false`。

监控模式规则：不阻断、不杀进程；利用**已有的** 10s 心跳顺带读取 `/proc/<pid>/status` 的 `VmRSS`（不新增定时器），超预算时记 WARN 并发 `system.event{kind:"resource_over_budget"}`；`/system/info` 增加 `enforce:false` 标记，前端明确提示「当前为监控模式」。

### 3.5 cgroup 可用性与降级矩阵

| 环境 | 事实 | 探测方法 | 可用性 | 缺失/受限时的行为 | 用户可见信号 |
| --- | --- | --- | --- | --- | --- |
| cgroup v2 unified（kernel ≥5.2 + systemd `Delegate=yes`） | 理想态 | `/proc/self/cgroup` 单行 `0::/`；`cgroup.controllers` 含 `memory cpu pids`；`kore.slice` 写探测成功 | 全量 | 按 §3.3 写入 `memory.max/high/swap.max`、`cpu.max`、`pids.max` | `cgroup_mode:"v2"`、`delegation:true`、`enforced:true` |
| cgroup v1 / hybrid（RHEL8 默认、老内核） | 无 unified | `/proc/self/cgroup` 多行（含 `memory:`/`cpu:`） | 否 | **不写任何 cgroup 文件**，只读 `/proc/<pid>/status` 的 `VmRSS` 监控 | `cgroup_mode:"v1"`、`enforced:false` |
| cgroup v2 但无委派（systemd 未 `Delegate=yes`；Alpine/OpenRC 无 systemd） | 目录不可写 | controllers 存在，但写 `memory.high` 返回 `EPERM`/`EACCES` | 受限 | 写失败**不得导致启动失败**：降级纯监控 + WARN 日志一次 | `delegation:false`、`enforced:false` |
| 容器内（`/sys/fs/cgroup` 只读或受限） | 常见 CI 环境 | `/proc/mounts` 该挂载带 `ro`，或写探测返回 `EROFS` | 受限 | 同「无委派」：降级纯监控；`make mem` 仍用 `ps` 采样 | `enforced:false`，日志标 `container` |
| 无 cgroup 挂载（极端精简系统） | `/sys/fs/cgroup` 不存在或为空 | 目录不存在、无 `cgroup.controllers` | 否 | 纯监控模式：插件资源只做「事后观测」，不做限制 | `cgroup_mode:"none"`、`enforced:false` |

### 3.6 探测时机与顺序

启动时执行一次（目标 < 10ms，不重试、失败不退出）：

1. 读 `/proc/self/cgroup`：唯一一行且以 `0::` 开头 → v2 unified；出现多行（如 `12:memory:/`）→ v1/hybrid。
2. 判 `/sys/fs/cgroup/cgroup.controllers` 是否存在且包含 `memory cpu pids`。
3. 可写性探测：读 `kore.slice/memory.high` 原值并写回同值（无副作用）；返回 `EPERM`/`EACCES`/`EROFS` 即不可写。
4. 结论写入 capability report，经 `/system/info` 暴露 `cgroup_mode`、`delegation`、`controllers[]`、`enforced` 四个字段；探测失败只记 WARN，不重试。

### 3.7 写入失败分类

| errno | 判定 | 处置 |
| --- | --- | --- |
| `EPERM` / `EACCES` | 无权限 / 未委派 | 降级纯监控，WARN 一次，不退出 |
| `EROFS` | 只读挂载（容器） | 降级纯监控，不退出 |
| `ENOSPC` / `EINVAL` | 值非法或超出 controller 限制 | **配置错误**：kore 自身 slice → 启动退出码 2；插件 slice → 拒绝启用该插件（`E_INVALID` + 状态 `failed`），主壳继续运行 |
| `ENODEV` / `ENOENT` | controller 不存在 | 降级纯监控，不退出 |

### 3.8 降级时预算怎么算

`memory.max` 不可写时，`resources.memory_mb` 降级为**观测阈值**：心跳（10s）顺带读 `VmRSS`，超过预算只记 WARN 并发 `system.event{kind:"resource_over_budget"}`，**不 kill、不重启**。这与「超预算即判失败」的门禁口径是两层：门禁是 CI 发版判定（`make mem` 实测中位数），运行时是监控；两者不能互相替代，也不因运行时不杀进程而放宽门禁。

### 3.9 与退出码 6 的边界

cgroup 缺失或受限**不是**硬要求，任何降级都不触发退出码 6，只影响 `cgroup_enforced` 与提示文案。仅以下情况触发退出码 6：① 架构不符（非 `linux/amd64` 或 `linux/arm64`）；② Linux 内核版本 < 4.18；③ 状态目录位于 NFS/SMB（`flock` 不可靠）；④ Windows < 10 1809（无 AF_UNIX 与 Job Objects）。cgroup 问题永远只降级，不阻止 kore 启动。

### 3.10 三平台资源限制（Linux / Windows / macOS）

| 平台 | 机制 | 可强制项 | 不可强制项 | 降级行为 |
| --- | --- | --- | --- | --- |
| Linux + cgroup v2 unified | cgroup v2 | `memory.max/high/swap.max`、`cpu.max`、`pids.max` | — | 全量生效（§3.3） |
| Linux + cgroup v1/hybrid 或 v2 无委派 | 无（或部分） | 无 | 全部 | 只读 `/proc/<pid>/status` 观测，`/system/info` 标 `resource_enforced:false` |
| Windows 10 1809+ | Job Objects | 内存上限（`JOB_OBJECT_LIMIT_PROCESS_MEMORY`）、CPU 时间/亲和 | 无 `pids.max` 等价、无 `memory.high` 软限 | Job Object 内存上限近似 `memory.max`；`/system/info` 标 `resource_mode:"jobobject"`、`resource_enforced:"partial"` |
| macOS 12+ | 无（`setrlimit` 只能限本进程） | 无 | 全部 | 仅观测 + 超预算 WARN，`/system/info` 标 `resource_mode:"observe"`、`resource_enforced:false` |

**口径分界（不可混谈）**：「预算门禁」是 CI/验收口径——`make mem` 实测 60s 中位数超阈值即判失败；「运行时限制」是平台能力——由 OS 机制决定能强制到什么程度。macOS 上 `memory_mb` 只是**告警阈值**，不是硬限；Windows 只有内存硬限、没有 pids 与软限；Linux 无 cgroup 时同样降为观测。平台能力字段统一经 `/system/info` 的 `resource_mode` / `resource_enforced` 暴露，禁止静默降级（G-16）。

## 4. 插件 resources 字段 → cgroup 映射

| info.json 字段 | cgroup 文件 | 缺省值 | 换算 | 备注 |
| --- | --- | --- | --- | --- |
| `resources.memory_mb` | `memory.max` | 12 | ×1048576 字节 | 允许 4–12；常驻合计不超过 24 |
| `resources.memory_mb` × 0.9 | `memory.high` | 10.8 MiB | 向下取整 | 软限，触发回收不杀 |
| （固定） | `memory.swap.max` | 0 | — | 不可覆盖 |
| `resources.cpu_quota` | `cpu.max` | `"50%"` | pct×1000 + ` 100000` | 仅接受 10%–100% 整数百分比 |
| `resources.pids_max` | `pids.max` | 128 | 原样 | 允许 16–512 |
| `lifecycle=resident` | slice 常驻 | — | 启动即建 slice，进程常驻其中 |
| `lifecycle=lazy` | slice 是否活跃 | — | 活跃时创建 slice；空闲退出后 slice 保留、`cgroup.procs` 为空，下次唤醒直接复用 |
| `lifecycle=oneshot` | slice 是否活跃 | — | 每次执行复用同一 slice，退出后 `cgroup.procs` 为空 |

插件仓库产物体积是**建议值**，不进 kore 的 G-03 硬门禁：各插件 `make dist` 打印 `stat -c%s` 与 `du -b`，kore 安装时把包体大小记入 `plugins` 记录；超建议值时按上表右列逐项砍，不抬预算。`resources` 缺字段时用上表缺省值并记录 WARN；安装时校验：`memory_mb` 超 12、`cpu_quota` 超 100%、`pids_max` 超 512 一律拒绝安装（`E_INVALID`）。

## 5. oneshot 调度模型

触发源三种，按优先级：

1. **HTTP invoke**：`POST /api/v1/invoke/{plugin}/{method}`，body 为 `params`，同步等待结果。
2. **kored CLI**：`kored invoke <plugin> <method> --json '<params>'`（单二进制子命令，标准库 `flag` 实现），走同一 UDS，供 systemd timer / cron 调用。
3. **可选 cron**：默认关闭，且**不创建内核定时器**——推荐用宿主 `systemd timer` 或 `cron` 调 `kored invoke`；`info.json.triggers` 里的 `cron` 条目只作元数据提示，M0–M3 主壳不内建调度器。

拉起-执行-回收时序：

1. 请求到达 → 入队（队列深度 32，满则 `E_RATELIMIT` + `Retry-After`）。
2. 并发检查：同时执行 ≤ 2（按插件 id 计），超出排队等待，排队超 30s 返回 `E_RATELIMIT`。
3. supervisor 以 `kore-<id>` 用户拉起 `/var/lib/kore/plugins/<id>/<version>/bin/<id>`（与 DATA-MODEL 落盘一致），写入 cgroup，等 hello（≤ 2s）。
4. 转发业务 envelope（默认 15s，envelope 可到 120s；长任务用 `timeout_ms` 显式声明）。
5. 单次调用的 envelope 默认 15s（上限 120s）；单次任务整体硬上限 **30 分钟**：到点发 SIGTERM，10s 未退出发 SIGKILL；返回 `E_UPSTREAM` 并在审计记录 `timeout`。
6. 进程回收：插件主动 `kore.shutdown` 退出、或空闲 60s 由 supervisor 回收；无论成功失败都 `wait` 并清 cgroup 中的 pid，失败时保留退出码与最后 100 行 stderr 到日志。
7. 空闲 RSS 必须为 0：回收后 `pgrep -f '/plugins/<id>/'` 必须无输出，CI/验收按此判定。

oneshot 不参与心跳，不注册 bus 常驻路由；并发 2 是硬上限，调大需要改本文并说明内存峰值。

## 6. 内存优化手段

| 手段 | 具体做法 | 预期收益 |
| --- | --- | --- |
| GOGC | 主壳与插件统一 `GOGC=100`（`GOMEMLIMIT=6MiB`） | 更早回收，压住 8 MiB 空载；代价是 CPU 略高，须同时过空闲 CPU ≤0.1% 门禁 |
| GOMEMLIMIT | 主壳固定 `6MiB`（低于 8 MiB 预算，留运行时余量） | 防止突发分配顶穿 RSS；低于稳定工作集会引发 GC 抖动，按 p95 CPU 复核 |
| 链接裁剪 | `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"` | 去符号表与调试信息，单二进制通常减 25%–35% |
| 静态构建 | `CGO_ENABLED=0`，不引 cgo 依赖 | 无 libc 差异、无额外线程与映射，RSS 更可控 |
| 避免常驻大缓冲 | 帧读写按需分配，单帧上限 8 MiB 但复用 `sync.Pool` 的 4 KiB/64 KiB 档，不预分配 8 MiB | 空载不背峰值内存 |
| 空闲连接释放 | 插件 UDS 连接空闲 5 分钟关闭；HTTP keep-alive 空闲 60s 关闭 | 空闲 fd 与读缓冲回收 |
| 避免全量加载 | 插件列表/任务列表分页，单页 ≤ 50；图片/前端资源不预读 | 列表请求不产生线性内存 |
| 日志不缓存 | 日志直写文件 + 10 MiB 轮转，不在内存攒批量 | 避免日志峰值叠加 |

禁止用「调大 GOGC」这类掩盖式手段达标：预算看 RSS 中位数，且必须同时过空闲 CPU 与 goroutine 门禁。

## 7. 度量与回归门禁

采样口径（CI 与验收共用，M1 起可执行）：

```bash
# 主壳空载 RSS：启动后等 60s 稳定，1 次/秒采 60 个点取中位数（KiB）
pid=$(pidof kored)
for i in $(seq 1 60); do ps -o rss= -p "$pid"; sleep 1; done | sort -n | awk 'NR==30{print $1}'
```

判定阈值：

| 指标 | 通过 | 警告 | 失败（CI fail） |
| --- | --- | --- | --- |
| 主壳空载 RSS 中位数 | ≤ 8192 KiB | 6144–8192 KiB | > 8192 KiB |
| 主壳空闲 CPU（60s `utime+stime` 差值） | ≤ 60 tick | 40–60 tick | > 60 tick |
| 空载 goroutine | ≤ 20 | 16–20 | > 20 |
| 空载 fd | ≤ 64 | 48–64 | > 64 |
| 空载出站连接 | 0 | — | ≥ 1 |
| resident 单插件 | ≤ 12288 KiB | 10240–12288 | > 12288 |
| 常驻合计（含活跃 lazy） | ≤ 24576 KiB | 20480–24576 | > 24576 |
| lazy 空闲退出 | 空闲 300s 后无进程 | — | 300s 后进程仍存活 |
| 插件冷启动 p95 | ≤ 300ms | 200–300ms | > 300ms |
| oneshot 空闲进程 | 无 | — | 有任一进程存活 |
| 插件包 `tar.gz` | ≤ 15,728,640 B | 12–15 MiB | > 15 MiB |
| `kored` 二进制 | ≤ 26,214,400 B | 24,000,000–26,214,400 | > 26,214,400 |
| 前端首屏 gzip | ≤ 307,200 B | 262,144–307,200 | > 307,200 |
| 背景定时器数量 | ≤ 1 且为证书续期 | — | ≥ 2 或存在非白名单定时器 |

CI 规则：`make mem` 与 `make idle` 仅在有 `kored` 时生效（M1 起）；M0 只做静态检查（二进制不存在则跳过并标注 N/A）。每次发版前必须跑一次全量预算核对，任一失败项阻塞 tag。

## 8. 前端体积预算与手段

预算：首屏 HTML + 首屏 JS/CSS 合计 ≤ 300 KiB gzip；首屏图片 ≤ 100 KiB；插件前端资源不计入首屏（按需 `import()` 加载）。

手段：

1. 路由级代码分割：登录页与主壳布局独立 chunk，未访问路由不下载。
2. Element Plus 按需引入（`unplugin-vue-components` + `unplugin-auto-import`），禁止全量 `app.use(ElementPlus)`。
3. 图标用 `unplugin-icons` 内联 SVG，不引 iconfont、不引整套图标库。
4. 字体用系统字体栈，不加载 webfont（中文字体动辄数 MB）。
5. UnoCSS 原子类 + 构建期裁剪，不引 Tailwind 全量预设之外的 UI 框架。
6. 构建后统计：`find web/dist -type f -name '*.js' -o -name '*.css' | xargs gzip -c | wc -c` 仅作总量参考，首屏以入口 chunk 的 gzip 字节为准（`vite build --report` 输出）。
7. 图片：仅登录页允许一张 ≤ 100 KiB 的图，其余用 CSS/内联 SVG。
8. 不引 Pinia（状态用 composables），不引 lodash/moment/dayjs 全量，日期格式化手写 ≤ 30 行。

## 9. 反模式清单

| # | 反模式 | 后果 | 正确做法 |
| --- | --- | --- | --- |
| 1 | 内核里做定时任务（清理、巡检、轮询插件） | 空载即有 CPU/内存开销，且无法解释 | 启动时 + 写路径惰性触发；唯一例外证书续期且可关 |
| 2 | 每个插件一个常驻轮询 goroutine | 插件数线性放大 goroutine 与栈内存 | 统一 10s 心跳循环 + 事件驱动 |
| 3 | 全量加载所有插件前端 | 首屏体积随插件数膨胀 | 安装后原生 `import()` 按需注入 |
| 4 | 日志写 bbolt | 写放大、事务争抢、备份体积暴涨 | 日志只写文件，bbolt 只存状态 |
| 5 | 读帧不设上限（`io.ReadAll`） | 单个恶意/异常插件打爆内存 | 先读 4B 长度，超 8 MiB 直接断开 |
| 6 | 每请求新建 `http.Client` | 连接与缓冲反复分配 | 全局复用 client，空闲 60s 关闭 |
| 7 | 任务历史全量驻留内存 | 运行越久 RSS 越大 | 分页读 bbolt，单页 ≤ 50 |
| 8 | 在 `internal/core` 引入 ORM/连接池 | 依赖膨胀、启动开销上升 | 只用 bbolt + 标准库 |
| 9 | 为每个 SSE 客户端开 goroutine 且不设超时 | 客户端断开后 goroutine 泄漏 | 每连接 context + 30s 写超时 + 断开即回收 |
| 10 | 秒级采集指标并落盘 | 无意义 IO 与磁盘增长 | 只在心跳/请求路径顺带采样，不落盘 |
| 11 | 把所有插件静态资源打进 `web/dist` | 二进制与首屏双膨胀 | 插件资源走 `/plugin-assets/<id>/*` |
| 12 | 热升级时先杀旧进程 | 升级窗口内服务中断 | 新进程 hello 成功后再 shutdown 旧进程 |
| 13 | 用容器/namespace 做隔离 | 引入运行时依赖与常驻开销 | 独立系统用户 + cgroup v2（红线一） |
| 14 | 内存超了先调大预算 | 约束失效，逐步失控 | 先定位分配来源；预算数字只能由 ADR 变更 |
| 15 | 插件启动时建数据库连接池/预连网络 | 冷启动超过 300ms，lazy 唤醒卡顿 | init 只做内存初始化，连接在首次调用时惰性建立 |
| 16 | lazy 插件内部起 ticker 保活 | 空闲永不退出，最终变成常驻 | 内部定时任务交给主壳事件或 oneshot；lazy 只响应调用 |
| 17 | 主壳每 N 秒轮询插件状态 | 空载 CPU 超标，且放大到 N 个插件 | 插件推 `plugin.health`/`plugin.state` 事件；配置变化走 SIGHUP |

## 10. 最小观测集

不引入 Prometheus、不引入 metrics 服务、不引 agent。观测数据只通过 `GET /api/v1/system/info` 返回 JSON：

| 字段 | 类型 | 含义 | 来源 |
| --- | --- | --- | --- |
| `rss_kb` | int | 主壳当前 RSS（KiB） | `/proc/self/status` 的 `VmRSS` |
| `goroutines` | int | 活跃 goroutine 数 | `runtime.NumGoroutine()` |
| `plugins_total` | int | 已安装插件数 | bbolt `plugins` |
| `plugins_ready` | int | ready 状态数 | registry 内存态 |
| `plugins_degraded` | int | degraded 状态数 | registry 内存态 |
| `enforce` | bool | cgroup 是否生效 | 启动探测结果 |
| `timers` | int | 常驻定时器数量（≤ 1） | 启动时登记，用于自检 |
| `uptime_s` | int | 主壳运行秒数 | `time.Since(start)` |
| `schema_version` | int | bbolt schema 版本 | `meta` bucket |

健康检查：`GET /-/healthz` 只返回 `{"ok":true}` 与 HTTP 200，不暴露版本与内部状态；`/system/info` 需登录。前端把 `rss_kb` 与预算并列展示，超预算标红——**观测的目的就是让膨胀无处藏身**。
