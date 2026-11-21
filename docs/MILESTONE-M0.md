> 状态: draft · 归属: lead · 更新: 2026-11-21 · 里程碑: M0

# M0 里程碑 · 文档与骨架

M0 的唯一目标是把 kore 的地基口径固化成可执行文档与仓库骨架：五锚点、内核规则、插件协议、资源硬预算、数据与前端模型、多仓库拓扑、14 篇 ADR、三平台兼容基线、v1 对标矩阵、agent 协作契约、门禁脚本。**M0 交付范围只有 `kore` 仓库**（文档 + 骨架 + 门禁），不含任何插件仓库与索引仓库；不含业务代码，验收全部落在"文件存在 + 内容一致 + 命令可判定"三件事上。

## 1. 交付物清单（文件级）

勾选权归 verifier：G1 独立验收通过后由 verifier 逐项勾选，交付者不自我勾选。行数目标与 `scripts/docs-check.sh` 的行数口径（`docs/*.md` 100–400，`MILESTONE-M0.md` 60–400）相容。

### 轨道 A · 愿景 / 总架构 / 内核规格 / 术语（architect）

- [ ] `docs/VISION.md` — 150–300 行 — architect
- [ ] `docs/ARCHITECTURE.md` — 200–300 行 — architect
- [ ] `docs/CORE.md` — 200–300 行 — architect
- [ ] `docs/GLOSSARY.md` — 60–120 行 — architect
- [ ] `docs/COMPATIBILITY.md` — 150–300 行 — architect（三平台矩阵 / Linux 明细 / 降级规则 / 验证节奏）
- [ ] `docs/FEATURE-PARITY.md` — 150–300 行 — architect（对标矩阵：每行 → 实现插件或"不做 + 理由"）
- [ ] `docs/PLUGIN-CATALOG.md` — 150–300 行 — architect（插件族 / 仓库数 / 里程碑映射，总数 18–22）
- [ ] `docs/SCENARIOS.md` — 150–300 行 — architect（8 个场景预设：插件清单 / 版本区间 / 资源合计）
- [ ] `docs/REPOS.md` — 150–300 行 — architect（仓库清单 / R1–R8 / 本地联调 / 兼容矩阵 / 创建清单）
- [ ] `docs/V1-GOALS.md` — 120–200 行 — architect（v1.0 九类目标 / gate 定义 / 里程碑映射 / 防稀释机制）

### 轨道 B · 插件协议 / 资源模型 / 数据模型（architect）

- [ ] `docs/PLUGIN-PROTOCOL.md` — 200–400 行 — architect
- [ ] `docs/RESOURCE-MODEL.md` — 150–250 行 — architect
- [ ] `docs/DATA-MODEL.md` — 150–250 行 — architect

### 轨道 C · 前端 / 安全 / 14 篇 ADR（architect）

- [ ] `docs/FRONTEND.md` — 150–300 行 — architect
- [ ] `docs/SECURITY.md` — 150–250 行 — architect
- [ ] `docs/DECISIONS/0001-*.md` … `docs/DECISIONS/0014-*.md` — 每篇 40–120 行，共 14 篇 — architect（0009 兼容基线、0010 跨平台、0011 SDK module、0012 商店预设、0013 极致资源、0014 v1 范围与深度分级）

### 轨道 D · 路线图 / 执行计划 / M0 清单（lead）

- [ ] `docs/ROADMAP.md` — 150–350 行 — lead
- [ ] `docs/PLAN.md` — 150–350 行 — lead
- [ ] `docs/MILESTONE-M0.md` — 150–350 行 — lead

### 轨道 E · 协作入口与 agent 管理架构（scribe）

- [ ] `AGENTS.md` — 60–180 行 — scribe
- [ ] `README.md` — 80–200 行 — scribe
- [ ] `.agents/README.md` — 60–160 行 — scribe
- [ ] `.agents/ROLES.md` — 80–200 行 — scribe
- [ ] `.agents/WORKFLOW.md` — 80–200 行 — scribe
- [ ] `.agents/BOARD.md` — 60–200 行 — scribe
- [ ] `.agents/QUALITY-GATES.md` — 60–200 行 — scribe
- [ ] `.agents/JOURNAL.md` — 40–120 行 — scribe
- [ ] `.agents/templates/` — 目录内至少 1 份模板 — scribe

### 轨道 F · 仓库骨架与门禁脚本（implementer）

- [ ] `.gitignore` — 20–80 行 — implementer
- [ ] `.editorconfig` — 20–80 行 — implementer
- [ ] `Makefile` — 60–160 行，含 build/vet/test/frontend/mem/docs-check/check 等全部目标 — implementer
- [ ] `scripts/docs-check.sh` — 100–250 行，可执行位 0755 — implementer
- [ ] 骨架目录：`cmd/kored/`、`internal/core/{httpapi,auth,registry,supervisor,bus,store,config}/`、`pkg/pluginapi/`、`web/`、`docs/`、`.agents/` — implementer（**不得有 `plugins/` 目录**）

### 轨道 G · 一致性验收与首次提交准备（verifier）

- [ ] `.agents/verify/m0-consistency.md` — 60–200 行 — verifier
- [ ] `.agents/verify/m0-commit-plan.md` — 40–120 行 — verifier

## 2. 验收标准三层

### 2.1 机械验收（命令 + 期望输出）

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 文档门禁 | `bash scripts/docs-check.sh` | 退出码 0，末行含 `结果: 门禁通过` |
| 必需文件 | `find docs .agents -name '*.md' \| wc -l` | 16 项必需文件全部存在，且 docs-check 第 1 段为 PASS |
| ADR 数量 | `find docs/DECISIONS -maxdepth 1 -name '*.md' \| wc -l` | ≥ 14（0001–0014） |
| 元信息 | `head -n 5 docs/*.md` | 每份前 5 行含 `> 状态:` 且含 `里程碑: M0` |
| 相对链接 | `bash scripts/docs-check.sh`（3/6 段） | `断链 0 条` |
| 占位词 | `bash scripts/docs-check.sh`（4/6 段） | 该段 PASS：每份文档合计 ≤ 2 次 |
| 行数 | `wc -l docs/ROADMAP.md docs/PLAN.md docs/MILESTONE-M0.md` | 三份均在 150–350 |
| Makefile 目标 | `make help` | 列出全部目标，至少含 help / build / vet / test / frontend / mem / docs-check / check |

### 2.2 内容验收（章节齐全、数字与契约一致）

- `docs/ROADMAP.md` 十四节齐全：版本策略、仓库拓扑与规则、里程碑总览表（M0–M5）、依赖图、插件族与里程碑映射、工程量现实（红队重算）、里程碑明细、质量升级表、资源预算演进表、发布与回滚、变更规则、风险登记、三平台兼容矩阵与验证节奏、对标诚实性。
- `docs/PLAN.md` 九节齐全：执行原则、M0 WBS（覆盖 A–G 七轨，每项含产出文件/owner/验收/依赖，并声明 M0 不含插件仓库）、Sprint 1–12 + M5 概述、DoD 七维（代码/文档/资源/安全/跨仓库/兼容性/跨平台）+ 插件级 DoD、验收命令清单（含 `go work`）、并行写域、Kore Loop 节奏、度量指标、风险登记（≥8 条）。
- `docs/MILESTONE-M0.md` 五节齐全：本清单、三层验收、可执行清单、完成定义与交接、已知缺口与 M1 入口。
- 契约数字逐字一致：主壳空载 RSS `8 MiB`、常驻插件单 `12 MiB`、合计 `24 MiB`、同时常驻 ≤3、空闲 CPU ≤0.1%、插件包 `15 MiB`、单二进制 `25 MiB`、前端首屏 `300 KiB gzip`、帧上限 `8 MiB`、MVP `0.1.0`、协议 `kore.plugin.v1`；`kore` module 为 `github.com/kore-project/kore`（占位，见 `REPOS.md` / ADR-0008）。
- M0 边界：交付范围仅 `kore` 仓库；`kore-plugins` 与 `kore-plugin-echo` 属 M1，M0 不创建、不打包、不在 kore 内放插件代码。
- 运行时路径逐字一致：`/etc/kore/config.yaml`、`/var/lib/kore`、`/run/kore/kore.sock`、`/run/kore/plugins/<id>.sock`、`/var/log/kore/`、cgroup `/sys/fs/cgroup/kore/<id>.slice`。
- 角色固定 6 个：lead / architect / implementer / verifier / red-team / scribe；Kore Loop 七阶段：提案 → 双评审 → 拆解 → 实现 → 验证 → 蓝军 → 归档复盘（第 7 阶段同时产出 JOURNAL 记录与 ADR 归档）。按 lead 2026-11-21 裁决采用七阶段，与 AGENTS.md / .agents/WORKFLOW.md 一致；8 项仅为动作清单口径，不作为阶段数对外使用。
- 里程碑编号 M0–M4 不得新增、不得重排；五条红线与依赖白名单在 ARCHITECTURE / CORE / ROADMAP 中口径一致。
- 兼容性基线成立：构建参数（`GOAMD64=v1` / `GOARM64=v8.0` / `CGO_ENABLED=0` / `-buildvcs=false`）在 `Makefile`、`ADR-0009`、`docs/COMPATIBILITY.md` 三处一致；降级矩阵每行都有触发条件与用户可见结果，无"可能不支持"类模糊表述。
- 三平台兼容基线成立：`docs/COMPATIBILITY.md` 的 OS 矩阵（Linux Tier A / macOS 12+ / Windows 10 1809+）与 `ADR-0009`（构建参数）、`ADR-0010`（`internal/platform` 五接口与降级矩阵）一致；`GOOS=windows go build` 在 M0 无源码，记录为 M1 验收项并标 `[N/A]` + 原因，不得伪造通过。
- 资源预算口径唯一：现役为**主壳 ≤8 MiB、单插件 ≤12 MiB、合计 ≤24 MiB**，`GOMEMLIMIT=6MiB` + `GOGC=100` 为默认档；旧预算与旧调优参数已清零，由 `make canonical-check` 自动校验（旧值字面量不再出现在现役文档中）。
- scope 口径唯一：全仓禁用词（"完全"紧邻"对标"）零命中，检查命令 `grep -rnE "完全.{0,1}对标"`（除 ADR-0014 中被拒备选叙述）；v1 口径统一为"覆盖 22 项能力域：12 生产级 / 8 基础级 / 6 明确不做；v1.0 = Linux GA，macOS/Windows preview"，README / 商店首屏 / 安装器三处一致。
- 对标矩阵闭合：`docs/FEATURE-PARITY.md` 每一行都映射到 `PLUGIN-CATALOG.md` 的某个插件仓库，或明确写"不做 + 理由"；"不做"项不得是宝塔/1Panel 专业版的核心能力。

### 2.3 一致性验收（跨文档交叉引用）

| 口径 | 必须同时命中的文档 | 判定 |
| --- | --- | --- |
| `8 MiB`（主壳 RSS） | CORE、RESOURCE-MODEL、ROADMAP、PLAN | 四处数字一致，无 8MB/8M 混写 |
| `kore.plugin.v1` | PLUGIN-PROTOCOL、CORE、PLAN | 方法表与帧格式互相引用，无 v2 字样 |
| `/run/kore` | CORE、PLUGIN-PROTOCOL、ROADMAP | socket 路径三处一致 |
| `12 MiB` / `24 MiB` | RESOURCE-MODEL、CORE、ROADMAP、PLAN | 单插件与合计口径不交叉；旧合计值零命中 |
| `0.1.0` | VISION、ROADMAP、AGENTS | 版本号与 M1 对齐 |
| HTTP API 13 端点（含 enable/disable/upgrade） | CORE、PLAN、AGENTS 命令速查 | 前缀 `/api/v1` 与端点名一致 |
| 角色与 Loop | AGENTS、.agents/ROLES、.agents/WORKFLOW、PLAN | 6 角色、七阶段、写域表一致 |
| 二进制名 | `Makefile`、AGENTS 命令速查、systemd ExecStart | 统一为 `kored`（项目名 / 仓库名仍为 `kore`，module 路径见 `REPOS.md`，unit 名仍为 `kore.service`），三者一致 |
| 门禁编号 | AGENTS、.agents/QUALITY-GATES、PLAN | G-01…G-15（含 G-13 仓库边界 / G-14 协议兼容 / G-15 变更集）与 make 目标对得上 |
| 拓扑一致性 | `docs/REPOS.md`、ROADMAP §2、PLAN §1/§2、AGENTS、README | 仓库清单（`kore` / `kore-plugins` / `kore-plugin-<id>`）、module 占位路径、创建时点（M0/M1/M2/M4）逐项一致 |
| 兼容性基线 | `docs/COMPATIBILITY.md`、`ADR-0009`、`ADR-0010`、`Makefile`、ROADMAP §13 | 构建参数逐字一致；三平台矩阵 3 行 + Linux 明细 10 行；降级规则无模糊表述 |

## 3. 可执行验收清单

M0 阶段 Makefile 可能尚未就绪，优先直接跑脚本；Makefile 落地后 `make docs-check` 与脚本等价。

```bash
# 1. 文档门禁（唯一真门禁）
bash scripts/docs-check.sh; echo "exit=$?"

# 2. 关键口径覆盖（docs-check 6/6 段的同口径手工复核）
grep -rlF "8 MiB" docs | wc -l          # 期望 ≥ 2
grep -rlF "kore.plugin.v1" docs | wc -l # 期望 ≥ 2
grep -rlF "/run/kore" docs | wc -l      # 期望 ≥ 2

# 3. 行数抽样（三份 lead 交付物）
wc -l docs/ROADMAP.md docs/PLAN.md docs/MILESTONE-M0.md   # 期望 150–350

# 4. 元信息（占位词由 docs-check 4/6 段覆盖）
head -n 5 docs/ROADMAP.md

# 5. 契约数字一致性
grep -rn "8 MiB\|12 MiB\|24 MiB\|15 MiB\|25 MiB\|300 KiB" docs | wc -l
grep -rn "kore.plugin.v1" docs | wc -l

# 6. 相对链接（docs-check 已覆盖，单点复核）
grep -oE '\]\([^)]+\)' docs/*.md | head -20

# 7. Makefile 就绪后
make help && make docs-check && make check
```

合法跳过判据：`make build` / `vet` / `test` / `frontend` / `mem` 在 M0 输出以 `[SKIP]` 开头并带原因、退出码 0；`make check` 内的源码类子项输出 `[N/A]`、文档类子项必须真实执行。任何编译错误、测试失败、文档断链不得以 `[SKIP]`/`[N/A]` 掩盖；`make docs-check` 不允许跳过。

## 4. 完成定义与交接说明

**完成定义（全部满足才算 M0 完成）**

1. 第 1 节清单全部由 verifier 勾选，无未勾选项（除 M1 才产生的产物）。
2. 第 2 节三层验收全部通过：机械命令全绿、内容章节齐全、跨文档交叉引用无冲突。
3. `.agents/verify/m0-consistency.md` 落盘且结论为 PASS，逐项附命令与退出码。
4. red-team 对文档的"膨胀/越权/口径漏洞"问题单全部闭环或明确接受为已知风险。
5. lead 在任务板 complete 时引用 verifier 报告路径与本文件第 3 节命令输出。

**交接说明（M1 接手者按此顺序读 5 个文件）**

1. [docs/VISION.md](VISION.md) — 先读 §3 五锚点（3.1–3.5），确认"内核只定规则"的边界。
2. [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 先读 §3 进程模型与 §7 插件状态机，确认故障域划分。
3. [docs/CORE.md](CORE.md) — 先读 §1 内核边界与 §2 模块规格（含 13 个 HTTP 端点），再看 §9 永不膨胀守卫，确认内核只做四类规则。
4. [docs/PLUGIN-PROTOCOL.md](PLUGIN-PROTOCOL.md) — 先读 §4 帧格式、§7 方法表、§9 错误码，这是 M1 supervisor 的实现依据。
5. [docs/PLAN.md](PLAN.md) — 先读 §2 M0 WBS 与 §3 Sprint 1，确认自己这一轮的目标、写域与退出条件。

补充：动工前读 [AGENTS.md](../AGENTS.md) 第 2 节硬门禁（G-01…G-15）、[.agents/QUALITY-GATES.md](../.agents/QUALITY-GATES.md) 与 [docs/REPOS.md](REPOS.md) 的 R1–R8；写代码前不读 VISION 五锚点就动手，等于把业务逻辑往内核里塞，往 kore 里塞插件就是 G-13 事故。

## 5. 已知缺口与 M1 入口条件

### 5.0 M1 收尾技术债（登记，不阻塞 M0）

| # | 位置 | 事实 | 处置 | 期限 |
| --- | --- | --- | --- | --- |
| D-1 | `cmd/kored/serve.go`（**241 行，超单文件 200 行上限**） | 启动装配 / 信号处理 / 资源锚点（`setRuntimeLimits`）混在一个文件 | 按职责拆分：`serve.go`（装配）/ `signals.go`（SIGHUP/SIGTERM）/ `runtime_limits.go`（`GOGC` / `GOMEMLIMIT` / `GOMAXPROCS` 锚点，保持 CORE §7 语义） | M1 收尾前 |


**已知缺口（不影响 M0 判定，但必须在 M1 前处理）**

1. 无源码：`make build` / `vet` / `test` / `mem` / `frontend` 在 M0 输出 `[SKIP]`（`make check` 内的 2/3、3/3 源码检查才是 `[N/A]`），属合法状态；M1 Sprint 1 必须让 `build` 先转 OK。
2. `.agents/verify/` 与 `docs/DECISIONS/` 由 verifier 与 architect 落盘，缺任一 docs-check 直接 FAIL。
3. Kore Loop 阶段数已按 lead 2026-11-21 裁决闭合：统一采用七阶段（归档复盘合并为第 7 阶段），与 AGENTS.md / .agents/WORKFLOW.md 一致，此项无需 ADR。
4. 无 CI、无 LICENSE、无 packaging、无 systemd unit：分别属 M1（CI 门禁）与 M3（systemd）。
5. 本目录若已由宿主初始化 git，首次提交须按 G-12 精确 `git add <file>` 执行；本计划不代替提交动作。
6. 二进制名已按 lead 2026-11-21 裁决统一为 `kored`（Makefile 同步修正；项目名 / 仓库名仍为 `kore`，module 路径见 `REPOS.md`，systemd unit 仍为 `kore.service`）。核对项保留：验收时确认 `make build` 产物为 `bin/kored`、ExecStart 指向 `kored`。

**M1 入口条件（缺一不可）**

- `bash scripts/docs-check.sh` 退出码 0，断链 0，14 篇 ADR（0001–0014）齐全。
- `Makefile` 的全部目标真实存在，`make build` 由 `[SKIP]` 转为产出 `bin/kored`。
- 依赖白名单确认：主壳直接依赖仅 yaml.v3 / bbolt（protobuf 到 M3），无 Web 框架、gRPC、NATS、SQLite、Redis 客户端、容器 SDK。
- 预算口径被 CORE、RESOURCE-MODEL、ROADMAP、PLAN 同时引用且数字一致（8 MiB / 12 MiB / 24 MiB / 15 MiB / 25 MiB / 300 KiB，+ 空闲 CPU ≤0.1%、同时常驻 ≤3）。
- 首批要创建的仓库清单与 module 路径已定：`kore-plugins`（`github.com/kore-project/kore-plugins`，空 `index/plugins.json` + 校验脚本）与 `kore-plugin-echo`（`github.com/kore-project/kore-plugin-echo`，只依赖 `kore/pkg/pluginapi`），见 `REPOS.md` §1 / §6 与 ADR-0008。
- 跨仓库联调方式已确认：`go.work` 只在本地联调、不进任何仓库；插件 `go.mod` 只允许 tag 依赖。
- verifier 的 M0 报告 PASS，red-team 无未闭环 P0 问题。
