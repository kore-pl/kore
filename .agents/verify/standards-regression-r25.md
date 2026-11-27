# 六项开源标准回归审计 · Round 25 固化记录（standards-regression-r25）

> 日期：2026-11-27 · 执行者：standards-r25（文档 worker）· 来源：task-217（回归审计）+ task-218 / 219 / 220（develop 收敛）+ lead 三项裁决
> 性质：**纯文档固化**。本卡不重跑审计、不联网、不改代码、不碰运行实例（G-29）；结论以四张上游任务卡的回报为准，历史原文不被改写。

## 0. 结论摘要

- 六项开源标准回归审计（26 仓）：**五项 26/26 全绿**；第六项「分支保护」26/26 全缺，经 lead 裁决为**主动不做**（单人仓库开 review 会阻塞默认发版，且可逆）。
- 上一轮唯一实质漂移（develop 分叉）已收敛：**22 仓 FF 合并 + 三端推送**，三端回读全 `MATCH_LOCAL`；无 force、无手工改文件。
- 三项裁决 + 1 条历史口径已逐条留痕（§2）；本卡精确路径提交，`-s` 签名，**不 push、不联网**。

## 1. 审计结论（task-217）

审计范围：26 个独立仓库 = `kore` + `kore-plugins` + 24 个 `kore-plugin-*`；判据以 `oss-project-standards` 技能 A①–A⑥ 与本卡定义的 Wiki 六页口径为准。

| 标准 | 结果 | 判据与说明 |
| --- | --- | --- |
| A① 签名 release tag | **26/26 全绿** | 全部 annotated tag，`git tag -v` 出现 **Good signature**；含近轮全部新版本；历史 tag 一律未改写、未重签、未强推 |
| A② Wiki 六页 | **156/156 全绿** | 26 仓 × 6 页 = 156 页 HTTP 200，中文、零日语；六页按**本卡定义**为 Home / Installation / Configuration / Usage / FAQ / Changelog |
| A③ 安全功能 | **26/26 全绿** | 三文件（`.github/dependabot.yml`、`.github/CODEOWNERS`、`SECURITY.md`）齐备；`gh api` 回读四项开关（vulnerability alerts / automated security fixes / dependency graph / private vulnerability reporting）均已开启 |
| A⑤ 七语言零日语 | **26/26 全绿** | locale 正好 `de` / `en` / `es` / `fr` / `pt` / `ru` / `zh`，无 `ja` / `jp`，无日文字符；README / DETAIL 语言入口对齐 |
| A⑥ star 提示 | **26/26 全绿** | 26 仓显著位置均有 star 引导，未打断正文 |
| A④ 分支保护 | **0/26（裁决不做）** | 26 仓 main 均未开 required review / checks；按 §2.1 裁决为主动选择，不补、不阻塞发版 |

口径边界：Wiki 的技能定义另含 Contributing 页，26 仓该页 404；本轮按 §2.3 裁决以本卡六页定义为准，不计缺口。SECURITY 七语译文的 16 仓缺口属基线问题，按 §2.2 处理，不计入发版漂移。

## 2. lead 裁决（三项决策 + 一条历史口径）

### 2.1 裁决一 · 分支保护 26/26 全缺 —— 不做

- **事实**：26 仓 main/master 均未配置 review / required checks 保护。
- **理由**：单人仓库开启 review 会成为用户要求的「默认发版」自动流程的阻塞点；属**主动选择而非遗漏**；设置本身可逆。
- **结论**：不补分支保护、不为此改发版流程；仅当转为多人协作或用户明确要求时重开。

### 2.2 裁决二 · SECURITY 七语译文 16 仓仅 zh + en —— 暂不收敛

- **事实**：16 仓的 SECURITY 译文只覆盖 zh + en 两语，未达七语基线。
- **判据**：git 历史证实从未存在六语版本 → 属**基线缺口**，非本轮发版漂移。
- **结论**：本轮不补译、不阻塞发版；保留为已知基线缺口，后续需要时单独开卡收敛。

### 2.3 裁决三 · Wiki 六页定义以本卡为准 —— 不补 Contributing

- **事实**：技能 A② 定义含 Contributing，26 仓该页 404；本卡定义的六页 156/156 全过。
- **结论**：回归审计以本卡定义（Home / Installation / Configuration / Usage / FAQ / Changelog）为准，不补 Contributing 页；后续审计沿用此口径。

### 2.4 历史口径（非新增决策）· commit 格式轻微偏差 —— 历史不改写

- **事实**：`kore` 3 条 / `kore-plugin-app-deploy` 1 条 commit 轻微偏离 `type(scope): 中文描述`。
- **结论**：历史提交**不改写**（禁 amend / reset / rebase / force-push）；后续提交按约定执行。

## 3. develop 收敛结果（task-218 / 219 / 220）

- **问题**：上一轮唯一实质漂移 = 26 仓 develop 与权威源 / 镜像分叉。
- **做法**：22 仓逐一 fast-forward 合并 + 三端推送；无 force、无手工改文件、无新建或改写 tag。

| 仓库 | 收敛动作 | 结果 / 落点 |
| --- | --- | --- |
| `kore` | FF 合并 117 个提交 | develop HEAD `d9f12c2`（本卡已 `git rev-parse` 回读） |
| `kore-plugins` | `git merge -X ours`，保留双亲 | `af559a4` + `5d2b957`；索引与版本**零回退** |
| `kore-plugin-container` | 纯 FF | `8a56684` |
| `kore-plugin-dns` | 纯 FF | `597ac30` |
| `kore-plugin-runtime-node` | 纯 FF | `99ece6c` |
| 其余 17 仓 | 纯 FF | 22 仓合计全部收敛 |

- **三端回读**：每仓 origin（Gitea，权威源）/ github / gitee 的 develop 分支 sha 全部 `MATCH_LOCAL`。
- **禁止项核对**：无 force push；未手工改任何文件；未触碰签名 tag 与运行态资产（G-29）。

## 4. 落点与复审

- 本文件是 round 25 的**最小落点**；[docs/OPEN-SOURCE.md](../../docs/OPEN-SOURCE.md)（治理口径文档，无对应章节）与 `docs/FEATURE-GAP-BACKLOG.md`（产品竞品差距台账，非工程标准裁决）本轮不改，四项裁决已在 §2 完整留痕。
- 上游任务卡：task-217（审计）、task-218 / 219 / 220（收敛）；本轮文档卡：task-221。
- 复审条件：仓库数量、签名策略、Wiki 六页定义或三端拓扑发生变化时重跑审计；分支保护在多人协作或用户明确要求时重开裁决；SECURITY 七语基线缺口单独开卡时更新 §2.2。
