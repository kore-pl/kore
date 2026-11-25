> 状态: accepted（2026-11-26 用户 accept U3 有限放宽，已 append 并入 ADR-0023 §3.5 与 §11 修订记录）· 归属: designer（task-41，用户 U3 裁决）→ scribe（task-42，accept 落地）· 更新: 2026-11-26 · 里程碑: R26 · 门禁关联: G-06 / G-12 / G-23 / G-29 / G-30 / G-31
> ADR 状态: accepted · 修订对象: [ADR-0023 §3.5 豁免清单](./0023-zero-intrusion.md)（accepted，2026-11-23；2026-11-26 append 新增豁免 #5，原文 4 项不动）· 关联: [草案 §6.2 U3](./self-update-design-draft.md)、[ADR-0059](./0059-silent-update-trigger-and-supply-chain.md)（更新链）、[ADR-0056](./0056-self-restart.md)（本地边界）、[实现任务图](./self-update-implementation-plan.md)
> 纪律: 只写文档 / 台账；不 push、不联网、不执行 install/serve/upgrade；品牌 Kore/kore。

# ADR-0023 §3.5 修订提案：静默自更新的最小安装目录外写入豁免（U3 有限放宽）

## 1. 提案性质与前置

本文件原为**修订提案**；2026-11-26 用户明确 accept U3（有限放宽）后，已按 §4 的建议以 append 方式并入已 accepted 的 ADR-0023——豁免 #5 落到 [§3.5](./0023-zero-intrusion.md)，accept 留痕落到 [§11](./0023-zero-intrusion.md)。ADR-0023 原有 4 项豁免、§3.6 验收判据、§5 被否决方案汇总**原文均保持不动**。本文件保留为提案来源与逐项依据（accept 后仍不得据此无限放宽）：

- 本提案只新增一项安装目录外写入豁免（§3.1），其余写入仍按 ADR-0023 §3.5 清单执行；
- 不得因本提案存在而放宽清单外路径；`make zero-intrusion-check`（`Makefile:338-340`、`scripts/zero-intrusion-check.sh`）的 `snap()` 由 M5 实现卡增该路径断言，未增前不得宣称已覆盖该项（G-31）。

用户 2026-11-26 的 U3 裁决原文口径：**有限放宽**——「允许新增 ADR 明确列出的最小安装目录外写入（如一个本地更新状态文件），逐项登记 changes.jsonl 可回滚；不是按需无限放宽——必须在 ADR-0023 §3.5 逐项列明新增豁免路径与回滚方式。」

## 2. 为什么需要这项豁免（现状依据，带行号）

1. 静默更新链需要在**内核重启前后**持久化「本次更新的意图与结果」：下载完成、校验通过、pending 标记、`.prev` 回滚材料、新进程 finalize 状态。现有 upgrade 链有 `.prev` 与 pending 标记（`cmd/kored/upgrade.go:150-208,265-295,340-379`），但**跨重启的聚合状态文件**没有位置——若继续塞进 `<install>/data/`，需确认它不被运行中 `kored` 的 bbolt flock 独占（`store.go:95-100`、`install.go:102-108` 的锁冲突先例，草案 §2.1）。
2. ADR-0023 §3.5 现有 4 项豁免（`0023-zero-intrusion.md:104-113`）：#1 systemd unit、#2 插件系统用户、#3 用户批准的宿主变更（须 `changes.jsonl` 可回滚）、#4 显式安装的二进制。清单外一切写入 = 违规（`:113`）。
3. U3 裁决明确要求「最小」与「逐项登记可回滚」，因此提案只加**一项**，且复用 #3 已有的 `changes.jsonl` 账本机制（`cmd/kored/changes.go` / ADR-0049 §5.1 现有实现），不引入第二套回滚体系。

## 3. 建议新增豁免项（逐项，供 accept 时逐项裁决）

### 3.1 新增豁免 #5：本地更新状态文件

| 字段 | 建议值 |
| --- | --- |
| 位置 | `<install>/data/update-state.json`（优先）或经用户显式配置的安装目录外单文件路径；**全系统仅此一个文件**，不得扩展为目录树 |
| 用途 | 记录静默更新链跨重启的意图与结果：`phase`（downloading/verified/installed/pending/committed/rolled_back）、`target_version`、`previous_version`、`asset_sha256`、`unit`、`commit_result`、`started_at`、`finished_at`；只写状态元数据，**不写凭据 / token / 口令**（G-30） |
| 权限 | 0600，属主 = kored 运行 uid（root 服务形态即 root；portable 即当前 uid）；原子写（临时文件 + fsync + rename），与 `upgrade.go:12-13` 的原子替换口径一致 |
| 登记 | 每次创建 / 覆写先追加 `<install>/data/changes.jsonl` 一条（复用 #3 账本）：`target` = 实际绝对路径、`summary` = 人话说明「更新状态记录」、`purge_op` = `file.remove`（结构化、可执行回滚） |
| 回滚 | `kore uninstall --purge` 按 `changes.jsonl` 的 `file.remove` 清单逐条删除该文件；手工回滚 = `rm <该路径>` 后 `grep -v <该路径> changes.jsonl`（账本同步清理，避免幽灵条目） |
| 边界 | 只此一个文件；不得在 `/etc`、`/var/lib`、`/var/log`、`/run`、`/usr/lib/systemd` 等 ADR-0023 `:113` 明列的清单外路径写入；不得借本豁免新增 unit / 用户 / crontab / 系统服务 |

**为什么是「最小」**：只加 1 个文件、1 条账本契约、1 条回滚操作；不新增常驻任务落盘、不新增 unit、不新增系统用户。U3 裁决点名排除的三类（常驻任务 / 新 unit / 新用户）**全部不在本提案内**。

### 3.2 明确不新增的豁免（提案的负空间）

| 曾被草案列为可能需要的新写入 | 本次处置 | 依据 |
| --- | --- | --- |
| 常驻任务落盘（独立 timer / crontab / `/etc/cron.d/kore-*`） | **不新增**：更新检查任务挂在已有 scheduler 单 ticker（ADR-0019），零落盘 | U3「不是按需无限放宽」；ADR-0059 §3.1 |
| 新 systemd unit（如独立的 `kore-updater.service`） | **不新增**：内核升级复用 `kore.service` 的 `--no-block` 重启（`upgrade.go:265-295`）；§4.1 的系统 unit 仍走现有豁免 #1 | U3；ADR-0056 §6 |
| 新系统用户（如 `kore-updater`） | **不新增**：本机身份用 `SO_PEERCRED` uid∈{0,kored uid}，无需新用户（ADR-0058 §3.1） | U3；ADR-0023 §3.2 |
| `/etc/kore`、`/var/lib/kore`、`/var/log/kore`、`/run/kore` 等目录树 | **不新增**：ADR-0023 `:113` 明列的清单外路径原样封禁 | G-31 |

## 4. 对 ADR-0023 现有章节的影响（2026-11-26 accept 后已 append 落地）

> 以下追加文字已由 scribe（task-42）以 append 修订段方式落到 ADR-0023（延续 ADR-0043 §6/§7、ADR-0056 §实现复核注记的先例），原文保持不动；落地位置为 [§3.5 豁免 #5](./0023-zero-intrusion.md) 与 [§11 追加修订记录](./0023-zero-intrusion.md)。

1. **§3.5 豁免清单追加一行**（编号 #5，内容取 §3.1 表格），并在清单下方注明「新增项来自 U3 有限放宽裁决（2026-11-26），仅此一项，逐项登记 `changes.jsonl` 可回滚」。
2. **§3.6 验收判据追加**：断言 `<install>/data/update-state.json` 存在时，`changes.jsonl` 必须有对应条目且 `purge_op=file.remove`；卸载后该文件必须不存在（纳入 `snap()` 断言集合），否则零侵入判 FAIL。
3. **§5 被否决方案汇总追加**：「按需无限放宽安装目录外写入」与「为自更新新增独立 unit / 用户 / 常驻任务落盘」列入否决，依据 U3 裁决与 §3.2。
4. **§8 复审条件追加**：若出现第二个安装目录外写入需求，必须另开 ADR 逐项裁决，不得援引本次 #5 类推。

## 5. 被否决选项与依据（G-23）

| 选项 | 否决依据 |
| --- | --- |
| 不新增任何豁免，更新状态只写 `<install>/data/` 内的既有 state.db | state.db 被运行中 kored 的 bbolt flock 独占（`store.go:95-100`、`install.go:102-108`），更新链在重启窗口无法可靠写入；且 U3 裁决已明确允许「最小安装目录外写入」这一项 |
| 按需无限放宽（凡更新链需要什么就写哪里） | 用户 U3 裁决直接否决；零侵入是核心约束，清单外写入目录树 / 新 unit / 新用户会让「删安装目录即卸载」失效（ADR-0023 §0 判据） |
| 新增独立 `kore-updater.service` / `kore-updater` 用户 / 常驻 timer | U3 点名排除的三类；G-05 常驻组件、G-03 资源预算、ADR-0042 root 服务目标形态均已覆盖需求（ADR-0059 §2.2-C 否决） |
| 用 `changes.jsonl` 以外的第二套回滚账本 | 双真源必漂移（G-06）；ADR-0049 §5.1 已有可执行的 `purge_op` 契约，复用成本最低 |
| 状态文件里附带机器指纹 / 版本遥测上报 | G-10 隐藏上报红线；本文件只记录本地状态，永不出站（ADR-0059 §3.3） |

## 6. 后果（accept 后）

**正面**：跨重启的更新意图可审计、可回滚；零侵入判据从「4 项清单」扩展为「4 + 1 项逐项可判」，未放宽为无限集。

**代价 / 风险**：`make zero-intrusion-check` 的 `snap()` 需增该路径断言（实现卡负责，G-06 同步）；状态文件是新增的运行态资产（G-29），测试必须起隔离实例，不得改主实例；若 `changes.jsonl` 写入失败，必须 fail-closed 不开始更新（沿用 ADR-0049「账本未装配即拒绝」口径）。

## 7. 验收标准（accept 并实现后）

```bash
make zero-intrusion-check     # exit 0；有状态文件时账本有对应 file.remove 条目，卸载后文件不存在
make docs-check               # exit 0；ADR-0023 append 段与 AGENTS.md G-31 引用同步
make secret-check             # exit 0；update-state.json 样本无口令/token/凭据字段
go test -timeout 200s ./cmd/kored/...   # exit 0；状态文件原子写 + changes.jsonl 登记正反例通过
```

## 8. 复审条件

1. 用户拒绝 accept 本提案 → 更新链退回「只写 `<install>/data/` 内既有文件」的实现方案，须另开 ADR 解决 bbolt 锁冲突，不得静默写入清单外路径。
2. 出现第二个安装目录外写入需求 → 另开 ADR 逐项裁决，不得援引 #5 类推（U3「有限放宽」边界）。
3. 平台形态变更（macOS / Windows preview 转 GA）导致状态文件路径语义不同 → 复审 §3.1 的路径与权限口径。
