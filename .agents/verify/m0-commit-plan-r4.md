> 状态: draft · 归属: verifier · 更新: 2026-11-21 · 里程碑: M0
> 关联报告：R4 = `.agents/verify/m0-consistency-r4.md`（结论 **REVISE**：7 项阻断）；R1–R3 为冻结证据，不改。
> 当前状态：**阻塞，未执行**。F1–F4 与 V1-1…V1-3 闭环前禁止 `git add`/`git commit`。
> **提交边界**：`.agents/proposals/**` 与 `.agents/reviews/**` 属 M1 并行写域，**一律排除**（本清单已排除 3 个文件）。

# M0 首次提交计划 R4

## 1. 待提交文件清单（56 行，按 `git status --porcelain -uall` 排除 proposals/reviews 后枚举）

| # | 路径 | 类别 |
| --- | --- | --- |
| 1 | `.agents/BOARD.md` | agents |
| 2 | `.agents/JOURNAL.md` | agents |
| 3 | `.agents/QUALITY-GATES.md` | agents |
| 4 | `.agents/README.md` | agents |
| 5 | `.agents/ROLES.md` | agents |
| 6 | `.agents/WORKFLOW.md` | agents |
| 7 | `.agents/templates/proposal.md` | agents |
| 8 | `.agents/templates/reflection.md` | agents |
| 9 | `.agents/templates/review.md` | agents |
| 10 | `.agents/templates/task.md` | agents |
| 11 | `.agents/verify/m0-commit-plan-r2.md` | agents/verify |
| 12 | `.agents/verify/m0-commit-plan-r3.md` | agents/verify |
| 13 | `.agents/verify/m0-commit-plan-r4.md` | agents/verify |
| 14 | `.agents/verify/m0-commit-plan.md` | agents/verify |
| 15 | `.agents/verify/m0-consistency-r2.md` | agents/verify |
| 16 | `.agents/verify/m0-consistency-r3.md` | agents/verify |
| 17 | `.agents/verify/m0-consistency-r4.md` | agents/verify |
| 18 | `.agents/verify/m0-consistency.md` | agents/verify |
| 19 | `.editorconfig` | config |
| 20 | `.gitignore` | config |
| 21 | `AGENTS.md` | agents |
| 22 | `Makefile` | build |
| 23 | `README.md` | docs |
| 24 | `docs/ARCHITECTURE.md` | docs |
| 25 | `docs/COMPATIBILITY.md` | docs |
| 26 | `docs/CORE.md` | docs |
| 27 | `docs/DATA-MODEL.md` | docs |
| 28 | `docs/DECISIONS/0001-go-stdlib-net-http.md` | docs |
| 29 | `docs/DECISIONS/0002-uds-length-prefix-json.md` | docs |
| 30 | `docs/DECISIONS/0003-process-isolation-plugins.md` | docs |
| 31 | `docs/DECISIONS/0004-no-resident-middleware.md` | docs |
| 32 | `docs/DECISIONS/0005-yaml-config-bbolt-state.md` | docs |
| 33 | `docs/DECISIONS/0006-vue-embed-single-binary.md` | docs |
| 34 | `docs/DECISIONS/0007-frame-type-and-encoding-negotiation.md` | docs |
| 35 | `docs/DECISIONS/0008-multi-repo-topology.md` | docs |
| 36 | `docs/DECISIONS/0009-compatibility-baseline.md` | docs |
| 37 | `docs/DECISIONS/0010-cross-platform-abstraction.md` | docs |
| 38 | `docs/DECISIONS/0011-pluginapi-nested-module.md` | docs |
| 39 | `docs/DECISIONS/0012-scenario-presets-and-store.md` | docs |
| 40 | `docs/DECISIONS/0013-extreme-resource-frugality.md` | docs |
| 41 | `docs/DECISIONS/0014-v1-scope-and-depth-tiers.md` | docs |
| 42 | `docs/FEATURE-PARITY.md` | docs |
| 43 | `docs/FRONTEND.md` | docs |
| 44 | `docs/GLOSSARY.md` | docs |
| 45 | `docs/MILESTONE-M0.md` | docs |
| 46 | `docs/PLAN.md` | docs |
| 47 | `docs/PLUGIN-CATALOG.md` | docs |
| 48 | `docs/PLUGIN-PROTOCOL.md` | docs |
| 49 | `docs/REPOS.md` | docs |
| 50 | `docs/RESOURCE-MODEL.md` | docs |
| 51 | `docs/ROADMAP.md` | docs |
| 52 | `docs/SCENARIOS.md` | docs |
| 53 | `docs/SECURITY.md` | docs |
| 54 | `docs/V1-GOALS.md` | docs |
| 55 | `docs/VISION.md` | docs |
| 56 | `scripts/docs-check.sh` | build |

**明确排除**：`.agents/proposals/0001-m1-walking-skeleton.md`、`.agents/reviews/0001-m1-premortem.md`、`.agents/reviews/0002-v1-parity-scope-premortem.md`（M1 规划件，下次 M1 检查点单独提交）。

## 2. 提交信息

```
docs(m0): 初始化愿景、架构、路线图与 agent 管理架构
```

## 3. 执行步骤（R5 通过后）

```bash
# 0) 真实枚举必须与 §1 一致（56 行），proposals/reviews 不得出现
git status --porcelain -uall | grep -v -E '^\?\? \.agents/(proposals|reviews)/' | wc -l   # 期望 56

# 1) 逐个显式 add（禁止 . / -A / 目录级）
git add -- docs/VISION.md docs/ARCHITECTURE.md docs/CORE.md docs/GLOSSARY.md docs/REPOS.md
git add -- docs/PLUGIN-PROTOCOL.md docs/RESOURCE-MODEL.md docs/DATA-MODEL.md docs/FRONTEND.md docs/SECURITY.md
git add -- docs/FEATURE-PARITY.md docs/PLUGIN-CATALOG.md docs/SCENARIOS.md docs/COMPATIBILITY.md docs/V1-GOALS.md
git add -- docs/ROADMAP.md docs/PLAN.md docs/MILESTONE-M0.md
git add -- docs/DECISIONS/0001-go-stdlib-net-http.md docs/DECISIONS/0002-uds-length-prefix-json.md
git add -- docs/DECISIONS/0003-process-isolation-plugins.md docs/DECISIONS/0004-no-resident-middleware.md
git add -- docs/DECISIONS/0005-yaml-config-bbolt-state.md docs/DECISIONS/0006-vue-embed-single-binary.md
git add -- docs/DECISIONS/0007-frame-type-and-encoding-negotiation.md docs/DECISIONS/0008-multi-repo-topology.md
git add -- docs/DECISIONS/0009-compatibility-baseline.md docs/DECISIONS/0010-cross-platform-abstraction.md
git add -- docs/DECISIONS/0011-pluginapi-nested-module.md docs/DECISIONS/0012-scenario-presets-and-store.md
git add -- docs/DECISIONS/0013-extreme-resource-frugality.md docs/DECISIONS/0014-v1-scope-and-depth-tiers.md
git add -- README.md AGENTS.md
git add -- .agents/README.md .agents/ROLES.md .agents/WORKFLOW.md .agents/BOARD.md .agents/QUALITY-GATES.md .agents/JOURNAL.md
git add -- .agents/templates/proposal.md .agents/templates/task.md .agents/templates/review.md .agents/templates/reflection.md
git add -- .agents/verify/m0-consistency.md .agents/verify/m0-commit-plan.md
git add -- .agents/verify/m0-consistency-r2.md .agents/verify/m0-commit-plan-r2.md
git add -- .agents/verify/m0-consistency-r3.md .agents/verify/m0-commit-plan-r3.md
git add -- .agents/verify/m0-consistency-r4.md .agents/verify/m0-commit-plan-r4.md
git add -- Makefile scripts/docs-check.sh .gitignore .editorconfig

# 2) staged 必须恰好 56 行且不含 proposals/reviews
git diff --cached --name-only | grep -E '^\.agents/(proposals|reviews)/' && echo "违规：M1 文件被 staged" && exit 1 || true
git diff --cached --name-only | wc -l    # 期望 56

# 3) 提交
git commit -m "docs(m0): 初始化愿景、架构、路线图与 agent 管理架构"
```

## 4. 提交后复核

1. `git log --oneline -1` → `docs(m0): 初始化愿景、架构、路线图与 agent 管理架构`。
2. `git status --short` → 仅剩 `.agents/proposals/`、`.agents/reviews/` 3 个未跟踪文件，无 staged。
3. `git show --stat --oneline HEAD | head -80` → 56 文件、无删除记录。
4. `make docs-check && make repo-check && make check` → 全绿（提交后文档数 53 份）。
5. 只改 `.agents/BOARD.md` 的 **M0-G 行**：`status=completed`，evidence 填 commit hash + `git log --oneline -1` + 56 文件/行数 + `git status --short`；其余行不动。

## 5. 当前阻塞项（7 条，修复后出 R5）

| # | 位置 | 修法 |
| --- | --- | --- |
| F1 | `Makefile:3` | 改为「主壳 ≤8 MiB（`GOGC=100`+`GOMEMLIMIT=6MiB`）· 常驻单 ≤12 MiB / 合计 ≤24 MiB」；48 MiB 只允许留在旧值说明里 |
| F2 | `CORE:68,69`、`GLOSSARY:31` | `type` → `lifecycle`（三值），补 `requires_kore`/`idle_timeout_s` 等字段；视图字段同步 |
| F3 | `CORE` §2/§10/路由表 | 补 installer/market 模块规格、`kored install --scenario/--package` 子命令、`POST /api/v1/store/install` + `GET /api/v1/store/jobs/{id}`，写明两入口共用 installer |
| F4 | `V1-GOALS:52` vs `SECURITY:33` | capabilities 校验点统一为同一数字（两处或三处），以 SECURITY 的校验表为准并同步 V1 |
| V1-1 | `AGENTS:32` G-03 | 补「推荐 ≤2、硬上限 3」，与 `V1-GOALS:34`/`RESOURCE:59` 逐字一致 |
| V1-2 | `ROADMAP §7.2` M1 退出条件 | 补「启动到就绪 ≤1s、API p95 ≤50ms」，与 `V1-GOALS:40`/`PLAN:244-245` 一致 |
| V1-3 | `V1-GOALS:22` | 补 12/8 插件名单（与 `ROADMAP:104-105`/`PLUGIN-CATALOG:85-86` 逐字相同，echo 不评级） |
