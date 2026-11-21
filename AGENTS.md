# kore · Agent 协作入口

kore 是一个**多仓库项目**：内核 + 插件中心 + 每插件一仓。内核是极简调度的薄壳（插件生命周期 / 权限校验 / 消息路由 / 资源隔离），不内置任何运维功能；插件在自己的仓库里定义能力，资源零侵占、完全归属使用者。
**v1 定位**：覆盖 **22 项能力域：12 项生产级 / 8 项基础级（边界用例延 v1.1）/ 6 项明确不做**。**v1.0 = Linux GA，macOS / Windows 为 preview**；能力由 **18–22 个插件仓库**提供，内核只做调度与商店 / 预设机制。
当前里程碑 **M0 · 文档与骨架**（只交付 `kore` 仓库：纯文档 + 空骨架，零业务代码）｜MVP 版本 0.1.0｜`kore-plugins` 与 `kore-plugin-echo` 归 M1，`site` / `backup` 归 M2。

- `kore`（module `github.com/kore-project/kore`）：内核 + `pkg/pluginapi` 公开 SDK + 主壳前端 + `docs/` + `.agents/`（**唯一协作中枢**）。
- `kore-plugins`（module `github.com/kore-project/kore-plugins`）：纯静态索引 `index/plugins.json` + 校验脚本；不做审核、不代管包、无账号。
- `kore-plugin-<id>`（module `github.com/kore-project/kore-plugin-<id>`）：每插件一仓库，含 `main.go` / `info.json` / `web/` / `Makefile` / `CHANGELOG.md`，只依赖 `kore/pkg/pluginapi`。

**读前必知**

1. 这是薄壳调度内核，不是大而全的面板。`internal/core` 里多写一行业务逻辑就是设计事故，不是"顺手优化"。
2. 资源预算是门禁不是建议：主壳空载 RSS ≤ 8 MiB、常驻插件单 ≤ 12 MiB / 合计 ≤ 24 MiB、单二进制 ≤ 25 MiB、前端首屏 ≤ 300 KiB gzip。**它是管理者，不能变成负担**——空载 1 个进程、空闲 CPU ≈0、22 个插件里同时常驻 ≤3。
3. 交付只认证据：命令原文 + 退出码 + 关键输出。没有输出的"已完成"不成立。
4. 一个静态二进制跑遍 RHEL8 → Alpine 3.19 是 **Tier A**；Windows 10 1809+ / macOS 12+ 为 **Tier B**（能用，隔离与限额降级）。兼容性靠**降级矩阵**，不是要求用户升级系统。

## 1. 阅读顺序（五步，不跳步）

1. [docs/VISION.md](docs/VISION.md) — 做什么、不做什么、五锚点原文与成功判据。
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 组件图、进程模型、插件状态机、故障域。
3. 本领域文档：内核 [docs/CORE.md](docs/CORE.md)｜协议 [docs/PLUGIN-PROTOCOL.md](docs/PLUGIN-PROTOCOL.md)｜资源 [docs/RESOURCE-MODEL.md](docs/RESOURCE-MODEL.md)｜数据 [docs/DATA-MODEL.md](docs/DATA-MODEL.md)｜前端 [docs/FRONTEND.md](docs/FRONTEND.md)｜安全 [docs/SECURITY.md](docs/SECURITY.md)｜决策 [docs/DECISIONS/](docs/DECISIONS/)。
4. [.agents/WORKFLOW.md](.agents/WORKFLOW.md) — Kore Loop 七阶段门禁、讨论协议、任务板状态机、上下文交接。
5. [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md) — G1–G15 门禁命令、执行者、分层与证据格式。

## 2. 硬门禁（违反任意一条，产物即不成立）

| 编号 | 规则 | 违反后果 | 检查方式 |
| --- | --- | --- | --- |
| G-01 | 薄壳红线：`internal/core` 只做规则不写业务，且禁止 import `plugins/**` | 提交拒绝，改动整段重写 | `grep -rn "plugins/" internal/core` 必须零命中（G7） |
| G-02 | 依赖白名单：主壳直接依赖上限 3 = `yaml.v3` / `bbolt` / `protobuf`（M3 引入）；禁 Web 框架、gRPC、NATS、SQLite、Redis 客户端、容器 SDK | 提交拒绝 | `go list -m all` 与白名单逐项比对（G5） |
| G-03 | 资源预算：主壳空载 RSS ≤ 8 MiB（目标 5–6，**`GOMEMLIMIT=6MiB` + `GOGC=100`**）、常驻插件单 ≤ 12 MiB、合计 ≤ 24 MiB、oneshot 空闲 RSS=0、二进制 ≤ 25 MiB、前端首屏 ≤ 300 KiB gzip；空载进程数 = **1 主壳 + 0~2 常驻（配额硬上限 3，推荐 ≤2，留 1 槽给用户临时启用第三个）**、空闲 CPU ≤ 0.1%、空载 goroutine ≤ 20 | 判为未完成，不进里程碑 | G6/G8/G9/G14 实测；内存证据按 G6 口径：`VmRSS` 为主值、`RssAnon`/`RssFile` 优先 `smaps_rollup` 否则 `status` 且须标注来源，`GOGC=100`/`200` **双跑 × 60 点中位数**（不再强制 `smaps`）|
| G-04 | 进程隔离：插件必须是独立进程 + 独立 socket，禁止同进程动态库插件 | 架构级拒绝 | 评审 `docs/PLUGIN-PROTOCOL.md` 与 supervisor 启动路径 |
| G-05 | 无中间件：不引入 Redis / NATS / MQ / 容器运行时等常驻组件，隔离直接走 systemd + cgroup v2 + 文件系统 | 架构级拒绝 | 依赖白名单 + 进程清单核对 |
| G-06 | 文档同步：改动路径 / 协议 / 预算数字 / 角色名，必须在同一检查点内同步对应文档；代码与文档不一致不得合并 | 合并拒绝 | `make docs-check`（G4）+ 评审逐项对照 |
| G-07 | 证据验收：完成任务必须贴 命令 + 退出码 + 关键输出，禁止"应该没问题" | 任务不得 complete | [.agents/BOARD.md](.agents/BOARD.md) evidence 字段逐项核对 |
| G-08 | 写域不相交：同层并行任务的 `write_scopes` 不得重叠，跨角色不改他人文件 | 冲突任务回滚重派 | 派发前核对 BOARD `scope` 列 |
| G-09 | 角色不可兼任：implementer ≠ verifier，red-team ≠ implementer | 该次验收作废 | BOARD owner 与验收报告署名 |
| G-10 | 无联网 / 无遥测：不强制账号、无联网校验、无隐藏上报、无功能封锁 | 直接回滚 | G10 grep 出网客户端与 telemetry 关键词 |
| G-11 | 非目标保护——**6 项明确不做**：多用户 RBAC、集群 / 多机、模板市场、厂商云存储深度集成、拖拽建站、多语言（i18n）；另不做容器编排、多租户 SaaS、移动 App、重型主题 | 需求退回提案阶段 | 提案评审对照 22 项能力域与 6 项不做清单，命中即退回 |
| G-12 | 提交纪律：精确 `git add <file>`，禁 `git add .`；不提交未验证或与他人未完成改动混在一起的变更 | 提交回退 | 提交前 `git status --short` 人工核对 |
| G-13 | 仓库边界：插件代码 / 插件前端 / 插件索引不得进入 `kore` 仓库；`kore` 不得 import 任何插件仓库 | 提交拒绝，改动迁出到对应插件仓库 | `grep -rn "plugins/" internal/ cmd/` 零命中（G11）+ 仓库内无 `*/main.go` 形态插件 |
| G-14 | 协议兼容：插件 `info.json` 必须声明 `requires_kore`；破坏性协议改动必须 `kore` 主版本递增 + ADR | 合并拒绝 | G12 比对 `requires_kore` 区间与 `kore` VERSION；ADR 编号可查；**lifecycle 解析（M1 起）**：`info.json.lifecycle` 接受 `resident` / `lazy` / `oneshot` 三值并落盘，M1 运行期只支持 `resident`，遇 `lazy` / `oneshot` 返回 `E_UNSUPPORTED`（message 写明"M2 支持"）——"字段接受但未实现"不算缺陷 |
| G-15 | 跨仓库变更集：一次跨仓库改动必须在 `.agents/BOARD.md` 登记为一个变更集（含各仓库 commit/tag 与合并顺序），否则不算完成 | 任务不得 complete | BOARD「变更集」区有对应 id，仓库 / 版本 / 顺序齐备（格式见 WORKFLOW §10） |
| G-16 | 兼容性基线：构建必须 `CGO_ENABLED=0` + `GOAMD64=v1` + `GOARM64=v8.0`；**build flags** = `-trimpath -buildvcs=false`，**link flags** = `-s -w`（`-buildvcs` 是 build flag，塞进 `-ldflags` 会报 `flag provided but not defined`）；**主线 Linux（Tier A）**，Windows 10 1809+ / macOS 12+ 为 **Tier B 降级支持**；`internal/core` **不得直接调用平台专有 API**（`syscall` / `os/signal` 平台分支必须收在 `internal/platform`）；能力缺失必须走降级矩阵、**禁止静默降级**；OS 版本 / 架构低于下限 → **退出码 6** | 构建拒绝（产物不可移植） | `make compat-info` + `GOOS=windows GOARCH=amd64 go build ./...` + `GOOS=darwin GOARCH=arm64 go build ./...`（M1 起生效，M0 记 N/A）+ `grep -rn "syscall\." internal/core` 只允许出现在 `internal/platform` |
| G-17 | 插件仓规范：每个插件仓库必须含 `info.json`（含 `depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore`）、`Makefile` 的 `dist` 目标、`CHANGELOG.md`；缺任一项不得进商店。**`replace` 规则**：同仓库嵌套 module 的 `replace => ./pkg/pluginapi` **允许且必须提交**（Go 标准做法）；跨仓库联调的 `replace => ../kore/...` 或绝对路径 **禁止提交**（只放 `go.work`） | 商店索引拒绝收录；跨仓 `replace` 拒绝合并 | `make store-check` 逐仓校验三件套 + 必填字段；`replace` 只拦 `=> ../` 或绝对路径，**不拦 `=> ./`**；M1 起生效 |
| G-18 | 预设一致性：`kore-plugins/presets/*.json` 引用的插件 id 与版本区间必须能在索引中解析；预设合计资源不得超预算 | 预设不得发布 | `make presets-check`：id / 区间可解析 + 合计常驻 RSS ≤ 24 MiB 与二进制体积预算；M2 起生效 |
| G-19 | 空闲行为：空载 60s 内 CPU 时间 ≤ 60ms、goroutine ≤ 20、打开 fd ≤ 64、出站连接 0、定时器仅 `cert_renew`；**禁止轮询**（主壳不得有定时拉取插件状态的循环，状态变化走事件推送）；lazy 插件必须能真正退出（不得内部起 ticker 续命） | 判为未完成 | `make idle`（可用，约 65s；M0 无进程时 SKIP）+ `/proc/<pid>/stat` utime+stime 差值 + `/proc/<pid>/task` 计数 + `ss -tnp` 空；M0 无进程，M1 起必跑 |
| G-20 | 深度等级：插件必须在 `info.json` 声明 `depth_level` ∈ {`production`, `basic`}；`basic` 插件不得被预设标为"开箱可用"；商店 UI 必须展示等级；`production` 插件必须过故障注入测试 | 不得进商店 / 不得标生产级 | G15：`grep -r "depth_level" <插件仓>/info.json` 必须存在；对标矩阵里 `basic` 不得标"生产级"；`production` 必须有 `tests/fault/`；M3 起生效 |

## 3. 提交规范

- 格式：`type(scope): 中文描述`，type ∈ `feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore` / `build`；scope 用模块名（如 `core/supervisor`、`docs`、`agents`）。
- 精确 add：`git add internal/core/bus.go`，禁止 `git add .` / `git add -A`。
- 检查点即提交：一处自洽且过了对应层级门禁（G1/G2/G4）就提交，不攒到任务收尾。
- 不提交未验证改动；门禁没跑或跑挂时，明确报告阻塞原因，不"先提交再说"。

## 4. 派发纪律

- lead 只做编排 / 拆解 / 派发 / 验收，**不写代码、不跑执行类命令**；执行类动作派给 implementer 或 verifier。
- verifier 必须独立于 implementer：不复用实现者结论，门禁命令按 [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md) 原文复跑并落验收报告。
- 失败回派**原 owner**，不跨角色改他人文件；确需新增写域时先回到拆解阶段重画 `write_scopes`。
- 派发必须自包含：目标、写域、验收命令、完成判据写进任务卡，缺一项不派。
- 子 agent 开工前必须读本文件；子 agent 不继承父会话上下文，未注入 = 裸奔。
- 角色全集（固定 6 个，不增不删）：lead / architect / implementer / verifier / red-team / scribe；各自使命、写域与禁止项见 [.agents/ROLES.md](.agents/ROLES.md)。

**术语边界（勿漂）**：`kore` = 项目 / 内核仓库 / Go module；`kored` = 守护进程 / 二进制 / `cmd/kored` 入口包；`kore-plugins` = 插件索引仓库；`kore-plugin-<id>` = 单个插件仓库；systemd unit = `kore.service`（`ExecStart=/usr/local/bin/kored`）；Kore Loop = 七阶段（第 7 阶段=归档复盘）。

## 5. 命令速查

| make 目标 | 作用 | M0 现状 |
| --- | --- | --- |
| `make help` | 列出全部目标与说明 | 可用 |
| `make docs-check` | 文档头元信息 + 相对链接可达 + 占位词检查 | 可用（M0 唯一真门禁） |
| `make check` | 聚合门禁：docs-check + 依赖白名单 + 薄壳边界 + 跨仓库边界 | 可用：1/4、4/4 真跑；2/4、3/4 打印 N/A（无 `go.mod`）|
| `make build` | 构建主壳 `bin/kored`（`CGO_ENABLED=0` + `-trimpath` + `-s -w`） | SKIP：`cmd/kored` 未就绪，退出码 0，M1 转真构建 |
| `make vet` | `go vet ./...` | SKIP：无 `go.mod`，M1 起生效 |
| `make test` | `go test -timeout 200s ./...` | SKIP：无 `go.mod`，M1 起生效 |
| `make mem` | 采样 RSS + `smaps_rollup`/`status` 拆分，按新证据口径出中位数（G6 入口） | 可用：M0 无进程时 SKIP；有 `kored` 时出实数 |
| `make frontend` | 构建 `web/dist` 并用 gzip 核对首屏体积 | SKIP：无 `web/package.json`，M2 起生效 |
| `make repo-check` | 跨仓库边界检查：无插件代码 / 无插件 import / 无旧 SDK 路径 / 无索引 / 无 submodule | 可用（G11 入口）：**5 pass / 0 fail**，M0 真跑 |
| `make compat-info` | 打印构建参数 + `file` + `go version -m`，并跑 Windows / macOS 交叉编译冒烟（G13 入口） | 可用：参数已钉死；无 `bin/kored` 时对二进制部分 SKIP、交叉编译 `[N/A]`（M0 预期），M1 起出实数 |
| `make store-check` | 插件仓库三件套校验：`info.json` 必填字段 / `Makefile` 的 `dist` 目标 / `CHANGELOG.md` | 未提供：M1 落地（G-17 入口） |
| `make presets-check` | 8 类场景预设校验：插件 id 与版本区间可解析、合计资源不超预算 | 未提供：M2 落地（G-18 入口） |
| `make idle` | 空载 60s 取样：CPU 时间 / 线程数 / fd 数 / 出站连接 / 定时器来源（G-19、G14 入口） | 可用：M0 无进程时 SKIP；有 `kored` 时约 65s 采样 |
| `make budget-check` | 资源预算聚合门禁：`mem` + `idle` + 进程数 + 二进制体积（G-03 出口） | 可用：M0 无进程/无产物时 SKIP + N/A（0 pass / 2 skip / 0 fail） |

## 6. 细则索引

- [.agents/README.md](.agents/README.md) — agent 体系为什么存在、角色总览图、产物地图、反模式清单。
- [.agents/ROLES.md](.agents/ROLES.md) — 6 张角色卡（输入/输出/可做/禁止/交接物/完成判据）、冲突仲裁、不可兼任。
- [.agents/WORKFLOW.md](.agents/WORKFLOW.md) — Kore Loop 七阶段逐条门禁、讨论协议、状态机、防漂移审计。
- [.agents/BOARD.md](.agents/BOARD.md) — 任务板字段、状态转移、WIP、变更集登记区、M0 七条轨道快照。
- [.agents/QUALITY-GATES.md](.agents/QUALITY-GATES.md) — G1–G15 门禁命令、三层组合、证据格式、M0 跳过规则。
- [.agents/JOURNAL.md](.agents/JOURNAL.md) — 复盘模板、里程碑记录、反模式沉淀。
- [docs/DECISIONS/](docs/DECISIONS/) — ADR：每个不可逆选择的备选对比、后果与复审条件。
- [docs/CORE.md](docs/CORE.md) — **九个内核模块**（config / store / auth / httpapi / registry / supervisor / bus / installer / market）+ 4 个支撑小节（logger / static / sse / envprobe），合计 §2 共 13 小节；HTTP API **20 个端点**：13 业务 + 7 store，前缀 `/api/v1`；另有 `/-/healthz` 与 3 条静态前缀。
- [docs/MILESTONE-M0.md](docs/MILESTONE-M0.md) — 本次交付文件级清单与可执行验收标准。
