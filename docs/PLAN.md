> 状态: draft · 归属: lead · 更新: 2026-11-21 · 里程碑: M0

# kore 执行计划（PLAN）

本文件把 ROADMAP 的 5 个里程碑拆成可派发、可验收的任务，并规定并行写域、门禁命令、迭代节奏与度量口径。项目是多仓库结构（`kore` / `kore-plugins` / `kore-plugin-<id>`，见 ROADMAP §2 与 `docs/REPOS.md`），**M0 只交付 `kore` 仓库**；任何任务都必须有 owner 角色、产出文件名与验收方式，"持续推进""加强完善"这类不可验收表述不进本表。

## 1. 执行原则

1. **薄壳优先**：内核只定规则（插件生命周期 / 权限校验 / 消息路由 / 资源隔离），任何业务能力先问"能不能放进插件仓库"，能放就不进内核。
2. **仓库边界硬约束**：插件代码、插件前端、插件索引不得进入 `kore` 仓库；`kore` 不得 import 任何插件仓库；跨仓库改动必须登记变更集（G-13 / G-15）。
3. **依赖单向**：插件仓库 → `kore/pkg/pluginapi`，`pkg/pluginapi` 是唯一公开 SDK；`requires_kore` 是插件与内核的兼容契约（G-14）。
4. **先跑通再优化**：M1 允许粗糙但必须跨仓库端到端可运行；内存/体积预算从第一行可执行代码起就是门禁。
5. **每轮可验证**：一轮 Loop 的产出必须能用一条命令判定通过与否；没有验收命令的任务不派发。
6. **一次 Loop 只推进一个目标**：单轮只改一个目标相关的文件，跨目标改动拆下一轮。
7. **证据先于结论**：完成 = 命令 + 退出码 + 关键输出；无证据的"已修复"按未完成处理。

## 2. M0 WBS 任务表

M0 只交付 `kore` 仓库的文档与骨架，**不含任何插件仓库与索引仓库**（`kore-plugins`、`kore-plugin-echo` 属 M1 前置，见表 2.2）。owner 角色为固定 6 角色之一。

| ID | 任务 | 产出文件 | owner 角色 | 验收 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| A1 | 愿景与五锚点 | `docs/VISION.md` | architect | 150–300 行；五锚点逐条成节；非目标齐全；不出现"大而全面板"定位 | — |
| A2 | 总架构与依赖方向 | `docs/ARCHITECTURE.md` | architect | 200–300 行；进程模型/模块/依赖方向/启动时序；与目录布局逐项对应 | A1 |
| A3 | 内核规格 | `docs/CORE.md` | architect | 200–300 行；四类规则各一节；13 个 HTTP 端点全列（含 enable/disable/upgrade 三个）；预算数字与契约一致 | A2 |
| A4 | 术语表 | `docs/GLOSSARY.md` | architect | 60–120 行；≥20 条中英对照；用词与其它文档一致 | A1 |
| A5 | 兼容基线文档 | `docs/COMPATIBILITY.md` | architect | 150–300 行；三平台矩阵 3 行 + Linux 发行版明细 10 行；降级规则逐条给触发条件与用户可见结果；无"可能不支持"类模糊表述；构建参数与 ADR-0009 一致 | A2 |
| B1 | 插件协议 | `docs/PLUGIN-PROTOCOL.md` | architect | 200–300 行；4 字节大端长度前缀 + JSON、帧上限 8 MiB；**4 个必选方法 + 1 条必选事件通道**；错误体 3 字段；包结构与 `requires_kore` | A3 |
| B2 | 资源模型 | `docs/RESOURCE-MODEL.md` | architect | 150–250 行；6 条硬预算逐条给测量方法与超限处置；cgroup 路径 | A3 |
| B3 | 数据模型 | `docs/DATA-MODEL.md` | architect | 150–250 行；`state.db` 表/字段/索引命名；迁移只追加；任务模型 | A3 |
| C1 | 前端规格 | `docs/FRONTEND.md` | architect | 150–250 行；技术栈逐项；composables 不引 Pinia；插件前端 ES module + 原生 `import()`；默认暗色 | A2 |
| C2 | 安全模型 | `docs/SECURITY.md` | architect | 150–250 行；鉴权、能力模型（6 特权 + 插件自有 `<plugin-id>:<action>`，非空 ≤16）、UDS 权限、隔离、无联网校验、无隐藏上报 | A3, B2 |
| C3 | 十四篇 ADR + 仓库清单 | `docs/DECISIONS/0001-0014`、`docs/REPOS.md` | architect | 14 篇各 40–120 行（6 节结构）；`0008` 多仓库拓扑含 R1–R8；`0009` 兼容基线；`0010` 平台五接口；`0011` SDK 嵌套 module；`0012` 商店与预设；`0013` 极致资源；`0014` v1 范围与深度分级（12 生产 / 8 基础 / 6 不做）；`REPOS.md` 与 ROADMAP §2 一致 | A1–C2 起稿后 |
| D1 | 路线图 | `docs/ROADMAP.md` | lead | 150–350 行；9 节齐全；M0–M4 固定编号；按仓库列交付物 | A1, B2 |
| D2 | 执行计划 | `docs/PLAN.md` | lead | 150–350 行；9 节齐全；WBS 覆盖 A–G 七轨；含 M1 前置任务 | D1 |
| D3 | M0 里程碑清单 | `docs/MILESTONE-M0.md` | lead | 150–350 行；文件级清单 + 三层验收 + M0/M1 边界 + 交接说明 | D1, D2 |
| E1 | Agent 协作契约 | `AGENTS.md` | scribe | 60–180 行；6 角色职责、写域、门禁、Kore Loop 七阶段、仓库拓扑摘要 | D2 |
| E2 | 项目门面 | `README.md` | scribe | 80–200 行；定位/五锚点摘要/仓库导航/文档导航；不承诺未实现能力 | A1 |
| E3 | Agent 管理架构 | `.agents/README.md`、`.agents/ROLES.md`、`.agents/WORKFLOW.md`、`.agents/BOARD.md`、`.agents/QUALITY-GATES.md`、`.agents/JOURNAL.md` | scribe | 80–200 行；角色卡 + 交接协议 + 门禁表 + 任务板字段（含变更集） | E1 |
| F1 | 骨架与 Makefile | `.gitignore`、`.editorconfig`、`Makefile` | implementer | `make help` 列出全部目标；统一 `[OK]/[SKIP]/[N/A]/[FAIL]` 前缀；`.gitignore` 含 `go.work` | D2 |
| F2 | 门禁脚本 | `scripts/docs-check.sh` | implementer | 退出码 0；能对元信息/章节/关键口径/互链四类违规报错 | F1 |
| F3 | `kore` 骨架目录 | `cmd/kored/`、`internal/core/*`、`pkg/pluginapi/`、`web/`、`docs/`、`.agents/` | implementer | 目录与契约一致；**无 `plugins/` 目录**；源码未就绪时 `make build` 输出 `[SKIP]` | F1 |
| G1 | 一致性独立验收 | `.agents/verify/m0-consistency.md` | verifier | 独立复跑 docs-check + 三层交叉核对 + 拓扑一致性；逐项 PASS/FAIL | A–F 全绿 |
| G2 | 首次提交准备 | `.agents/verify/m0-commit-plan.md` | verifier | 文件清单 + `type(scope): 描述` 提交信息草案；git 提交由 lead 在具备 git 的宿主执行 | G1 |

### 2.1 M0 边界

M0 交付范围**只有 `kore` 仓库**：文档、骨架、门禁脚本。`kore-plugins` 与 `kore-plugin-echo` 的仓库创建、`pkg/pluginapi` 的可发布 SDK 化、任何插件的 `main.go`，都属于 M1 交付；M0 阶段在 `kore` 仓库里出现插件代码即违反 G-13。

### 2.2 M1 前置任务（不属 M0 交付）

| ID | 任务 | 产出 | owner 角色 | 验收 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| P1 | 仓库拓扑落地：建 `kore-plugins` 与 `kore-plugin-echo` | 两仓库骨架（module 路径按 `REPOS.md` / ADR-0008）；`kore-plugins`：空 `index/plugins.json` + 校验脚本；`kore-plugin-echo`：`main.go` + `info.json`（含 `requires_kore`）+ `Makefile`（`dist`）+ `CHANGELOG.md` | implementer | 两仓库各自 `make build` 通过；echo 的 `go.mod` 只依赖 `kore/pkg/pluginapi`；echo `make dist` 产出 tar.gz + sha256；`go.work` 仅本地联调且不提交 | M0 完成 + ADR-0008 落盘 |

## 3. 后续 Sprint 计划

Sprint 1–3 覆盖 M1（Linux 内核 + SDK 独立 module + echo 跨仓库验证）；Sprint 4–6 覆盖 M2（installer / preset / store / 商店 UI + site/ssl/backup 三插件 + macOS）；Sprint 7–9 覆盖 M3（web/data/ops 共 11 个插件仓库）；Sprint 10–12 覆盖 M4（sec/app 6 个插件 + Windows + 故障注入 + v1.0.0）；M5 以 S13+ 概述。**插件按深度分级**：生产级 12 个（每个 DoD 含故障注入 + 边界用例），基础级 8 个（只要求核心路径 + 基本错误处理，边界用例延 v1.1）。每个 Sprint 最多 4 条并行轨，退出条件必须命令可判定。

### Sprint 1（M1-1）Linux 内核骨架 + SDK 独立 module

- **目标**：`kore` 能起（Linux 全功能）、`pkg/pluginapi` 拆成仓库内嵌套 module（ADR-0011）、`internal/platform` 五接口定义 + Linux 实现、echo 与索引仓库骨架就位。
- **任务清单**：`cmd/kored`、`internal/core/{config,httpapi,auth,bus}`、`internal/platform` 五接口（`Listener` / `PeerIdentity` / `ProcessSupervisor` / `ResourceLimiter` / `ServiceManager`）+ Linux 实现；`pkg/pluginapi` 独立 `go.mod` + 版本变量；Makefile 增 `cross` / `compat-info`；建 `kore-plugin-echo`（`go.mod` 只 `require` `pkg/pluginapi` 的 tag）与 `kore-plugins`（空索引 + 校验脚本）。
- **退出条件**：`make build` 0 且 `bin/kored` ≤25 MiB；`/-/healthz` 200、未登录 `/api/v1/auth/session` 401；echo 仓库 `make build` 通过且 `go list -m all` 只含 SDK module；`kore-plugins` 空索引校验 0；`file bin/kored` static、`GOAMD64=v1` 可见。
- **风险**：SDK module 拆分导致 import 路径变更 → ADR-0011 + 单测锁版本；跨仓库联调依赖本地路径 → `go.work` 不提交。

### Sprint 2（M1-2）UDS 协议与 supervisor

- **目标**：`kore.plugin.v1` 帧编解码 + supervisor 拉起/心跳/崩溃重启 + echo 跑通 4 个必选方法与 1 条事件通道。
- **任务清单**：`pkg/pluginapi` 实现 4 字节大端长度前缀 + JSON（8 MiB 上限、半包/粘包）；supervisor spawn、hello 握手、ping、shutdown、reload、退避重启；echo 实现 `kore.ping` 并声明 `requires_kore`；从 echo 仓库 `dist` 产物安装。
- **退出条件**：`POST /api/v1/invoke/echo/ping` → `pong`；kill -9 后 5s 回 running；`kore.event` 通道收到事件；>8 MiB 帧被拒且连接不崩。
- **风险**：僵尸进程/socket 残留 → 退出钩子回收 + 启动清理。

### Sprint 3（M1-3）内存红队判据与 M1 验收

- **目标**：内存、交叉编译、跨仓库隔离三项同时达标，补齐 M1 全部证据。
- **任务清单**：`make mem` 自动采样；运行参数 `GOGC=100` + `GOMEMLIMIT=6MiB`（理由：GOMEMLIMIT 守上限，GOGC 调高反而放大堆峰值）；`scripts/compat-smoke.sh`（3 个 Linux 镜像，含无 systemd）；verifier 独立复跑九条退出条件。
- **退出条件**：内存三件齐全且 ≤8192 KiB（GOGC 双档 × 60s×60 点中位数 × `smaps` 拆 `RssAnon`/`RssFile`）；`make cross` 五目标通过；3/3 镜像 smoke；`grep -rn "syscall\." internal/core` 零命中；**启动到就绪 ≤1s**（`kored` 进程启动 → `GET /-/healthz` 返回 200，不含插件 ready）；**API p95 ≤50ms（本地）**（`GET /api/v1/auth/session` 或 `/api/v1/system/info` 连续 200 次）；lazy 冷启动 p95 ≤300ms 标注 M2 起生效（M1 echo 为 resident）。
- **风险**：超预算 → 降 `GOGC=50` 重测，禁止改预算口径；跨仓库验证走过场 → verifier 独立执行。

### Sprint 4（M2-1）installer + store 模块 + site 插件

- **目标**：内核具备"商店安装"能力，第一个核心插件（site）经商店装/卸/回滚。
- **任务清单**：`registry` 的安装/卸载/升级/回滚状态机；store 模块（读本地 `index/plugins.json`、分类/搜索/依赖提示的数据接口）；`kore-plugin-site` 仓库（`main.go` / `info.json` 含 `depends_on` / `scenario_tags` / `size_bytes` / `Makefile` / `CHANGELOG.md`）；前端插件列表页。
- **退出条件**：site 仓库 `make dist` 出包，kore 经商店安装后 running；安装/卸载/回滚各一次结果一致；site 60s 中位数 ≤24576 KiB；首屏 ≤300 KiB gzip。
- **风险**：安装状态机漏回滚路径 → 每个失败分支补用例。

### Sprint 5（M2-2）ssl / backup 插件 + preset 引擎 + 8 场景预设

- **目标**：3 个核心插件齐备，首次安装可按 8 个预设一键装批。
- **任务清单**：`kore-plugin-ssl`、`kore-plugin-backup` 两仓库；preset 引擎（读 `kore-plugins/presets/*.json`、按 `scenario_tags` 选插件、版本区间解析、依赖顺序安装）；8 个预设置；能力校验（6 特权 + `<plugin-id>:<action>`，非空 ≤16）；`make presets-check`。
- **退出条件**：8 预设一键安装可复现（同预设两次结果一致）；backup oneshot 空闲 RSS=0；越权能力调用被拒；预设引用 id/区间全部可解析（G-18）。
- **风险**：预设与版本区间耦合 → 预设与索引同 tag 发布 + 校验脚本。

### Sprint 6（M2-3）商店 UI + macOS + M2 验收

- **目标**：商店可分类/搜索/提示依赖，macOS 12+ 跑通同一条链路。
- **任务清单**：商店 UI 三视图（分类/搜索/依赖提示、安装、事件流）；`internal/platform` darwin 实现（launchd、`LOCAL_PEERCRED`、arm64+amd64）；macOS runner 流水线。
- **退出条件**：M2 退出条件逐条有证据；索引 sha256 三处一致；macOS runner install → hello → invoke → uninstall 通过（`cgroup=unlimited` 明示）；M1 门禁无回归。
- **风险**：Element Plus 体积回潮 → 首屏预算进 `make check`。

### Sprint 7–9（M3）对标第一批：11 个插件仓库

- **Sprint 7**：web 三插件——`runtime-php`（生产）/ `runtime-node`（基础）/ `runtime-python`（基础）；各自仓库 + `info.json`（含 `depth_level`）+ `dist` + CI。
- **Sprint 8**：data 三插件——`db-mysql`（生产）/ `db-postgres`（基础）/ `redis`（生产）——数据目录、端口、备份钩子；`depends_on` 与 `conflicts` 生效。
- **Sprint 9**：ops 五插件——`file` / `cron` / `logs` / `monitor`（生产）+ `container`（基础，宿主已有容器/服务管理，不内置运行时）；同 Sprint 拆两批（≤4 仓库/批）；产出常驻/按需唤起分配表 + M3 验收（11 插件经商店安装/卸载/回滚、同时常驻 ≤3 + 合计 ≤24 MiB、索引 sha256 一致、11 仓库 CI 全绿）。
- **并行规则**：同 Sprint 最多 4 个插件仓库并行（Sprint 7 与 8 各 3 个，Sprint 9 四插件拆两批）；每仓库独立 agent 轨道与 CI。
- **风险**：合计内存逼近上限 → 先出分配表再写插件；11 仓库写域冲突 → 按仓库切 `write_scopes`，同批 ≤4。

### Sprint 10–12（M4）对标第二批 = v1.0

- **Sprint 10**：sec 四插件——`firewall`（生产）+ `waf` / `ssh-guard` / `integrity`（基础）；`system:admin` 最小化授权，防火墙规则幂等。
- **Sprint 11**：app 两插件——`app-deploy`（生产）/ `dns`（基础）+ 备份到对象存储（凭据走配置，不入库）+ 故障注入套件（kill -9 插件 / 主壳重启 / 磁盘满）。
- **Sprint 12**：`internal/platform` windows 实现（AF_UNIX / SCM / Job Objects / HMAC）+ cgroup 隔离/热升级/日志轮转/systemd + 三平台 runner + **v1.0 gate 取证并打 `v1.0.0`**（20 产品插件 + echo 可装可卸、12 生产级过故障注入、Linux 全矩阵 smoke、三处文案一致、资源达标）。
- **风险**：6 插件与三平台同时收口 → 平台层在 Sprint 11 并行启动；Windows 隔离弱 → capability report 明示。

### Sprint 13+（M5）概述

签名（ed25519）与三平台分发（notarization / Authenticode / 安装器）→ 静态市场页 → Go/Rust/Starlark SDK 与示例插件 → 文档站；退出条件见 ROADMAP §7.6。

## 4. DoD 七维

**代码**

- [ ] 新增/修改路径有对应测试，`make test`、`make vet` 退出码 0。
- [ ] 无新增直接依赖超出白名单（yaml.v3 / bbolt / protobuf，主壳上限 3）。
- [ ] 主壳内不出现业务逻辑；插件能力都在独立插件仓库。
- [ ] 错误处理不吞异常；对外错误体统一 `{code,message,detail}`。
- [ ] 关键路径无遗留项；遗留必须带 issue 编号与负责人。

**文档**

- [ ] 受影响的 `docs/` 文档同步更新，`make docs-check` 退出码 0（仅 kore 仓库）。
- [ ] 契约数字（8 MiB / 12 MiB / 24 MiB / 15 MiB / 25 MiB / 300 KiB / 0.1.0）与代码一致。
- [ ] 互链用相对路径且目标文件真实存在。
- [ ] ADR 覆盖本轮所有契约级决策；跨仓库拓扑变更先改 ADR-0008 与 `REPOS.md`。

**资源**

- [ ] 空载 RSS 60s 中位数 ≤8 MiB；单二进制 ≤25 MiB；前端首屏 ≤300 KiB gzip；插件包 ≤15 MiB。
- [ ] 常驻插件单 ≤12 MiB、合计 ≤24 MiB、**同时常驻 ≤3**；`lazy` 空闲 300s 退出且冷启动 p95 ≤300ms；oneshot 空闲 RSS=0。
- [ ] 空闲 CPU 实测 ≤0.1%（60s 累计 ≤60ms，`make idle` 或 `/proc/<pid>/stat` 差值）；空闲 goroutine ≤20；零轮询；空载出站 0。

**安全**

- [ ] 所有外部输入校验；安装包拒绝路径穿越；UDS 目录权限 0700 root:root。
- [ ] 未登录访问受保护端点返回 401；能力越权返回拒绝码。
- [ ] 无强制账号、无联网校验、无隐藏上报；日志不打印凭据。
- [ ] 越权/注入类改动经 red-team 出问题单并闭环。

**跨仓库**

- [ ] 插件仓库可独立构建：`go.mod` 只依赖 `kore/pkg/pluginapi`，不含 kore 内部包。
- [ ] `info.json` 声明 `requires_kore`，且安装/启用时被校验（不满足即拒绝）。
- [ ] 索引条目 sha256 与插件 release 产物一致；索引校验脚本对该条目的篡改必须非 0。
- [ ] `kore` 仓库无插件代码、无 `plugins/` 目录；`make repo-check` 零命中。
- [ ] 跨仓库改动已按 G-15 在 `.agents/BOARD.md` 登记变更集（仓库 / 版本 / 合并顺序）。

**兼容性**

- [ ] 静态二进制验证：`file bin/kored` 为 static，`go version -m bin/kored` 显示 `GOAMD64=v1`、`CGO_ENABLED=0`、`-buildvcs=false`（G-16）。
- [ ] 能力探测输出：启动产出 capability report（cgroup / init / SELinux / AppArmor 探测结果），API 与日志可见。
- [ ] 降级矩阵覆盖：每个缺失能力都有明确降级路径与用户可见提示，禁止静默降级。
- [ ] 目标镜像 smoke：M1 3/3、M2 6/6、M3 起全矩阵通过；失败镜像不得发版。

**跨平台**

- [ ] 交叉编译通过：`make cross` 五目标全绿（linux/amd64、linux/arm64、darwin/amd64、darwin/arm64、windows/amd64）。
- [ ] 平台接口无泄漏：`grep -rn "syscall\." internal/core` 零命中，平台专有调用只在 `internal/platform`（G-16）。
- [ ] 降级矩阵覆盖三平台：Linux cgroup 缺失、macOS 无强制限额、Windows 弱隔离各有 capability report 与用户可见提示。
- [ ] 三平台 smoke：M2 2/3（Linux + macOS）、M3 3/3（含 Windows）；低于最低版本返回退出码 6。

**插件级 DoD（每个插件仓库，任务验收模板）**

- [ ] `make dist` 产出 `<id>-<version>.tar.gz` + `.sha256`，包 ≤15 MiB。
- [ ] `info.json` 含 `requires_kore` / `depends_on` / `conflicts` / `scenario_tags` / `size_bytes`（G-17）。
- [ ] 独立仓库 CI 绿（build / test / vet / dist）；安装 → 调用 → 卸载 → 回滚可验，两次安装结果一致。
- [ ] **空闲 RSS**（resident 时 ≤12 MiB；lazy 空闲时应为 0 且 300s 内退出）与**冷启动 p95 ≤300ms** 两项必须贴实测数据，缺一项不算过。
- [ ] **生产级额外**（`depth_level=production`）：`tests/fault/` 故障注入（kill -9 / 磁盘满 / 主壳重启）全过 + 边界用例；任一失败不得标生产级。
- [ ] **基础级**（`depth_level=basic`）：核心路径 + 基本错误处理即可；不得被预设标"开箱可用"，商店与对标矩阵必须显示"基础级"，边界用例延 v1.1。

## 5. 验收命令清单

`Makefile` 必须提供以下目标（F1 交付，本表即验收口径）；文档门禁实现见 [scripts/docs-check.sh](../scripts/docs-check.sh)。多仓库联调用 `go work`，**`go.work` 不进版本库**。

| 命令 | 含义 | 期望输出 | M0 状态与合法跳过判据 |
| --- | --- | --- | --- |
| `make help` | 列出全部目标与说明 | 每个目标一行，含 build/vet/test/frontend/mem/docs-check/check | 必须成功 |
| `make build` | 构建主壳二进制 `bin/kored` | M1 起 `[OK] 构建完成: ./bin/kored` | `[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现`，退出码 0 |
| `make vet` | `go vet ./...` | M1 起 `[OK] go vet 通过` | `[SKIP] 源码未就绪...`，退出码 0 |
| `make test` | `go test -timeout 200s ./...` | M1 起 `[OK] go test 通过` | `[SKIP] 源码未就绪...`，退出码 0 |
| `make docs-check` | 必需文件/元信息/相对链接/占位词/行数/关键口径 | 末行 `结果: 门禁通过（N WARN 不阻断）` | 必须执行，不得跳过 |
| `make check` | `docs-check` + 依赖白名单 + 薄壳边界三段 | 末行 `[OK] 门禁全部通过` | 末行 `[FAIL] 门禁未通过` 即失败；源码缺失段输出 `[N/A]` 属合法 |
| `make mem` | RSS 口径与测量命令（M1 起自动 60s 采样） | M1 起 `[INFO] 当前 RSS: X.X MiB` | `[INFO]` 口径行 + `[SKIP] 未发现运行中的 kore 进程`，退出码 0 |
| `make frontend` | 构建 `web/dist` 并复核首屏体积 | M2 起 `[OK] 前端构建完成: web/dist` | `[SKIP] web/package.json 未就绪...`，退出码 0 |
| `make repo-check` | 跨仓库边界检查（插件代码不落 kore、kore 不 import 插件仓库） | M1 起 `[OK] 仓库边界通过` | `[SKIP] 检查脚本未就绪（M1 落地）`，退出码 0 |
| `go work use ./kore ./kore-plugin-echo` | 联调期多仓库本地协同 | 各仓库构建共享本地代码 | 不适用 M0；`go.work` 必须在 `.gitignore`，禁止提交 |
| `make cross` | 五目标交叉编译：linux/amd64、linux/arm64、darwin/amd64、darwin/arm64、windows/amd64 | M1 起 `[OK] cross 构建完成: 5/5` | `[SKIP] 源码未就绪`，退出码 0 |
| `go test ./internal/platform/...` | 平台抽象单测（五接口契约 + 降级矩阵） | M1 起 `[OK] ok ... internal/platform` | `[SKIP] 无 Go 包`，退出码 0 |
| `make compat-info` | 打印构建参数 + `file` + `go version -m`，核对可移植性 | M1 起 `[OK] 可移植性检查通过` | `[SKIP] bin/kored 未就绪`，退出码 0 |
| `bash scripts/compat-smoke.sh` | 目标镜像 smoke（M1 3 个 / M2 6 个） | `compat-smoke: 3/3 passed` | 不适用 M0；脚本 M1 Sprint 3 产出 |
| `make idle` | 空载 60s 取样：CPU 时间 / goroutine / fd / 出站连接 / 定时器来源（G-19） | M1 起 `[OK] idle: cpu=NNms goroutine=NN fd=NN outbound=0` | 未提供：M1 落地；落地前用 `/proc/<pid>/{stat,task,fd}` + `ss -tnp` 手工取证 |

合法跳过必须同时满足三条：① 目标源码/产物不存在，不是编译或测试失败；② 输出以 `[SKIP]`（目标级）或 `[N/A]`（`check` 子项级）开头并带原因；③ 退出码 0。任一不满足即视为失败。

## 6. 并行轨道与写域规则

- `kore` 仓库内写域如下；**每个插件仓库、索引仓库各自是独立写域**，不属于 kore 写域，但跨仓库改动必须登记变更集（G-15）。

| 写域 | 所有者 | 说明 |
| --- | --- | --- |
| `docs/`（除下三行） | architect | 愿景/架构/内核/协议/模型/前端/安全/ADR/REPOS |
| `docs/ROADMAP.md`、`docs/PLAN.md`、`docs/MILESTONE-M0.md` | lead | 路线图与计划口径 |
| `AGENTS.md`、`README.md`、`.agents/`（verify 除外） | scribe | 协作契约、门面、归档 |
| `cmd/`、`internal/`、`pkg/`、`web/`、`scripts/`、`Makefile`、`.gitignore`、`.editorconfig` | implementer | kore 全部可执行代码与构建资产 |
| `.agents/verify/` | verifier | 独立验收记录与提交计划 |
| 插件仓库（`kore-plugin-*`）、索引仓库（`kore-plugins`） | implementer | 独立仓库；仓库内自带 Makefile，不复制 `.agents/` |

- 一个 sprint 最多 4 条并行轨；同层并行任务的写域必须完全不相交。
- 跨仓库改动（例如改 `pkg/pluginapi` 同时升级 echo）必须登记一个变更集（各仓库 tag + 合并顺序），并由 architect 评审兼容窗口；不得在 kore 仓库里顺手改插件代码。
- red-team 不写代码、不改文件，只通过任务板/消息给 lead 出问题单，归档由 scribe 落盘。

## 7. 迭代节奏（Kore Loop）

每轮 Loop 固定七阶段：提案 → 双评审 → 拆解 → 实现 → 验证 → 蓝军 → 归档复盘（第 7 阶段同时产出 JOURNAL 记录与 ADR 归档）。

| 项 | 规定 |
| --- | --- |
| 单轮输入 | 一个目标 + 验收命令 + 写域边界（仓库 + 路径）+ 依赖任务状态 |
| 单轮输出 | 变更文件清单（按仓库分组）+ 命令与退出码 + 关键输出 + 未验证项与风险 |
| 时长上限 | 单轮 ≤2 小时；超时未收敛即拆小目标，不延长单轮 |
| 阻塞判定 | 同一验收连续 2 轮不通过，或缺私有信息且自查后仍无法判定 → 上报 lead，禁止自行扩大范围 |
| 失败计数 | 同目标第 2 次失败换本质不同方案；第 3 次拆目标或降级范围；≥4 次回滚并交 lead + red-team |
| 跨仓库 | 涉及两个及以上仓库时，必须先登记变更集（G-15），再逐仓库实现与验证 |
| 蓝军 | 每轮对"膨胀/越权/崩溃/资源"四类各给一次攻击尝试，问题单不修代码 |
| 归档 | 结论与证据落 `.agents/`；复盘三句话：根因、有效方法、下次如何提前发现 |

## 8. 度量指标表

| 指标 | 目标 | 测量方法 | 采集频率 |
| --- | --- | --- | --- |
| 空载 RSS | ≤8 MiB（目标 5–6；`GOGC=100` + `GOMEMLIMIT=6MiB`） | GOGC 双档（100 与 200）各跑一次 × 60s×60 点中位数 × `smaps` 拆 `RssAnon`/`RssFile`，三者齐全且 ≤8192 KiB | 每 Sprint 末 + 每次发布 |
| 二进制体积 | ≤25 MiB | `stat -c%s bin/kored` | 每次构建 |
| 启动到就绪 | ≤1s | `kored` 进程启动 → 首次 `GET /-/healthz` 返回 200（不含插件 ready） | 每 Sprint 末 |
| API p95（本地） | ≤50ms | `GET /api/v1/auth/session` 或 `/api/v1/system/info` 连续 200 次取 p95 | 每 Sprint 末 |
| 插件拉起 | ≤300ms | spawn → `kore.hello` 完成 | M2 起每 Sprint |
| 空闲 goroutine | ≤20 | `/api/v1/system/info` 暴露 `runtime.NumGoroutine` | 每 Sprint 末 |
| 空载进程数 | 1 个主壳（插件进程另计 ≤3） | `pgrep -c kored` + 常驻插件进程计数 | 每 Sprint 末 + 每次发布 |
| 空闲 CPU | ≤0.1%（60s 累计 ≤60ms） | `make idle` 或 `/proc/<pid>/stat` 的 utime+stime 60s 差值 | 每 Sprint 末 + 每次发布 |
| 常驻插件数 | ≤3 | 插件状态快照（`/api/v1/plugins`） | 每 Sprint 末 |
| lazy 冷启动 p95 | ≤300ms | 唤醒计时（安装/调用触发到 hello 完成），200 次取 p95 | M2 起每 Sprint |
| 插件包体积 | ≤15 MiB | `stat -c%s <id>-<version>.tar.gz` | 每次插件发布 |
| 空载出站连接 | 0 | `ss -tnp` 过滤 kored 与插件进程 | 每 Sprint 末 |
| 生产级覆盖率 | M4 起 12/12 通过故障注入 | `tests/fault/` 结果汇总（按插件） | 每插件发布 + M4 门禁 |
| 基础级升级进度 | v1.0 0/8 → v1.1 8/8 | 商店 `depth_level` 统计 | 每轮（M5 起） |
| 常驻插件内存 | 单 ≤12 MiB、合计 ≤24 MiB、同时常驻 ≤3 | `ps -o rss=` 60s 中位数 + 进程计数 | M2 起每 Sprint |
| oneshot 空闲 | RSS=0 | `pgrep -f <id>` 无结果 | M2 起每 Sprint |
| 前端首屏 | ≤300 KiB gzip | 首屏资源逐文件 gzip 后求和 | 每次前端构建 |
| 仓库边界 | 0 命中 | `make repo-check` + `grep -rn "plugins/" internal/ cmd/` | 每次提交 |
| 索引一致性 | sha256 三处一致率 100% | 比较 dist 产物 / release 附件 / `index/plugins.json` | 每次插件发布 |
| 目标镜像 smoke 通过率 | Linux M1 3/3、M2 6/6、M3 全矩阵 | `bash scripts/compat-smoke.sh` 汇总行 | 每次发布 |
| 三平台 smoke 通过率 | M2 2/3（Linux+macOS）、M3 3/3（+Windows） | 同脚本的 platform 段汇总 | 每次发布 |
| 可移植性 | 100% 检查项通过 | `make compat-info`（static / GOAMD64=v1 / GOARM64=v8.0 / CGO_ENABLED=0 / -buildvcs=false） | 每次构建 |
| 后台定时器 | 0 | 代码审计 + 运行时定时器计数断言 | 每 Sprint |
| 文档一致性 | 0 违规 | `make docs-check` | 每个检查点 |

## 9. 风险登记表

| 风险 | 概率 | 影响 | 缓解 | 触发信号 |
| --- | --- | --- | --- | --- |
| 主壳 RSS 超 8 MiB | 高 | 高（核心定位失真） | 依赖白名单、延迟初始化、每 Sprint 卡点 | `make mem` 中位数 >8192 KiB |
| 依赖膨胀（引入 Web 框架/中间件） | 中 | 高 | 白名单评审 + 门禁断言 | `go.mod` 直接依赖 >3 或出现禁用库 |
| 跨仓库版本兼容矩阵漂移 | 高 | 高 | `requires_kore` + 兼容矩阵自动化（M3）+ 只保障最近两个 minor | 矩阵出现未覆盖组合或旧插件安装失败 |
| 协议包破坏性变更打断所有插件仓库 | 中 | 极高 | `pkg/pluginapi` 独立版本 + R2 兼容窗口 + 破坏性改动需 ADR 与主版本递增 | 任一插件仓库 `make build` 失败或 hello 协商失败 |
| 多仓库联调成本（go.work/本地路径） | 高 | 中 | `go.work` 仅本地、发布前移除；变更集登记；CI 用 tag 而非本地 replace | 本地能跑、按 tag 构建失败 |
| 索引篡改或索引与发布物脱钩 | 中 | 高 | sha256 由 dist 产物写入；校验脚本进发布门禁；索引独立 tag | 三处 sha256 不一致或校验脚本放过坏条目 |
| 插件越权（6 特权 + 插件自有能力校验漏检） | 中 | 高 | 能力校验单测 + red-team 越权用例 | 越权调用返回 200 |
| oneshot 被误常驻 | 中 | 中 | 执行超时强杀 + `pgrep` 断言 | 空闲时仍能查到进程 |
| 前端首屏膨胀 | 中 | 中 | 按需引入 + 构建期 gzip 预算 | 首屏 >300 KiB gzip |
| 文档口径漂移（多仓库表述） | 高 | 中 | 关键字符串进 docs-check、verifier 拓扑核对 | REPOS 与 ROADMAP/PLAN/AGENTS 表述不一致 |
| 写域冲突导致覆盖 | 中 | 中 | 一 sprint ≤4 轨、写域不相交、lead 核对 | 派发时 writeScopes 相交 |
| cgroup v2 发行版差异 | 中 | 高 | 启动探测 + 降级为只读报告 | 创建 slice 失败 |
| 热升级状态机复杂 | 中 | 高 | 先停机升级再叠加切换，失败自动回滚 | 升级后插件不可用 |
| 备份恢复不可验证 | 低 | 高 | 备份即校验，恢复演练进门禁 | 恢复后校验和不一致 |
| 签名密钥管理失控 | 低 | 高 | 公钥进配置、私钥不入库不入镜像 | 未签名包被放行 |
| 单人串行导致 M3 拖期 | 中 | 中 | 发布链路与兼容矩阵在 M2 后半程并行启动 | Sprint 燃尽持续为 0 |
| 兼容矩阵维护成本（10 发行版 × 架构） | 高 | 中 | 镜像清单脚本化；M1 只保 3 个、M2 扩到 6 个、M3 才全矩阵；矩阵结果自动进发布说明 | 每次发版人工拼镜像、矩阵结果缺失 |
| 降级路径未测导致线上行为不一致 | 中 | 高 | 降级矩阵进 ADR-0009 与 COMPATIBILITY；每个降级分支在至少一个镜像上验证 | 同版本在 Alpine/RHEL 行为不同且无 capability report 可查 |
| `lazy` 冷启动在低配机器上超 300ms | 高 | 中 | 冷启动 p95 进每个插件验收；超限插件改 resident 需 ADR；低配 runner 常备 | 低配 runner 冷启动 p95 >300ms |
| 冷启动风暴（并发唤醒同一插件） | 中 | 高 | 单插件 single-flight 唤醒 + 排队；并发 50 次唤醒压测 | 同一插件被拉起多个进程 |
| 常驻配额抢占导致频繁升降级 | 中 | 中 | 常驻 ≤3 固定配置，不按运行时内存动态抢占 | 日志频繁 resident↔lazy 切换 |
| 基础级插件质量事故 | 中 | 高 | `depth_level=basic` 在商店/矩阵明示；不进"开箱可用"预设；核心路径 DoD；事故不静默升生产 | basic 插件被标开箱可用或线上故障 |
| v1.1 升级进度落后 | 高 | 中 | 8 个基础级升级单列 M5（14–18 轮）；每轮跟踪升级进度指标 | M5 中后期仍有 >4 个未升 |
| 迁移导入缺失导致宝塔用户迁移成本高 | 高 | 高 | v1 明确不做一键导入；文档给手工迁移清单；v1.1 评估导入器 | 用户反馈无法从宝塔迁移 |
| Windows 隔离强度弱于 Linux（同用户会话） | 高 | 高 | capability report 标 `isolation=weak`；插件 HMAC 身份校验；文档明确不等价 | 评审把 Windows 当等价隔离 |
| macOS 无法强制内存限额 | 中 | 中 | `ResourceLimiter` 只观测并标 `unlimited`；不对外宣称 12/24 MiB 硬预算 | macOS 插件 RSS 超预算且无提示 |
| 三平台服务集成测试成本 | 高 | 中 | runner 清单脚本化；M1 Linux、M2 加 macOS、M3 加 Windows 逐平台引入 | 发版需人工拼三平台 runner |
| AF_UNIX 在 Windows 上的稳定性未知 | 中 | 高 | M3 试点；不可用时必须 ADR 决定替代传输，禁止静默降级 | Windows runner 连接偶发失败 |
