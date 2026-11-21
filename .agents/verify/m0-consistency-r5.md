> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 复验链：R5 ← R4（`m0-consistency-r4.md`）← R3 ← R2 ← R1（`m0-consistency.md`，编号 **R1-M0-2026-11-21**）；R1–R4 为冻结证据，本报告不修改。
> 验收对象：M0 全部交付物 + `docs/V1-GOALS.md` + 新增 `scripts/canonical-check.sh`；`.agents/proposals/**`、`.agents/reviews/**` 为 M1 规划件，不纳入 M0 验收与提交。全部命令与行号由 verifier 自行复跑/重读。

# M0 最终验收报告 R5

## 0. 结论

**VERDICT: APPROVE**。7 项阻断 **全部 CLOSED**；V1-GOALS 六项交叉核对 **全部 PASS**；机械门禁 13/13 通过（`make check` **5/5**）；反向验证三连均按预期失败（含新增 `canonical-check` 真会红）。

记录级遗留 3 条（不阻断，已写入 BOARD「已知遗留」）：ADR-0001 背景句仍含 GOGC=200（ADR 按设计被 canonical-check 排除）、`make idle` SKIP 文案未写"约 65s"、C5「12 项生产级」与 FEATURE-PARITY「14 个生产域」的措辞可再精确。

## 1. 机械门禁（原样复跑）

| # | 命令 | 退出码 | 关键输出 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `make help` | 0 | 16 个目标，含 `canonical-check` | PASS |
| 2 | `make -n build` | 0 | 含 `-o ./bin/kored`；`-trimpath -buildvcs=false` 在 build flags，ldflags 仅 `-s -w -X` | PASS |
| 3 | `make build` | 0 | `[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现` | PASS |
| 4 | `bash -n scripts/docs-check.sh` | 0 | 无输出 | PASS |
| 5 | `bash -n scripts/canonical-check.sh` | 0 | 无输出 | PASS |
| 6 | `make docs-check` | 0 | `53 份文档元信息合规`；`215 条相对链接全部可达`；`6 pass, 0 warn, 0 fail` | PASS |
| 7 | `make repo-check` | 0 | `repo-check: 5 pass, 0 fail` | PASS |
| 8 | `make canonical-check` | 0 | 7 行 `[OK]`（旧预算/GOGC/旧字段/幽灵 id 清零 + 3 项预算声明 3/3 命中）；`7 pass, 0 fail` | PASS |
| 9 | `make compat-info` | 0 | 强制参数行 `CGO_ENABLED=0 GOAMD64=v1 GOARM64=v8.0 -trimpath -buildvcs=false`；交叉编译 `[N/A]` | PASS |
| 10 | `make mem` | 0 | `VmRSS 为主值…smaps_rollup…标注来源`；预算 8/12/24 MiB（写明"常驻合计 24 MiB"）；`[SKIP]` 无进程 | PASS |
| 11 | `make idle` | 0 | `[SKIP] 未发现运行中的 kored 进程…（M1 起生效）` | PASS（附注 P2-1） |
| 12 | `make budget-check` | 0 | `budget-check: 0 pass, 2 skip, 0 fail` | PASS |
| 13 | `make check` | 0 | **5/5**：docs-check / 依赖+兼容基线 / 薄壳边界 `[N/A]` / repo-check 5 pass / canonical-check 7 pass；`[OK] 门禁全部通过` | PASS |
| 14 | `git status --short` | 0 | 未跟踪 8 项（62 文件，含 3 份 M1 规划件） | PASS |
| 15 | `git rev-list --count HEAD` | **128** | `fatal: 有歧义的参数 'HEAD'`（提交前） | PASS（预期） |

## 2. 7 项阻断销账

| 项 | 判定 | 证据（file:line） |
| --- | --- | --- |
| F1 旧预算/旧调优 | **CLOSED** | `Makefile:3` 已改「≤8 MiB（默认 GOGC=100 + GOMEMLIMIT=6MiB，另跑 GOGC 双档对照）· 常驻单 ≤12 MiB / 合计 ≤24 MiB」；全仓 `48 MiB` 零命中、默认 `GOGC=200` 零命中（canonical-check 规则 1/2）；`make mem` 提示写明 24 MiB。附注：`ADR-0001:8` 背景句仍含 GOGC=200，属 ADR 冻结记录（canonical-check 按设计排除 `docs/DECISIONS/`）→ 记录级 P2 |
| F2 `type` → `lifecycle` | **CLOSED** | `CORE:68` 必填字段已为 `id,name,version,protocol,lifecycle,entry,…`；`CORE:69` 视图为 `{…,lifecycle,state,…}`；`GLOSSARY:31` 为 `` `lifecycle: lazy` ``；全仓 `type: resident\|oneshot\|lazy` 零命中（canonical 规则 3） |
| F3 installer/market 两入口 | **CLOSED** | `CORE:115` §2.12 installer、`CORE:122` §2.13 market，各自职责/输入输出/失败模式/明确不做什么**四小节齐全**；`CORE:62` 路由表含 7 个 `/store/*`（plugins/refresh/presets/install/update/jobs/DELETE）；`CORE:318-319` CLI `install --scenario` / `install --package`，且 `:118` 明写与 HTTP `store/install` **共用同一实现** |
| F4 capabilities 三处 | **CLOSED** | `V1-GOALS:53` 已列「①安装校验 ②启用授予 ③调用校验」三处；`SECURITY:33` 同为「三处校验（安装/授予/调用）」 |
| V1-1 常驻数一致 | **CLOSED** | `AGENTS:32` G-03 已改「1 主壳 + 0~2 常驻（配额硬上限 3，推荐 ≤2，留 1 槽…）」；与 `V1-GOALS:34`「0~2 常驻（硬上限 3）」、`RESOURCE:59`「上限 3，推荐 ≤2」逐字一致；canonical 规则 5「推荐 ≤2」3/3 命中 |
| V1-2 M1 性能时限 | **CLOSED** | `ROADMAP §7.2` 退出条件已含「**启动到就绪 ≤1s**（不含插件 ready）」「**API p95 ≤50ms**（本地，200 次取 p95）」「lazy 冷启动 p95 ≤300ms（M2 起生效）」；与 `V1-GOALS:40`、`PLAN:244-245` 一致 |
| V1-3 12/8 名单 | **CLOSED** | `V1-GOALS:23` 已有名单；脚本比对：生产级 12 项 `== PLUGIN-CATALOG:85`、基础级 8 项 `== PLUGIN-CATALOG:86`（逐字，`echo` 标注"验证件、不评级"） |

## 3. 历史与拓扑（全部 CLOSED）

- r1 基线 28 条：全部 CLOSED（R4 §2.1 已逐条重读，本轮回归无变化）。
- r2/r3 残留 6 条：#14/#17/N1/N2/N3/N4 全 CLOSED（N3 见 `CORE:42` 首启 bootstrap 表述）。
- 拓扑 T1–T10：REPOS/ADR-0008/pkg/pluginapi/requires_kore/索引非信任源/插件前端不 embed/AGENTS 门禁/BOARD 变更集/M0 边界/ADR 14 篇——全 CLOSED（R4 §2.3 证据仍成立）。
- 历史遗留 O1（`WORKFLOW/ROLES` 的 `plugins/` 输出目录）已修：`grep "plugins/" internal/ cmd/` 零命中，impl 输出目录改为 `cmd/ internal/ pkg/ web/`。

## 4. C1–C6 复核（全部 PASS）

| 项 | 判定 | 证据 |
| --- | --- | --- |
| C1 资源预算唯一 | PASS | 8/12/24 MiB + GOGC=100 + GOMEMLIMIT=6MiB 在 AGENTS/Makefile/RESOURCE/CORE/V1 一致；`48 MiB`/默认 `GOGC=200` 零命中（canonical 1/2） |
| C2 生命周期三态 | PASS | `lifecycle` 三值 + lazy 默认 + `idle_timeout_s` 300/60–1800（PROTOCOL:66-67）；lazy 状态机含 draining→stopped（PROTOCOL:204） |
| C3 常驻与预设 | PASS | resident=site+monitor/16 MiB/推荐 2、硬上限 3；8 预设 ≤19.2 MiB、余量 ≥8 MiB；幽灵 id 零命中（canonical 4）；cron=lazy+宿主调度器 |
| C4 深度分级 | PASS | V1/ROADMAP/PLUGIN-CATALOG 名单逐字一致；20 产品 + 1 验证件；echo 不评级 |
| C5 scope | PASS | 22 域/6 不做全仓一致；「完全对标」仅禁止/ADR-0014 被拒语境；v1.0=Linux GA、macOS/Windows preview |
| C6 兼容基线 | PASS | Tier A/B；exit 6 四类硬要求；`-buildvcs=false` 只在 build flags；五目标；`syscall` 只在 `internal/platform` |

## 5. V1-GOALS 六项交叉核对（重跑）

| # | 项 | 结论 | 行号对照 |
| --- | --- | --- | --- |
| 1 | 资源数字 | **PASS** | `V1-GOALS:34` ↔ `AGENTS:32` ↔ `RESOURCE:59,244-250`：8/12/24/25 MiB、300 KiB、0.1%/60ms、goroutine 20、0~2 常驻/硬上限 3/推荐 ≤2 全部一致 |
| 2 | 性能数字 | **PASS** | `V1-GOALS:40` ↔ `ROADMAP §7.2`（启动 ≤1s 不含插件、API p95 ≤50ms、lazy 300ms M2 起）↔ `PLAN:244-245` |
| 3 | 分级名单 | **PASS** | `V1-GOALS:23` ↔ `PLUGIN-CATALOG:85-86`（脚本逐字比对 12/12、8/8 相等；echo 不评级） |
| 4 | 兼容口径 | **PASS** | `V1-GOALS:46` ↔ `ROADMAP:14` ↔ `COMPATIBILITY:18-19,68-82`（10 发行版 + arm64、preview 不计入 gate） |
| 5 | scope 口径 | **PASS** | `V1-GOALS:22,70` ↔ `AGENTS:40` G-11 ↔ `FEATURE-PARITY:12,65`（22 域 / 6 不做，六项逐字） |
| 6 | 九类可验收性 | **PASS** | §1.1–§1.9 每行 4 列（目标/量化判据/验收命令或方式/责任里程碑）无空值；§4 防稀释五条可执行 |

## 6. 反向验证（门禁不空转）

| # | 操作（`/tmp` 副本） | 输出 | 判定 |
| --- | --- | --- | --- |
| ① | 造 `plugins/foo/main.go` | `[FAIL] plugins/ 下发现插件代码（*.go）`；`repo-check: 4 pass, 1 fail`；`EXIT=2` | 有效 |
| ② | `docs/VISION.md` 的 `里程碑: M0` → `M9` | `[FAIL] 元信息不合规 1 处`；`docs-check: 5 pass, 0 warn, 1 fail`；`EXIT=2` | 有效 |
| ③ | 向 `docs/RESOURCE-MODEL.md` 注入 `常驻合计 ≤ 48 MiB` | `[FAIL] 规则1 旧预算 48 MiB 命中 1 处`（`RESOURCE-MODEL.md:316`）；`canonical-check: 6 pass, 1 fail`；`EXIT=2`；恢复后 `7 pass, 0 fail` | 有效（自动门禁） |

副本已 `rm -rf`，工作区无临时文件（`git status` 仅业务文件）。

## 7. 结构与质量

| 项 | 结果 |
| --- | --- |
| AGENTS | 98 行（≤130）；G-01…G-20 连续；§6 已更新为「九个内核模块 + 20 个端点（13 业务 + 7 store）」 |
| ADR | 14 篇（0001–0014），无重号，逐篇 6 节 |
| 元信息 / 占位 / 链接 | docs-check 55 份全合规、215 链接全通、占位词 0 超限；M0 文档无 `[待裁决]`/`[待确认]` |
| 交叉一致性 10 项 | 状态机/心跳/超时/cgroup/日志轮转/端点前缀/角色/Loop/预算/端点数 全部 PASS（端点数已随 20 端点口径同步：CORE:62 与 AGENTS:97 一致） |

## 8. 统计与结论

- 文件：**62 个**（docs/*.md 18 篇 + ADR 14 篇 + `.agents` 23 份 + scripts 2 + 根 5）；待提交 **59 个**（排除 3 份 M1 规划件）。
- 行数：全量 **8,619 + r5 两份报告**（提交后以 `git show --stat` 实测为准）。
- `make docs-check`：55 份文档、215 链接、6 pass / 0 warn / 0 fail；`make check` 5/5。

**VERDICT: APPROVE**（阻断级 0 条；记录级 3 条写入 BOARD「已知遗留」，随后提交）。
