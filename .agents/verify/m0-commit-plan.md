> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 验收者: verifier（m0-g-verify） · 关联报告: `m0-consistency.md`（同日，结论 REVISE）
> 当前状态: **阻塞，不得执行提交**。本文件是修复并重验通过后的提交基线；VERDICT 为 REVISE 时禁止 `git add` / `git commit`。

# M0 首次提交计划（待批准）

## 1. 前置条件（缺一不可）

1. `m0-consistency.md` 的 28 条问题全部闭环，或经 lead 裁决降级为"已知风险"并写入 BOARD §5。
2. `make docs-check` 末行 `docs-check: 6 pass, 0 warn, 0 fail`，退出码 0（报告文件落盘后需复核 31 份文档元信息）。
3. `make check` 退出码 0；`make build` 仍为 `[SKIP]` 且退出码 0。
4. `git status --short` 的 staged 列表必须与本文件 §2 清单逐字一致。

## 2. 待提交文件清单（`git status --porcelain` 实际枚举，35 + 2 = 37 行）

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
| 32 | `.agents/verify/m0-consistency.md` | agents |
| 33 | `.agents/verify/m0-commit-plan.md` | agents |
| 34 | `Makefile` | build |
| 35 | `scripts/docs-check.sh` | build |
| 36 | `.gitignore` | config |
| 37 | `.editorconfig` | config |

## 3. 提交信息（最终使用这一条）

```
docs(m0): 初始化愿景、架构、路线图与 agent 管理架构
```

## 4. 为何这些文件属于同一检查点

一句话：它们是 M0 一个自洽的文档基线——`docs/` 定义契约、`.agents/` 定义协作规则、`Makefile` 与 `docs-check.sh` 是这批契约的唯一可执行门禁、`.gitignore`/`.editorconfig` 是仓库骨架的工程约定，缺任一组都无法单独通过 `make docs-check` + `make check`，故必须同一提交。

## 5. 提交动作（逐个显式 add，禁止目录级）

```bash
# 逐行执行，路径来自 §2；禁止 git add . / git add -A / git add docs/
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
git add -- Makefile scripts/docs-check.sh .gitignore .editorconfig
git status --short          # staged 必须与 §2 完全一致，多一个少一个都不提交
git commit -m "docs(m0): 初始化愿景、架构、路线图与 agent 管理架构"
```

## 6. 提交后复核（三步，需贴原文与退出码）

1. `git log --oneline -1` → 期望 `docs(m0): 初始化愿景、架构、路线图与 agent 管理架构`。
2. `git status --short` → 期望空输出（无残留未跟踪文件；`bin/` 等构建产物已在 `.gitignore`）。
3. `git show --stat --oneline HEAD | head -40` → 期望 37 个文件变更、插入行数约 4,600（含两份验收报告），无删除记录。

## 7. 提交后状态登记（仅当提交成功）

- 把 `.agents/BOARD.md` 的 **M0-G 行** 状态改为 `completed`，evidence 填：`git log --oneline -1` 输出 + commit hash + `git status --short` 空输出。
- 只改 M0-G 这一行；A–F 行不动（他人写域）。
- 同步 `.agents/JOURNAL.md` 里程碑记录与本报告的 VERDICT 行，注明"提交 hash"。

## 8. 当前阻塞说明

第 2 次复跑 `make docs-check` 时本目录新增 `m0-consistency.md` 与 `m0-commit-plan.md`，文档总数由 29 增至 31；这两份文件前 5 行已带 `> 状态:` 与 `里程碑: M0`，不会破坏门禁，但**必须**在修复后重跑一次确认。VERDICT 为 REVISE 期间，本计划仅作为清单，不执行 §5。
