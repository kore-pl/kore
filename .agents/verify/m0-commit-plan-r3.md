> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 关联报告：R3 = `.agents/verify/m0-consistency-r3.md`（结论 **REVISE**：43 CLOSED / 1 STILL-OPEN）；R1/R2 为冻结证据，不改。
> 当前状态：**阻塞，未执行**。N3 残留（`CORE:42`）与 O1（`WORKFLOW:36`/`ROLES:38`）修复并复验通过前，禁止 `git add`/`git commit`。
> **提交边界**：`.agents/proposals/` 与 `.agents/reviews/` 是 M1 并行写域，**无论内容是否已落盘，一律排除**；本清单只含 M0 交付物。

# M0 首次提交计划 R3

## 1. 待提交文件清单（M0 交付物，43 行）

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
| 10 | `docs/REPOS.md` | docs |
| 11 | `docs/ROADMAP.md` | docs |
| 12 | `docs/PLAN.md` | docs |
| 13 | `docs/MILESTONE-M0.md` | docs |
| 14 | `docs/DECISIONS/0001-go-stdlib-net-http.md` | docs |
| 15 | `docs/DECISIONS/0002-uds-length-prefix-json.md` | docs |
| 16 | `docs/DECISIONS/0003-process-isolation-plugins.md` | docs |
| 17 | `docs/DECISIONS/0004-no-resident-middleware.md` | docs |
| 18 | `docs/DECISIONS/0005-yaml-config-bbolt-state.md` | docs |
| 19 | `docs/DECISIONS/0006-vue-embed-single-binary.md` | docs |
| 20 | `docs/DECISIONS/0007-frame-type-and-encoding-negotiation.md` | docs |
| 21 | `docs/DECISIONS/0008-multi-repo-topology.md` | docs |
| 22 | `README.md` | docs |
| 23 | `AGENTS.md` | agents |
| 24 | `.agents/README.md` | agents |
| 25 | `.agents/ROLES.md` | agents |
| 26 | `.agents/WORKFLOW.md` | agents |
| 27 | `.agents/BOARD.md` | agents |
| 28 | `.agents/QUALITY-GATES.md` | agents |
| 29 | `.agents/JOURNAL.md` | agents |
| 30 | `.agents/templates/proposal.md` | agents |
| 31 | `.agents/templates/task.md` | agents |
| 32 | `.agents/templates/review.md` | agents |
| 33 | `.agents/templates/reflection.md` | agents |
| 34 | `.agents/verify/m0-consistency.md`（R1，冻结） | agents/verify |
| 35 | `.agents/verify/m0-commit-plan.md`（R1，冻结） | agents/verify |
| 36 | `.agents/verify/m0-consistency-r2.md`（R2） | agents/verify |
| 37 | `.agents/verify/m0-commit-plan-r2.md`（R2） | agents/verify |
| 38 | `.agents/verify/m0-consistency-r3.md`（R3） | agents/verify |
| 39 | `.agents/verify/m0-commit-plan-r3.md`（R3） | agents/verify |
| 40 | `Makefile` | build |
| 41 | `scripts/docs-check.sh` | build |
| 42 | `.gitignore` | config |
| 43 | `.editorconfig` | config |

**明确排除**：`.agents/proposals/**`、`.agents/reviews/**`（M1 并行写域，下次 M1 检查点单独提交）。若目录尚不存在则无实际文件；若出现，提交前必须用 `git status --short` 核对并排除。

## 2. 提交信息

```
docs(m0): 初始化愿景、架构、路线图与 agent 管理架构
```

## 3. 执行步骤（修复并通过复验后）

```bash
# 0) 快照与核对：真实枚举必须与 §1 对齐（proposals/reviews 不得出现）
git status --porcelain -uall | grep -v -E '^.. \.agents/(proposals|reviews)/' | wc -l   # 期望 43

# 1) 逐个显式 add（禁止 . / -A / 目录级）
git add -- docs/VISION.md docs/ARCHITECTURE.md docs/CORE.md docs/GLOSSARY.md docs/REPOS.md
git add -- docs/PLUGIN-PROTOCOL.md docs/RESOURCE-MODEL.md docs/DATA-MODEL.md docs/FRONTEND.md docs/SECURITY.md
git add -- docs/ROADMAP.md docs/PLAN.md docs/MILESTONE-M0.md
git add -- docs/DECISIONS/0001-go-stdlib-net-http.md docs/DECISIONS/0002-uds-length-prefix-json.md
git add -- docs/DECISIONS/0003-process-isolation-plugins.md docs/DECISIONS/0004-no-resident-middleware.md
git add -- docs/DECISIONS/0005-yaml-config-bbolt-state.md docs/DECISIONS/0006-vue-embed-single-binary.md
git add -- docs/DECISIONS/0007-frame-type-and-encoding-negotiation.md docs/DECISIONS/0008-multi-repo-topology.md
git add -- README.md AGENTS.md
git add -- .agents/README.md .agents/ROLES.md .agents/WORKFLOW.md .agents/BOARD.md .agents/QUALITY-GATES.md .agents/JOURNAL.md
git add -- .agents/templates/proposal.md .agents/templates/task.md .agents/templates/review.md .agents/templates/reflection.md
git add -- .agents/verify/m0-consistency.md .agents/verify/m0-commit-plan.md
git add -- .agents/verify/m0-consistency-r2.md .agents/verify/m0-commit-plan-r2.md
git add -- .agents/verify/m0-consistency-r3.md .agents/verify/m0-commit-plan-r3.md
git add -- Makefile scripts/docs-check.sh .gitignore .editorconfig

# 2) staged 必须恰好 43 行且不含 proposals/reviews
git status --short
git diff --cached --name-only | grep -E '^\.agents/(proposals|reviews)/' && echo "违规：M1 文件被 staged" && exit 1 || true
git diff --cached --name-only | wc -l    # 期望 43

# 3) 提交
git commit -m "docs(m0): 初始化愿景、架构、路线图与 agent 管理架构"
```

## 4. 提交后复核

1. `git log --oneline -1` → `docs(m0): 初始化愿景、架构、路线图与 agent 管理架构`。
2. `git status --short` → 仅剩 `.agents/proposals/`、`.agents/reviews/` 等 M1 未跟踪文件（若已出现），无 staged。
3. `git show --stat --oneline HEAD | head -60` → 43 文件、无删除记录。
4. `make docs-check && make repo-check && make check` → 全绿（文档数 37 份）。
5. 只改 `.agents/BOARD.md` 的 **M0-G 行**：`status=completed`，evidence 填 commit hash + `git log --oneline -1` + 43 文件/行数 + `git status --short` 结果；其余行不动。

## 5. 本轮阻塞项（修复清单，共 3 项）

| # | 位置 | 修法 |
| --- | --- | --- |
| N3 | `docs/CORE.md:42` | 删掉「（如 `auth.admin_password_hash`）」这个必填缺失例子；首启空哈希按 `CORE:56` bootstrap，只有 `initialized=true` 但哈希为空才 exit 2 |
| O1 | `.agents/WORKFLOW.md:36`、`.agents/ROLES.md:38` | implementer 输出目录去掉 `plugins/`，改为 `cmd/ internal/ pkg/ web/`（跨仓库实现另在插件仓库） |
| O2/O3 | `ROADMAP:119`、`GLOSSARY:106`、`DATA-MODEL:159` | 散文端点补 `/api/v1`；`kored db dump` 在 CORE/ARCHITECTURE 登记为子命令（或删该示例） |

上述 3 项闭环后由 verifier 出 R4 复核；R4 通过即按 §3 提交。
