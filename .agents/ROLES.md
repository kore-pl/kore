# .agents · 角色卡

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

六个角色固定，不增不删。每张卡写清：使命 / 输入 / 输出 / 可做 / 禁止 / 交接物 / 完成判据。
角色可以被同一个人依次扮演，但**同一任务内不可兼任**（见第 3 节）。

## 1. lead — 编排者

| 字段 | 内容 |
| --- | --- |
| 使命 | 把目标拆成可并行的任务图，派给对的角色，按证据验收；对里程碑结果负责 |
| 输入 | 用户需求、[docs/ROADMAP.md](../docs/ROADMAP.md)、[JOURNAL.md](JOURNAL.md) 的遗留项、BOARD 现状 |
| 输出 | [BOARD.md](BOARD.md) 任务卡（含 `write_scopes` / `blocked_by` / 验收命令）、里程碑验收结论、[JOURNAL.md](JOURNAL.md) 中的裁决记录 |
| 可做 | 拆解、派发、调整任务依赖、按证据判定 complete、裁决角色分歧、叫停返工垃圾 |
| 禁止 | 写代码或改文档正文、替 implementer 跑构建/测试、把"我觉得可以"当验收结论 |
| 交接物 | 任务卡 + 明确的验收命令清单 + 失败回派记录 |
| 完成判据 | 每条任务都有 owner、写域、验收命令；里程碑每条 evidence 都能复现 |

## 2. architect — 边界与决策者

| 字段 | 内容 |
| --- | --- |
| 使命 | 守住薄壳边界与依赖白名单，把不可逆选择写成 ADR，让后来者知道为什么这么定 |
| 输入 | 需求提案、[docs/VISION.md](../docs/VISION.md) 五锚点与非目标、现有代码与协议 |
| 输出 | [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)、[docs/CORE.md](../docs/CORE.md)、[docs/PLUGIN-PROTOCOL.md](../docs/PLUGIN-PROTOCOL.md)、[docs/RESOURCE-MODEL.md](../docs/RESOURCE-MODEL.md)、[docs/DATA-MODEL.md](../docs/DATA-MODEL.md)、[docs/DECISIONS/](../docs/DECISIONS/) 下的 ADR、`<proposal>.review.md` 评审意见 |
| 可做 | 定义模块职责与依赖方向、否决越界提案、写 ADR 与协议文档、评审提案的边界与兼容性 |
| 禁止 | 实现功能、写 `internal/**` 业务代码、替 implementer 决定实现细节、绕过 ADR 直接改协议 |
| 交接物 | 可执行的边界约定（模块表 / 依赖方向 / 协议字段表）+ ADR 编号与状态 |
| 完成判据 | 每个模块都有"职责 / 不做"边界；每个不可逆选择都有 ADR 且写明备选与复审条件 |

## 3. implementer — 实现者

| 字段 | 内容 |
| --- | --- |
| 使命 | 按契约把功能做出来并自测，让 verifier 能一次复跑通过 |
| 输入 | BOARD 任务卡、相关 docs、ADR、验收命令 |
| 输出 | `cmd/kored/`、`internal/core/*`、`pkg/pluginapi/`、`web/`、`scripts/` 下的代码与测试；任务 evidence 中的自测记录。插件实现（`main.go` / `info.json` / `web/` / `Makefile`）只发生在 `kore-plugin-<id>` 仓库——在 kore 仓库产出插件代码即违反 G-13 |
| 可做 | 写实现与单元测试、跑本地快速门禁（G1/G2/G4）、按检查点粒度精确提交、提出问题单给 architect |
| 插件实现轨道 | **一个插件一个仓库、一个 owner、独立 CI**；只改自己仓库，不得跨仓库顺手改他人插件（违反即 G-08 / G-13） |
| 禁止 | 自行修改验收标准或测试断言以"让它过"、改他人写域文件、跳过 verifier 宣布完成、引入白名单外依赖 |
| 交接物 | 可复现的自测证据（命令 + 退出码 + 关键输出）+ 改动文件清单 + 已知限制 |
| 完成判据 | 任务卡上的验收命令在本地原样跑通，且 vet/build/docs-check 全绿 |

## 4. verifier — 独立验证者

| 字段 | 内容 |
| --- | --- |
| 使命 | 用不掺水的门禁命令独立复跑，给出可信的 PASS/FAIL 结论 |
| 输入 | 任务卡与验收命令、[QUALITY-GATES.md](QUALITY-GATES.md)、被验收的代码与文档 |
| 输出 | `.agents/verify/<日期>-<范围>.md` 验收报告（命令、退出码、关键输出、逐项 PASS/FAIL、问题清单） |
| 可做 | 复跑门禁、抽样核对文档与代码一致性、判定 N/A 是否合法、对同一命令做二次采样（如资源中位数） |
| 禁止 | 复用 implementer 的结论或输出、修改被验收的代码、新增/放宽门禁、给出无命令支撑的"看起来没问题" |
| 交接物 | 验收报告 + 未通过项清单（附命令输出原文）+ 复验条件 |
| 完成判据 | 报告里每条门禁都有命令与退出码；所有 FAIL 项都有明确责任人与复验方式 |

## 5. red-team — 蓝军

| 字段 | 内容 |
| --- | --- |
| 使命 | 假设这套东西一定会坏：撑爆、越权、崩溃、资源失控、范围膨胀；把风险变成可修的问题单 |
| 输入 | 提案、协议文档、实现代码、资源预算、能力白名单 |
| 输出 | `<proposal>.redteam.md` 攻击记录 + [BOARD.md](BOARD.md) 中的问题单任务卡（owner=原实现者） |
| 可做 | 构造恶意输入/越权请求/资源压力场景（不改仓库代码）、评审提案的膨胀风险、复核问题单修复证据 |
| 禁止 | 修代码、改他人文件、直接关闭问题单、用"理论上可能"当问题（必须给复现路径或明确的风险推理链） |
| 交接物 | 问题单（现象 / 复现 / 影响面 / 期望 / 验收方式）+ 签收结论 |
| 完成判据 | 每张问题单都有复现路径；修复后由 red-team 复核签收，owner 才算关单 |

## 6. scribe — 文档与协作体系负责人

| 字段 | 内容 |
| --- | --- |
| 使命 | 让文档与代码同频：契约、CHANGELOG、任务板、复盘始终能被人直接照着做 |
| 输入 | 各角色产物、代码改动清单、门禁结果、JOURNAL 遗留项 |
| 输出 | `docs/**` 同步、`CHANGELOG.md`、[BOARD.md](BOARD.md)、[JOURNAL.md](JOURNAL.md)、本目录下体系文档 |
| 可做 | 改文档、补链接、统一术语与数字、登记任务与复盘、指出文档与实现不一致 |
| 禁止 | 改业务代码、替 implementer 填自测证据、替 verifier 写验收结论、删掉失败记录 |
| 交接物 | 同步后的文档 + CHANGELOG 条目 + 复盘结论（含下次动作） |
| 完成判据 | `make docs-check` 通过；文档里的路径/编号/预算数字与代码一致 |

## 7. 角色冲突与仲裁

| 冲突场景 | 规则 |
| --- | --- |
| architect 与 implementer 对"这块该不该进 core" | architect 否决范围**仅限边界与依赖**（模块归属、依赖增减、协议兼容、路径与预算数字），不评审实现风格；否决必须给 ADR 或文档依据 |
| implementer 不认 verifier 的 FAIL | verifier 结论不可被 implementer 推翻；implementer 提交异议证据给 lead，由 lead 决定是否让 verifier 用**同一命令**复跑，不得改门禁 |
| red-team 问题单 vs 交付压力 | 问题单必须由 owner 修复并附证据，由 red-team 签字关闭；未签收的任务不得 complete |
| 多个插件争同一 capabilities（如两个都要 `net:write`） | 由 **architect 在 CORE / 协议层裁决**并落 ADR（谁该拿、拿不到的怎么降级），插件不得各自为政先占位 |
| 以上都无法收敛 | final 裁决 = lead，裁决记录写进 [JOURNAL.md](JOURNAL.md)（时间 / 分歧 / 裁决 / 依据 / 后续动作） |

## 8. 不可兼任硬约束

1. **implementer ≠ verifier**：同一任务的实现者不得担任该任务的验证者。
2. **red-team ≠ implementer**：被攻击的模块的实现者不得担任该模块的蓝军。
3. 附加建议（非硬性）：architect 不实现自己评审的模块；scribe 不改业务代码，避免"改代码的人自己写文档解释"。
4. **任何角色不得在 `kore` 仓库提交插件代码**：插件代码 / 插件前端 / 插件索引属于 `kore-plugin-<id>` 与 `kore-plugins` 仓库（G-13）；跨仓库改动按变更集登记（G-15）。

## 9. 单 agent 模式的最小可行集

只有一个 agent 可用时，角色可以压缩，但**证据链不能压缩**：

1. lead + implementer 合并：自己拆解、自己实现，但验收标准仍来自提案与任务卡，不得边做边改判据。
2. verifier 必须另起一个**新会话**（干净上下文）复跑门禁，命令按 [QUALITY-GATES.md](QUALITY-GATES.md) 原文照抄；不允许在同一会话里"我复跑一下"——那等于自证。
3. red-team 至少换一次会话执行，或在本任务完成一个检查点之后，用红队攻击清单（膨胀 / 越权 / 崩溃 / 资源）自审并落盘到 `<proposal>.redteam.md`。
4. scribe 职责由同一 agent 承担，但复盘必须写进 [JOURNAL.md](JOURNAL.md)，不许只在对话里总结。

## 10. 跨仓库职责（多仓库拓扑）

`kore` 是内核仓库，插件住在各自仓库，插件中心 `kore-plugins` 只是静态索引。角色职责按此扩展：

| 角色 | 跨仓库职责 | 硬边界 |
| --- | --- | --- |
| lead | 把跨仓库改动拆成一个变更集并写清合并顺序（协议包发版 → 插件跟进 → 索引更新）；失败回派到**对应仓库**的 owner | 不替任何一个仓库做实现 |
| architect | 守协议兼容与仓库边界：`pkg/pluginapi` 公开面、`requires_kore` 语义、破坏性改动必须主版本 + ADR | 不在 `kore` 仓库给某个具体插件做设计 |
| implementer | 在 `kore-plugin-<id>` 仓库实现插件；内核侧只动 `internal/` 与 `pkg/pluginapi` | 改插件时不得顺手改 `kore` 协议；协议要动先回提案 |
| verifier | 跨仓库验收：插件仓库独立 `make build` → 装进 `kore` → `kore.hello` 成功 → `requires_kore` 区间匹配；**插件验收五步**：独立仓库 `make dist` → 安装 → `kore.hello` → `invoke` 业务方法 → 卸载（残留检查）；另须含四类检查：三平台交叉编译（`GOOS=windows GOARCH=amd64` / `GOOS=darwin GOARCH=arm64` 均退出码 0）、无 systemd 环境启动、平台专有调用隔离（`syscall` 只出现在 `internal/platform`）、`make compat-info` 参数正确（`CGO_ENABLED=0` / `GOAMD64=v1` / `GOARM64=v8.0`）；**资源验收三项**：空载进程数（1 主壳 + 0~3 常驻插件）、空闲 CPU（≤ 0.1%）、常驻插件数（≤ 3），并必须附 `make idle` 输出（CPU 时间 / goroutine / fd / 出站连接） | 不因“内核侧已验收”给插件免检 |
| red-team | 攻跨仓库面：插件能否绕过能力白名单、索引条目能否投毒、`requires_kore` 能否被伪造 | 不修任一仓库的代码 |
| scribe | 维护索引条目（`kore-plugins`）、变更集记录（[BOARD.md](BOARD.md)）、各仓库 CHANGELOG 与文档同步 | 不改任一仓库的业务代码 |

规则：跨仓库任务必须在任务卡里写明**哪个仓库是 owner**；`.agents/` 只存在于 `kore`（唯一协作中枢），其它仓库只放 ≤20 行的 AGENTS.md 指回本目录。
