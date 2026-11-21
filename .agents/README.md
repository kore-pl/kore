# .agents · agent 协作体系

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

## 1. 为什么需要这套东西

上下文是有限的：单个 agent 连续干活越久，越容易忘记早期约束、跳过门禁、把"感觉能跑"当"已经跑过"。
解法不是让一个 agent 更努力，而是把工作拆成**角色 + 文件 + 证据**三件事：

1. **角色分离**：写代码的人不给自己发合格证；挑毛病的人不许顺手改代码。
2. **产物落文件**：提案、评审、验收、复盘都是仓库里的文件，换 agent、压缩上下文、隔周回看都不丢。
3. **证据验收**：完成判据是「命令 + 退出码 + 关键输出」，不是任何人的自述。

一句话：**agent 的记忆靠文件，agent 的信用靠证据。**

## 2. 角色总览

```
                       ┌──────────────┐
                       │     lead     │  拆解 / 派发 / 验收（不写代码）
                       └──────┬───────┘
        ┌────────────┬────────┼────────┬────────────┐
  ┌─────▼──────┐┌────▼───────┐┌───▼────┐┌───▼──────┐┌───▼─────┐
  │ architect  ││ implementer││verifier││ red-team ││  scribe │
  └─────┬──────┘└────┬───────┘└───┬────┘└───┬──────┘└───┬─────┘
        │            │            │         │           │
  docs/DECISIONS/  代码+自测   验收报告   问题单   JOURNAL / CHANGELOG
        └──────────── 提案与评审记录 ◄── .agents/proposals/ ──────────┘
```

| 角色 | 一句话 | 不做什么 |
| --- | --- | --- |
| lead | 编排、拆解、派发、验收 | 不写代码、不跑执行命令 |
| architect | 定边界与依赖，写 ADR | 不实现功能 |
| implementer | 实现与自测 | 不自行改验收标准 |
| verifier | 独立复跑门禁 | 不复用实现者结论 |
| red-team | 蓝军攻击：膨胀、越权、崩溃、资源 | 只出问题单，不修代码 |
| scribe | 文档同步、CHANGELOG、复盘归档 | 不改业务代码 |

完整角色卡（输入 / 输出 / 可做 / 禁止 / 交接物 / 完成判据）见 [ROLES.md](ROLES.md)。

## 3. Kore Loop

```
提案 ──► 双评审(architect + red-team) ──► 拆解 ──► 实现 ──► 验证(verifier) ──► 蓝军 ──► 归档复盘
```

七阶段固定，不许合并、不许跳步：跳步等于把"我没想过"伪装成"不需要想"。每个阶段的入口条件、动作、产出文件、门禁、失败回退见 [WORKFLOW.md](WORKFLOW.md)。

## 4. 产物地图

| 产物 | 落盘位置 | 谁写 | 什么时候写 |
| --- | --- | --- | --- |
| 提案 | `.agents/proposals/<日期>-<slug>.md`（模板 [templates/proposal.md](templates/proposal.md)） | 提案人 | Loop 第 1 阶段 |
| 评审 / 攻击记录 | 提案同目录 `<slug>.review.md`（模板 [templates/review.md](templates/review.md)） | architect / red-team | Loop 第 2、6 阶段 |
| 任务卡 | [BOARD.md](BOARD.md)（模板 [templates/task.md](templates/task.md)） | lead | Loop 第 3 阶段 |
| 验收报告 | `.agents/verify/<日期>-<范围>.md`（M0 为 `m0-consistency.md`、`m0-commit-plan.md`） | verifier | Loop 第 5 阶段 |
| 复盘 | [JOURNAL.md](JOURNAL.md)（模板 [templates/reflection.md](templates/reflection.md)） | scribe | Loop 第 7 阶段 |
| 判断台账 | [LOG/](LOG/)（`DECISIONS.md` / `DISPATCH.md` / `sessions/`） | scribe | 裁决当天 / 派发时 / 里程碑收口 |
| 决策 | [docs/DECISIONS/](../docs/DECISIONS/) `NNNN-<slug>.md` | architect | 做出不可逆选择时 |
| 变更集 | [BOARD.md](BOARD.md)「变更集登记区」 | lead | 跨仓库改动开始时 |
| 索引条目 | `kore-plugins` 仓库的 `index/plugins.json` | scribe | 插件发版后 |
| 协议 SDK 版本 | `kore` 仓库 `pkg/pluginapi` 的 tag | architect | 协议有增删改时 |

`.agents/verify/` 目录归属 **verifier**：每次验收落一份报告，只写事实（命令 + 退出码 + 关键输出 + 逐项 PASS/FAIL + 问题编号）。复验时不改旧报告内容，而是追加新报告并在新报告里引用旧报告的问题编号（如 M0 的 13/21/23）；旧报告是冻结证据，改它就等于改历史。

规则：**产物必须落文件**。只在对话里说过的结论，等于没发生；换 agent 后没人能引用它。

## 5. 新 agent 加入 5 步

1. 读根 [AGENTS.md](../AGENTS.md)：硬门禁、阅读顺序、提交与派发纪律。
2. 读自己要扮演的角色卡 [ROLES.md](ROLES.md)：确认使命、写域、禁止项与完成判据。
3. 到 [BOARD.md](BOARD.md) 领任务：只领 `status=pending` 且 `blocked_by` 已全部 complete 的任务，claim 时带上当前 revision。
4. 带证据交付：命令原文 + 退出码 + 关键输出写进 evidence；`write_scopes` 之外的文件一个都不动。
5. 写复盘或交接：本任务结束前把结论、踩坑、遗留写进 [JOURNAL.md](JOURNAL.md)；跨会话任务先写 `[KORE-CHECKPOINT]`。

## 6. 反模式清单

| 反模式 | 为什么错 | 正确做法 |
| --- | --- | --- |
| 自行修改验收标准（放宽命令、跳过失败用例、删断言） | 等于自己给自己发合格证，缺陷直接进主干 | 验收标准只由提案与 lead 改；有异议提交证据，由 verifier 用原命令复跑 |
| 跳过 verifier，implementer 自证通过 | 写的人看不见自己写歪的地方，G3/G5/G7 全部形同虚设 | 每个合并前任务都必须有独立 verifier 报告 |
| 只聊天不落文件 | 上下文一压缩，讨论成果蒸发，后来者重复踩坑 | 结论一律写进 proposals / BOARD / verify / JOURNAL |
| 跨角色改别人的写域 | 两处编辑互相覆盖，冲突排查成本远高于收益 | 需要改他人文件时回拆解阶段，重画 `write_scopes` 再派 |
| 一次 Loop 追多个目标 | 验收标准互相污染，失败后无法定位是哪一项 | 一个提案一个目标；超范围就拆成下一个 Loop |
| 用"差不多""应该可以"结束任务 | 没有证据的完成 = 未完成 | 贴命令与退出码；跑不了就写 N/A + 原因，不许含糊 |
| 在 `kore` 仓库里塞插件代码或插件前端 | 插件不属于内核仓库，混进来会让内核被迫跟业务耦合、也让插件无法独立发版 | 插件代码去 `kore-plugin-<id>` 仓库；只把协议面留在 `kore/pkg/pluginapi`（G-13 / G11） |
