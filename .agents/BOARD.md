# .agents · 任务板

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

任务板是唯一事实源：谁在做什么、卡在哪、凭什么叫完成，都以本文件为准。对话里的口头约定不算。

## 1. 字段定义

| 字段 | 含义 | 填写规则 |
| --- | --- | --- |
| `id` | 任务编号 | `<里程碑>-<轨道>`，如 `M0-A`、`M1-C2`；同一里程碑内不重复 |
| `subject` | 一句话任务标题 | 动词开头，能独立看懂，不含"相关""优化一下"这类模糊词 |
| `owner` | 责任角色 | 必须是 lead / architect / implementer / verifier / red-team / scribe 之一 |
| `status` | 状态 | `pending` / `in_progress` / `completed` / `blocked` |
| `scope` | 写域 | 允许改动的文件或目录前缀，逗号分隔；跨多个目录时逐个列出 |
| `blocked_by` | 前置任务 | 依赖任务 id 列表，全部 complete 才能开工；无依赖写 `—` |
| `变更集` | 跨仓库变更集编号 | 单仓库任务填 `—`；跨仓库任务填 `CS-<YYYYMMDD>-<序号>`，且「变更集登记区」有对应行 |
| `evidence` | 交付证据 | 命令原文 + 退出码 + 关键输出 3 行；文档任务写文件清单 + 行数 |
| `revision` | 版本号 | 每次状态或字段变更 +1；claim / complete 必须带当前 revision |

## 2. 状态机与合法转移

| 从 | 到 | 条件 | 执行者 |
| --- | --- | --- | --- |
| pending | in_progress | `blocked_by` 全清、`scope` 与同层任务不相交 | owner（claim） |
| in_progress | blocked | 等外部依赖 / 等他人写域释放，写清阻塞原因 | owner |
| blocked | in_progress | 阻塞条件已解除 | owner（claim） |
| in_progress | completed | evidence 齐备且验收通过 | owner 提交 + lead/verifier 确认 |
| completed | pending | reopen：发现回归、证据不足、蓝军问题单未签收 | lead |
| pending | completed | 不允许：没有执行的完成是伪造 | — |
| blocked | completed | 不允许：跳过执行阶段 | — |

非法转移一律打回，并把原因写进任务备注。

## 3. WIP 限制

- `in_progress` 总数 ≤ 5；到上限时先完成或阻塞，不许继续开新任务。
- 同一层并行任务的 `scope` 不得相交；相交即视为冲突，必须串行化（用 `blocked_by` 表达顺序）。
- 一个任务只允许一个 owner；需要两人协作时拆成上下游两个任务。

## 4. 当前快照（M0 · 7 条轨道）

快照时间 2026-11-21 21:50（多仓库拓扑修订后）。evidence 中的行数是该时点实测值；文档再改动时由 scribe 在下一次归档刷新。`status` 表示验收事实：A–F 已交付并过 G4；M0-G 依赖已全部解除、正在产出验收报告。`revision` 为本次状态登记的版本（每次状态或字段变更 +1）。**M0 的交付边界只有 `kore` 这一个仓库**：`kore-plugins` 与 `kore-plugin-echo` 属 M1，`kore-plugin-site` / `kore-plugin-backup` 属 M2，均不在本板。

| id | subject | owner | status | scope | blocked_by | 变更集 | evidence | revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0-A | 愿景 / 总体架构 / 内核规格 / 术语表 | architect | completed | `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/CORE.md`, `docs/GLOSSARY.md` | — | — | `wc -l docs/{VISION,ARCHITECTURE,CORE,GLOSSARY}.md` → 退出码 0；178 / 348 / 286 / 172 行 | 3 |
| M0-B | 插件协议 / 资源模型 / 数据模型 | architect | completed | `docs/PLUGIN-PROTOCOL.md`, `docs/RESOURCE-MODEL.md`, `docs/DATA-MODEL.md` | — | — | `wc -l docs/{PLUGIN-PROTOCOL,RESOURCE-MODEL,DATA-MODEL}.md` → 退出码 0；350 / 205 / 268 行；帧 = 4B 长度 + JSON、无额外帧头（ADR-0002 / ADR-0007） | 3 |
| M0-C | 前端架构 / 安全模型 / 8 篇 ADR | architect | completed | `docs/FRONTEND.md`, `docs/SECURITY.md`, `docs/DECISIONS/` | — | — | `wc -l docs/{FRONTEND,SECURITY}.md` + `ls docs/DECISIONS/` → 退出码 0；253 / 216 行；ADR 0001–0008 共 8 篇、无重号（0008 = 多仓库拓扑） | 3 |
| M0-D | 路线图 / 执行计划 / M0 清单 | lead | completed | `docs/ROADMAP.md`, `docs/PLAN.md`, `docs/MILESTONE-M0.md` | — | — | `wc -l docs/{ROADMAP,PLAN,MILESTONE-M0}.md` → 退出码 0；191 / 227 / 169 行 | 2 |
| M0-E | AGENTS.md + agent 管理架构 | scribe | completed | `AGENTS.md`, `README.md`, `.agents/` | — | — | `wc -l AGENTS.md README.md` → 退出码 0；86 / 150 行；`.agents/` 体系文档 6 份 + 模板 4 份；`make docs-check` 退出码 0（6 pass / 0 fail，35 份文档 / 8 篇 ADR） | 4 |
| M0-F | 仓库骨架 / 门禁脚本 | implementer | completed | `.gitignore`, `.editorconfig`, `Makefile`, `scripts/` | — | — | `grep -E '^APP' Makefile; grep -E '^BIN' Makefile` → 退出码 0；`APP ?= kored` / `BIN ?= ./bin/kored`；`bash scripts/docs-check.sh` → 退出码 0（6 pass / 0 fail）；`git rev-list --count HEAD` → 退出码 128（0 commit，HEAD 未出生，符合 M0） | 3 |
| M0-G | 独立验收 + 首提交 | verifier | in_progress | `.agents/verify/` | M0-A, M0-B, M0-C, M0-D, M0-E, M0-F | — | 进行中：已产出 `m0-consistency.md` / `m0-commit-plan.md`，r2 复核在 `m0-consistency-r2.md`；前置 A–F 全部 completed，依赖已解除 | 2 |

轨道说明：

- M0-A：定"做什么不做什么"，是其余所有文档的上游。
- M0-B：定协议、资源、数据三条硬契约，实现阶段直接照抄。
- M0-C：定前端与安全边界，8 篇 ADR（0001–0008，含多仓库拓扑）承载不可逆选择。
- M0-D：定排期与验收口径，把 M0 拆成可执行 WBS。
- M0-E：定协作规则本身（本文件即其产物之一）。
- M0-F：定仓骨架与门禁脚本，让后续每条命令都有落点。
- M0-G：独立复跑 `make docs-check` + 交叉一致性核对 + 精确提交，**依赖 A–F 全部完成**。

### 插件轨道（M1 起启用）

M1 之后 18–22 个插件仓各自一张卡，**一个仓库一个 owner**，与内核轨道分开统计；下面的表头即模板，逐行填：

| 仓库 | 插件 id | owner | 里程碑 | 状态 | evidence |
| --- | --- | --- | --- | --- | --- |
| `kore-plugin-<id>` | `<id>` | implementer（一仓一人） | M1 / M2 | pending | `make dist` 退出码 + 安装/hello/invoke/卸载五步记录 |

规则：同里程碑并行插件仓 ≤ 4；索引（`kore-plugins`）不单独占行，跟随变更集收尾。

## 5. 变更集登记区

跨两个及以上仓库的一次改动登记在这里（格式见 [WORKFLOW.md](WORKFLOW.md) §10）。单仓库任务不占位。

| 变更集 | 目标 | 涉及仓库（tag / commit） | kore 协议影响 | 合并顺序 | 验收方式 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| — | M0 只交付 `kore` 单仓库，暂无变更集 | — | — | — | — | — |

规则：一行内写全「仓库 / tag 或 commit / 协议影响 / 合并顺序 / 验收方式」才允许置 completed；缺任一列视为未完成（G-15）。

## 6. 本里程碑裁决记录

M0 期间产生过分歧、且必须以裁决收口的口径。后续任何任务先读这里，不要再以"某份正文当前这么写"为依据推翻。

| # | 裁决 | 依据 |
| --- | --- | --- |
| 1 | 二进制 / 进程 / systemd `ExecStart` = `kored`；项目 / 仓库 / Go module = `kore`；systemd unit = `kore.service` | daemon 惯例与 `cmd/kored/` 同源；`Makefile` 已为 `APP ?= kored` / `BIN ?= ./bin/kored`；scribe 反证后 lead 改判 |
| 2 | Kore Loop = 七阶段（第 7 阶段 = 归档复盘） | 项目地基契约原文；`MILESTONE-M0` / `PLAN` 原写 8 步，已按裁决改为七阶段 |
| 3 | 帧格式 = ADR-0002（4B 长度前缀 + JSON，无额外帧头）；M3 的编码协商由 `kore.hello` 会话级完成 | ADR-0002 + ADR-0007；首版"2 字节帧头"说法作废 |
| 4 | 口令哈希 = stdlib `PBKDF2-HMAC-SHA256` / 600k 迭代（放弃 argon2id，以守住依赖白名单） | 主壳直接依赖上限 3；复审条件：公网暴露或多用户场景改为内存硬 KDF 并补 ADR |
| 5 | 升级临时 socket = `<id>.next.sock`；插件 socket 由主壳 `listen` + `chown kore-<id>` + 0600 + `SO_PEERCRED` 校验 | `/run/kore` 为 0700 root:root，插件进程无权自行创建 socket；首版 `.sock.new` 说法作废 |
| 6 | 多仓库拓扑：`kore`（内核 + `pkg/pluginapi` + 前端 + `docs/` + `.agents/`）/ `kore-plugins`（纯静态索引）/ `kore-plugin-<id>`（每插件一仓）；M0 只交付 `kore` | 用户架构级修正（2026-11-21）+ R1–R8 规则；`plugins/` 目录假设作废，`make repo-check` 落地前以 grep 为准 |
| 7 | `pkg/pluginapi` 必须是**公开包**，不得放 `internal/` | 插件在独立仓库，`internal/` 对外不可见；依赖单向：插件 → `kore/pkg/pluginapi`，`kore` 不 import 任何插件 |
| 8 | v1 = M4 完成：对标宝塔 / 1Panel 专业版的能力覆盖面，由 18–22 个插件仓库提供（含 22 插件对标验收） | 用户产品级 scope 变更（2026-11-21）；内核只做调度与商店/预设机制 |
| 9 | 场景预设 = **embed 进二进制** + 可刷新（在线拉取新版本预设）+ 离线目录兜底；首次安装按 8 类场景一键成型 | 零联网校验前提下仍要能"开箱成型"；离线可用不能被在线刷新绑架 |
| 10 | 商店 = 无账号、无评分、无审核：只做索引与校验（`index/plugins.json` + 校验脚本） | 五锚点④开放；审核与评分会引入中心化权力与账号体系 |
| 11 | 包名避让：`internal/core/store` = bbolt 持久化（既有语义），插件商店包命名 `internal/core/market`，对外 HTTP 前缀与 UI 仍叫 `/store` / 商店；**不做全局重命名** | 避免与既有 store 包语义冲突；重命名会波及 12 处引用与全部文档（G-06 成本），收益仅是"名字好看" |

## 7. 完成判定

任务从 `in_progress` 进入 `completed` 前，逐项核对：

1. **evidence 必须含三件**：命令原文、退出码、关键输出 3 行（文档类任务为文件清单 + `wc -l` 行数）。
2. **验收命令必须是任务卡里事先写好的那条**，不许事后换一条更容易过的。
3. **未通过项必须显式列出**：写 N/A 的要给原因（M0 阶段规则见 [QUALITY-GATES.md](QUALITY-GATES.md)）。
4. **蓝军问题单全部签收**：有未签收问题单的任务不得 complete。
5. **写域核对**：改动文件与 `scope` 一致；出现写域外改动即回滚并重派。

无 evidence 不得 complete。lead 验收时看的不是当事人的结论，而是 evidence 能不能复现。

## 8. 粒度规则

- 单个任务 1–2 小时可完成；超过 2 小时必须拆。
- 拆分依据是"能否独立验收"，不是"文件多少"：一个任务对应一条可执行的验收命令。
- 任务标题出现"顺便""相关""完善一下"= 粒度不清，退回重写。
- 文档类任务按"一份文档一个任务"或"一组同源文档一个任务"拆；同一份文档不得由两个任务并行改。
