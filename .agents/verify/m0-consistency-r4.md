> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 复验链：R4 ← R3（`m0-consistency-r3.md`）← R2（`m0-consistency-r2.md`）← R1（`m0-consistency.md`，编号 **R1-M0-2026-11-21**）；R1–R3 为冻结证据，本报告不修改。
> 验收对象：M0 交付物 + **`docs/V1-GOALS.md`（22:32 落盘，本报告已纳入预检）**；`.agents/proposals/**`、`.agents/reviews/**` 为 M1 规划件，不纳入 M0 验收与提交。全部命令与行号由 verifier 自行复跑/重读。

# M0 最终验收报告 R4

## 0. 结论先行

**VERDICT: REVISE** —— V1-GOALS 已于 22:32 落盘（121 行），正式交叉核对七项中 **3 项不达标**（资源常驻数三方不逐字一致、性能数字在 ROADMAP M1 退出条件缺项、V1-GOALS 无 12/8 名单）；连同既有 F1–F4，共 **7 项阻断**。按"全项 PASS 才提交"的门槛，本轮不提交（`staged=0`、无 commit）。

当前已确认 **4 条 P1 阻断项（即使 V1-GOALS 通过也不会 APPROVE）**：

| # | 位置 | 事实 |
| --- | --- | --- |
| F1 | `Makefile:3` | 头注释仍写「常驻插件单 ≤ 24 MiB / 合计 ≤ 48 MiB」「GOGC=200」——现役预算应为 12/24 MiB、`GOGC=100`+`GOMEMLIMIT=6MiB`（C1） |
| F2 | `docs/CORE.md:68,69`、`docs/GLOSSARY.md:31` | `info.json` 必填字段仍列 **`type`** 且无 `lifecycle`；插件视图仍输出 `type`；GLOSSARY 仍写 `` `type: lazy` ``——与 `PLUGIN-PROTOCOL:66` 的 `lifecycle` 三态冲突（C2） |
| F3 | `docs/CORE.md`（§2 无 installer/market、§10 CLI 无 `install`、路由表无 `/store/install`）+ `FEATURE-PARITY:168`/`PLUGIN-CATALOG:209`/`SCENARIOS:205,232` | 「安装两入口共用 installer 模块」未成立：CORE 没有 installer/market 模块规格，CLI 与 HTTP 入口均未登记，而另三份文档指认 CORE 是规格源 |
| F4 | `docs/V1-GOALS.md:52` vs `docs/SECURITY.md:33` | V1-GOALS 写 capabilities「**两处**校验（hello 与调用前）」，SECURITY 写「**三处**校验（安装/授予/调用）」——V1-GOALS 自身要求"数字逐字一致"，此处第二套口径 |

另有 6 条 P2 观察（见 §6）。机械门禁与反向抽验全部通过（`make check` 4/4；三项反向验证均按预期分别 FAIL/FAIL/无自动门禁）。

## 1. 机械门禁（原样复跑）

| # | 命令 | 退出码 | 关键输出 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `make help` | 0 | 15 个目标，含 `compat-info`/`repo-check`/`idle`/`budget-check` | PASS |
| 2 | `make -n build` | 0 | 含 `-o ./bin/kored`；build flags `-trimpath -buildvcs=false`，ldflags 仅 `-s -w -X` | PASS |
| 3 | `make build` | 0 | `[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现` | PASS |
| 4 | `bash -n scripts/docs-check.sh` | 0 | 无输出 | PASS |
| 5 | `make docs-check` | 0 | `52 份文档元信息合规`；`213 条相对链接全部可达`；`6 pass, 0 warn, 0 fail` | PASS |
| 6 | `make repo-check` | 0 | 5 行 `[OK]`，`repo-check: 5 pass, 0 fail` | PASS |
| 7 | `make compat-info` | 0 | 强制参数行：`CGO_ENABLED=0 GOAMD64=v1 GOARM64=v8.0 -trimpath -buildvcs=false`；交叉编译 `[N/A]` | PASS |
| 8 | `make mem` | 0 | `VmRSS 为主值…RssAnon/RssFile 优先 smaps_rollup，缺失取 status；输出必须标注来源`；预算 8/12/24 MiB；`[SKIP]` 无进程 | PASS |
| 9 | `make idle` | 0 | `[SKIP] 未发现运行中的 kored 进程…`（实测采样逻辑为 `sleep 5 + 60`≈65s；SKIP 文案未写"约 65s"，见 P2-1） | PASS（附注） |
| 10 | `make budget-check` | 0 | `budget-check: 0 pass, 2 skip, 0 fail`（另有 2 项 `[N/A]`） | PASS |
| 11 | `make check` | 0 | **4/4**：docs-check / 依赖白名单 `[N/A]` / 薄壳边界 `[N/A]` / repo-check 5 pass；末行 `[OK] 门禁全部通过` | PASS |
| 12 | `git status --short` | 0 | 未跟踪顶层 8 项（57 文件，含 V1-GOALS 与 3 份 M1 规划件） | PASS |
| 13 | `git rev-list --count HEAD` | **128** | `fatal: 有歧义的参数 'HEAD'`（无提交） | PASS（预期） |

## 2. 历史销账

### 2.1 r1 基线 28 条（全部 CLOSED，本轮重读行号）

| # | 证据 |
| --- | --- |
| 1 | `ROADMAP:50,84,126` 交付物为 `cmd/kored`/`kored`；全仓无「单二进制 `kore`」误写 |
| 2 | `GLOSSARY:90` 七阶段（第 7 阶段=归档复盘） |
| 3 | `ARCHITECTURE:331` 帧头不承载任何编码信息；扩展帧头须新 ADR |
| 4 | `ADR-0005:13` 6 bucket（含 `granted_capabilities`，无 grants/secrets） |
| 5 | `SECURITY` 全文无 grants/secrets bucket（grep 空）；密钥走文件路径 |
| 6 | `SECURITY:40,132,149` `/run/kore` 0700 root:root |
| 7 | `CORE:34,40` 配置以 `DATA-MODEL §3` 为唯一真源 |
| 8 | `CORE:42`/`DATA-MODEL:124` 未知字段 = WARN 继续 |
| 9 | `DATA-MODEL:178,179` schema 降级/迁移失败 = 退出码 4 |
| 10 | `SECURITY:133` cgroup 取值以 RESOURCE-MODEL 为唯一真源 |
| 11 | `SECURITY:30,71` 60s 内 5 次锁 300s |
| 12 | `ARCHITECTURE:327`、`ADR-0002:12` 主壳 socket 0600 root:root |
| 13 | `ROADMAP:49,133`、`MILESTONE:5,29`、`PLAN:32`、`BOARD:49` 均 14 篇 ADR（0001–0014） |
| 14 | `PLAN:28,69`、`ARCHITECTURE:282`、`VISION:95` 统一「4 方法 + 1 事件通道」 |
| 15 | `CORE:68`、`GLOSSARY:45-46` 能力 8 项 |
| 16 | `ARCHITECTURE:148`、`GLOSSARY:79` 八层链（含 csrf 第 6 层） |
| 17 | 全仓 `api/v1/-/healthz` 零命中，统一 `/-/healthz` |
| 18 | `SECURITY:110,111` 端点全带 `/api/v1` |
| 19 | `SECURITY:16`、`CORE:138` 可执行路径含 `<version>` |
| 20 | `ARCHITECTURE:295` ADR 必含 6 节 |
| 21 | `WORKFLOW:62` G4 文档同步 / G6 资源预算 |
| 22 | `MILESTONE:143,169` `[SKIP]` 与 `[N/A]` 判据 |
| 23 | `AGENTS:65` 六角色全集 |
| 24 | 旧 `kore db/backup/restore` CLI 零命中；现为 `kored` 子命令（`CORE:298`） |
| 25 | `ADR-0003:28` 8 状态机 |
| 26 | `ADR-0007:35` 正文冲突已同步完成 |
| 27 | `ADR-0001:8` 13 业务端点 + 3 静态 + healthz = 17 路由（另见 F3：store 路由未计入） |
| 28 | `VISION:102,149` 首屏逐文件 gzip 求和 |

### 2.2 r2/r3 残留 6 条

| 项 | 判定 | 证据 |
| --- | --- | --- |
| #14 | CLOSED | 同 2.1-14 |
| #17 | CLOSED | 同 2.1-17 |
| N1 | CLOSED | `ARCHITECTURE:148` 8 层含 csrf |
| N2 | CLOSED | `ARCHITECTURE:176`（无权限=3）/`DATA-MODEL:131`/`DATA-MODEL:180-183` 码表一致 |
| N3 | CLOSED | `CORE:42` 已改「`auth.admin_password_hash` **不是**必填项，空值走 §2.3 首启 bootstrap」 |
| N4 | CLOSED | `FRONTEND:50,106` 端点均带 `/api/v1` |

### 2.3 拓扑 T1–T10（全部 CLOSED）

| 项 | 证据 |
| --- | --- |
| T1 | `docs/REPOS.md` 10 节：仓库清单/拓扑/R1–R8/创建清单/版本矩阵 |
| T2 | `ADR-0008:2` 决策者=lead；6 节；备选含 monorepo/workspace/submodule/多仓库 |
| T3 | 无 `plugins/{site,backup,echo}` 仓库内目录表述（仅 `/run/kore/plugins/*.sock` 运行期路径）；`PLAN:41`/`MILESTONE:55` 骨架无 `plugins/` |
| T4 | `internal/pluginapi` 文档零命中；`pkg/pluginapi` 全仓统一 |
| T5 | `PLUGIN-PROTOCOL:79,90-93,178,193,296`、`DATA-MODEL:147,155`、`REPOS:109-116` 三处一致；区间仅两种写法 |
| T6 | `SECURITY:35,223,249` 索引非信任源、sha256 自算；`DATA-MODEL:155` schema 归 `kore-plugins/index/schema.json` |
| T7 | `FRONTEND:80,240`、`SECURITY:224` 明写 `go:embed` 只含主壳 |
| T8 | `AGENTS:65-98` 含 G-13/14/15 且 98 行；`QUALITY-GATES:21-22` 含 G11/G12；`BOARD:17,45,81` 含变更集字段与登记区 |
| T9 | `PLAN:5,19`、`BOARD:81,96`、`ROADMAP:130` 均写"M0 只交付 kore" |
| T10 | 14 篇 ADR（0001–0014），无重号，逐篇 6 节 |

## 3. C1–C6 逐条

| 项 | 判定 | 证据 / 问题 |
| --- | --- | --- |
| C1 资源预算唯一 | **FAIL** | 现役 8/12/24 MiB、`GOGC=100`+`GOMEMLIMIT=6MiB` 在 AGENTS:32、RESOURCE:219-220、CORE:230/253、VISION:64 一致；但 **`Makefile:3` 仍写 24/48 MiB + GOGC=200**；`ADR-0001:8` 背景句仍带 GOGC=200（P2-4）；`docs-check`/`make check` **无 12/24/48 预算断言**（反向③证明，见 §5） |
| C2 生命周期三态 | **FAIL** | `PLUGIN-PROTOCOL:66-67` `lifecycle` 三值 + `idle_timeout_s` 300/60–1800；`PLUGIN-PROTOCOL:204` lazy 状态机 `idle→starting→ready→draining→stopped`；`ARCHITECTURE:98,117,123` 一致。**但 `CORE:68` 必填字段仍写 `type` 且无 `lifecycle`，`CORE:69` 视图仍输出 `type`，`GLOSSARY:31` 仍 `` `type: lazy` ``** |
| C3 常驻与预设 | PASS | `ARCHITECTURE:120` 推荐 site+monitor/2 个/16 MiB、硬上限 3；`RESOURCE:50,55,59` 8 预设 ≤19.2 MiB、最小余量 8 MiB；幽灵 id（edge/db(/gateway(/sec(）零命中；`cron` 为 lazy + 宿主调度器（`PLUGIN-CATALOG:40,79,127`），无"每 60s 轮询"（`RESOURCE:296` 为反模式条目） |
| C4 深度分级 | PASS | `ROADMAP:104-105` 与 `PLUGIN-CATALOG:85-86` 的 12/8 名单脚本比对**逐字相等**；20 名称在 ROADMAP/PLAN/FEATURE-PARITY/PLUGIN-CATALOG 均出现且无幽灵；总数 20 产品 + 1 验证件（`ROADMAP:7,14,108,113`）。P2-5：PLAN/FEATURE-PARITY 无集中名单，不能做"四处逐字"直接比对 |
| C5 scope 口径 | PASS | 22 项 / 6 不做在 ROADMAP:13,108,316、FEATURE-PARITY:12,65、MILESTONE:94、ADR-0014、AGENTS、README 一致；「完全对标」仅出现在禁止/ADR-0014 被拒语境；v1.0=Linux GA、macOS/Windows preview（ADR-0014:15） |
| C6 兼容基线 | PASS | `COMPATIBILITY:18-19,68,82` Tier A/B；exit 6 四类硬要求（:97,98,99,106）；`ldflags=.*buildvcs` 零命中；`Makefile:12,58` 五目标；`syscall` 只在规则句（`ARCHITECTURE:88`、`PLAN:169`），无代码违规 |
| 安装两入口 | **FAIL** | `FEATURE-PARITY:129`/`SCENARIOS:205` 用 `kored install --scenario/--package`，`SCENARIOS:232` 用 `POST /api/v1/store/install`；但 `CORE` §2 无 installer/market 模块、§10 CLI 表无 `install`、路由表无 `/store/*`，且无"共用 installer 模块"表述；`FEATURE-PARITY:168`/`PLUGIN-CATALOG:209` 却指认 CORE 是这两个模块的规格源（F3） |
| platform 桩 | PASS | `ARCHITECTURE:94`：`!linux` 下 `New()` 返回 `ErrUnsupported` 的桩 ≤5 行，禁止更宽空壳 |
| M1 lifecycle 范围 | PASS | `ARCHITECTURE:123` 三值解析落盘、运行只 resident、`lazy/oneshot` → `E_UNSUPPORTED`；`AGENTS:41` G-14、`QUALITY-GATES:22` G12 同口径 |

## 4. 结构与质量

| 项 | 结果 |
| --- | --- |
| AGENTS 行数 / 门禁 | 98 行（≤130）；G-01…G-20 连续、无重号无跳号 |
| ADR | 14 篇（0001–0014），无重号，逐篇 6 节 |
| 元信息 / 占位 | docs-check 51 份全合规；M0 文档无 `[待裁决]`/`[待确认]`（唯一命中在 `.agents/proposals/0001`，属排除的 M1 规划件） |
| 交叉一致性 10 项 | 状态机 PASS（PROTOCOL:204 + ARCHITECTURE 8 状态）；心跳 PASS（CORE:151 10s/2s/3 次/60s）；超时 PASS（CORE:84/PLAN 15s/120s）；cgroup PASS（SECURITY:133 引用真源）；日志轮转 PASS（10 MiB×5 / ×2）；端点前缀 PASS（`/-/healthz` 单一写法）；角色 PASS（AGENTS:65 六角色）；Loop PASS（七阶段）；预算 **FAIL**（同 C1）；端点数 **PASS（但 store 路由缺失，见 F3）** |

## 5. 反向验证（证明门禁不空转）

| # | 操作 | 结果 | 结论 |
| --- | --- | --- | --- |
| ① | `/tmp` 副本造 `plugins/foo/main.go` | `[FAIL] plugins/ 下发现插件代码（*.go）——插件属于 kore-plugin-<id> 独立仓库`；`repo-check: 4 pass, 1 fail`；`EXIT=2` | 门禁有效 |
| ② | `/tmp` 副本把 `docs/VISION.md` 的 `里程碑: M0` 改 `M9` | `[FAIL] 元信息不合规 1 处`；`docs-check: 5 pass, 0 warn, 1 fail`；`EXIT=2` | 门禁有效 |
| ③ | `/tmp` 副本把 `RESOURCE-MODEL` 现役「合计 ≤ 24 MiB」改回「≤ 48 MiB」后 `make check` | `docs-check: 6 pass, 0 warn, 0 fail`；`[OK] 门禁全部通过`；`EXIT=0` | **C1 无自动门禁**：`docs-check` 只断言 8 MiB / kore.plugin.v1 / /run/kore，不断言 12/24/48；此项靠人工复验，不假装自动 |

副本已 `rm -rf`，工作区无残留（`git status` 仅业务文件）。

## 6. V1-GOALS 正式交叉核对（121 行，落盘 22:32）

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 资源数字 | **FAIL** | 8/12/24 MiB、25 MiB、300 KiB、CPU 0.1%/60ms、goroutine 20 三方一致（`V1-GOALS:34` ↔ `AGENTS:32` ↔ `RESOURCE:244-250`）；**常驻数不一致**：V1「0~2 常驻（硬上限 3）」= `RESOURCE:59`「上限 3，推荐 ≤2」，但 `AGENTS:32` G-03 写「1 主壳 + 0~3 常驻插件」且无"推荐 ≤2"，三处不逐字一致 |
| 2 | 性能数字 | **FAIL** | `V1-GOALS:40` 启动 ≤1 s（不含插件）/ lazy p95 300 ms（SLO 不判失败）/ API p95 50 ms，与 `PLAN:244-245` 一致；但 lead 指定的对照 **`ROADMAP §7.2 M1 退出条件` 未列任何性能时限**（无启动 ≤1s、无 API ≤50ms），无法证明"与 ROADMAP M1 一致" |
| 3 | 分级名单 | **FAIL** | `V1-GOALS:22` 只有「12 生产级 + 8 基础级」数量，**全文无插件名单**（`grep` 无 `site…ssl…runtime-php` 序列）；`PLUGIN-CATALOG:85-86`/`ROADMAP:104-105` 有名单且脚本比对逐字相等，但 V1 无名单可比，"四处逐字一致"不成立 |
| 4 | 兼容口径 | PASS | `V1-GOALS:46`（10 发行版、amd64/arm64、arm64 门禁 M2 起、macOS/Windows preview 不计入 gate）↔ `ROADMAP:14`（10 发行版 + arm64，不含 macOS/Windows 全链路）↔ `COMPATIBILITY:18-19,68-82`（Tier A 10 行矩阵） |
| 5 | scope 口径 | PASS | `V1-GOALS:22,70` 的 22 域 / 6 不做 ↔ `AGENTS:40` G-11 六项逐字相同 ↔ `FEATURE-PARITY:12,65` |
| 6 | 九类目标可验收性 | PASS | §1.1–§1.9 每张表均为 4 列（目标 / 量化判据 / 验收命令或方式 / 责任里程碑），无空单元格（脚本逐行校验列数=4） |
| 7 | 防稀释机制 | PASS | `V1-GOALS:104-108` 五条：需求归类 → 改判据走 ADR → 数字唯一来源 → 非目标不进里程碑 → 验收权分离，均可执行 |

已核实 lead 所述同步：`MILESTONE-M0:22` 已登记 V1-GOALS 交付物；`VISION:172-174` 已加指向链接；docs-check 文档数 50 → **52**（V1-GOALS + 本报告），链接 213 条全通，仍 6 pass / 0 warn / 0 fail。

V1 之外仍成立的 P2：P2-1 `make idle` SKIP 文案未写"约 65s"（实现为 5+60s）；P2-2 C5 的「22 项能力域：12 项生产级」与 `FEATURE-PARITY:12`「14 项由生产级插件承载」是插件数 vs 域数的两种说法；P2-3 `ADR-0001:8` 的 GOGC=200；P2-4 store 端点未计入 13/17 端点口径；P2-5 PLAN/FEATURE-PARITY 无集中 12/8 名单。

## 7. 结论

机械门禁 13/13 通过（`make check` 4/4）、历史 44 条全 CLOSED、拓扑 T1–T10 全 CLOSED、C3/C4/C5/C6 与两项细节 PASS；但阻断项共 **7 条**：

- F1 `Makefile:3` 旧预算 24/48 MiB + GOGC=200（C1）；
- F2 `CORE:68,69`/`GLOSSARY:31` 仍用 `type` 作 info.json 字段（C2）；
- F3 installer/market 模块、`kored install` 子命令、`/api/v1/store/install` 路由与"共用 installer"均未在 CORE 登记（安装两入口）；
- F4 `V1-GOALS:52` capabilities 两处 vs `SECURITY:33` 三处；
- V1-1 常驻数 V1「0~2（硬上限 3）」vs `AGENTS:32`「0~3」不逐字一致；
- V1-2 `ROADMAP §7.2 M1 退出条件` 缺启动 ≤1s / API ≤50ms；
- V1-3 `V1-GOALS` 无 12/8 名单。

**最终结论：VERDICT: REVISE**。本轮不提交（`staged=0`、`git log` 无 commit）；F1–F4 与 V1-1…V1-3 闭环后由 verifier 出 R5，全项 PASS 才提交，并把 `docs/V1-GOALS.md` 纳入清单（继续排除 `.agents/proposals/**` 与 `.agents/reviews/**`）。
