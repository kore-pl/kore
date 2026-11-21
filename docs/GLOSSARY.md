> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

# GLOSSARY — 术语表与命名约定

## 0. 使用方式

| 缩写 | 指代 |
| --- | --- |
| V | [VISION.md](./VISION.md) |
| A | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| C | [CORE.md](./CORE.md) |
| G | 本文档 |
| R | [REPOS.md](./REPOS.md) |
| X | 项目协作入口 `AGENTS.md`（角色与门禁名） |

「出现文档」列按**概念**计：中文术语或其英文名（如 注册表 / `registry`、监督器 / `supervisor`、蓝军 / `red-team`）在该文档中被定义或反复使用即计入。只列定义或主用文档，不追求穷举。

规则三条：

1. **一份术语只有一种写法**。文档、代码、commit、任务卡必须用本表"术语"列的写法；英文列给代码与日志用。
2. **易混淆点必须读**。"插件包"和"插件清单"混用会导致 registry 验收标准漂移，这类事故比写错数字更难查。
3. **新术语进表才能用**。任何文档引入本表之外的概念名，先加一行再引用；禁止"先写后补"。

## 1. 术语表

| 术语 | 英文 | 一句话定义 | 出现文档 | 易混淆点 |
| --- | --- | --- | --- | --- |
| 内核 | kernel | 只定规则（插件生命周期/权限校验/消息路由/资源隔离）、不含任何运维功能的调度层 | V·A·C | 常被误当成"包含插件的整体"；整体叫 kore，内核只是 `internal/core` + `cmd/kored` |
| 薄壳内核 | thin kernel | 对内核形态的强调：薄到新增功能不需要改它 | V | 不是"功能少"，是"职责少"；插件可以很多 |
| 主壳 | main shell / kored | 内核的可执行实体，单进程单二进制，systemd 托管 | V·A·C | 与"内核"近义但主壳强调**进程**，内核强调**代码边界** |
| 惰性插件 | lazy plugin | `lifecycle: lazy`（**默认**）：调用即拉起、空闲 300 s 退出，冷启动 p95 ≤300 ms | A·C·R | 不是 oneshot：lazy 复用 300 s 窗口；也不是 resident：不占常驻配额 |
| 常驻配额 | resident quota | 同时运行的 resident 插件上限：3 个 / 合计 ≤24 MiB / 单个 ≤12 MiB | A·C | 不是"装了几个"，是"同时启用了几个"；超限拒绝启用而非自动踢人 |
| 插件 | plugin | 以独立进程存在、通过协议向主壳提供能力的可安装单元 | V·A·C | 不是 Go plugin 动态库；红线①禁止同进程加载 |
| 插件仓库 | plugin repo (`kore-plugin-<id>`) | 每个插件一个独立 git 仓库，module 为 `github.com/kore-project/kore-plugin-<id>`，只依赖 kore 的 `pkg/pluginapi` | V·A·R | 不是 kore 的 `plugins/` 子目录（该旧拓扑已作废）；也不是 mono-repo 的一个 package |
| 索引仓库 | index repo (`kore-plugins`) | 纯静态聚合仓库：`index/plugins.json` + 校验脚本，只读插件发布物，不代管包、无审核、无账号 | A·R | 不是市场后端；没有上传接口、没有用户体系、运行期不被 kore 访问 |
| 协议 SDK | protocol SDK (`pkg/pluginapi`) | kore 对外公开的协议包（帧编解码/消息类型/错误码），插件仓库唯一可依赖的 kore 包 | V·A·C·R | 不是 `internal/` 下的私有包；放 `internal/` 会让外部 module 编译期无法导入 |
| 项目名 | kore | 项目 / 仓库 / Go module 名，全小写；不用于进程名与服务名 | V·A·C·G | 不是二进制名；进程与二进制是 `kored` |
| 守护进程名 | kored | 主壳二进制与进程名：入口 `cmd/kored`，产物 `bin/kored` | A·C·G | 不是 systemd unit 名；unit 是 `kore.service` |
| systemd 单元 | kore.service | 托管 `kored` 的 unit，`ExecStart=/usr/local/bin/kored` | C·G | 插件不注册 systemd unit，由内核 supervisor 拉起 |
| 生命周期 | lifecycle | 插件生命周期三态：`resident`（常驻，占配额）/ `lazy`（默认，调用即起、空闲 300 s 退）/ `oneshot`（用完即退）；`info.json` 用 `lifecycle` 字段，**旧字段名已废弃且不保留别名** | A·C·R | 不是运行期状态（那是 installed/enabled/ready…）；lifecycle 是安装时就固定的形态 |
| 常驻插件 | resident plugin | `lifecycle: resident`，enable 后进程常驻，随时可调用（如 site） | V·A·C | 常驻≠无限资源：单插件 ≤ 12 MiB，且同时常驻 ≤3 个 |
| 一次性插件 | oneshot plugin | `lifecycle: oneshot`，触发才拉起、执行完退出，空闲 RSS = 0（如 backup） | V·A·C | 空闲为 0 指**进程不存在**，不是"内存占用很小" |
| 插件包 | plugin package | 分发单元 `<id>-<version>.tar.gz`，含 `info.json` + `bin/<id>` + `web/` + 可选 `signature` | V·A·C | 与"插件清单"混用；包是 tar.gz，清单是包内的 info.json |
| 插件清单 | manifest (`info.json`) | 包内声明文件：id/name/version/protocol/lifecycle/entry/capabilities/resources/triggers | A·C | 不是"已安装插件列表"；列表在 registry 的 plugins bucket |
| 能力 | capability | 插件被允许使用的资源类别，能力白名单 8 项（`site:read`/`site:write`/`db:read`/`db:write`/`net:read`/`net:write`/`system:read`/`system:admin`） | V·A·C | 不是 RBAC 权限点；只做"插件能否碰这类资源"，不细分到具体对象 |
| 能力白名单 | capability allowlist | 内核唯一承认的 8 项能力集合，清单里出现集合外能力即安装失败 | A·C | 白名单是集合包含校验，不是前缀匹配（`site:admin` 不存在） |
| 触发 | trigger | 拉起一次性插件的条件：cron / HTTP invoke / bus 事件 | A·C | 不是"事件订阅"；触发决定**何时起进程**，事件是运行期通知 |
| 热升级 | hot upgrade | 新进程拉起并 hello 成功后，再优雅停旧进程的升级方式 | V·A·C | 不是"零中断"；升级窗口内该插件的新调用会短暂 503 |
| 帧 | frame | 协议传输单元：4 字节大端长度前缀 + JSON 负载 | A·C | 不是 TCP 包；一次 send 可能跨多个帧，必须按长度前缀切分 |
| 帧上限 | max frame size | 单帧 8 MiB（8388608 字节）硬顶，超长即断开连接 | A·C | 是**单帧**不是"单次调用总字节"；分页/流式不在 MVP |
| 协议 | protocol (`kore.plugin.v1`) | 主壳与插件之间的版本化约定，含帧格式、必选方法、错误体 | V·A·C | 不是 HTTP API；浏览器永远不直连插件 socket |
| 必选方法 | required methods | 每个插件必须实现的 **4 个方法**：`kore.hello` / `kore.ping` / `kore.shutdown` / `kore.reload` | V·A | 不含 `event`；`kore.event` 是必选**事件通道**，不是方法；`reload` 是配置重载，不是热升级 |
| 事件通道 | event channel (`kore.event`) | 插件→内核的单向事件通道，与 4 个必选方法并列构成插件契约 | V·A | 与 `kore.ping` 不同：ping 是请求-响应，event 不期待响应 |
| 业务方法 | business method | 插件自有 `<plugin>.<verb>`（如 `site.status`），内核不解释其语义 | A·C | 不得以 `kore.` 开头；保留前缀只属内核 |
| 错误码 | error code | 8 个固定枚举 E_INVALID/E_UNAUTHORIZED/E_NOTFOUND/E_CONFLICT/E_UPSTREAM/E_INTERNAL/E_UNSUPPORTED/E_RATELIMIT | V·A·C | 不是 HTTP 状态码；一个错误码可映射多个状态（401/403、502/504） |
| 总线 | bus | 内核内部的帧收发与请求关联组件，负责超时、扇出、SSE 缓冲 | A·C | 不是 MQ；无持久化、无重试、无跨重启投递 |
| 事件 | event (`kore.event`) | 插件发往主壳的单向通知，经 bus 扇出到 SSE | A·C | 不是 RPC；不期待响应，丢了不补（除 256 条缓冲补发） |
| SSE | Server-Sent Events | `GET /api/v1/events` 的单向推送通道，主壳唯一推送机制 | A·C | 不是 WebSocket；浏览器→服务器方向只有普通 HTTP |
| 注册表 | registry | 插件清单校验、安装/卸载/enable/disable 与状态持久化的组件 | A·C | 不是服务发现；不做健康检查（那是 supervisor） |
| 监督器 | supervisor | 插件进程生命周期组件：拉起、健康检查、退避重启、优雅停止、热升级、孤儿清理 | A·C | 不是 init/systemd；它只管插件，主壳自身由 systemd 管 |
| 状态机 | state machine | 插件状态集合与合法迁移：installed→enabled→starting→ready→degraded→stopping→stopped/failed | A·C | 不是"随便改状态"；非法迁移必须拒绝并记日志 |
| 降级 | degraded | 插件进程还在但连续 ping 超时，路由暂停新调用的中间态 | A·C | 不是 failed；degraded 会自愈，failed 需人工 enable |
| 故障域 | failure domain | 单个组件崩溃时受影响的范围边界 | V·A·C | 不是"高可用"；kore 不承诺自动容错，只承诺**影响可控** |
| 单实例锁 | single-instance lock | `flock /run/kore/kore.lock`，保证同一宿主只有一个 kored | A·C | 不是 pid 文件；flock 由内核释放，崩溃不留幽灵锁 |
| 状态目录 | state dir | `/var/lib/kore`（`KORE_STATE_DIR`），含 `state.db`、`plugins/`、`tasks/` | V·A·C | 不是配置目录；配置在 `/etc/kore/config.yaml` |
| 资源预算 | resource budget | 门禁级资源上限：主壳 ≤ 8 MiB、同时常驻 ≤3 个/单 ≤12 MiB/合计 ≤24 MiB、二进制 ≤ 25 MiB、首屏 ≤ 300 KiB gzip、空闲 CPU ≤0.1% | V·A | 不是"优化目标"；超了判未完成，不合并 |
| 空载 RSS | idle RSS | 启动后无请求、稳定 60 s 取中位数的常驻内存 | V·A·C | 不是峰值 RSS；度量口径 `ps -o rss= -p PID`（KiB/1024） |
| 内存上限 | GOMEMLIMIT | `main` 启动时 `debug.SetMemoryLimit(6<<20)` 的软上限：GC 为守住上限更积极，超限不 OOM | A·C | 不是 cgroup/Job Objects 的硬限；硬限由 resource 后端负责 |
| 零常驻 | zero-resident | 一次性插件空闲时进程数 = 0、RSS = 0 的形态约束 | V·A | 不是"内存占用小"；判据是 `pgrep` 为 0 |
| 锚点 | anchor | VISION 中不可协商的五个形态约束（形态/架构/资源/开放/体验） | V·A | 不是"目标"；目标可调，锚点是判据来源 |
| 变更集 | change set | 一次跨仓库改动在 `.agents/BOARD.md` 登记为一个 id，含各仓库 commit/tag 与合并顺序 | R·X | 不是单个 PR；也不是发布批次，它只保证跨仓库改动有唯一负责人与验收证据 |
| 版本声明 | requires_kore | `info.json` 必填的 kore 版本区间（如 `">=0.1.0 <0.2.0"`），不满足时 kore 回 `E_UNSUPPORTED` | A·R·C | 不是 `protocol`；protocol 管协议主版本，requires_kore 管内核版本区间 |
| 里程碑 | milestone | 固定编号的交付阶段 M0 文档与骨架 → M1 Walking Skeleton → M2 插件生态 MVP → M3 生产可用 → M4 生态开放 | V·A·C | 编号固定不得新增；非目标不能塞进任何里程碑 |
| 非目标 | non-goal | 明确不做且不受理的需求：容器编排/多租户/集群/拖拽建站/i18n/移动 App/重型主题 | V·A | 不是"以后再说"；强做要 ADR 且默认拒绝 |
| ADR | Architecture Decision Record | `docs/DECISIONS/<4 位序号>-<kebab-slug>.md`，记录备选、决策、后果、复审条件 | V·A·C | 不是变更日志；ADR 只记不可逆或跨模块的选择 |
| 门禁 | gate | 可执行检查项的集合（`make gate` / `make docs-check`），不过不得合并 | V·A | 不是"建议"；门禁失败时禁止用"下次补"绕过 |
| 蓝军 | red-team | 只出问题单、不修代码的对抗角色，专攻膨胀/越权/崩溃/资源 | V·A·C | 不是 verifier；verifier 复跑门禁，蓝军主动构造攻击 |
| 会话 | session | 单用户登录后的服务端凭证，Cookie `kore_session`，TTL 12 h | A·C | 不是插件会话；插件无会话概念，只有连接 |
| 中间件链 | middleware chain | 固定 8 层：req_id→recover→access_log→body_limit→auth→csrf→rate_limit→router | A·C | 顺序不可调换；调换即评审拒绝 |
| 请求标识 | req_id | 16 位 hex 的请求追踪标识，贯穿 HTTP 头、日志、插件帧 | A·C | 不是协议 `id`；`id` 用于请求-响应配对，`req_id` 用于跨进程追日志 |
| 孤儿进程 | orphan process | 主壳崩溃后残留的插件进程，靠 `run.json` 的 pid + start_time 核对回收 | A·C | 不是僵尸进程；僵尸是已退出未 wait，孤儿是还活着但没人管 |
| cgroup slice | cgroup v2 slice | `/sys/fs/cgroup/kore/<id>.slice`，按插件限制 memory/cpu/pids | V·A·C | 不是容器；无命名空间隔离，只有资源限额 |
| 系统用户 | system user | 每个插件专属的 `kore-<id>` 低权用户，隔离文件与进程权限 | A·C | 不是登录用户；无 shell、无 home、不可交互登录 |
| 统一调用入口 | unified invoke | `POST /api/v1/invoke/{plugin}/{method}`，前端调用插件的唯一路径 | A·C | 不是通用网关；不做协议转换、不做聚合调用 |
| 插件资产 | plugin assets | 插件自带前端产物，挂在 `/plugin-assets/<id>/*`，需会话访问 | A·C | 不是主壳静态资源；主壳资源在 embed 里、免鉴权 |
| 单二进制 | single binary | 前端 `web/dist` 经 `//go:embed` 编入 `kored` 的交付形态 | V·A | 不是"只有一个可执行文件就够"；还要求 ≤ 25 MiB |
| 归属 | ownership | 用户拥有二进制、配置、数据、插件源码，可整体迁走、无云端依赖 | V·A | 不是"开源许可"；归属强调退出成本与数据可直读 |
| 契约 | contract | 本批文档锁定的数字/路径/命名/编号，改动须 ADR 且全链同步 | V·A·C·G | 不是"建议规范"；契约漂移=文档事故 |
| 角色 | role | 固定 6 个协作身份：lead/architect/implementer/verifier/red-team/scribe | X | 不是权限账号；角色不可兼任（implementer ≠ verifier） |
| Kore Loop | Kore Loop | 七阶段固定顺序：提案 → 双评审 → 拆解 → 实现 → 验证 → 蓝军 → 归档复盘（第 7 阶段=归档复盘） | X | 不是 CI 流水线；它是人/agent 的协作门禁序列 |

## 2. 反术语表

以下词在本项目文档、注释、commit、任务卡中**禁止使用**。它们不提供可验证信息，只会把"没想清楚"包装成"想清楚了"。

| 禁用词 | 为什么禁用 | 替换写法 |
| --- | --- | --- |
| 赋能 | 没说赋什么能、给谁、怎么验 | 写"提供 X 能力：方法名 + 入参 + 返回 + 失败码" |
| 抓手 | 抽象到无法执行 | 写"入口：`POST /api/v1/invoke/<plugin>/<method>`" |
| 中台 | 本项目不存在此物，属概念挪用 | 删除，或写具体组件名（`registry` / `bus`） |
| 生态闭环 | 把"装→调→卸"说成宏大叙事 | 写"安装 → 调用 → 卸载 的可验证链路" |
| 大而全 | 与定位相反，且无法判定 | 写"薄壳内核 + 插件"，并给出内核职责表 |
| 无缝 / 无感 | 无法判定，掩盖握手与失败路径 | 写"2 s 内完成 `kore.hello`，失败重试 1 次" |
| 智能化 | 没有模型、没有阈值就不是智能 | 写判定条件与阈值（如"连续 3 次 ping 超时→degraded"） |
| 云原生 | 本机 systemd/cgroup 不是云原生 | 写"systemd unit + cgroup v2 slice" |
| 高可用 | 单机单实例没有 HA，只有重启策略 | 写"`Restart=on-failure`，`RestartSec=2`" |
| 轻量级 | 形容词，无法验收 | 写"空载 RSS ≤ 8 MiB（60 s 中位数）" |
| 极致性能 | 无指标的性能是修辞 | 写"P95 ≤ 5 ms""单帧 ≤ 8 MiB" |
| 一键部署 | 掩盖前置条件（root、systemd、目录权限） | 写命令序列：`make build && install` + 前置条件列表 |
| 用户旅程 | 把调用链说成故事 | 写请求序列：`POST /api/v1/auth/login` → `GET /api/v1/plugins` → `POST /api/v1/invoke/...`（探针 `/-/healthz` 例外，不带前缀） |
| 体系化 | 同上，无法验收 | 写具体文档/门禁清单 |
| 联动 | 没说谁调谁、什么条件 | 写"A 收到 B 的事件后调用 C 的 D 方法" |

## 3. 命名约定

| 对象 | 规则 | 正例 | 反例 |
| --- | --- | --- | --- |
| 目录 | 全小写；多词用 `-`（文档/配置）或直接小写单词（Go 包） | `cmd/kored`、`internal/core/httpapi`、`docs/DECISIONS` | `internal/Core`、`docs/decision` |
| Go module 路径 | `github.com/kore-project/<repo>`；插件为 `github.com/kore-project/kore-plugin-<id>` | `github.com/kore-project/kore`、`github.com/kore-project/kore-plugin-echo` | `kore`、`kore/site`、裸 `kore-plugin-echo`（缺组织路径） |
| Go 包名 | 小写单词，不用下划线/复数 | `supervisor`、`pluginapi` | `supervisor_pkg`、`utils` |
| Go 标识符 | 导出 PascalCase，非导出 camelCase | `PluginState`、`callTimeout` | `plugin_state`、`Call_Timeout` |
| 文档文件 | 顶层全大写 `.md`；ADR 用 `<4 位序号>-<kebab>.md` | `VISION.md`、`0002-uds-length-prefix-json.md` | `vision.md`、`adr1.md` |
| HTTP 路径 | 小写复数名词，版本在路径，层级嵌套 | `/api/v1/plugins/{id}/enable` | `/api/v1/plugin/enable`、`/api/v1/enablePlugin` |
| JSON 字段 | camelCase（HTTP）；`info.json` 用 snake_case（契约锁定） | `expiresAt`、`memory_mb`、`cpu_quota` | `expires_at`（HTTP 中）、`memoryMb`（info.json 中） |
| 配置键 | snake_case，点分层级（键名以 `DATA-MODEL.md` §3 为准） | `security.login_rate_limit.window`、`auth.session_ttl` | `bus.callTimeout`、`Bus-Call-Timeout` |
| 环境变量 | 全大写 `KORE_` 前缀 + UPPER_SNAKE | `KORE_CONFIG`、`KORE_STATE_DIR` | `koreConfig`、`KORE_CONFIG_PATH` |
| 协议方法 | 保留名 `kore.<verb>`；业务名 `<plugin>.<verb>`，全小写 | `kore.hello`、`site.status` | `Kore.Hello`、`site.Status`、`site-status` |
| 错误码 | `E_` 前缀 + UPPER_SNAKE，仅 8 个枚举 | `E_UPSTREAM`、`E_RATELIMIT` | `UPSTREAM_ERROR`、`E_TIMEOUT`（不存在，超时归 E_UPSTREAM） |
| 日志字段 | 小写 snake_case，固定集合 | `ts,level,mod,req_id,msg,plugin,method,dur_ms,err_code` | `timestamp`、`requestId` |
| 角色名 | 全小写，多词用 `-` | `lead`、`architect`、`red-team`、`scribe` | `RedTeam`、`red_team` |
| 里程碑 | `M` + 数字，不复用、不新增 | `M0`、`M3` | `MVP1`、`M2.5` |
| 插件 id | 小写字母开头，`[a-z0-9-]`，长度 2–32，不含点 | `site`、`backup`、`cert-manager` | `Site`、`my.plugin`、`site_plugin` |
| socket 文件 | `/run/kore/plugins/<id>.sock`；升级临时 `<id>.next.sock` | `plugins/site.sock` | `plugins/site-v1.0.0.sock`（稳态不用版本号） |

## 4. 常见误用对照

| 错误说法 | 正确说法 | 为什么 |
| --- | --- | --- |
| "插件跑在内核里" | "插件以独立进程运行，通过 UDS 与内核通信" | 进程边界是红线①，说错会导致实现走动态库 |
| "主壳包含了站点和备份功能" | "主壳不含业务；站点/备份是插件" | 内核边界，评审第一条 |
| "用 Redis 做事件总线" | "bus 是进程内内存实现，无第三方中间件" | 红线②，依赖白名单也不允许 |
| "一次调用最多 8 MiB 响应" | "单帧 ≤ 8 MiB；大结果需插件自行分页" | 帧是传输单元，不是调用总量 |
| "插件升级是零中断的" | "热升级期间该插件新调用可能短暂 503" | 不承诺做不到的事，失败域要写实 |
| "内核会自动恢复所有故障" | "单插件故障由 supervisor 退避重启；主壳崩溃由 systemd 拉起" | 恢复手段必须点名，不能笼统"自动" |

## 5. 术语 → 代码落点

第 1 节给"什么意思"，本表给"代码与磁盘上长什么样"，避免文档名词与实现名词两套皮。

| 术语 | 落点 |
| --- | --- |
| 内核 / 主壳 | `cmd/kored/main.go` 只做装配；实现全在 `internal/core/*` |
| 协议 / 帧 | `pkg/pluginapi/`（公开 SDK：`frame.go` 帧编解码、`types.go` 消息类型、`errors.go` 错误码） |
| 注册表 | `internal/core/registry/`；状态落 `plugins` bucket |
| 监督器 | `internal/core/supervisor/`；孤儿记录 `/var/lib/kore/plugins/<id>/run.json` |
| 总线 | `internal/core/bus/`；SSE 环形缓冲在进程内存 |
| 存储 | `internal/core/store/`；bucket `meta/plugins/plugin_state/tasks/sessions/audit`（无 `users`） |
| 鉴权 / 会话 | `internal/core/auth/`；Cookie 名 `kore_session` |
| 配置 | `internal/core/config/`；文件 `/etc/kore/config.yaml` |
| HTTP 入口 / 中间件链 / SSE | `internal/core/httpapi/`（`sse` 为包内子包） |
| 插件 | 独立仓库 `kore-plugin-<id>/`（`main.go` + `info.json`），产物 `bin/<id>` 与 tar.gz |
| 插件包 / 清单 | `<id>-<version>.tar.gz` → `/var/lib/kore/plugins/<id>/<version>/info.json` |
| 状态目录 | `/var/lib/kore`（env `KORE_STATE_DIR`） |
| socket | `/run/kore/kore.sock`；插件 `/run/kore/plugins/<id>.sock` |
| 单实例锁 | `/run/kore/kore.lock`（flock） |
| 日志 | `/var/log/kore/kore.log`；插件 `/var/log/kore/plugins/<id>.log` |
| 前端 / 插件资产 | `web/`（`//go:embed`）；插件资产 `/plugin-assets/<id>/*` |

## 6. 维护规则

1. 新增术语：先在本文加行，再在目标文档首次出现处保持中英对照（如"插件清单（manifest）"）。
2. 术语改名：等同契约变更——同一次提交内改齐所有文档与代码引用，并写 ADR。
3. 反术语表只增不删：证明某词在本项目恒无歧义时才可移除，且需 ADR。
4. 本文与 [VISION.md](./VISION.md)、[ARCHITECTURE.md](./ARCHITECTURE.md)、[CORE.md](./CORE.md) 冲突时，以 VISION 的定义为准并回改本文。

> 术语不一致不是"文风问题"，是**验收标准漂移**：同一个词两种理解，verifier 和 implementer 就会红绿相反。这份表是让争论停在定义层的工具。
