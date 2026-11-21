# .agents · LOG · 派发台账

> 状态: draft · 归属: scribe · 更新: 2026-11-22 · 里程碑: M1

登记"谁在做什么、写到哪、依赖谁、交了什么、落在哪个 commit"。**task 即登记，回报后在同一行补交付与 commit**，不另开一行。写域以派发时的 `write_scopes` 为准，事后扩域必须回拆解阶段重画。

「owner」列带「（推断）」= 仓库内无该次派发记录，由 commit 内容与文件归属推断，不作为验收依据；不带者来自 BOARD 快照、提案任务表或 commit 署名。不确定的 commit 写 `—`。

| 时间 | task | owner | 写域 | 依赖 | 交付 | commit | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-21 | M0-A 愿景 / 总体架构 / 内核规格 / 术语表 | architect | `docs/VISION.md`、`docs/ARCHITECTURE.md`、`docs/CORE.md`、`docs/GLOSSARY.md` | — | 4 份文档 178 / 348 / 286 / 172 行 | `7404ad1` | completed |
| 2026-11-21 | M0-B 插件协议 / 资源模型 / 数据模型 | architect | `docs/PLUGIN-PROTOCOL.md`、`docs/RESOURCE-MODEL.md`、`docs/DATA-MODEL.md` | — | 3 份文档 350 / 205 / 268 行；帧 = 4B 长度 + JSON | `7404ad1` | completed |
| 2026-11-21 | M0-C 前端架构 / 安全模型 / 8 篇 ADR | architect | `docs/FRONTEND.md`、`docs/SECURITY.md`、`docs/DECISIONS/` | — | 2 份文档 253 / 216 行 + ADR 0001–0008（无重号） | `7404ad1` | completed |
| 2026-11-21 | M0-D 路线图 / 执行计划 / M0 清单 | lead | `docs/ROADMAP.md`、`docs/PLAN.md`、`docs/MILESTONE-M0.md` | — | 3 份文档 191 / 227 / 169 行 | `7404ad1` | completed |
| 2026-11-21 | M0-E AGENTS.md + agent 管理架构 | scribe | `AGENTS.md`、`README.md`、`.agents/` | — | 体系文档 6 份 + 模板 4 份；`docs-check` 6 pass / 0 fail | `7404ad1` | completed |
| 2026-11-21 | M0-F 仓库骨架 / 门禁脚本 | implementer | `.gitignore`、`.editorconfig`、`Makefile`、`scripts/` | — | `APP ?= kored` / `BIN ?= ./bin/kored`；`docs-check.sh` + `canonical-check.sh` | `7404ad1` | completed |
| 2026-11-21 | M0-G 独立验收 + 首提交 | verifier | `.agents/verify/` | M0-A…F | R1–R5 报告（`m0-consistency-r5.md` 99 行）+ 59 文件首提交 | `7404ad1` | completed |
| 2026-11-21 | M0 首提交执行 | kore-implementer-commit(1) | 精确 `git add` 59 个文件 | M0-G APPROVE | 59 文件 / 8,193 insertions，排除 proposals / reviews 3 件 | `7404ad1` | completed |
| 2026-11-21 约 22:51 | M1 提案 + 双评审（前置于 M1 开工） | kore-architect-m1（提案）/ kore-red-team-2（v1 对标验尸） | `.agents/proposals/`、`.agents/reviews/` | M0-G | `0001-m1-walking-skeleton.md` 300 行 + 验尸 163 / 183 行 | `7e4602c` | completed |
| 2026-11-21 | M1 规划件提交 | kore-implementer-commit(2) | 同上 4 文件（BOARD 状态同步） | 双评审落盘 | 4 文件 / 653 insertions | `7e4602c` | completed |
| 2026-11-21 约 23:0x | M1-01/M1-02 帧编解码 + 信封类型 | kore-impl-pluginapi | `pkg/pluginapi/` | M1-01 提案 | 9 文件 / 687 insertions；8 MiB 边界、超限零分配、半包测试 | `c31d13f` | completed |
| 2026-11-21 约 23:03 | 协议口径补丁（信封字段 / 帧层边界） | kore-architect-m1（推断） | `docs/PLUGIN-PROTOCOL.md`、`docs/DECISIONS/0007`、`proposals/0001` | `c31d13f` 实现反馈 | 3 文件 / +12 −11；明确 `id` 归 bus、`timeout_ms<=0` 取 15000 | `90c5936` | completed |
| 2026-11-21 约 23:1x | 根 module 骨架 + platform 五接口 + envprobe + 最小 httpapi | kore-impl-core | `go.mod`、`cmd/kored/`、`internal/core/{envprobe,httpapi}`、`internal/platform/` | `c31d13f` | 20 文件 / 1,762 insertions；交叉编译桩通过 | `82ba3c5` | completed |
| 2026-11-21 约 23:4x | 资源锚点注释修正 + version 复用 `pluginapi.Protocol` | kore-impl-runtime（推断） | `cmd/kored/main.go`、`cmd/kored/serve.go` | `82ba3c5`、ADR-0015 | 2 文件 / +16 −12 | `6fdaedd` | completed |
| 2026-11-21 23:47–11-22 00:06 | M1 内存基线独立测量（GOGC 三档 × 60 点） | kore-verifier-mem | `.agents/verify/m1-memory-baseline.md` | `6fdaedd` | 135 行报告；发现 `SetGCPercent(-1)` 关闭 GC 的 P0 | — | completed |
| 2026-11-22 | GC 副作用 P0 修复 + G-21 落地 | kore-impl-runtime（推断） | `cmd/kored/serve.go`、`cmd/kored/serve_test.go` | `m1-memory-baseline` §5 | 2 文件 / +193 −23；修复后 VmRSS 中位数 7,688 KiB、300 次 healthz 触发 1,374 次 GC | `02d0154` | completed |
| 2026-11-21 约 23:0x | M1-04 store：bbolt 打开 / 6 bucket / schema v1 | kore-impl-storage | `internal/core/store/` | M1-04 提案 | `store.go`、`tx.go` 已落盘，**未提交** | — | in_progress |
| 2026-11-22 约 00:2x | M1-03 config：默认 + YAML + 校验 + SIGHUP | —（派发记录缺失） | `internal/core/config/` | M1-03 提案 | 7 个文件已落盘，**未提交** | — | in_progress |
| 2026-11-22 约 00:2x | M1-10 registry：12 字段 + `lifecycle` 解析 | —（派发记录缺失） | `internal/core/registry/` | M1-10 提案 | `manifest.go` 已落盘，**未提交** | — | in_progress |
| 2026-11-22 约 00:2x | 建立判断台账 + 回填 M0/M1 | kore-scribe-log | `.agents/LOG/`、`.agents/README.md`、`.agents/BOARD.md`、`.agents/WORKFLOW.md` | M0/M1 既有产物 | 5 份台账文件 + 3 处索引 / 工作流补丁 | — | in_progress |

## 未回收与待补

1. **`internal/core/config` / `registry` 的派发记录缺失**：文件已落盘（2026-11-22 00:2x），但会话内没有对应的 `team_task_*` 或派发消息可引；owner 列留 `—`，等 lead 补登记后再回填。
2. **`90c5936` 的 owner 为推断**：commit 署名不区分角色；按改动文件（协议正文 + ADR + 提案）推断为 `kore-architect-m1`。
3. **`6fdaedd` / `02d0154` 的 owner 为推断**：两笔均只改 `cmd/kored/`，与 `kore-impl-runtime` 写域一致，但无派发记录。
4. **M1 各 implementer 任务的 `blocked_by`**：以 `proposals/0001` §3 任务表的依赖列为准（如 M1-02 ← M1-01、M1-12 ← M1-09/10/21），本表不重复展开。
