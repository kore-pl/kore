> 状态: draft · 归属: lead · 更新: 2026-11-21 · 里程碑: M0

# kore 路线图（ROADMAP）

kore 是极简内核驱动、插件定义能力、资源零侵占、完全归属使用者的服务器运维基础底座（定位原文见 [VISION](VISION.md)）。它不是"大而全面板"，而是薄壳调度内核：内核只定规则（插件生命周期 / 权限校验 / 消息路由 / 资源隔离），不内置任何运维功能。

项目是**多 git 仓库**结构：内核仓库 `kore`、纯静态索引仓库 `kore-plugins`、每个插件一个独立仓库（`kore-plugin-<id>`）。v1 定位是**对标宝塔 / 1Panel 专业版的功能覆盖面**，能力由 **20 个产品插件仓库 + 1 个验证件仓库**提供；内核只做调度与商店 / 预设机制，不吞业务。本路线图经 lead 2026-11-21 裁决重排为 M0–M5，**v1.0 gate 位于 M4**。

## 1. 版本策略

- **0.x 语义（M0–M3）**：MVP 版本号 **0.1.0** 与 M1 对齐；0.x 内 minor（0.1.0 → 0.2.0 → 0.3.0）允许破坏性变更，但必须 ADR 归档、CHANGELOG 标注不兼容项、升级说明给出回滚步骤。patch 只修缺陷。
- **1.x 起点**：**M4 完成即打 `v1.0.0`**，进入 1.x 语义：协议 `kore.plugin.v1` 内不做破坏性改动，插件按 `requires_kore` 区间适配。
- **范围口径**：覆盖 **22 项能力域：12 个生产级 / 8 个基础级 / 6 项明确不做**（见 §14）；禁用"完全·对标"式表述（两词紧邻即违规），文案三处（README / 商店首屏 / 安装器）必须一致。
- **v1.0 gate 定义**：`20 个产品插件仓库（12 生产级 + 8 基础级）+ 1 个验证件仓库全部可经商店安装/卸载` + `12 个生产级插件全部通过故障注入` + `Linux 全矩阵 smoke 通过（10 发行版 + arm64）` + `README / 商店首屏 / 安装器三处文案口径一致` + `资源合计达标（同时常驻 ≤3、常驻合计 ≤24 MiB、空闲 CPU ≤0.1%）`；**不含 macOS/Windows 全链路**（仅 preview：交叉编译 + 基础链路可跑）。全部满足才打 `v1.0.0`。
- **里程碑即发布点**：M0 → `v0.0.1`、M1 → `v0.1.0`、M2 → `v0.2.0`、M3 → `v0.3.0`、M4 → `v1.0.0`、M5 → `v1.1.0`。不做滚动发布；每个发布物只从对应 tag 构建并附 SHA256。
- **每仓库独立 tag**：`kore`、`kore-plugins`、`kore-plugin-<id>` 各自打 `v<semver>`，发布互不牵连；插件用 `requires_kore` 声明兼容区间。

## 2. 仓库拓扑与协作规则

### 2.1 仓库清单

module 路径以 `docs/DECISIONS/0008-multi-repo-topology.md` 与 `docs/REPOS.md` 为准（仓库归属 `pengtang1024`）。

| 仓库 | module 路径 | 定位 | 创建时点 |
| --- | --- | --- | --- |
| `kore` | `github.com/pengtang1024/kore` | 内核 + `pkg/pluginapi` 公开 SDK（独立嵌套 module）+ 主壳前端 + `docs/` + `.agents/` | 已存在（M0） |
| `kore-plugins` | `github.com/pengtang1024/kore-plugins` | 纯静态索引（`index/plugins.json` + `presets/*.json` + 校验脚本），不做审核、不代管包、无账号 | **M1** |
| `kore-plugin-echo` | `.../kore-plugin-echo` | M1 跨仓库依赖验证件（最小插件） | **M1** |
| `kore-plugin-site` / `-ssl` / `-backup` | `.../kore-plugin-<id>` | 核心插件（站点 / 证书 / 备份） | **M2** |
| 其余 17 个产品插件仓库 | `.../kore-plugin-<id>` | 见 §5 插件族映射（web / data / ops / sec / app） | **M3–M4** |

`kore` 仓库不再包含 `plugins/` 目录：正式插件一律独立仓库；测试桩只放 `tests/fixtures/`，不得进入发布物。

### 2.2 仓库规则 R1–R8

- **R1 依赖单向**：插件仓库 → `kore/pkg/pluginapi`；`kore` 永不 import 插件仓库（G-13）。
- **R2 协议包公开**：协议包不得放 `internal/`；`pkg/pluginapi` 是唯一公开 SDK，独立 module + 独立版本线（ADR-0011）。
- **R3 版本声明**：插件 `info.json` 必填 `requires_kore` 区间（如 `">=0.1.0 <0.2.0"`）；不满足回 `E_UNSUPPORTED`（G-14）。
- **R4 独立版本**：每仓库各自 `v<semver>` tag，不做 monorepo 联动 tag。
- **R5 协作文件归属**：`.agents/` 只在 `kore`；其它仓库最多放 ≤20 行 `AGENTS.md` 指针。
- **R6 变更集**：跨仓库改动在 `.agents/BOARD.md` 登记为一个变更集（G-15）。
- **R7 各自构建**：各仓库自带 `Makefile`（`build` / `test` / `dist`），kore 的 `make` 不构建插件。
- **R8 门禁归属**：`docs-check` 只在 `kore`；插件仓库以 `README.md` + `info.json` 为契约，另由 `make store-check` 校验三件套（G-17）。

## 3. 里程碑总览表

| 里程碑 | 主题 | 目标 | 交付物（按仓库） | 退出条件 | 资源预算 | 预估工作量（人日） | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M0 | 文档与骨架 | 固化成可执行文档 + 空骨架 | `kore`：`docs/` 15 篇 + 14 篇 ADR、`REPOS.md`、`FEATURE-PARITY.md`、`PLUGIN-CATALOG.md`、`SCENARIOS.md`、`COMPATIBILITY.md`、`AGENTS.md`、`README.md`、`.agents/`、`Makefile`、`docs-check`、空骨架 | `make docs-check` 退出码 0；三层验收全绿；对标矩阵每行有实现插件或"不做 + 理由" | 无运行时代码，仅冻结预算口径 | 5–7 | 跨文档表述漂移；ADR 0014 未落盘 |
| M1 | Walking Skeleton | Linux 内核可跑 + SDK 独立 module + echo 跨仓库验证 | `kore`：`cmd/kored`、`internal/core/*`、`internal/platform`（五接口 + Linux）、`pkg/pluginapi`（嵌套 module）、`web/` 壳、`bin/kored`；`kore-plugin-echo` 完整仓库；`kore-plugins` 空索引 + 校验脚本 | 二进制 ≤25 MiB；内存红队判据 ≤8 MiB；echo 独立仓库 `make dist` + kore 安装 hello；交叉编译 windows/darwin 通过 | 主壳 ≤8 MiB；二进制 ≤25 MiB；首屏 ≤300 KiB gzip | 14–20 | SDK module 拆分；跨仓库依赖切换；内存超预算 |
| M2 | 插件框架与商店 | installer + preset 引擎 + store 模块 + 3 核心插件 + 商店 UI + 8 场景预设 | `kore`：registry、能力校验、SSE、installer、preset 引擎、store 模块、商店 UI（分类/搜索/依赖提示）；`kore-plugin-site` / `-ssl` / `-backup` 三仓库；`kore-plugins`：索引条目 + 8 个预设置；`kore`（macOS）：darwin 平台实现 | 8 个预设一键安装可复现；3 插件独立 `make dist`；install/uninstall/rollback 可验；索引 sha256 一致；macOS 12+ 跑通 install→hello→invoke→uninstall；空载进程数 ≤1、同时常驻 ≤3、空闲 CPU ≤0.1% | 单插件 ≤12 MiB；合计 ≤24 MiB；同时常驻 ≤3；oneshot 0；首屏 ≤300 KiB gzip | 40–55 | 预设与版本区间耦合；商店离线部署；macOS 限额仅观测 |
| M3 | 对标第一批 | web 补齐（runtime-php/node/python）+ data（db-mysql/db-postgres/redis）+ ops（file/cron/logs/monitor/container） | 11 个插件仓库（各自 `info.json` / `Makefile` / `CHANGELOG.md` / CI）；`kore-plugins` 索引与索引条目；商店分类与搜索可用 | 11 插件全部经商店安装/卸载/回滚；同时常驻 ≤3、常驻合计 ≤24 MiB（其余 lazy/oneshot）；空载进程数 ≤1、空闲 CPU ≤0.1%；依赖提示与冲突检测可验 | 单插件 ≤12 MiB；合计 ≤24 MiB；同时常驻 ≤3 | 65–85 | 11 仓库并行写域；插件间依赖/冲突；合计内存逼近上限 |
| M4 | 对标第二批 = **v1.0** | sec（firewall/waf/ssh-guard/integrity）+ app（app-deploy/dns）+ 对象存储备份 + 故障注入 + 三平台 | 6 个插件仓库；备份到对象存储；故障注入套件；`internal/platform` 的 windows 实现（AF_UNIX/SCM/Job Objects/HMAC）；`kore` 的 cgroup 隔离/热升级/日志轮转/systemd；三平台分发脚本 | **v1.0 gate 全满足**：20 产品插件 + echo 可装可卸、12 生产级过故障注入、Linux 全矩阵 smoke、三处文案一致、资源达标；打 `v1.0.0` | 同上；新增 cgroup 硬上限与三平台限额降级明示 | 70–95 | 三平台与 6 插件同时收口；Windows 隔离弱；对象存储凭据 |
| M5 | 生态开放 | 签名、静态市场页、第三方 SDK、文档站 | `kore`：ed25519 校验 + 三平台分发（notarization/Authenticode/安装器）；`kore-plugins` 静态市场页；Go/Rust/Starlark SDK；文档站与示例插件 | 篡改包拒装；第三方按 SDK 30 分钟跑通 hello；市场页断网可开；M0–M4 门禁回归 | 主壳预算不变；新增公钥与文档站体积 | 30–40 | 密钥管理；SDK 与协议漂移；签名矩阵爆炸 |

## 4. 依赖图（仓库与里程碑关系）

```text
M0 文档与骨架（仅 kore 仓库）
   │ 口径/协议/预算/拓扑/对标矩阵冻结
   ▼
M1 Walking Skeleton
   kore（内核 + pkg/pluginapi 独立 module + internal/platform）
     ▲ 单向依赖 pkg/pluginapi
     ├── kore-plugin-echo（验证件）
     └── kore-plugins（空索引 + 校验脚本）
   ▼
M2 插件框架与商店（installer / preset / store / 商店 UI）
   ├── kore-plugin-site / -ssl / -backup（3 个核心插件仓库）
   └── kore-plugins：索引条目 + 8 个场景预设
   ▼
M3 对标第一批（+10 插件仓库）
   web: runtime-php / runtime-node / runtime-python
   data: db-mysql / db-postgres / redis
   ops:  file / cron / logs / monitor
   ▼
M4 对标第二批 + 三平台 = v1.0  ▲ 可与 M3 后半程并行的只有平台层（internal/platform windows 实现）
   sec: firewall / waf / ssh-guard / integrity
   app: app-deploy / dns（+ 对象存储备份 / 故障注入 / macOS+Windows runner）
   ▼
M5 生态开放（签名 / 市场页 / SDK / 文档站）

恒定方向：插件仓库 → kore/pkg/pluginapi；索引只读插件 release，不被任何仓库依赖；
kore 仓库内部：cmd/kored → internal/core/* → internal/platform/*；core 禁止 import 插件仓库（G-13）。
```

## 5. 插件族与里程碑映射

产品插件 **20 个**（12 生产级 + 8 基础级）+ 验证件 `echo` 1 个 = **21 个插件仓库**。

| 插件族 | 插件 | 仓库数 | 里程碑 |
| --- | --- | --- | --- |
| web | `site`、`ssl` | 2 | M2 |
| web | `runtime-php`、`runtime-node`、`runtime-python` | 3 | M3 |
| data | `backup` | 1 | M2 |
| data | `db-mysql`、`db-postgres`、`redis` | 3 | M3 |
| ops | `file`、`cron`、`logs`、`monitor`、`container` | 5 | M3 |
| sec | `firewall`、`waf`、`ssh-guard`、`integrity` | 4 | M4 |
| app | `app-deploy`、`dns` | 2 | M4 |
| 验证件 | `echo`（非产品，M1 后保留为回归夹具） | 1 | M1 |

深度分级（G-20，商店与对标矩阵必须展示等级）：

- **生产级 12 个**：`site`、`ssl`、`runtime-php`、`db-mysql`、`file`、`backup`、`cron`、`logs`、`monitor`、`firewall`、`redis`、`app-deploy`。
- **基础级 8 个**：`runtime-node`、`runtime-python`、`db-postgres`、`waf`、`ssh-guard`、`integrity`、`dns`、`container`。基础级的边界用例延 v1.1。
- **验证件 `echo`**：独立仓库，不计入商店评级、不属于 12/8 任何一档，G-20 对它不适用。

分布：M1 1 个（echo）；M2 3 个产品插件；M3 +11；M4 +6；M5 不减不增（只做签名与分发、基础级升生产级）。22 项能力域由 20 个产品插件覆盖（runtime / db 族各覆盖多个域），另有 6 项明确不做（§14）。每个插件仓库自带 `info.json`（`depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore`）、`Makefile` 的 `dist`、`CHANGELOG.md`、独立 CI（G-17）。对标矩阵（`docs/FEATURE-PARITY.md`）的每一行必须映射到上表某个插件，或明确写"不做 + 理由"。

## 6. 工程量现实（按红队重算）

- **结论先行**：纯插件 **288–488 人日**，v1 总盘 **432–650 人日**。此前 224–302 的估算系**低估 2.1 倍**，已按 red-team-2 重算，不再沿用乐观值。
- **分级**：20 个产品插件仓库 = **12 生产级 + 8 基础级**，另有 `echo` 验证件 1 个（不参与评级）；基础级的边界用例延 v1.1。单插件区间：生产级 **12–35 人日**、基础级 **8–20 人日**。

| 分项 | 数量 | 单插件区间（人日） | 排期均值（人日） | 小计（人日） |
| --- | --- | --- | --- | --- |
| 生产级插件 | 12 | 12–35 | 16–30 | 192–360 |
| 基础级插件 | 8 | 8–20 | 12–16 | 96–128 |
| **纯插件合计** | 20 | — | — | **288–488** |
| 内核 / 商店 / 预设 / 索引 / 平台层 | — | — | — | 144–162 |
| **v1 总盘** | — | — | — | **432–650** |

- **排期用迭代轮次，不用日历承诺**：一轮 = 一个 Kore Loop 周期（提案 → 双评审 → 拆解 → 实现 → 验证 → 蓝军 → 归档复盘）。人日只用于相对比较，**agent 并行度决定墙钟时间**。轮次区间：M0 2–3、M1 4–6、M2 10–14、M3 16–22、M4 18–24、M5 14–18（合计 64–87 轮）。
- **并行上限**：同一里程碑内最多 4 个插件仓库并行，20 个产品插件按 M2 3 → M3 11 → M4 6 分批。
- **预算硬约束不因插件变多而放松**：同时常驻 ≤3、合计 ≤24 MiB，M3 起绝大多数插件必须是 `lazy`/`oneshot`，排期必须同步产出常驻/按需分配表。
- **诚实边界**：对标的是**功能覆盖面，不是同等资源占用**。同类面板常驻数百 MiB、多进程；kore 目标空载 ≤1 个进程（仅 `kored`）+ 同时常驻插件 ≤3。功能对齐不等于资源对齐，任何以"专业版也这么占"为由抬高预算的提案直接驳回。

## 7. 里程碑明细

### 7.1 M0 文档与骨架（仅 `kore` 仓库）

- **目标**：冻结五锚点、内核规则、协议、预算、数据/前端模型、多仓库拓扑、三平台基线与 v1 对标矩阵；建立 `kore` 骨架与门禁；不创建任何插件仓库或索引仓库。
- **交付物**：`docs/` 15 篇（含 `FEATURE-PARITY.md`、`PLUGIN-CATALOG.md`、`SCENARIOS.md`、`COMPATIBILITY.md`、`REPOS.md`）+ ADR 0001–0014；`AGENTS.md`、`README.md`、`.agents/`；`Makefile`、`scripts/docs-check.sh`；空骨架 `cmd/kored/`、`internal/core/*`、`pkg/pluginapi/`、`web/`。
- **退出条件**：`make docs-check` 退出码 0；三层验收全绿；拓扑、三平台、对标矩阵三处表述与 `REPOS.md` / `COMPATIBILITY.md` / `FEATURE-PARITY.md` 一致；对标矩阵每行有插件映射或"不做 + 理由"；空载进程数与空闲 CPU 不适用（M0 无进程），M1 起按 §9 门禁。
- **明确不做**：任何 Go 可执行代码、前端构建、插件/索引仓库创建、发布二进制。
- **风险与缓解**：口径漂移 → `docs-check` 关键口径 + verifier 交叉核对；对标矩阵与插件目录脱钩 → 两者由同一 ADR 定稿。

### 7.2 M1 Walking Skeleton（3 仓库）

- **目标**：打通"内核可跑（Linux 全功能）→ SDK 独立 module → 插件仓库独立构建/打包 → kore 加载"，建立索引骨架，平台差异收敛到 `internal/platform` 五接口（本阶段只实现 Linux）。
- **交付物**：`kore`（`cmd/kored`、`internal/core/*`、`internal/platform` 五接口 + Linux、`pkg/pluginapi` 嵌套 module、`web/` 壳、`bin/kored`、HTTP API 13 端点 + `/-/healthz`）；`kore-plugin-echo` 完整仓库；`kore-plugins` 空索引 + 校验脚本。
- **退出条件**：二进制 ≤25 MiB；内存红队判据三件齐全且 ≤8192 KiB（GOGC 双档 × 60s×60 点中位数 × `smaps` 拆 `RssAnon`/`RssFile`）；`/-/healthz` 200 与未登录 401；echo 独立仓库 `make dist` + kore 安装后 `POST /api/v1/invoke/echo/ping` 返回 `pong`；改 `internal/core` 不影响 echo 编译；无 systemd 容器内可启动；交叉编译 windows/darwin 通过；`GOAMD64=v1` 可见；空载进程数 ≤1（仅 `kored`，echo 常驻另计 ≤1）、空闲 CPU ≤0.1%（60s 累计 ≤60ms）、goroutine ≤20；**启动到就绪 ≤1s**（`kored` 进程启动 → `GET /-/healthz` 返回 200，**不含插件 ready**——插件 lazy、按需拉起）；**API p95 ≤50ms（本地）**（对 `GET /api/v1/self` 或 `GET /api/v1/system/info` 连续 200 次取 p95）；lazy 冷启动 p95 ≤300ms（M1 无 lazy 插件、echo 为 resident，该判据 **M2 起生效**）。
- **明确不做**：产品插件、商店、预设、macOS/Windows 运行时实现（只保证交叉编译）。
- **风险与缓解**：SDK module 拆分导致 import 路径变更 → ADR-0011 + 单测；调优方向错判 → `GOMEMLIMIT=6MiB` 守上限，GOGC 调高反而放大堆峰值，实测仍超则降 `GOGC=50` 重测。

### 7.3 M2 插件框架与商店（4 仓库）

- **目标**：内核从"能装一个插件"升级为"有商店、有预设、可自管安装/更新/卸载"，并用 3 个核心插件验证；首次安装按 8 个场景预设一键装批。
- **交付物**：`kore`（installer、preset 引擎、store 模块、能力校验、SSE、商店 UI：分类/搜索/依赖提示、前端管理中心、macOS darwin 实现）；`kore-plugin-site` / `-ssl` / `-backup`；`kore-plugins`（索引条目 + 8 个 `presets/*.json` + 校验脚本）。
- **退出条件**：8 个预设在干净环境一键安装可复现（同一预设两次安装结果一致）；3 插件独立 `make dist` 且 kore 安装/卸载/回滚可验；索引 sha256 与发布物一致；同时常驻 ≤3、常驻合计 ≤24 MiB；macOS 12+ runner 跑通 install → hello → invoke → uninstall（capability report 标 `cgroup=unlimited`）；空载进程数 ≤1、空闲 CPU ≤0.1%（60s ≤60ms）。
- **明确不做**：web/data/ops/sec/app 其余 16 个插件、Windows 运行时、对象存储备份、签名、市场页。
- **风险与缓解**：预设与插件版本区间耦合 → 预设进 G-18 校验（id/区间可解析、合计资源达标）；商店离线部署 → 索引与包全部本地可解析，不依赖公网。

### 7.4 M3 对标第一批（11 个插件仓库）

- **目标**：把 web / data / ops 三族补齐到"能对标专业版日常使用"，并验证 10 个仓库并行开发的写域与依赖治理。
- **交付物**：`runtime-php`、`runtime-node`、`runtime-python`、`db-mysql`、`db-postgres`、`redis`、`file`、`cron`、`logs`、`monitor`、`container` 十一个插件仓库（container 为宿主已有容器/服务管理，不内置容器运行时）；`kore-plugins` 索引扩容；商店分类/搜索/依赖提示可用。
- **退出条件**：11 插件全部经商店安装/卸载/回滚；同时常驻 ≤3、常驻合计 ≤24 MiB（其余默认 `lazy`，空闲 300s 退出，冷启动 p95 ≤300ms）；空载进程数 ≤1、空闲 CPU ≤0.1%；插件间 `depends_on` / `conflicts` 生效；索引 sha256 一致；11 个仓库 CI 全绿。
- **明确不做**：sec/app 两族、Windows、对象存储备份、v1 tag。
- **风险与缓解**：11 仓库并行写域冲突 → 每仓库独立 agent 轨道与 CI，同里程碑最多 4 仓库并行；合计内存逼近上限 → 提前定常驻/按需分配表。

### 7.5 M4 对标第二批 = v1.0（6 个插件仓库 + 三平台）

- **目标**：补齐 sec / app 两族与对象存储备份、故障注入、三平台，满足 v1.0 gate 并打 `v1.0.0`。
- **交付物**：`firewall`、`waf`、`ssh-guard`、`integrity`、`app-deploy`、`dns` 六个插件仓库；备份到对象存储；`tests/fault`（kill -9 插件 / 主壳重启 / 磁盘满）；`internal/platform` windows 实现（AF_UNIX / SCM / Job Objects / HMAC）；cgroup 隔离、热升级、日志轮转、systemd unit；三平台分发脚本。
- **退出条件**：**v1.0 gate 逐条取证**：20 个产品插件仓库（12 生产级 + 8 基础级）+ 1 个验证件仓库均可装可卸、**12 个生产级全部通过故障注入**、Linux 全矩阵 smoke（10 发行版 + arm64）、三处文案口径一致、同时常驻 ≤3 + 合计 ≤24 MiB、空载进程数 ≤1 + 空闲 CPU ≤0.1%、cgroup 超限只杀插件、SELinux/AppArmor 启动通过；macOS/Windows 只要求 preview（交叉编译 + 基础链路，**不计入 gate**）；全部满足后打 `v1.0.0`。
- **明确不做**：签名、市场页、SDK（留 M5）。
- **风险与缓解**：6 插件与三平台同时收口 → 平台层提前在 M3 后半程并行；Windows 隔离弱 → capability report 明示，不假装等价。

### 7.6 M5 生态开放 = v1.1

- **目标**：把 8 个基础级插件升为生产级、macOS/Windows 转 GA，并让第三方能安全地"写插件、发插件、信任插件"：签名、静态市场页、SDK、文档站。
- **交付物**：8 个基础级插件的生产级改造（边界用例 + 故障注入）；macOS/Windows GA（全链路 + 分发）；`kore` 的 ed25519 校验与三平台分发（notarization / Authenticode / 安装器）；`kore-plugins` 静态市场页（由索引生成，无后端/无账号）；Go / Rust / Starlark SDK；文档站与示例插件。
- **退出条件**：篡改包被拒装；第三方按 SDK 30 分钟跑通 hello 与业务方法；市场页断网可开、无外部请求；三平台分发各跑通"下载 → 校验签名 → 安装 → 启动"；macOS/Windows 全链路 GA；8 基础级插件全部过故障注入；空载进程数 ≤1、同时常驻 ≤3、空闲 CPU ≤0.1%；M0–M4 门禁回归；打 `v1.1.0`。
- **明确不做**：在线市场后端、审核流程、账号体系、多租户 SaaS。
- **风险与缓解**：密钥管理 → 公钥进配置、私钥不入库不入镜像；SDK 与协议漂移 → 版本与 `kore.plugin.v1` 联动校验。

## 8. 质量随里程碑升级表

| 门禁维度 | M0 | M1 | M2 | M3 | M4 | M5 |
| --- | --- | --- | --- | --- | --- | --- |
| 文档一致性与互链 | 强制（docs-check，仅 kore） | 强制 | 强制 | 强制 | 强制 | 强制 |
| 仓库边界（G-13） | 拓扑表述一致 | `make repo-check` 强制 | 强制 | 强制 | 强制 | 强制 |
| 协议兼容（G-14） | `requires_kore` 写入协议 | echo 声明并校验 | 3 插件声明并校验 | 13 插件声明并校验 | 19 插件 + 兼容矩阵 | SDK 联动校验 |
| 插件仓规范（G-17） | 不适用 | echo 三件套 | 3 插件三件套 | 13 插件三件套 | 19 插件三件套 | 第三方模板 |
| 深度等级（G-20） | 不适用 | echo 验证件（不评级） | 3 生产级 / 0 基础 | 10 生产 / 4 基础 | 12 生产 / 8 基础验收 | 8 基础升生产 |
| 预设一致性（G-18） | 不适用 | 不适用 | 8 预设可解析 | 8 预设覆盖新插件 | 预设可装 20 个产品插件 | 市场页展示预设 |
| 跨仓库变更集（G-15） | 不适用（单仓库） | 从 echo 起登记 | 强制 | 强制（11 仓库） | 强制 | 强制 |
| 单元测试 | 不适用 | 新增路径必测 | 核心链路 + store/preset | 全量 + 插件契约 | 全量 + 故障用例 | 全量 + SDK 用例 |
| 内存门禁（空载 RSS） | 口径冻结 | 红队判据 ≤8 MiB | ≤8 MiB | ≤8 MiB | ≤8 MiB + cgroup 实测 | 同 M4 |
| 体积门禁（二进制/首屏） | 不适用 | ≤25 MiB / ≤300 KiB gzip | 同 M1 | 同 M1 | 同 M1 | 同 M1 |
| 插件合计内存 | 不适用 | ≤12 MiB | ≤24 MiB | ≤24 MiB（含分配表） | ≤24 MiB | ≤24 MiB |
| 同时常驻插件数 | 0 | ≤1 | ≤3 | ≤3 | ≤3 | ≤3 |
| 空闲 CPU | 不适用 | ≤0.1% | ≤0.1% | ≤0.1% | ≤0.1% | ≤0.1% |
| 三平台 | 基线冻结 | Linux 全功能 + 交叉编译 | + macOS 全链路 | Linux 全矩阵 | + Windows 全链路 | 三平台分发 |
| 故障注入 | 不适用 | 插件 kill -9 | 安装失败回滚 | 插件崩溃/超时 | 主壳重启 + 磁盘满 | 同 M4 |
| 蓝军复审与复盘 | 每轨一次 | 每 Sprint 一次 | 每 Sprint 一次 | 每插件至少一次 | 每故障场景一次 | 每 Sprint 一次 |

## 9. 资源预算演进表（门禁级）

硬预算为门禁级：任何里程碑降低预算需 ADR，抬高预算一律不批。**插件包单包 ≤15 MiB**；同时常驻插件 ≤3，其余必须 `lazy` 或 `oneshot`。

| 里程碑 | 主壳空载 RSS | 同时常驻插件数 | 常驻插件合计 | 空闲 CPU | 空闲 goroutine | 单二进制 | 插件包 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M0 | 口径冻结（无运行时代码） | 0 | — | — | — | — | — |
| M1 | ≤8 MiB（目标 5–6；`GOGC=100` + `GOMEMLIMIT=6MiB`） | ≤1（echo） | ≤12 MiB | ≤0.1%（60s ≤60ms） | ≤20 | ≤25 MiB | ≤15 MiB |
| M2 | ≤8 MiB | ≤3 | ≤24 MiB | ≤0.1% | ≤20 | ≤25 MiB | ≤15 MiB |
| M3 | ≤8 MiB | ≤3（其余 lazy/oneshot） | ≤24 MiB | ≤0.1% | ≤20 | ≤25 MiB | ≤15 MiB |
| M4 | ≤8 MiB | ≤3 | ≤24 MiB | ≤0.1% | ≤20 | ≤25 MiB | ≤15 MiB |
| M5 | ≤8 MiB | ≤3 | ≤24 MiB | ≤0.1% | ≤20 | ≤25 MiB | ≤15 MiB |

补充硬约束（全里程碑）：

- **零轮询**：无周期定时器；插件状态用事件驱动 + 按需唤醒（心跳与健康检查不算业务轮询）。
- **空载出站 0**：无任何主动外连；索引与包全部本地解析。
- **生命周期三态**：`resident`（常驻，计入 ≤3 配额）/ `lazy`（默认；空闲 300s 退出，冷启动 p95 ≤300ms）/ `oneshot`（一次性，空闲 RSS=0）。常驻与 lazy 的分配表随 M2 起每个里程碑维护。

## 10. 发布与回滚策略

- **主壳发布（kore）**：`CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o kored ./cmd/kored`；写入 `/usr/local/bin/kored.new` 后 rename 覆盖，`systemctl restart kore`，复跑 `/-/healthz` 与内存采样。
- **插件发布（各插件仓库）**：独立 tag → `make dist` → `<id>-<version>.tar.gz` + sha256 → release；`info.json` 必须含 `requires_kore` / `depends_on` / `scenario_tags`。
- **预设与索引发布（kore-plugins）**：更新 `index/plugins.json` 与 `presets/*.json` → `make presets-check` / 校验脚本通过 → 独立 tag；不做审核、不代管包、无账号。
- **兼容矩阵**：M3 起每次发布前跑矩阵（kore N/N-1 × 插件版本 × `requires_kore`），矩阵不通过不发版；M4 起叠加三平台 smoke。
- **回滚条件（任一命中即回滚并冻结发布）**：空载 RSS 超 8 MiB 连续 3 次采样；崩溃重启 ≥3 次/10 分钟；鉴权回归；插件安装/启用失败率 >5%；预设装不起来；索引 sha256 与发布物不符；`state.db` 迁移不可逆；越权或签名绕过。
- **版本保留**：`kore` 保留当前 + 上一版 2 个二进制（`/usr/local/lib/kore/kored-<version>`）；每个插件保留 2 个版本；索引与预设保留上一版；`state.db` 升级前备份。
- **回滚顺序**：停服 → 换回主壳 → 恢复 DB（如需）→ 按变更集逆序回退插件与索引/预设 → 起服 → 复跑该里程碑门禁 → 复盘入 `.agents/`。

## 11. 里程碑变更规则

- 改动里程碑范围、交付物、仓库清单或退出条件，必须同时产出 ADR（编号自 0013 续起）+ 一次 Kore Loop 复盘；缺一不生效。
- **重排留痕**：M0–M5 结构由 lead 2026-11-21 裁决重排（原 M4 拆为 M4/M5，v1.0 gate 移到 M4），记录在 `docs/DECISIONS/0012-*` 与本次复盘；ADR 编号不重排。
- **仓库拓扑变更**（新增/合并/拆分仓库、改 module、改 R1–R8）必须先改 `ADR-0008` 与 `docs/REPOS.md`，再改本文件与 PLAN。
- **禁止静默加需求**：新需求只进 backlog；对标矩阵新增一行必须同时指定"哪个插件 / 哪个里程碑 / 资源从哪来"。
- 里程碑编号 M0–M5 固定，不得新增、不得重排；变更涉及预算/协议/目录/路径需 architect + verifier 双签。

## 12. 风险登记（范围 / 跨仓库 / 兼容性）

| 风险 | 概率 | 影响 | 缓解 | 触发信号 |
| --- | --- | --- | --- | --- |
| 21 个插件仓库（20 产品 + echo）的跨仓库版本矩阵爆炸 | 高 | 高 | 只保障最近两个 minor；矩阵自动化生成；插件少而深，不追求数量 | 矩阵组合未覆盖或旧插件装不上 |
| 场景预设与插件版本区间耦合 | 高 | 高 | 预设进 G-18 校验：id/区间可解析、合计资源达标；预设与索引同 tag 发布 | 预设一键安装失败或装出超预算组合 |
| 商店离线 / 内网部署 | 中 | 高 | 索引与包全部本地可解析，不依赖公网；离线导入包路径有测试 | 断网环境下装不上或索引 404 |
| 单管理员模型与专业版多用户功能的差距 | 高 | 中 | 文档明示差异（不做多租户/多用户 RBAC），对标矩阵写"不做 + 理由"，不假装对齐 | 销售/文档把单管理员说成多用户 |
| 协议包破坏性变更打断所有插件仓库 | 中 | 极高 | `pkg/pluginapi` 独立 module + 版本线；破坏性改动需主版本递增 + ADR | 任一插件 `make build` 或 hello 协商失败 |
| 多仓库联调成本（`go.work` / 本地路径） | 高 | 中 | `go.work` 仅本地且不提交；插件 `go.mod` 只允许 tag 依赖 | 本地通过、按 tag 构建失败 |
| 索引条目与发布物脱钩 | 中 | 高 | sha256 由 `dist` 产物写入；校验脚本进发布门禁 | 三处 sha256 不一致 |
| 插件越权（6 特权 + 插件自有能力校验漏检） | 中 | 高 | 能力校验单测 + red-team 越权用例 | 越权调用返回 200 |
| 常驻插件合计逼近 24 MiB / 常驻数超 3 | 高 | 中 | 生命周期三态：`resident` 只留必要项，其余 `lazy`（默认，300s 退出）或 `oneshot`；超限即降级并出分配表 | 合计超 24 MiB、单插件超 12 MiB 或同时常驻 >3 |
| 主壳 RSS 超 8 MiB | 中 | 高 | 依赖白名单、延迟初始化、每 Sprint 红队判据卡点 | 内存三件任一超 8192 KiB |
| 开发节奏低估（对标专业版的工作量） | 高 | 高 | 工程量按 432–650 人日 / 64–87 轮排；单插件生产级 12–35、基础级 8–20 人日；同里程碑最多 4 插件并行 | 轮次燃尽持续为 0 或反复顺延 |
| 基础级插件质量事故 | 中 | 高 | `depth_level=basic` 必须在商店与对标矩阵明示；不进"开箱可用"预设；核心路径 + 基本错误处理 DoD；事故不静默升生产 | basic 插件被预设标为开箱可用，或线上故障 |
| v1.1 升级进度落后 | 高 | 中 | 8 个基础级升级单列里程碑与轮次（M5 14–18 轮）；每轮跟踪升级进度指标 | M5 中后期仍有 >4 个基础级未升 |
| 迁移导入缺失导致宝塔用户迁移成本高 | 高 | 高 | v1 明确不做一键迁移导入；文档给出"手工迁移清单"，v1.1 评估导入器 | 用户反馈"无法从宝塔迁过来" |
| 发行版 cgroup 挂载差异 | 高 | 中 | 启动探测 capability report；v1 只监督不硬限并明示 | RHEL 8 上无法创建 slice |
| `lazy` 冷启动在低配机器上超 300ms | 高 | 中 | 常驻/懒加载分档；冷启动预算进每个插件任务验收（p95 ≤300ms）；超限插件降级为 resident 需走 ADR | 低配 runner 上冷启动 p95 >300ms |
| 冷启动风暴（并发唤醒同一插件） | 中 | 高 | 单插件单飞（single-flight）唤醒 + 唤醒排队；压测并发 50 次唤醒 | 同一插件被并发拉起多个进程或排队超时 |
| 常驻配额抢占导致频繁升降级 | 中 | 中 | 常驻 ≤3 由配置固定，不按运行时内存动态抢占；升降级只由管理员或预设变更触发 | 日志出现频繁 resident↔lazy 切换 |
| Alpine 无 systemd 导致进程管理退化 | 中 | 中 | 降级为 `kored` 自管进程树；systemd 专属能力标记不可用 | Alpine smoke 失败或插件无法回收 |
| SELinux 拦截写 `/run/kore` | 中 | 高 | 提供 `kore.te`；启动失败明确错误；M4 在 enforcing 下验证 | enforcing 下 permission denied |
| Windows 隔离强度弱于 Linux（同用户） | 高 | 高 | capability report 标 `isolation=weak`；插件 HMAC 身份校验；文档明示 | 安全评审把 Windows 当等价隔离 |
| macOS 无法强制内存限额 | 中 | 中 | 只观测并标 `unlimited`；不宣称 12/24 MiB 硬预算 | macOS 插件 RSS 超预算且无提示 |
| 三平台服务集成测试成本 | 高 | 中 | runner 清单脚本化；M1 Linux、M2 加 macOS、M4 加 Windows | 发版需人工拼三平台 runner |
| AF_UNIX 在 Windows 上的稳定性未知 | 中 | 高 | M4 试点；不可用时必须 ADR 决定替代传输，禁止静默降级 | Windows runner 连接偶发失败 |
| 签名密钥管理失控 | 低 | 高 | 公钥进配置、私钥不入库不入镜像 | 未签名包被放行 |

## 13. 三平台兼容矩阵与验证节奏

兼容性不是一句"要兼容"：目标是**同一个静态二进制**在 Linux（Tier A，glibc/musl、systemd/OpenRC/无 init、cgroup v1/v2、SELinux/AppArmor）、macOS 12+（Tier B）与 Windows 10 1809+/Server 2019+（Tier B）上都能启动；能力缺失按**降级矩阵**降级并明示，禁止静默降级（G-16）。平台差异收敛在 `internal/platform` 五接口之后，`internal/core` 不得直接调用平台专有 API。

### 13.1 三平台矩阵

| OS | 最低版本 | 架构 | 传输 | 资源限制 | 服务 | 验证里程碑 |
| --- | --- | --- | --- | --- | --- | --- |
| Linux（Tier A） | 内核 4.18+；Alpine 3.19+ | amd64, arm64 | UDS（AF_UNIX，`SO_PEERCRED`） | cgroup v2（v1 降级为只观测） | systemd / OpenRC（无 systemd 时自管） | M1 全功能 → M3 全矩阵 |
| macOS（Tier B） | 12 (Monterey)+ | arm64, amd64 | UDS（AF_UNIX，`LOCAL_PEERCRED`） | 无强制内存限额，仅观测并标 `unlimited` | launchd | M2 跑通全链路 |
| Windows（Tier B） | 10 1809+ / Server 2019+ | amd64 | AF_UNIX（Win10 1809+） | Job Objects（隔离强度弱于 Linux） | SCM 服务 | M4 跑通全链路 |

### 13.2 Linux 发行版明细（Tier A）

| 发行版 | 内核 | cgroup | init | 验证状态 |
| --- | --- | --- | --- | --- |
| Ubuntu 20.04 LTS | 5.4 | v1（默认）/ v2（可选） | systemd 245 | M2 起验证 |
| Ubuntu 22.04 LTS | 5.15 | v2 | systemd 249 | M1 验证（glibc 基线） |
| Ubuntu 24.04 LTS | 6.8 | v2 | systemd 255 | M2 起验证 |
| Debian 11 | 5.10 | v1（默认）/ v2（可选） | systemd 247 | M2 起验证 |
| Debian 12 | 6.1 | v2 | systemd 252 | M1 验证（glibc 基线） |
| Rocky / Alma / RHEL 8 | 4.18 | v1（默认）/ v2 需启用 | systemd 239 | M2 起验证 |
| Rocky / Alma / RHEL 9 | 5.14 | v2 | systemd 252 | M2 起验证 |
| Fedora 38+ | 6.2+ | v2 | systemd 253+ | M3 全矩阵 |
| openSUSE Leap 15.5+ | 5.14 | v2 | systemd 249 | M3 全矩阵 |
| Alpine 3.19+ | 6.6 | v2 | OpenRC（无 systemd） | M1 验证（musl + 无 systemd） |

降级规则（探测 → 明确降级）：cgroup v1/未挂载 → 只监督并标 `cgroup=degraded`；无 systemd → 自管进程树；macOS → 标 `cgroup=unlimited` 且不宣称硬预算；Windows → 标 `isolation=weak`；SELinux/AppArmor 拦截 → 启动失败给明确错误码；OS 低于下限 → 退出码 6。

### 13.3 验证节奏

| 阶段 | 平台与镜像 | 执行方式 |
| --- | --- | --- |
| M1 | Linux 3 镜像（Ubuntu 22.04 / Debian 12 / Alpine 3.19）+ `GOOS=windows/darwin go build ./...`（只编译） | `scripts/compat-smoke.sh` + `make cross`，每次发布前 |
| M2 | Linux 6 镜像 + macOS 12+ runner（install → hello → invoke → uninstall） | 同上 + macOS runner |
| M3 | Linux 全矩阵 10 + QEMU arm64（`GOARM64=v8.0`） | 同上，结果写入发布说明 |
| M4 | Linux 全矩阵 + macOS runner + Windows 10 1809+/Server 2019+ runner + SELinux/AppArmor | 同上，作为 v1.0 gate 的一部分 |
| M5 | 同 M4 + 三平台分发（notarization / Authenticode / 安装器） | 每发布前一轮 |

未通过的平台/镜像不得发版，除非该目标被 ADR 明确移出支持范围；矩阵结果（通过数 / 总数）是发布门禁的一部分。

### 13.4 非目标保护（容器不是产品依赖）

- **产品内不引入任何容器运行时**：kore 交付物是静态单二进制 + 插件包，不依赖 Docker / Podman / containerd。
- **CI 用容器 ≠ 产品依赖容器**：目标镜像只作测试夹具，不得成为安装前提。
- 不支持 Windows < 10 1809、Windows Server < 2019、macOS < 12、32 位架构：启动返回退出码 6。
- 不做发行版专属分支、不强制依赖发行版包管理器；Tier A 同一二进制覆盖全部 Linux 支持矩阵。

## 14. 对标诚实性

**口径**：覆盖 **22 项能力域：12 个生产级 / 8 个基础级 / 6 项明确不做**。禁用"完全·对标"式表述；全仓 `grep -rnE "完全.{0,1}对标"` 必须零命中（ADR-0014 里"被拒备选"的叙述除外）。22 项能力域由 20 个插件覆盖（runtime / db 族各覆盖多个域），另 6 项明确不做。

### 14.1 能力域状态表

| 等级 | 插件 / 能力域 | 覆盖内容 | v1.1 去向 |
| --- | --- | --- | --- |
| 生产级 | `site` | 站点 / 域名绑定 / 反向代理 | 保持 |
| 生产级 | `ssl` | 证书申请 / 续期 / 部署 | 保持 |
| 生产级 | `runtime-php` | PHP 运行时 / 版本切换 | 保持 |
| 生产级 | `db-mysql` | MySQL 安装 / 库管理 | 保持 |
| 生产级 | `file` | 文件管理 | 保持 |
| 生产级 | `backup` | 本地备份 / 恢复 | 保持 |
| 生产级 | `cron` | 计划任务 | 保持 |
| 生产级 | `logs` | 日志查看 / 轮转 | 保持 |
| 生产级 | `monitor` | 监控概览 | 保持 |
| 生产级 | `firewall` | 防火墙规则 | 保持 |
| 生产级 | `redis` | Redis 实例管理 | 保持 |
| 生产级 | `app-deploy` | 应用部署流水 | 保持 |
| 基础级 | `runtime-node` / `runtime-python` / `db-postgres` | Node/Python 运行时、PostgreSQL（核心路径） | 升生产级 |
| 基础级 | `waf` / `ssh-guard` / `integrity` / `dns` / `container` | WAF、SSH 防护、完整性、DNS、宿主容器管理（核心路径） | 升生产级 |
| 验证件 | `echo` | 协议验证件（不参与商店评级，G-20 不适用） | 保持夹具 |
| 不做 | 多用户 RBAC | v1 单管理员模型，差距在 README 明示 | 需重开 ADR |
| 不做 | 集群 / 多机 | 非目标，需重开 ADR | 不排期 |
| 不做 | 模板市场 | 非目标 | 不排期 |
| 不做 | 厂商云存储深度集成 | 只做 S3 兼容对象存储 | 不排期 |
| 不做 | 拖拽建站 | 非目标 | 不排期 |
| 不做 | 多语言 i18n | MVP 仅中文 | 不排期 |

### 14.2 三处文案一致

README 首段、商店首屏、安装器欢迎页必须使用同一句口径："覆盖 22 项能力域（12 生产级 / 8 基础级 / 6 不做）；v1.0 = Linux GA，macOS/Windows 为 preview"。任一处的等级/数量与本表不一致即视为发布阻断项；CI 断言 `grep -rnE "完全.{0,1}对标"` 零命中（ADR-0014 除外）。

### 14.3 v1.1 提升路径

8 个基础级插件补边界用例与故障注入 → 升生产级（G-20 要求 `tests/fault/`）→ macOS/Windows 全链路 GA → 签名 / 市场页 / SDK。**升生产级前，商店与对标矩阵不得标"生产级"**；升级进度按轮次跟踪（M5 14–18 轮）。
