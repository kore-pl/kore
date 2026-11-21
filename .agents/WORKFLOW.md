# .agents · 工作流（Kore Loop）

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

七阶段固定顺序：**提案 → 双评审 → 拆解 → 实现 → 验证 → 蓝军 → 归档复盘**。
不合并、不跳步、不并行跨阶段——上一阶段的产出文件不存在，下一阶段不许开工。

## 1. 阶段一：提案

- 入口条件：有明确需求或问题单；提出者能说清"要解决什么"与"不做什么"。
- 动作：按 [templates/proposal.md](templates/proposal.md) 写提案，逐项对齐五锚点与非目标表，明确不做范围。
- 产出文件：`.agents/proposals/<YYYY-MM-DD>-<slug>.md`。
- 门禁：背景必须带证据（文件:行 或命令输出）；验收标准必须可执行；未写"不做范围"的提案退回。
- **Scope 变更三问（必答，缺一退回）**：① 是不是 22 项能力域以内（不在就进 6 项不做清单，别开新插件）；② 深度等级是 `production` 还是 `basic`（G-20）；③ 这次不做，用户如何得知（商店等级 / 预设标注 / 文档）。答不清这三条，说明需求还没想清楚。
- 失败回退：缺验收标准或范围失控 → 退回提案人重写，不入评审。

## 2. 阶段二：双评审（architect + red-team）

- 入口条件：提案文件已落盘且字段完整。
- 动作：architect 评边界与依赖（模块归属、白名单、协议兼容、预算数字）；red-team 攻击膨胀、越权、崩溃、资源；双方各出一份评审意见，格式见第 5 节。
- 产出文件：`.agents/proposals/<slug>.review.md`（两份意见合并在同一文件，署名到角色）。
- 门禁：两份意见都含 `VERDICT:` 行；`REJECT` 必须给替代路径；`REVISE` 必须列可执行的修改项。
- 失败回退：任一方 `REJECT` → 回提案阶段重写；`REVISE` → 提案人改完重新送审，**不得跳过复审**。

## 3. 阶段三：拆解

- 入口条件：双评审结论为 `APPROVE`（或 `REVISE` 已复审通过）。
- 动作：lead 拆任务卡，每条 1–2 小时可完成；写 `owner` / `write_scopes` / `blocked_by` / 验收命令；同层写域不得重叠；`in_progress` 总数 ≤ 5。
- 产出文件：[BOARD.md](BOARD.md) 新增任务行（模板 [templates/task.md](templates/task.md)）。
- 门禁：缺验收命令、写域重叠、粒度超 2 小时 → 打回重拆。
- 失败回退：依赖画不出来 → 回双评审确认边界；写域必冲突 → 串行化，用 `blocked_by` 表达顺序。

## 4. 阶段四：实现

- 入口条件：任务 `status=pending` 且 `blocked_by` 全部 complete；implementer 已 claim（带当前 revision）。
- 动作：按契约写实现与测试；每完成一个自洽检查点就跑 G1/G2/G4 并精确提交；不动写域外文件。
- 产出文件：代码与测试（`cmd/kored/`、`internal/core/*`、`pkg/pluginapi/`、`web/`、`scripts/`）、任务 evidence 中的自测记录。**插件实现（`main.go` / `info.json` / `web/` / `Makefile`）只发生在 `kore-plugin-<id>` 仓库；在 kore 仓库产出插件代码即违反 G-13。**
- 门禁：检查点层 G1（build）/ G2（vet）/ G4（docs-check）。
- 失败回退：门禁挂 → 自己修到绿；实现中发现契约矛盾 → 停止编码，回提案/双评审补决策，不许"先凑合实现"。

## 5. 阶段五：验证（verifier）

- 入口条件：implementer 声明自测通过并贴出证据；verifier 与被验任务无兼任关系。
- 动作：按 [QUALITY-GATES.md](QUALITY-GATES.md) 原文复跑合并前层门禁（G1–G5、G7），抽样核对文档与代码一致性，逐项写 PASS/FAIL。
- 产出文件：`.agents/verify/<YYYY-MM-DD>-<范围>.md`（含命令、退出码、关键输出、问题清单）。
- 门禁：合并前层全绿；出现 FAIL 即不得进入蓝军阶段。
- 失败回退：FAIL → 回派**原 owner** 修复并重新验证；怀疑验收标准本身有误 → 升级 lead 裁决，verifier 不得自行放宽命令。并行轨道对同一契约读数不一致时，lead 回派前必须先 `grep` 核实事实（文件:行 + 命令输出），不得直接按报告派单。

## 6. 阶段六：蓝军（red-team）

- 入口条件：验证报告 PASS。
- 动作：按四条攻击线动手：范围膨胀（是否偷偷做了非目标）、越权（能力白名单外是否能调到）、崩溃（异常输入/插件自杀/内核是否连坐）、资源（超预算、泄漏、僵尸进程）。
- 产出文件：`.agents/proposals/<slug>.redteam.md` 攻击记录 + BOARD 问题单（owner=原 implementer）。
- 门禁：每个问题单必须有复现路径或明确风险推理链；无复现路径的"理论担忧"不入单。
- 失败回退：问题单 → 回阶段四修复 → 重走阶段五验证 → red-team 复核签收，未签收不得 complete。

## 7. 阶段七：归档复盘（scribe）

- 入口条件：验证 PASS + 蓝军问题单全部签收关闭。
- 动作：同步 `docs/**` 与 CHANGELOG；更新 BOARD 状态；写复盘；里程碑收尾时跑里程碑层门禁。
- 产出文件：[JOURNAL.md](JOURNAL.md) 新记录、`CHANGELOG.md`、被改动文档的同步更新。
- 门禁：里程碑层 G4（文档同步，`make docs-check`）/ G6（资源预算实测）/ G8（二进制体积）/ G9（前端体积）/ G10（无联网 / 无遥测）；单任务层以 G4 为准。
- 失败回退：文档与代码不一致 → 回阶段四补齐或回阶段一改提案，不许只改文档掩盖差异。

## 8. 讨论协议（文件式异步）

评审、裁决、异议全部走文件，不靠"我们刚才说好了"。

1. **提案 → 评审 → 裁决**：提案落 `proposals/`；评审追加到 `<slug>.review.md`；裁决由 lead 写进 [JOURNAL.md](JOURNAL.md)。
2. **评审意见必含四段**，缺一段视为无效评审，直接退回：

```text
VERDICT: APPROVE | REVISE | REJECT
依据: docs/PLUGIN-PROTOCOL.md:42 / 命令原文 + 退出码 + 关键输出
风险: 若不采纳会发生什么，影响哪个模块或哪个预算
阻塞项: 必须解决才能继续的具体条目（无则写"无"）
```

3. 禁止"看起来不错""建议进一步优化"式空评：没有依据行号或命令输出的评审一律退回重写。
4. 分歧升级：角色间无法收敛 → 升级 lead；lead 裁决必须写依据，并记录在 JOURNAL（时间 / 分歧 / 裁决 / 后续动作）。
5. 复审：`REVISE` 后必须复审，复审只核对修改项，但可因新问题再 `REVISE`；连续三轮 `REVISE` 未收敛 → lead 叫停并重写提案。
6. **ADR 是唯一准绳，下游文档的当前文本不是。** 修改协议 / 数据 / 资源口径前，先查 `docs/DECISIONS/` 是否已有裁决；若 ADR 与正文冲突，以 ADR 为准并同步正文，不得反向以正文覆盖 ADR。发现正文与 ADR 冲突时，报告 lead 并等裁决，不得自行选择一方继续写。

## 9. 任务板状态机与 WIP

```
           claim                 evidence 齐备
pending ──────────► in_progress ──────────────► completed
   ▲                    │  ▲                        │
   │                    │  │ 解除阻塞                │ reopen（发现回归/证据不足）
   │                    ▼  │                        ▼
   └──── release ─── blocked ──────────────────► pending
```

| 转移 | 触发条件 | 谁执行 | 必带字段 |
| --- | --- | --- | --- |
| pending → in_progress | `blocked_by` 全清、写域不撞车 | owner claim | revision |
| in_progress → blocked | 外部依赖未就绪 / 等他人写域 | owner | 阻塞原因 + 解阻塞条件 |
| blocked → in_progress | 阻塞条件解除 | owner claim | revision |
| in_progress → completed | evidence 齐备（命令 + 退出码 + 关键输出） | owner 提交，lead/verifier 确认 | evidence |
| completed → pending（reopen） | 发现回归、证据不足、蓝军问题单未签收 | lead | reopen 原因 |

**WIP 限制**：`in_progress` ≤ 5；同一层任务的 `write_scopes` 不得相交；超过 5 条时先关闭或阻塞，不许"都开着慢慢做"。

**插件轨道并行度**：同一里程碑同时在跑的插件仓库 ≤ 4；同一插件仓库同一时间只能有一个 owner；`kore` 协议包与需它的插件仓库按「协议先发版 → 插件跟进 → 索引收尾」串行。

## 10. 变更集（跨仓库改动）

单仓库任务照常走 BOARD；**一次改动跨两个及以上仓库时必须登记为一个变更集**，否则不算完成（G-15）。登记位置：[BOARD.md](BOARD.md) 的「变更集登记区」。

格式：

```text
id: CS-<YYYYMMDD>-<序号>
目标: <一句话，用户视角能看懂>
涉及仓库:
  - repo: kore               tag/commit: <v0.2.0 / abc1234>   角色: 协议包 + 内核
  - repo: kore-plugin-echo   tag/commit: <v0.1.0 / def5678>   角色: 插件跟进
  - repo: kore-plugins       tag/commit: <v0.0.2 / 9abc012>   角色: 索引更新
kore 协议影响: 无 / 新增字段 X（向后兼容）/ 破坏性（需主版本 + ADR-NNNN）
合并顺序: kore 协议包发版 → 插件跟进并对齐 requires_kore → 索引更新 → 宣告完成
验收方式: 各仓库 build/test 命令 + 装进 kore 后 kore.hello 成功 + requires_kore 区间匹配
```

规则：

1. 顺序不可乱：**协议包先发版（打 tag）→ 插件跟进 → 索引最后更新**。索引先更新，等于把一个还装不上的插件公布出去。
2. 各仓库 tag 独立打（R4），不搞 monorepo 式统一版本号。
3. 任一仓库缺 tag/commit、或合并顺序缺环 → 变更集不得 complete。
4. 门禁前移：跨仓库变更在**合并前**就要验证 `requires_kore` 区间满足（不等里程碑层）。
5. 变更集只是登记，不是分支策略：不引入 submodule、不引入统一发布流水线。

### 插件族变更集（示例：一次发布 = 协议 + 3 个插件 + 索引，共 5 仓库）

```text
id: CS-20270210-03
目标: 站点插件族支持多站点 TLS 证书自动续期
涉及仓库:
  - repo: kore               tag: v0.3.0   commit: abc1234   角色: 协议包（新增 cert.renew 事件，向后兼容）
  - repo: kore-plugin-cert   tag: v0.2.0   commit: aaa1111   角色: 证书能力提供方
  - repo: kore-plugin-site   tag: v0.4.0   commit: def5678   角色: 主实现（消费证书能力）
  - repo: kore-plugin-nginx  tag: v0.2.1   commit: bbb2222   角色: 消费方配置重载
  - repo: kore-plugins       tag: v0.5.0   commit: ccc3333   角色: 索引更新 + 预设 refresh
kore 协议影响: 新增事件 `cert.renew`（向后兼容，旧插件可忽略；需 ADR-0011）
合并顺序: kore v0.3.0 → cert v0.2.0 → site v0.4.0 → nginx v0.2.1 → kore-plugins v0.5.0
验收方式: 各插件仓 `make dist` + 装进 kore（hello / invoke / 卸载残留检查）+ `make presets-check`
```

6. 插件族变更集可以超过 4 个仓库，但**同一里程碑同时最多 4 个插件仓库并行**；超出按批次串行，每批 ≤ 4，批次顺序必须写进「合并顺序」。
7. **同一插件仓库同一时间只能有一个 owner**；写域按仓库切分，一个仓库一张任务卡，不合并派发。
8. 索引仓库（`kore-plugins`）永远排在最后；它的变更集条目必须引用各插件仓的已发布 tag，不允许指向未打 tag 的分支头。

## 11. 上下文交接规则

长任务（跨压缩、跨 agent、跨会话）必须写检查点，格式固定：

```text
[KORE-CHECKPOINT]
目标: 一句话，与任务卡 subject 一致
已完成: 文件 / 命令 / 结论（带证据位置）
已排除: 试过但不成立的方向 + 排除依据
下一步: 下一个具体动作（可直接执行）
失败计数: 同一子目标的实际失败次数 → 当前压力等级
```

- 写在哪：任务 evidence 或 JOURNAL 的对应记录段；换 agent 时由交班方写、接班方读。
- 时机：上下文即将压缩前、任务跨天、失败计数 ≥ 2 时。没写就压缩 = 等于主动丢弃进度。
- 接班方必须先核对检查点与 BOARD 状态是否一致，不一致以 BOARD 为准并记录差异。

## 12. 防漂移机制（锚点审计）

每 5 轮对话或每个里程碑收尾，做一次锚点审计，结论写 [JOURNAL.md](JOURNAL.md)：

1. **五锚点逐条自评**：形态 / 架构 / 资源 / 开放 / 体验，每条给"符合 / 偏离 / 待观察"与证据。
2. **资源实测**：主壳空载 RSS 60s 中位数（`ps -o rss= -p <pid>`）、二进制体积、前端首屏 gzip 体积，与预算表逐项对比。
3. **依赖体检**：`go list -m all` 与白名单比对，与上次审计结果 diff，新增依赖必须能指到 ADR。
4. **文档一致性**：路径、socket、预算数字、里程碑编号、角色名在 docs 与代码中是否一致（G4 + 抽样人工核对）。
5. 任一项偏离 → 转成提案进入下一轮 Loop，不许"心里记着下次改"。

## 13. 停止与失败规则

- **DoD 全绿才可宣布完成**：本层门禁全部通过 + evidence 齐备 + 无未签收问题单，三者缺一不算完成。
- **同一方案连续 3 次失败必须换方法**：换的必须是本质不同的方法（换思路/换工具/换抽象层），不是改参数；换法记录进 JOURNAL 的复盘段。
- **不许把未验证写成完成**：跑不了的门禁写 N/A + 原因（见 QUALITY-GATES 的 M0 跳过规则），不许写成 PASS。
- **有尊严地停**：确实无法推进时输出结构化失败报告——已验证事实 / 已排除可能 / 缩小后的范围 / 推荐下一步 / 交接信息，然后把任务置 blocked。
