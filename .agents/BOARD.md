# .agents · 任务板

> 状态: draft · 归属: scribe · 更新: 2026-11-22 · 里程碑: M1

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

## 4. 里程碑记录与轨道快照

### 4.1 里程碑记录

里程碑只有在「轨道全部 completed + 独立验收报告 PASS + JOURNAL 复盘段落盘 + 台账齐备 + 变更集无未闭环 P0」五条同时满足时才可置 `completed`（G-07 / G-23 / G-15）。第五条是 2026-11-22 收口时新加的：M1 的验收报告运行时 PASS，但登记后发现发布链 P0（`pkg/pluginapi/v0.1.0` 内容为旧 module 路径），按「发布物不可用即变更集未完成」处理。

| 里程碑 | 名称 | 状态 | 收口日期 | 证据 |
| --- | --- | --- | --- | --- |
| M0 | 文档与骨架 | completed | 2026-11-21 | [verify/m0-consistency-r5.md](verify/m0-consistency-r5.md)（PASS）；[JOURNAL.md](JOURNAL.md) 2026-11-21 两条 M0 复盘 |
| M1 | 行走骨架 | blocked | —（代码 2026-11-22 完成；发布链 P0 未闭环） | [verify/m1-final-acceptance.md](verify/m1-final-acceptance.md)（运行时 VERDICT PASS）；[JOURNAL.md](JOURNAL.md) 2026-11-22「M1 里程碑复盘」§4.5 / §5；[docs/MILESTONE-M1.md](../docs/MILESTONE-M1.md)。**阻断项**：`GOWORK=off` 干净 clone `go mod download` 报 `module declares its path as: github.com/kore-project/... but was required as: github.com/pengtang1024/...`；`CS-M1-01` 降为 blocked |

### 4.2 M0 轨道（7 条，已收口）

快照时间 2026-11-21 21:50（多仓库拓扑修订后）。evidence 中的行数是该时点实测值；文档再改动时由 scribe 在下一次归档刷新。`status` 表示验收事实：A–F 已交付并过 G4；M0-G 依赖已全部解除、正在产出验收报告。`revision` 为本次状态登记的版本（每次状态或字段变更 +1）。**M0 的交付边界只有 `kore` 这一个仓库**：`kore-plugins` 与 `kore-plugin-echo` 属 M1，`kore-plugin-site` / `kore-plugin-backup` 属 M2，均不在本板。

| id | subject | owner | status | scope | blocked_by | 变更集 | evidence | revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0-A | 愿景 / 总体架构 / 内核规格 / 术语表 | architect | completed | `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/CORE.md`, `docs/GLOSSARY.md` | — | — | `wc -l docs/{VISION,ARCHITECTURE,CORE,GLOSSARY}.md` → 退出码 0；178 / 348 / 286 / 172 行 | 3 |
| M0-B | 插件协议 / 资源模型 / 数据模型 | architect | completed | `docs/PLUGIN-PROTOCOL.md`, `docs/RESOURCE-MODEL.md`, `docs/DATA-MODEL.md` | — | — | `wc -l docs/{PLUGIN-PROTOCOL,RESOURCE-MODEL,DATA-MODEL}.md` → 退出码 0；350 / 205 / 268 行；帧 = 4B 长度 + JSON、无额外帧头（ADR-0002 / ADR-0007） | 3 |
| M0-C | 前端架构 / 安全模型 / 8 篇 ADR | architect | completed | `docs/FRONTEND.md`, `docs/SECURITY.md`, `docs/DECISIONS/` | — | — | `wc -l docs/{FRONTEND,SECURITY}.md` + `ls docs/DECISIONS/` → 退出码 0；253 / 216 行；ADR 0001–0008 共 8 篇、无重号（0008 = 多仓库拓扑） | 3 |
| M0-D | 路线图 / 执行计划 / M0 清单 | lead | completed | `docs/ROADMAP.md`, `docs/PLAN.md`, `docs/MILESTONE-M0.md` | — | — | `wc -l docs/{ROADMAP,PLAN,MILESTONE-M0}.md` → 退出码 0；191 / 227 / 169 行 | 2 |
| M0-E | AGENTS.md + agent 管理架构 | scribe | completed | `AGENTS.md`, `README.md`, `.agents/` | — | — | `wc -l AGENTS.md README.md` → 退出码 0；86 / 150 行；`.agents/` 体系文档 6 份 + 模板 4 份；`make docs-check` 退出码 0（6 pass / 0 fail，35 份文档 / 8 篇 ADR） | 4 |
| M0-F | 仓库骨架 / 门禁脚本 | implementer | completed | `.gitignore`, `.editorconfig`, `Makefile`, `scripts/` | — | — | `grep -E '^APP' Makefile; grep -E '^BIN' Makefile` → 退出码 0；`APP ?= kored` / `BIN ?= ./bin/kored`；`bash scripts/docs-check.sh` → 退出码 0（6 pass / 0 fail）；`git rev-list --count HEAD` → 退出码 128（0 commit，HEAD 未出生，符合 M0） | 3 |
| M0-G | 独立验收 + 首提交 | verifier | completed | `.agents/verify/` | M0-A, M0-B, M0-C, M0-D, M0-E, M0-F | — | `make check` 5/5（docs-check 55 份 6 pass / 0 warn / 0 fail；repo-check 5 pass；canonical-check 7 pass）；`git commit 7404ad1`（59 文件 / 8,193 insertions，排除 proposals/reviews 3 件）；`git status --short` 仅剩 M1 未跟踪件；报告 `m0-consistency-r5.md`（99 行） | 3 |

轨道说明：

- M0-A：定"做什么不做什么"，是其余所有文档的上游。
- M0-B：定协议、资源、数据三条硬契约，实现阶段直接照抄。
- M0-C：定前端与安全边界，8 篇 ADR（0001–0008，含多仓库拓扑）承载不可逆选择。
- M0-D：定排期与验收口径，把 M0 拆成可执行 WBS。
- M0-E：定协作规则本身（本文件即其产物之一）。
- M0-F：定仓骨架与门禁脚本，让后续每条命令都有落点。
- M0-G：独立复跑 `make docs-check` + 交叉一致性核对 + 精确提交，**依赖 A–F 全部完成**。

### 4.3 M1 轨道（7 条，已收口）

快照时间 2026-11-22 02:05（M1 收口）。evidence 为收口实测值；M1 的交付边界是 `kore` + `kore-plugin-echo` 两个仓库，索引仓 `kore-plugins` 未在 M1 落地（`index/plugins.json` 仍归 M2）。

| id | subject | owner | status | scope | blocked_by | 变更集 | evidence | revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1-A | 协议与公开 SDK：frame / envelope / timeout + 嵌套 module | implementer | completed | `pkg/pluginapi/` | — | CS-M1-01 | 705 行 / 10 文件；`go test -count=1 ./pkg/pluginapi` ok；tag `pkg/pluginapi/v0.1.0`；根 `go.mod` `replace => ./pkg/pluginapi` | 1 |
| M1-B | 内核 7/9 模块 + envprobe / platform 支撑包 | implementer | completed | `internal/core/`, `internal/platform/` | — | — | `internal/core` 7,414 行 + `platform` 880 行；`go test -count=1 ./...` 10 包全 ok；auth / market 未做，`routes()` 回 501 | 1 |
| M1-C | `cmd/kored` 装配：`install` / `serve` 子命令 | implementer | completed | `cmd/kored/` | M1-B | — | 20 文件 1,910 行；11 步 E2E（验收报告 §C）全通过 | 1 |
| M1-D | 9 段门禁接线（含 canonical / oss / case） | implementer | completed | `Makefile`, `scripts/` | M1-B | — | `make check` **9/9**：docs 6 / dep 2 / thin-shell 4 / repo 5 / canonical 9 / log 8 / wt 4 / oss 8 / case 5 | 1 |
| M1-E | 开源六件套 + CI 模板 | scribe | completed | `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `.github/workflows/` | — | — | `make oss-check` 8 pass / 0 warn / 0 fail | 1 |
| M1-F | 跨仓库：echo 验证插件 + 首次公开 | implementer | completed | `../kore-plugin-echo` | M1-A | CS-M1-01 | `make dist` → `echo-0.1.0.tar.gz` 1,258,020 B + `.sha256`；`git ls-remote` 双仓 main 可达 | 1 |
| M1-G | 独立验收（verifier ≠ implementer） | verifier | completed | `.agents/verify/` | M1-A…F | — | [verify/m1-final-acceptance.md](verify/m1-final-acceptance.md) VERDICT PASS、阻断 0；`make mem MEM_POINTS=60` 中位 9,664 KiB | 1 |

轨道说明：M1-A 冻结协议面（SDK 先于内核发版）；M1-B 是主链，auth / market 的缺席见 [JOURNAL](JOURNAL.md) M1 段第 5 节；M1-C 只做装配不写业务；M1-D 让每条命令都有落点；M1-E 满足 G-26 发布红线；M1-F 证明"插件只依赖公开 SDK"成立；M1-G 由非实现者复跑全部命令。

### 4.4 插件轨道（M1 起启用）

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
| CS-M1-01 | M1 首次公开发布：kore 内核与 echo 验证插件上线 GitHub public 仓库 | `kore` @ `2616374`（tag `pkg/pluginapi/v0.1.0` → `3a59b98`）；`kore-plugin-echo` @ `3422c10`（tag `v0.1.0`） | 无协议变更（首次发布；module 路径统一为 `github.com/pengtang1024/*`） | `kore`（main + SDK tag）→ `kore-plugin-echo`（main + tag） | 本地 `make check` 9/9、`go build`/`go test` 通过；`git ls-remote` 双仓可达。**但** `GOWORK=off` 干净 clone `go mod download` FAIL（`pkg/pluginapi/v0.1.0` 声明旧 module 路径 `kore-project`，proxy 已缓存该 `.mod`） | blocked |

规则：一行内写全「仓库 / tag 或 commit / 协议影响 / 合并顺序 / 验收方式」才允许置 `completed`；缺任一列视为未完成（G-15）。状态含义：`completed` = 变更集内仓库与顺序齐备、本地验收通过；`confirmed` = 已发布且干净 clone / `git ls-remote` 复验通过（里程碑收口口径，2026-11-22 由 verifier 报告与本节证据共同支撑）。

## 6. 里程碑裁决记录

M0 / M1 期间产生过分歧、且必须以裁决收口的口径。后续任何任务先读这里，不要再以"某份正文当前这么写"为依据推翻。**M1 的裁决（第 21–30 条）不复制到本表**，以 [LOG/DECISIONS.md](LOG/DECISIONS.md) 为唯一真源；下表 1–11 是 M0 期间直接以 BOARD 收口的口径。

**判断留痕见 [`.agents/LOG/`](LOG/)**：本板只存裁决结论与任务状态；选项、被否决方案与依据在台账，两者冲突时以 ADR + 台账为准（G-23）。

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

## 9. 已知遗留（M0 / M1 记录级，不阻断提交）

- **M1 · P0（阻断收口）**：SDK tag `pkg/pluginapi/v0.1.0` 不可被消费——内容声明的 module 路径仍是 `github.com/kore-project/kore/pkg/pluginapi`，干净目录 `GOWORK=off go mod download` 失败；proxy.golang.org 已缓存该 `.mod`，**不可改写 tag**，只能切 `v0.1.1` + `retract v0.1.0` + echo 升 `require` + 删本地 `go.work` 后复验。详见 [JOURNAL.md](JOURNAL.md) M1 段 §4.5 与 [docs/MILESTONE-M1.md](../docs/MILESTONE-M1.md) §5 第 0 项。
- **M1 遗留（8 项）**：见 [JOURNAL.md](JOURNAL.md) 2026-11-22 M1 段「结论与 M2 前置」与 [docs/MILESTONE-M1.md](../docs/MILESTONE-M1.md) §5——auth / market 未做、web 壳未交付、退避重启与心跳按 M1-12/13 延期、capability 方法级校验（M1-08）、audit 写入（M1-09）、bus 多路复用、`registry/validate.go` 241 行超 200 行上限、bbolt mmap 计入 RssFile（M4 瘦身）。
- `docs/DECISIONS/0001-go-stdlib-net-http.md:8` 背景句仍含 `GOGC=200`：ADR 为冻结决策记录，`canonical-check` 按设计排除 `docs/DECISIONS/`，不影响现役口径；下次修订该 ADR 时顺手改为"默认 GOGC=100 + GOMEMLIMIT=6MiB"。
- `make idle` 的 SKIP 文案未写"约 65s"（实现为 `sleep 5 + 60` 采样）；M1 起有 `kored` 进程时输出实测，届时补文案。
- C5 口径「22 项能力域：12 项生产级 / 8 项基础级」与 `FEATURE-PARITY:12`「14 项由生产级插件承载」是"插件数 vs 能力域数"两种说法；建议后续在 ROADMAP 该句加"（由 12 个生产级插件承载 14 个域）"限定语。
