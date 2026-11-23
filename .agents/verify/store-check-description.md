# store-check · description 判据对账

> 状态: 完成（verifier: store-check-reconcile）
> 里程碑: M0
> 结论: 脚本比 G-17 / 协议顶层 schema 多要求了 `description`（门禁自我膨胀）；24 仓以 `name` 承担描述职责。判据改为「描述类字段四选一，全缺只 WARN」，未改任何插件仓、未制造版本抖动。

## 1. 事实：24 仓描述类字段现状

探测命令（对每个 `../kore-plugin-*` 读 `info.json`）：

```bash
for d in ../kore-plugin-*; do echo "== $d"; \
  python3 -c "import json;d=json.load(open('$d/info.json'));\
print({k:v for k,v in d.items() if k in ('description','title','summary','name')})"; done
```

| 描述类字段 | 命中仓数 | 说明 |
| --- | --- | --- |
| `description` | **1 / 24** | 仅 `kore-plugin-ssh-guard` |
| `name` | **24 / 24** | 全部非空，中文展示名（如「应用一键部署插件」） |
| `title` | 0 / 24 | 无仓使用 |
| `summary` | 0 / 24 | 无仓使用 |
| 四者全无 | **0 / 24** | 不存在真正的「无描述字段」仓 |

结论：不存在「23 个仓真的没有任何描述类字段」的情况；`name` 是协议必填的展示名，等价承担「一句话说明」职责。**这正是判决 B 的成立条件。**

## 2. 规格原文

### 2.1 G-17（`AGENTS.md` §2 硬门禁原文）

> 插件仓规范：每个插件仓库必须含 `info.json`（含 `depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore`）、`Makefile` 的 `dist` 目标、`CHANGELOG.md`；缺任一项不得进商店。

`info.json` 必填字段 = **5 项**：`depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore`。**`description` 不在其中。**

### 2.2 协议顶层 schema（`docs/PLUGIN-PROTOCOL.md` §3.1）

> **必填口径（与代码逐字对齐）**：**9 个必填** = `id` `name` `version` `protocol` `entry` `capabilities` `resources` `requires_kore` `triggers`；3 个可选 = `lifecycle` / `scenario_tags` / `size_bytes`；另有 ADR-0018 的 `requires_root` / `root_actions` 与方法级 `method_capabilities`。

顶层字段表**没有 `description` 这一行**（§3.1.3 的 `description` 是 `root_actions[]` 子项的可选字段，不是插件级描述）。因此 `description` 既非 G-17 必填，也非协议顶层字段。

## 3. 脚本 vs 规格逐项对照（改前）

改前 `REQ_FIELDS` = `id` `version` `description` `depends_on` `conflicts` `scenario_tags` `size_bytes` `requires_kore` `depth_level` `capabilities`（10 项）。

| 字段 | G-17 | 协议 §3.1 | 脚本 | 判定 |
| --- | --- | --- | --- | --- |
| `depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore` | 必填 | 可选/按表 | 必填 | ✅ 一致 |
| `id` | 隐含（G-27 正则 + 目录名一致） | 必填 | 必填 | ✅ 有依据 |
| `version` | 隐含（G-17 延伸发版一致性 + manifest 比对） | 必填 | 必填 | ✅ 有依据 |
| `depth_level` | G-20 必填 | 未列（G-20 增补） | 必填 | ✅ 有依据 |
| `capabilities` | 未列 | 必填 9 项之一 | 必填 | ✅ 有依据 |
| **`description`** | **未要求** | **顶层无此字段** | **必填 FAIL** | ❌ **脚本自加，无规格依据** |

**脚本多要求的字段**：仅 `description` 一项无依据（其余 4 项各有 G-27 / G-17 延伸 / G-20 / 协议 §3.1 依据，本次不动）。
**规格要求但脚本未（充分）校验的字段**：G-17 的 5 项均已查「存在性」，但**未校验类型与取值**——`scenario_tags` 未校验 5 值枚举（`web`/`data`/`ops`/`sec`/`app`）、`size_bytes` 未校验 int 且 ≥0、`requires_kore` 未校验区间语法、`depth_level` 未校验 ∈ {`production`,`basic`}。这些是**后续加严**的候选，不属于本次范围（本次只允许改 `description` 判据）。

## 4. 判决与实施

**判决：(A) 为主 + (B) 的事实支撑。** 主因是脚本把规格外的 `description` 判成必填 FAIL（自我膨胀）；同时 24 仓普遍以协议必填的 `name` 承担描述职责，存在等价字段。

**实施（仅改 `description` 一项判据，`scripts/store-check.sh`）：**

1. `REQ_FIELDS` 去掉 `description`，剩 9 项必填（G-17 的 5 项 + `id`/`version`/`depth_level`/`capabilities`）。
2. 新增 `DESC_FIELDS = (description, title, summary, name)`：任一非空字符串即通过，`[OK]` 行注明 `desc-source: <字段名>`；四者全缺只打 `[WARN]`，不 FAIL、不改退出码（G-17 与协议顶层均未要求该字段，判 FAIL 无规格依据）。
3. 汇总行新增 `warn` 计数，退出码仍只看 `fail`。

**未做**：未改任何 `../kore-plugin-*` 仓；未加字段；未 bump 版本；未打 dist；未放宽 `depends_on` 等其它字段判据（见 §5 反例）。

## 5. 门禁证据

### 5.1 改前 / 改后（真仓 24 个）

| 时点 | 命令 | 结果 |
| --- | --- | --- |
| 改前 | `bash scripts/store-check.sh` | **1 pass / 23 fail**，exit 1；23 条 FAIL 全部为 `info.json 缺必填字段 description` |
| 改后 | `bash scripts/store-check.sh` | **24 pass / 0 fail / 0 warn**，exit 0；23 仓 `desc-source: name`，`ssh-guard` 为 `desc-source: description` |

### 5.2 反例证明（`/tmp` 假仓，不碰真仓；测完即删）

| 假仓 | 构造 | 期望 | 实测 |
| --- | --- | --- | --- |
| `kore-plugin-fake1` | 其余齐备，**缺 `depends_on`** | FAIL，exit 1 | `[FAIL] ... 缺必填字段 depends_on`，`0 pass, 1 fail`，exit 1 ✅ |
| `kore-plugin-fake2` | 9 项必填齐备，**无任何描述类字段** | 不 FAIL，只 WARN | `[OK]` + `1 warn`，exit 0 ✅ |
| `kore-plugin-fake3` | 其余齐备，**缺 `capabilities`** | FAIL，exit 1 | `[FAIL] ... 缺必填字段 capabilities`，exit 1 ✅ |

结论：`depends_on` / `capabilities` 等规格字段**仍是硬 FAIL**，本次只把 `description` 从 FAIL 降为「四选一 + 缺失 WARN」，没有为了变绿放宽其它判据。

### 5.3 聚合门禁

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `make check` | **0** | 16/16 段全过；14/16 store-check 段输出 `24 pass, 0 fail, 0 warn`（WARN 级、当前无 WARN）；末行 `[OK] 门禁全部通过` |
| `make docs-check` | **0** | `5 pass, 1 warn, 0 fail`；唯一 WARN 是 4 份历史长文行数越界（GITEE-MIRROR / PLUGIN-PROTOCOL / RUNBOOK / SIGNING-KEY-SOP），与本次改动无关 |

## 6. 「要不要批量补 description」的建议

**建议：现在不补。** 理由与代价：

1. **无门禁收益**：G-17 与协议顶层 schema 都不要求 `description`；补它不会让任何门禁从红变绿（本判据已按规格对齐）。
2. **补字段的成本是 24 次发版**：`info.json` 会进包体，改它会改变 dist sha；按 `AGENTS.md` §3「同 `id@version` 只允许一个 sha，任何改变 dist sha 的改动必须 bump」，每仓都要 bump 版本 → 重建 dist → 重算 sha256 → 更新 `kore-plugins` 的 `versions.lock.json` 与 `presets/*.json` → 发 release。**24 次无功能意义的版本抖动**，纯粹增加索引与预设的同步面积。
3. **展示需求已被满足**：`name`（协议必填，中文展示名）已足够商店列表与搜索结果展示。
4. **如果产品确实需要一句说明**，两条更便宜的路径：① 索引生成时从各仓 README / CHANGELOG 摘要一行；② 把 `description` 写进 **G-17 的下一个版本**作为 M1 新增必填，**随各仓下一次自然发版顺带补齐**（不专门为加字段 bump），届时再把脚本该判据升回 FAIL。

## 7. 残留漂移（不在本次写域，交 lead 派发）

| 位置 | 现状 | 建议 |
| --- | --- | --- |
| `AGENTS.md` §5 store-check 行 | 已按新判据改写（9 字段 + 描述四选一 + 24 pass/0 fail/0 warn）**并留在工作树**：该行本身是并发 agent 未提交的新增行（HEAD 无此行），整文件提交会把其 16 段门禁改造一起卷走 | 由该改动 owner 在其提交内一并带上本行；内容已就绪，无需再改 |
| `Makefile` store-check 目标注释 | 仍写「info.json 必填 10 字段」 | 改为「必填 9 字段 + 描述类字段四选一（WARN）」，一行改动；本次写域不含 Makefile，未动 |
| `.agents/QUALITY-GATES.md` §G-17 | 并发 agent 在改（工作树已修改） | 由该改动 owner 在其提交内同步「9 字段 + 描述四选一」口径 |
