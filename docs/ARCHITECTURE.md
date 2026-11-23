> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

# ARCHITECTURE — kore 总体架构

## 0. 文档定位

| 项 | 内容 |
| --- | --- |
| 读者 | implementer / verifier / red-team；评审进程模型与故障域的人 |
| 作用 | 定义组件边界、依赖方向、进程模型、数据流、状态机、故障域与设计权衡 |
| 不作用 | 不写单个模块的字段级规格（见 [CORE.md](./CORE.md)）、不写协议帧细节（由 `PLUGIN-PROTOCOL.md` 承载，本文件只给结论）、不写愿景（见 [VISION.md](./VISION.md)） |
| 上位约束 | 五条红线：不做同进程动态库插件；不引入常驻中间件；主壳不含业务逻辑；不做容器化底座；无账号/联网校验/上报/封锁 |
| 版本基线 | MVP 0.1.0；Go module `github.com/pengtang1024/kore`（仓库归属 `pengtang1024`）；单二进制 `kored`；协议 `kore.plugin.v1` |

本文件所有数字（RSS、超时、退避、帧上限、路径）为**门禁值**，改动必须同步 [CORE.md](./CORE.md) 并落 ADR。术语以 [GLOSSARY.md](./GLOSSARY.md) 为准。

## 1. 架构总览

```
                  ┌────────────────────────────────────────────────────────────┐
                  │ 浏览器  Vue 3 主壳：登录 / 全局布局 / 插件管理中心 / 通用组件 │
                  │ 插件前端 = 标准 ES module，安装后 import() 注入并注册路由菜单 │
                  └──────────────┬─────────────────────────────────────────────┘
     /api/v1/*  HTTP/1.1        │        SSE /api/v1/events
     静态 /  /assets/*  /plugin-assets/<id>/*
                  ┌──────────────▼─────────────────────────────────────────────┐
                  │ kored 主壳：单进程 · 单二进制 · systemd 托管 · 空载 目标8/红线16 MiB│
                  │                                                            │
                  │   httpapi ──► auth ──► registry ──► supervisor ──► bus      │
                  │      │          │          │            │           │       │
                  │      │          └──────────┴──── store(bbolt) ◄─────┘       │
                  │      │                                                     │
                  │   static/embed    config（启动读 + SIGHUP 重载）   logger    │
                  └──────────────┬─────────────────────────────────────────────┘
                                 │ UDS 帧：4 字节大端长度 + JSON
                                 │ kore.plugin.v1 · 单帧 ≤ 8 MiB · hello ≤ 2 s
        ┌────────────────────────┼──────────────────────────────┐
        ▼                        ▼                              ▼
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────────────────┐
│ 常驻插件 site     │   │ 一次性插件 backup     │   │ 旁挂资源（全部文件系统落点）  │
│ 由 supervisor    │   │ 触发才拉起，用完即退   │   │ 配置 /etc/kore/config.yaml    │
│ 常驻并在途可用    │   │                      │   │ 状态 /var/lib/kore/state.db    │
│ 单实例 ≤ 24 MiB  │   │ 空闲 RSS = 0          │   │      /var/lib/kore/plugins/   │
│ socket:          │   │ socket:              │   │      /var/lib/kore/tasks/     │
│ plugins/site.sock│   │ plugins/backup.sock  │   │ 日志 /var/log/kore/kore.log   │
│ 用户 kore-site   │   │ 用户 kore-backup     │   │      /var/log/kore/plugins/   │
└──────────────────┘   └──────────────────────┘   │ 锁   /run/kore/kore.lock      │
                                                  └──────────────────────────────┘
```

> 仓库边界：上半部属 `kore` 仓库；`site` / `backup` 两个框分别属 `kore-plugin-site` / `kore-plugin-backup` 仓库；右侧旁挂资源是运行时数据，不属任何仓库；索引仓库 `kore-plugins` 不参与运行期调用（仅在安装时提供条目与 sha256）。

读图要点：

1. **浏览器只和主壳说话**，永远不直连插件 socket（浏览器拿不到 UDS 权限，也不该拿）。
2. **异步边界只有一处**：主壳 ↔ 插件的帧通道。所有跨进程调用都走 `POST /api/v1/invoke/{plugin}/{method}` 或 `kore.event`。
3. **旁挂资源全部是文件**（无独立 DB/MQ/缓存进程）——红线②的物理体现；一次性插件无触发时**不在进程表里**（RSS=0），这是资源锚点的硬判据。

## 2. 分层与依赖方向

依赖**单向向下**，反向依赖在任何层都不允许（评审即拒）：

| 层 | 位置 | 允许依赖 | 明确禁止 |
| --- | --- | --- | --- |
| L0 协议层 | `pkg/pluginapi/`（公开协议 SDK） | 仅 Go 标准库（`encoding/json`、`encoding/binary`、`errors`） | import `internal/core/*`；import 任何业务包；引入第三方库 |
| L1 内核层 | `internal/core/{httpapi,auth,registry,supervisor,bus,store,config}` | 标准库 + `pkg/pluginapi` + 白名单 3 依赖（`yaml.v3`、`bbolt`、M3 的 `protobuf`） | import `plugins/**`；Web 框架；SQL/ORM；gRPC/NATS/Redis/容器 SDK |
| L2 壳层 | `cmd/kored/` | `internal/core/*`、`pkg/pluginapi`、标准库 | 业务逻辑；直接读写 `state.db` 表结构（必须经 store） |
| L3 插件层 | 独立仓库 `kore-plugin-<id>/`（各自独立 `go.mod`） | `github.com/pengtang1024/kore/pkg/pluginapi`（tag 依赖，协议类型与帧编解码）+ 标准库 + 插件自选依赖 | import `internal/*`（Go 不可见）；import 其他插件；共享进程内存 |
| L4 前端 | `web/`（Vue 3 + Vite + TS） | 仅 HTTP API `/api/v1/*` 与静态资源 | import Go 包；直接访问文件系统；绕过 auth 拿数据 |

插件如何复用协议类型（M1 必须按此落地）：插件仓库的 `go.mod` 声明 `module github.com/pengtang1024/kore-plugin-<id>`，`require github.com/pengtang1024/kore vX.Y.Z`（**tag 依赖**），只导入 `github.com/pengtang1024/kore/pkg/pluginapi`。协议包放在 `pkg/` 而不是 `internal/`，是因为 Go 的 `internal` 规则让外部 module **编译期就无法导入**——协议包留在 `internal/` 等于插件永远接不进来。

公开性约束：`pkg/pluginapi` 只允许标准库依赖，不得 import `internal/*`；任何破坏性改动按 R2 走 kore 主版本递增 + ADR + 索引标记不兼容。

### 2.1 仓库边界与依赖方向

R1（依赖单向）在物理层的体现，三条边界不可跨越：

```
kore-plugin-<id> ──require github.com/pengtang1024/kore vX.Y.Z──► kore/pkg/pluginapi
kore-plugin-<id> ──release tar.gz + sha256──► kore-plugins（索引只读，不代管包）
kore             ──✗ 不 import 任何 kore-plugin-* ─────────────► 插件仓库
```

- **插件只能 import `pkg/pluginapi`**（`pkg/` 公开、`internal/` 对外部 module 不可见，Go 可见性即 R1 执行者）；**kore 反向核对**：`go list -deps ./cmd/kored | grep -c 'kore-plugin-'` 为 0，`grep -rn 'kore-plugin-' internal/ cmd/` 零命中。
- **索引只读**：`kore-plugins` 只聚发布物、不回写插件仓库；kore 运行期不访问索引（详见 [REPOS.md](./REPOS.md) §2–§3）。

### 2.2 `internal/platform` 五接口（core 不得直接调用 `syscall`/`os/signal` 平台专有部分，必须经此层）

- `paths`：配置/状态/运行/日志四类目录的唯一来源（Linux `/etc/kore`+`/var/lib/kore`；Windows `%ProgramData%\kore`；macOS `/usr/local/etc/kore`+`/usr/local/var/lib/kore`）。
- `service`：服务注册与自启（systemd unit / SCM / launchd plist 的安装、卸载、查询）。
- `signals`：停止信号归一化（`SIGTERM` / console control event / launchd `SIGTERM`）→ 统一 `context` cancel。
- `resource`：资源后端（cgroup v2 / Job Objects / 仅观测），供 supervisor 建限额。
- `transport`：UDS 建连与对端身份（`SO_PEERCRED` / `LOCAL_PEERCRED` / Windows 无 → hello HMAC）。**空实现界线（M1）**：允许 `!linux` 构建标签下 `New()` 返回 `ErrUnsupported` 的桩（≤5 行，只为交叉编译通过）；**禁止**更宽的空壳（有方法体但不工作、返回值假成功）——判据一句话：桩只允许存在到"能编译"，不允许存在到"看起来能用"。

## 3. 进程模型

| 维度 | 主壳 `kored` | 常驻（`resident`） | 惰性（`lazy`，默认） | 一次性（`oneshot`） |
| --- | --- | --- | --- | --- |
| 生命周期 | systemd 托管，常驻 | 跟随 enable 常驻；热升级新旧短暂共存 | 调用拉起 → 空闲 300 s 退出 → RSS 归 0 | 触发拉起 → 执行 → 立即退出 |
| 实例数 | 单实例（flock 保证） | 每插件 1 个，**同时 ≤3 个** | 每插件 1 个（按需），不计入常驻配额 | 同一插件同一时刻 ≤ 1 个（串行队列） |
| 内存预算 | 空载 **目标 ≤8 MiB / 红线 ≤16 MiB**（`GOGC=50` + `GOMEMLIMIT=6MiB`） | 单 ≤ 12 MiB；**推荐 2 个/16 MiB**，上限 3 个/24 MiB | 峰值 ≤ 12 MiB；空闲 0 | 峰值 ≤ 16 MiB；空闲 0 |
| 运行用户 | root（M3 起收窄 capabilities） | `kore-<id>` 系统用户 | 同左 | 同左 |
| 隔离手段 | systemd unit + 单实例锁 | cgroup v2 `/sys/fs/cgroup/kore/<id>.slice` | 同左，退出即释放 | 同左，退出即释放 |
| socket | `/run/kore/kore.sock`（可选 `127.0.0.1:8787`） | `/run/kore/plugins/<id>.sock` | 同左，退出后清理 | 同左，退出后清理 |
| 失败域 | 全部功能不可用（systemd 拉起） | 仅该插件能力不可用 | 仅该次调用失败（`E_UPSTREAM`） | 仅本次任务失败（`E_UPSTREAM`） |
| 重启策略 | `Restart=on-failure` + `RestartSec=2` | 退避 1/2/4/8/16/32/60 s；10 分钟 5 次 `failed` | 冷启动失败按退避重试，超限 `failed` | 不自动重启，等下次触发 |
| 冷启动 | — | — | **p95 ≤ 300 ms**（进程 exec + hello） | p95 ≤ 300 ms |
| 崩溃可见性 | `/-/healthz` 连不上 | 该插件 `degraded/failed` | 该插件 `failed`，其它不受影响 | 本次调用 502 + `detail` 指向日志 |

**为什么主壳是 root、插件是低权用户**：主壳要创建 `kore-<id>` 系统用户、写 cgroup 文件、bind `/run/kore/` 下的 socket；插件只需要连自己的 socket、读自己的状态目录。权限不对称是隔离的前提——任一插件拿到 root 就等于隔离失效。M3 起主壳收窄为最小 capability 集（`CAP_SETUID`、`CAP_SETGID`、`CAP_SYS_ADMIN` 仅 cgroup 操作需要，视内核实现细化为 DAC 读写），并写 ADR 记录。

### 3.1 lazy 激活与常驻配额

| 问题 | 规则 |
| --- | --- |
| 谁唤醒 lazy | 四种：① bus 转发调用前查 supervisor，未运行 → 冷启动并**排队**（上限 32，超限 `E_RATELIMIT`）；② 事件订阅命中；③ 显式 `enable`；④ **宿主调度器触发**——`cron` 插件写入的 `systemd timer` / `/etc/cron.d/kore-*` / launchd / Task Scheduler 到点调用 `kored invoke <plugin> <method>`，主壳自身**无 ticker** |
| 空闲判定 | supervisor 记 `last_used_at`；空闲满 **300 s** 进入 drain：停接新调用 → 等在途 ≤2 s → `kore.shutdown` → 5 s → `SIGKILL` |
| 冷启动互斥 | 同一插件同时只允许 1 次 cold start，其余请求并入等待队列；hello 失败则整队返回 `E_UPSTREAM` |
| 配额（resident） | **默认 ≤2 个（`site`+`monitor`，16 MiB，`resources.resident_max=2`）**；总数硬上限 3（resident + 活跃 lazy）、合计 ≤24 MiB、单个 ≤12 MiB。**第 3 个 resident 启用直接拒绝**（`E_RATELIMIT` + 当前 resident 列表），resident **不自动踢人**；lazy 至少保留 1 槽 |
| 配额（lazy/oneshot） | 不计入常驻配额；但并发冷启动总数 ≤4（防止一次点开 20 个页面把机器打满） |
| 低配降级 | `resources.profile=compact` 时常驻配额降为 1、合计 ≤12 MiB（见 [COMPATIBILITY.md](./COMPATIBILITY.md) §7） |
| **M1 范围** | `lifecycle` 三值（`resident`/`lazy`/`oneshot`）解析、校验并落盘；**运行期只实现 `resident`**，遇 `lazy`/`oneshot` 返回 `E_UNSUPPORTED` + message 写明"M2 支持"——契约先定型、能力后补齐，不允许 M1 出现半成品 lazy |

## 4. 组件职责

`internal/core` 7 个子包 + 公开的 `pkg/pluginapi`，一行一职责一禁止。中文名与包名对照：注册表（registry）、监督器（supervisor）、总线（bus）、配置（config）、存储（store）、鉴权（auth）、HTTP 入口（httpapi）。

| 组件 | 单一职责 | 明确禁止 |
| --- | --- | --- |
| `internal/core/httpapi` | HTTP/SSE 入口、路由、中间件链、静态与插件资源托管 | 写业务逻辑；直接操作 bbolt；直接 spawn 进程 |
| `internal/core/auth` | 单用户口令校验、会话签发/校验/注销、登录限速 | 多租户/RBAC；第三方 OAuth；把会话写入内存 Map 而不落 store |
| `internal/core/registry` | 插件包解析、`info.json` 校验、安装/卸载/enable/disable 状态持久化 | 启动进程；调用插件方法；理解插件业务语义 |
| `internal/core/supervisor` | 插件进程生命周期：拉起、健康检查、退避重启、优雅停止、热升级、孤儿清理 | 处理 HTTP；解析业务参数；写插件业务数据 |
| `internal/core/bus` | 帧编解码、请求-响应关联、超时、事件分发、SSE 订阅扇出 | 业务路由决策；持久化消息；重试业务失败 |
| `internal/core/store` | bbolt 打开/关闭/bucket 定义、事务封装、schema 版本迁移 | 暴露 SQL；存业务数据；跨 bucket 长事务 |
| `internal/core/config` | 默认值、YAML 解析、字段校验、SIGHUP 热重载白名单 | 热更不可热更字段；静默忽略未知字段（必须报错） |
| `pkg/pluginapi` | 协议类型（hello/ping/shutdown/reload + `kore.event` 事件通道）、错误码、帧编解码、限长校验；对外公开 SDK | 依赖 core；含业务方法；引入第三方库 |

## 5. 三条关键数据流

> 协议防漂：帧布局、方法名、错误码、超时、心跳与次版本协商等参数，以 `docs/PLUGIN-PROTOCOL.md` 为唯一数值源；本文件只引用结论、不复述参数。帧类型与编码协商的决策记录见 [ADR-0007](./DECISIONS/0007-frame-type-and-encoding-negotiation.md)。

### 5.1 HTTP 同步调用插件

```
浏览器 ──POST /api/v1/invoke/site/site.status──► httpapi
  1. 中间件链：req_id → recover → access_log → body_limit → auth → csrf → rate_limit → router
  2. 路由解析：plugin=site，method=site.status；保留前缀 kore.* 一律拒绝（400 E_INVALID）
  3. registry 校验：插件已安装且 enabled，否则 404 E_NOTFOUND / 409 E_CONFLICT
  4. supervisor 确保就绪：resident 未 ready 则等待（≤ 3 s），oneshot 则拉起（hello ≤ 2 s）
  5. bus 分配请求 id（16 字节随机 hex），组帧写入 /run/kore/plugins/site.sock
  6. 插件回帧 {id, result} 或 {id, error}；bus 按 id 唤醒等待方
  7. httpapi 映射：result → 200，error.code → HTTP 状态（表见 CORE §3）；access_log 记 plugin/method/dur_ms/err_code（不记正文）
超时：单次调用默认 15 s（协议值，见 `PLUGIN-PROTOCOL.md`；envelope 可覆盖至 120 s）；超时返回 504 + E_UPSTREAM
```

### 5.2 SSE 事件推送

```
插件 ──kore.event{type,data}──► bus ──扇出──► httpapi.GET /api/v1/events
  1. 插件侧 kore.event 为单向通知，不期待响应；主壳收到后补 event id（单调递增 uint64）
  2. bus 写入内存环形缓冲（最近 256 条，进程重启即丢，不做持久化）
  3. 每个已登录会话最多 1 条 SSE 连接；全局并发上限 64，超出 429 E_RATELIMIT
  4. 帧格式：`id: <n>` + `event: <type>` + `data: <json>` + 空行；心跳 `: ping` 每 15 s
  5. 断线重连：浏览器带 Last-Event-ID，bus 从环形缓冲补发 id > Last-Event-ID 的事件；缺口则发 `event: resync`
  6. 内核关闭时向所有连接发 `event: shutdown`，随后关闭连接（不等待客户端确认）
禁止：事件持久化、事件重放超过 256 条、跨进程可靠投递承诺
```

### 5.3 一次性插件触发与回收

```
触发源（三选一）：info.json triggers[] 的 cron ──│
                  POST /api/v1/invoke/{plugin}/{method} ──► supervisor.Ensure(plugin)
                  bus 事件订阅命中
  1. registry 读 info.json 的 type=oneshot 与 triggers[]
  2. supervisor 建 cgroup slice（/sys/fs/cgroup/kore/<id>.slice）→ 以 kore-<id> 身份 exec bin/<id>
  3. 主壳作为 server 持有 /run/kore/plugins/<id>.sock；插件 connect 后 2 s 内必须发 kore.hello
  4. hello 校验 id/version/protocol/capabilities ⊂ 白名单；失败 → SIGKILL + 状态 failed
  5. 执行期：单次调用默认 15 s（上限 120 s）；插件可主动 kore.shutdown 退出，或空闲 60 s 被回收
  6. 退出后：waitpid 回收、删 socket、写任务记录到 /var/lib/kore/tasks/<id>/<ts>.json（保留 7 天）；500 ms 内进程必须从进程表消失（`pgrep` 为 0），cgroup 目录删除
```

## 6. 启动引导与优雅关闭

### 6.1 启动顺序（严格串行，任一步失败即退出并给退出码）

| # | 步骤 | 失败处理 |
| --- | --- | --- |
| 1 | 解析 flag 与 env（`KORE_CONFIG`、`KORE_STATE_DIR`） | 参数非法 → stderr + 退出码 2 |
| 2 | 读 `/etc/kore/config.yaml`（缺失用内置默认 + WARN）；随后执行**环境探测 `envprobe`**（状态目录尚未创建时取最近存在祖先的挂载点判定）→ **平台适配**（`internal/platform` 绑定 paths/service/signals/resource/transport）→ **服务注册判定**（systemd/SCM/launchd 是否存在）→ 判定硬/软要求 → 硬失败即退出 | YAML 解析失败/未知字段 → 退出码 2；**硬要求不满足 → 退出码 6** |
| 3 | 确保 `/var/lib/kore`（0700）、`/var/lib/kore/plugins`、`/var/lib/kore/tasks` 存在 | 无权限 → 退出码 3 |
| 4 | `flock /run/kore/kore.lock`（`LOCK_EX\|LOCK_NB`），写入 pid | 已被占用 → 退出码 3，提示持有者 pid |
| 5 | 初始化 logger（`/var/log/kore/kore.log`，启动期同时 stderr） | 打不开 → 退出码 4 |
| 6 | 打开 bbolt `/var/lib/kore/state.db`（0600，`Timeout=1s`），建 6 个 bucket：`meta` / `plugins` / `plugin_state` / `tasks` / `sessions` / `audit`（单管理员无用户表，鉴权凭据来自 `config.yaml` 的 `auth.admin_password_hash`），校验 schema 版本 | 打不开/版本更高 → 退出码 4 |
| 7 | 孤儿清理：扫 `/var/lib/kore/plugins/*/run.json`，按 pid + `/proc/<pid>/stat` starttime 核对 | 无法核对 → 只删 socket，不动进程 |
| 8 | bind `/run/kore/kore.sock`（先 unlink 旧文件，`umask 0077`）；按配置可选 bind `127.0.0.1:8787` | bind 失败 → 退出码 5 |
| 9 | registry 从 bucket 加载已安装清单与 enable 状态 | 单条清单损坏 → 标记该插件 failed，不阻塞启动 |
| 10 | supervisor 并发拉起所有 enabled 的 resident 插件（各自 hello ≤ 2 s） | 单个失败 → 该插件 degraded/failed，主壳继续 |
| 11 | 启动 httpapi（中间件链 + embed 静态 + SSE），就绪后写 INFO `kore ready`（pid/socket/版本/插件数），`/-/healthz` 返回 200 | httpapi 失败 → 退出码 5 |

退出码码表：**2** 配置（解析/校验/必填）、**3** 状态目录或单实例锁、**4** 存储（bbolt / 日志文件 / schema）、**5** 监听绑定或 HTTP 服务启动、**6** 环境硬要求不满足（架构不支持 / 内核 < 4.18 / 状态目录文件系统不支持）。探测项、发行版矩阵与降级行为见 [COMPATIBILITY.md](./COMPATIBILITY.md) §5–§7，本文件只写流程、不复述矩阵。

### 6.2 优雅关闭（启动的严格逆序）

| # | 步骤 | 时限 |
| --- | --- | --- |
| 1 | httpapi 停止接受新连接；向全部 SSE 连接发 `event: shutdown` | ≤ 100 ms |
| 2 | 等在途 HTTP 请求结束（`http.Server.Shutdown`） | ≤ 5 s |
| 3 | 停止 cron 触发与新的 oneshot 拉起；bus 拒绝新调用 | 立即 |
| 4 | 对 resident 插件并发发 `kore.shutdown`，等其自退；超时 5 s → `SIGKILL`（**不发 `SIGTERM`**，主壳不直接调 `syscall.SIGTERM`，G-16） | ≤ 5 s |
| 5 | 关闭 bus（在途 `E_UPSTREAM`）→ 关闭 bbolt（等 fsync）→ unlink 两个 socket → 释放 flock（不删锁文件），退出码 0 | ≤ 5 s |

总自限 ≤ 12 s；systemd `TimeoutStopSec=15` 兜底（见 [CORE.md](./CORE.md) §7）。

## 7. 插件状态机

```
                    ┌───────────┐  POST /plugins（安装成功）
                    │ installed │◄──────────────────────────────
                    └─────┬─────┘
             enable       │        uninstall（先 stop，再删包与状态）
                    ┌─────▼─────┐ ─────────────────────────────► ┌─────────┐
                    │  enabled  │                              │ stopped │
                    └─────┬─────┘ ◄──────────────────────────── └─────────┘
        supervisor 拉起    │        disable / 手动 stop              ▲
                    ┌─────▼─────┐                                      │
                    │ starting  │──hello 超时(2s)/校验失败──► failed   │
                    └─────┬─────┘                              │       │
        hello ok          │                                    │       │
                    ┌─────▼─────┐  ping 连续 3 次超时(2s/次)    │       │
                    │   ready   │──────────────────────► ┌──────┴────┐ │
                    └─────┬─────┘                        │ degraded  │ │
        kore.shutdown     │                              └──────┬────┘ │
        (无 SIGTERM)      │                     ping 恢复 / 重启成功│      │
                    ┌─────▼─────┐ ◄────────────────────────────┘      │
                    │ stopping  │────5s→SIGKILL（无 SIGTERM）──────────►┘
                    └───────────┘
```

状态转移表（触发条件以事件为准，不以时间猜测）：

| 当前 | 事件 | 目标 | 条件 / 动作 |
| --- | --- | --- | --- |
| installed | enable | enabled | `info.json` 校验通过、capabilities 在白名单内、包签名存在则校验（M4 强校验） |
| installed | uninstall | stopped | 直接删包与状态，不发进程信号（无进程） |
| enabled | supervisor.Start | starting | 建 cgroup、exec `bin/<id>`、主壳持 socket |
| starting | hello 成功 | ready | 2 s 内收到 hello，id/version/protocol 与清单一致，capabilities 为清单子集 |
| starting | hello 超时 / 校验失败 | failed | SIGKILL，记 `failed_reason`，10 分钟内不自动重试 |
| ready | ping 连续 3 次超时 | degraded | 暂停新调用路由到该插件（返回 503 E_UPSTREAM），继续探测 |
| degraded | ping 恢复 | ready | 恢复路由，计数器清零 |
| degraded | 重启成功（or 60 s 内无任何成功响应，≈连续 6 次 ping 失败） | ready / starting | 退避重启；成功即 ready，失败进 failed |
| ready/degraded | disable / stop | stopping | 停止路由，发 `kore.shutdown` |
| stopping | 进程退出 | stopped | 清理 socket、cgroup、run.json |
| stopping | 5 s 未退出 | stopping | SIGKILL，随后 stopped（记 `killed=true`） |
| failed | 手动 enable / 重新安装 | starting | 清退避计数与 failed_reason |

## 8. 故障域分析

| 谁崩 | 影响谁 | 恢复手段 | 用户可见性 |
| --- | --- | --- | --- |
| 主壳 panic/OOM | 全部 HTTP 与插件调用；resident 插件成为孤儿 | systemd `Restart=on-failure` 拉起；启动时按 run.json 清孤儿 | 页面 502/连接拒绝 ≤ `RestartSec=2` + 启动耗时；`healthz` 恢复即正常 |
| 单个 resident 插件崩 | 仅该插件能力；其他插件与内核不受影响 | supervisor 退避重启（1/2/4/8/16/32/60 s） | 插件中心该行 `degraded→ready`；调用方收到 503 + E_UPSTREAM |
| resident 插件 OOM（cgroup 超限） | 该插件进程被内核 kill | 同上；`info.json.resources.memory_mb` 决定天花板 | 状态 `failed`，`detail` 指向 `/var/log/kore/plugins/<id>.log` |
| oneshot 插件崩/超时 | 仅本次任务 | 不自动重启，任务记录标失败；下次触发重新拉起 | 本次调用 502 + E_UPSTREAM；任务列表出现失败记录 |
| 插件死循环占满 CPU | 该 cgroup 受限，主壳与其他插件不受影响 | `cpu_quota` 限流；red-team 需验证主壳调度不被拖慢 | 该插件响应变慢，其他功能正常 |
| bbolt 文件损坏 | 主壳无法启动（store 打不开） | 退出码 4；从 `/var/lib/kore/state.db.bak` 恢复或重装（配置与插件包仍在） | 服务不可用，日志给出损坏页与恢复指引 |
| 磁盘写满 / `/run` 被清理 | 日志停写、bbolt 事务失败、安装失败 / socket 丢失 | 写操作 507 语义 + `healthz` 仍 200；socket 启动即重建 | 安装失败但只读可用；重启后自动恢复 |
| SSE 客户端断开 | 无影响（仅该连接） | 客户端带 Last-Event-ID 重连，缓冲补发 | 前端自动重连，缺口时 `resync` 全量刷新 |
| 会话存储不可写 | 新登录失败，已登录会话仍可用（内存态未持久化部分） | 返回 500 E_INTERNAL；修复磁盘后恢复 | 登录页报错，既有页面在会话过期前可用 |

## 9. 扩展点清单

### 9.1 新增插件（不需要 ADR，只有前置条件）

| # | 前置条件 | 检查方式 |
| --- | --- | --- |
| 1 | 包结构符合 `<id>-<version>.tar.gz`，内含 `info.json` + `bin/<id>` + `web/`（可选）+ `signature`（可选） | 安装时 registry 校验 |
| 2 | `info.json` 12 个必填字段齐全且取值合法（见 CORE §registry） | 安装时 schema 校验，失败返回 400 E_INVALID |
| 3 | capabilities 合法：**6 个特权能力**（`system:read` `system:admin` `net:read` `net:write` `proc:read` `proc:write`，内核唯一认识、固定不可扩展）+ 插件自有 `<plugin-id>:<action>`（**域必须等于插件 id**）；**非空（≥1 项、≤16 项）**；重复 / 超限 / 语法非法 → 400 `E_INVALID`。内核**不维护业务域名词表** | registry 语法 + 域匹配 + 数量校验 |
| 4 | 只用 **4 个必选方法（`kore.hello`/`kore.ping`/`kore.shutdown`/`kore.reload`）+ 1 条必选事件通道（`kore.event`，单向）**，加自己的 `<plugin>.<verb>`；不占用 `kore.*` 保留名 | verifier 抓帧 + 契约测试 |
| 5 | 资源声明与实测一致（`memory_mb`/`cpu_quota`/`pids_max`） | `make mem` + cgroup 读数 |

### 9.2 新增内核能力（必须 ADR，且同时满足 6 条）

| # | 约束 | 不满足的后果 |
| --- | --- | --- |
| 1 | 不得含业务语义（业务词表见 CORE §9） | 直接拒绝，改由插件实现 |
| 2 | 不得新增直接依赖（白名单 3 个已封顶） | 拒绝，或先走 ADR 改白名单（需 red-team 评估体积/攻击面） |
| 3 | 不得突破资源预算（空载红线 ≤16 MiB、目标 8 MiB，二进制 ≤ 25 MiB） | 拒绝，除非同 ADR 内给出替换/削减方案 |
| 4 | 不得引入常驻进程/端口/中间件；必须给出失败域与回滚路径（关掉即恢复旧行为） | 踩红线②直接拒绝；不允许"只能前进"的设计 |
| 6 | 必须同步 [CORE.md](./CORE.md)、[ARCHITECTURE.md](./ARCHITECTURE.md) 与 ADR | 文档不一致不得合并 |

ADR 文件命名 `docs/DECISIONS/<4 位序号>-<kebab-slug>.md`（如 `0002-uds-length-prefix-json.md`），必含 6 节：背景 / 决策 / 备选方案对比 / 后果（含失败域）/ 验证方式 / 复审条件。

## 10. 目录布局

| 路径 | 作用 | 归属 | M0 状态 |
| --- | --- | --- | --- |
| `cmd/kored/` | 主壳入口 `main.go`：装配 config/store/registry/supervisor/bus/httpapi，不写业务 | 内核 | 空骨架 |
| `internal/core/{httpapi,auth,registry}` | HTTP/中间件/SSE；单用户会话与限速；插件清单与安装状态 | 内核 | 空骨架 |
| `internal/core/{supervisor,bus,store,config}` | 进程与 lazy 配额；帧路由；bbolt 封装；配置与 SIGHUP 重载 | 内核 | 空骨架 |
| `pkg/pluginapi/` | 协议类型 + 帧编解码（**公开 SDK**，插件仓库唯一可依赖的 kore 包） | 协议 | 空骨架 |
| `internal/platform/` | 五接口：paths / service / signals / resource / transport（唯一的平台专有代码落点） | 内核 | 空骨架 |

| `web/` | Vue 3 + Vite + TS 主壳源码；`web/dist` 经 `//go:embed` 编入二进制 | 前端 | 空骨架 |
| `docs/`、`docs/DECISIONS/` | 契约文档（本文件所在）与 ADR（备选对比、后果、复审条件） | 全员 / architect | 本批 + 领域文档；ADR 目录已建 |

| `Makefile`、`scripts/`、`.gitignore` / `.editorconfig` / `AGENTS.md` / `README.md` | 门禁入口与脚本（不参与运行期）+ 协作入口与工程约定 | 全员 | 骨架 |

插件**不在本仓库**：`site` / `backup` 分别是独立仓库 `kore-plugin-site` / `kore-plugin-backup`，索引在 `kore-plugins`；kore 只提供 `pkg/pluginapi` 与安装/运行机制（见 [REPOS.md](./REPOS.md)）。`kored` 的 CLI 子命令（serve / db dump / backup / restore / invoke / version）见 [CORE.md](./CORE.md) §10。

运行时落点（与目录布局区分）：配置 `/etc/kore/config.yaml`；状态 `/var/lib/kore/{state.db,plugins,tasks}`；socket `/run/kore/kore.sock` 与 `/run/kore/plugins/<id>.sock`；日志 `/var/log/kore/kore.log` 与 `/var/log/kore/plugins/<id>.log`；锁 `/run/kore/kore.lock`。

## 11. 设计权衡

每条给"选 A，因为 B 的代价是 C"，并给复审条件。权衡不是一次性正确，是可被证据推翻的假设。

### 11.1 进程 vs 库

**选独立进程，因为动态库的代价是**：任一插件 panic 直接打穿主壳；cgroup 无法按插件限资源；热升级必然重启内核；插件依赖冲突变成内核依赖冲突。代价是每次调用多一次 UDS 往返（实测目标 P95 ≤ 5 ms，M1 用 echo 插件量化）。
复审条件：若 M2 实测高频调用（> 200 QPS）下 UDS 往返成为瓶颈且无法用批量接口缓解，才考虑同进程方案——但那等于推翻红线①，需 ADR + 蓝军双评审；当前不预优化。

### 11.2 UDS vs TCP

**选 UDS 为主、`127.0.0.1:8787` 为可选，因为 TCP 的代价是**：必须引入第二套鉴权（否则本机任意用户可调）；暴露面从文件权限变成网络端口；多机场景才需要 TCP，而集群是非目标。UDS 用文件系统权限即可完成鉴权：`/run/kore` 0700 root:root、`kore.sock` 0600 root:root（0700 目录下组权限无意义，文件权限即边界），零握手成本。复审条件：若用户需要"远程浏览器直连"且拒绝 SSH 隧道，再评估默认关闭的显式开关，并同步 SECURITY 文档与限速策略。

### 11.3 JSON vs protobuf

**MVP 选 JSON（前置 4 字节大端长度），因为 protobuf 的代价是**：M0/M1 就要引入 `.proto` 文件、codegen 流程与版本兼容规则；调试时不能 `xxd` 直接看帧；第三方插件接入门槛从"写 JSON"变成"跑 codegen"。JSON 的代价是体积与解析开销（8 MiB 帧上限正是为此设的硬顶）。复审条件：若未来需要在不重建连接的前提下切换编码，或需要支持非 JSON 的零协商快速路径，再评估扩展帧头——届时必须开新 ADR 并同步 ADR-0002 / ADR-0007。帧结构恒为 `4B 长度 + 载荷`（MVP 载荷为 JSON，M3 由 `kore.hello` 的 `encoding` 会话级协商切换），帧头不承载任何编码信息。

### 11.4 embed vs 独立静态服务

**选 `//go:embed web/dist`，因为独立静态服务的代价是**：多一个进程/端口/部署单元，破"单二进制 ≤ 25 MiB"的交付形态；用户要管两处升级；静态服务崩溃时页面 404 但 API 正常，故障域反而更碎。embed 的代价是前端改动必须重新编译二进制（M2 前端迭代期用 `vite dev` + 反代绕过，仅开发期）。复审条件：若前端产物导致二进制 > 25 MiB 且压缩无法收敛，改为可选外置 `web/dist` 目录（优先级低于 embed），并写 ADR。

### 11.5 bbolt vs SQLite

**选 bbolt，因为 SQLite 的代价是**：`mattn/go-sqlite3` 需要 cgo（破 `CGO_ENABLED=0` 单二进制），纯 Go 实现（`modernc.org/sqlite`）体积远超预算且直接违反依赖白名单；而 kore 的持久化只有 6 个 bucket（`meta/plugins/plugin_state/tasks/sessions/audit`，无 `users`：单管理员凭据来自配置，用户表是多余抽象）、无联表查询、单写者串行化，B+ 树 KV 足够。bbolt 的代价是没有 SQL 查询能力，统计类需求要靠遍历（数据量在千级以内可接受）。
复审条件：若 store 出现"多条件范围查询且数据 > 10 万条"的真实需求，先评估内存索引，仍不够再 ADR 讨论换存储（须同时改依赖白名单）。

## 12. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| [VISION.md](./VISION.md) | 本文件的上位目标：五锚点与成功判据，冲突时以 VISION 为准 |
| [CORE.md](./CORE.md) | 本文件的模块级展开：中间件链、supervisor 退避参数、配置热更边界、systemd unit |
| [GLOSSARY.md](./GLOSSARY.md) | 本文件术语与命名约定的唯一解释 |

> 架构不是画得好看，是**崩溃时知道谁会死、升级时知道谁要重启、加功能时知道该往哪放**。这三点答不上来，图就是装饰。
