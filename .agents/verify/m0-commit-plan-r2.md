> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> **阻塞：等待多仓库拓扑文档重构完成，清单将失效需重出。**（用户已下达架构级指令：`kore` 内核 / 插件中心 / 每插件各一个独立仓库；本文件的一切 `git add` / `git commit` 动作暂停执行。）
> 关联报告：R2 = `.agents/verify/m0-consistency-r2.md`（结论 **REVISE**，暂停原因：多仓库拓扑变更）；R1 = `.agents/verify/m0-consistency.md`（冻结证据，不改）
> 当前状态：**阻塞，未执行**。R2 的 28 条销账为 26 CLOSED / 2 STILL-OPEN，另有 N1–N4 待修；叠加拓扑暂停，提交清单需在重构后重出。

# M0 首次提交计划 R2

## 1. 待提交文件清单（`git status --porcelain -uall` 实际枚举，35 + 4 = 39 行）

| # | 路径 | 类别 |
| --- | --- | --- |
| 1 | `docs/VISION.md` | docs |
| 2 | `docs/ARCHITECTURE.md` | docs |
| 3 | `docs/CORE.md` | docs |
| 4 | `docs/GLOSSARY.md` | docs |
| 5 | `docs/PLUGIN-PROTOCOL.md` | docs |
| 6 | `docs/RESOURCE-MODEL.md` | docs |
| 7 | `docs/DATA-MODEL.md` | docs |
| 8 | `docs/FRONTEND.md` | docs |
| 9 | `docs/SECURITY.md` | docs |
| 10 | `docs/ROADMAP.md` | docs |
| 11 | `docs/PLAN.md` | docs |
| 12 | `docs/MILESTONE-M0.md` | docs |
| 13 | `docs/DECISIONS/0001-go-stdlib-net-http.md` | docs |
| 14 | `docs/DECISIONS/0002-uds-length-prefix-json.md` | docs |
| 15 | `docs/DECISIONS/0003-process-isolation-plugins.md` | docs |
| 16 | `docs/DECISIONS/0004-no-resident-middleware.md` | docs |
| 17 | `docs/DECISIONS/0005-yaml-config-bbolt-state.md` | docs |
| 18 | `docs/DECISIONS/0006-vue-embed-single-binary.md` | docs |
| 19 | `docs/DECISIONS/0007-frame-type-and-encoding-negotiation.md` | docs |
| 20 | `README.md` | docs |
| 21 | `AGENTS.md` | agents |
| 22 | `.agents/README.md` | agents |
| 23 | `.agents/ROLES.md` | agents |
| 24 | `.agents/WORKFLOW.md` | agents |
| 25 | `.agents/BOARD.md` | agents |
| 26 | `.agents/QUALITY-GATES.md` | agents |
| 27 | `.agents/JOURNAL.md` | agents |
| 28 | `.agents/templates/proposal.md` | agents |
| 29 | `.agents/templates/task.md` | agents |
| 30 | `.agents/templates/review.md` | agents |
| 31 | `.agents/templates/reflection.md` | agents |
| 32 | `.agents/verify/m0-consistency.md`（R1，冻结） | agents/verify |
| 33 | `.agents/verify/m0-commit-plan.md`（R1，冻结） | agents/verify |
| 34 | `.agents/verify/m0-consistency-r2.md`（R2） | agents/verify |
| 35 | `.agents/verify/m0-commit-plan-r2.md`（R2） | agents/verify |
| 36 | `Makefile` | build |
| 37 | `scripts/docs-check.sh` | build |
| 38 | `.gitignore` | config |
| 39 | `.editorconfig` | config |

## 2. 提交信息（修复并通过 R3 后使用这一条）

```
docs(m0): 初始化愿景、架构、路线图与 agent 管理架构
```

## 3. 提交动作（逐个显式 add，禁止目录级）

```bash
# 路径逐条来自 §1；禁止 git add . / git add -A / git add docs/
git add -- docs/VISION.md docs/ARCHITECTURE.md docs/CORE.md docs/GLOSSARY.md
git add -- docs/PLUGIN-PROTOCOL.md docs/RESOURCE-MODEL.md docs/DATA-MODEL.md
git add -- docs/FRONTEND.md docs/SECURITY.md docs/ROADMAP.md docs/PLAN.md docs/MILESTONE-M0.md
git add -- docs/DECISIONS/0001-go-stdlib-net-http.md docs/DECISIONS/0002-uds-length-prefix-json.md
git add -- docs/DECISIONS/0003-process-isolation-plugins.md docs/DECISIONS/0004-no-resident-middleware.md
git add -- docs/DECISIONS/0005-yaml-config-bbolt-state.md docs/DECISIONS/0006-vue-embed-single-binary.md
git add -- docs/DECISIONS/0007-frame-type-and-encoding-negotiation.md
git add -- README.md AGENTS.md
git add -- .agents/README.md .agents/ROLES.md .agents/WORKFLOW.md .agents/BOARD.md
git add -- .agents/QUALITY-GATES.md .agents/JOURNAL.md
git add -- .agents/templates/proposal.md .agents/templates/task.md .agents/templates/review.md .agents/templates/reflection.md
git add -- .agents/verify/m0-consistency.md .agents/verify/m0-commit-plan.md
git add -- .agents/verify/m0-consistency-r2.md .agents/verify/m0-commit-plan-r2.md
git add -- Makefile scripts/docs-check.sh .gitignore .editorconfig
git status --short          # staged 必须与 §1 完全一致（39 行）
git commit -m "docs(m0): 初始化愿景、架构、路线图与 agent 管理架构"
```

## 4. 提交后复核

1. `git log --oneline -1` → `docs(m0): 初始化愿景、架构、路线图与 agent 管理架构`。
2. `git status --short` → 空输出（构建产物已在 `.gitignore`）。
3. `git show --stat --oneline HEAD | head -50` → 39 个文件、无删除记录；插入行数以实际为准。
4. `make docs-check` → `docs-check: 6 pass, 0 warn, 0 fail`（此时应为 33 份文档）。
5. 仅改 `.agents/BOARD.md` 的 **M0-G 行**：`status=completed`，evidence 填 `git log --oneline -1` 输出 + commit hash + `git status --short` 空 + 39 文件/行数；BOARD 其余行不动。

## 5. 本轮阻塞项（修复清单）

- R2 #14：必选方法口径（4 方法 + 1 事件通道）需同步 GLOSSARY:45 / ADR-0002:14 / VISION:95,119 / ARCHITECTURE:252 / PLAN:26,57。
- R2 #17：`ROADMAP:91,95` 的 `/api/v1/-/healthz` 改为 `/-/healthz`。
- R2 N1：`ARCHITECTURE:113` 中间件链补 `csrf`（8 层）。
- R2 N2：`DATA-MODEL:129,177-180` 与 `ARCHITECTURE:160` 的状态目录退出码统一（3 或 4）。
- R2 N3：`CORE:56` 与 `DATA-MODEL:40`/`SECURITY:73` 的首启空口令行为统一。
- R2 N4：`FRONTEND:50,104` 端点补 `/api/v1` 前缀。

上述 6 项闭环后由 verifier 出 R3；R3 全 CLOSED 才执行 §3。
