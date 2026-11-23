> 状态: accepted · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [PLUGIN-CATALOG](../PLUGIN-CATALOG.md) §6.1、[PLUGIN-MATURITY](../PLUGIN-MATURITY.md) §0/§2、[G-18 / G-20 / G-23](../../AGENTS.md)、[presets-check](../../scripts/presets-check.sh)、[depth-level-pending](../../scripts/depth-level-pending.txt)

# ADR-0045: 8 个仓的 `depth_level` 以 PLUGIN-CATALOG 的 12/8 为准，随各仓下次发版收敛

## 0. 问题

索引里 8 个插件的 `depth_level` 是 `basic`，对应插件仓的 `info.json` 却是 `production`。门禁（`scripts/presets-check.sh`）把这类不一致分成两档：登记在 `scripts/depth-level-pending.txt` 的算 WARN，未登记的算 FAIL。于是这 8 条一直「合法地」挂着——**没有裁决、没有责任人、没有期限**，`pending` 文件成了无期限豁免。本 ADR 只回答两件事：**以谁为准**、**怎么收敛到零**。

## 1. 事实核查（三方口径）

### 1.1 产品口径（CATALOG）：12 生产级 / 8 基础级

- `docs/PLUGIN-CATALOG.md:81` §6.1 标题即「深度等级（12 生产级 / 8 基础级）」。
- `docs/PLUGIN-CATALOG.md:85` 生产级 12：`site` `ssl` `runtime-php` `db-mysql` `file` `backup` `cron` `logs` `monitor` `firewall` `redis` `app-deploy`。
- `docs/PLUGIN-CATALOG.md:86` 基础级 8：`runtime-node` `runtime-python` `db-postgres` `waf` `ssh-guard` `integrity` `dns` `container`；用户可见文案「基础级 · 边界能力 v1.1」。
- `docs/PLUGIN-CATALOG.md:88` 与 `:233`：`echo` 是 M1 验证件，索引里 `basic` 只是 schema 两值约束下的占位，**不参与 12/8 评级**。

### 1.2 8 个仓的 `info.json`（HEAD 实测）：`production`

```
$ grep -H '"depth_level"' ../kore-plugin-{container,db-postgres,dns,echo,integrity,runtime-node,runtime-python,waf}/info.json
../kore-plugin-container/info.json:  "depth_level": "production",
../kore-plugin-db-postgres/info.json:  "depth_level": "production",
../kore-plugin-dns/info.json:  "depth_level": "production",
../kore-plugin-echo/info.json:  "depth_level": "production",
../kore-plugin-integrity/info.json:  "depth_level": "production",
../kore-plugin-runtime-node/info.json:  "depth_level": "production",
../kore-plugin-runtime-python/info.json:  "depth_level": "production",
../kore-plugin-waf/info.json:  "depth_level": "production",
```

### 1.3 索引（商店显示的真源）：`basic`

```
$ python3 -c '…（读 ../kore-plugins/index/plugins.json）'
basic(9): echo integrity ssh-guard dns runtime-node runtime-python db-postgres waf container
production(15): site file ssl cron monitor logs runtime-php db-mysql redis backup firewall app-deploy terminal process discover
```

- 索引 `basic` 的 9 条 = §6.1 基础级 8 条（含 `ssh-guard`）+ `echo` 占位；**与 CATALOG 完全一致**。索引 `production` 的 12 条 = §6.1 生产级 12 条；另 3 条 `terminal` / `process` / `discover` 未进 §6.1 名单，**不在本次裁决范围**（是否属 CATALOG 漏列，未确认，交 CATALOG owner）。
- 关键事实：**商店读的是索引，索引值是对的**——用户当前看到的是「基础级」，不是错误等级。

### 1.4 门禁现状（2026-11-24 实测）

```
$ bash scripts/presets-check.sh
[WARN] depth_level 待裁决（已知存量，不阻断）: echo: 索引 basic / 仓库 production（已登记 depth-level-pending.txt，等产品裁决方向）
…（同格式共 8 条：echo / integrity / dns / runtime-node / runtime-python / db-postgres / waf / container）
[INFO] depth_level 核对: 24 个已收录插件 · 不一致 8 条（已知待裁决 8 / 新增 0）
presets-check: 8 pass, 8 warn, 0 fail        # exit 0
```

- 判定逻辑：`scripts/presets-check.sh:355-359` 不一致且在清单 → WARN；`:360-364` 不一致且不在清单 → FAIL（阻断）；`:366-375` 清单条目已一致或已不在索引 → WARN「陈旧条目，请移除」；`:377-378` 输出 `已知待裁决 N / 新增 M`。
- 清单本体：`scripts/depth-level-pending.txt:9-16` 共 8 行（`container` / `db-postgres` / `dns` / `echo` / `integrity` / `runtime-node` / `runtime-python` / `waf`）。
- **文档漂移（只记录、本次不改）**：`AGENTS.md:129` 仍写 `presets-check` 为「7 pass / 8 warn / 1 fail（1 fail = `db-only.json` 的 G-20 违规）」，实测已收敛为 `8 pass / 8 warn / 0 fail`；`AGENTS.md` 不在本 ADR 写域（可能被他人占用），由该文件 owner 后续同步。

### 1.5 与 `PLUGIN-MATURITY` 的口径冲突（只指出，不改那两个文件）

- `docs/PLUGIN-MATURITY.md:16`：「…（全部 `depth_level: production`，`basic` 0）」；`:18`：「`depth_level` 24/24 `production`、`basic` 0」。
- 这与 `PLUGIN-CATALOG.md` §6.1 的 12/8 **直接冲突**：同一批 8 个仓，一处说「全部生产级」，一处说「基础级，边界能力延 v1.1」。两者再与索引 `basic` 构成第三方口径。
- 另有反向漂移：`PLUGIN-MATURITY.md:61` 记「本轮升 8 仓」，名单含 `ssh-guard`；但 HEAD 实测 `../kore-plugin-ssh-guard/info.json:8` 为 `"depth_level": "basic"`（版本 0.3.1）。是后续版本回退还是盘点误记，**未确认**（本次未追溯其 commit，不臆测）。
- **以谁为准**：以 `docs/PLUGIN-CATALOG.md` §6.1 的 12/8 为准（用户裁决）。`PLUGIN-MATURITY` 的「24/24 production」是对**当时仓库文件状态的盘点陈述**，不是分级口径——分级口径只能有一个，且必须是 CATALOG；它的这句陈述同时被索引与 CATALOG 证伪。
- **处置边界**：本 ADR 只指出冲突与判定依据；`docs/PLUGIN-MATURITY.md` 与 `docs/PLUGIN-CATALOG.md` 本次**一行不改**（可能被其他会话 / owner 占用），同步动作归各自 owner。

## 2. 裁决

**以 `PLUGIN-CATALOG` 的 12 生产级 / 8 基础级为唯一分级口径。** 8 个仓（`container`、`db-postgres`、`dns`、`echo`、`integrity`、`runtime-node`、`runtime-python`、`waf`）的 `info.json.depth_level` 应回到 `basic`；`../kore-plugins/index/plugins.json` 保持 `basic` 不动（它已经是正确值）。`echo` 按 CATALOG §6.1 的口径澄清保持 `basic` 占位、不参与 12/8 评级，因此同样回 `basic`。

裁决范围不含：`ssh-guard`（索引与仓库均已 `basic`，一致）、`terminal` / `process` / `discover`（未进 §6.1 名单，另案）。

## 3. 执行策略

**不强制现在一次性发 8 个版本；改为「各仓下次自然发版时顺带改」，`scripts/depth-level-pending.txt` 随之一条条删除，清单自然收敛到空。**

理由三条：

1. `depth_level` 是**展示与分级元数据**，不影响功能正确性——改它不修任何行为缺陷。
2. 索引已经是 `basic`，**商店显示的是正确值**——用户侧没有正在发生的错误，不存在「必须立刻止血」的紧迫性。
3. `info.json` 在 **dist 包体内**，改它必须 bump 版本 + 重发 dist + 更新索引 sha + 重签索引 → 8 次发版 + 1 次重签。为一条纯元数据占用 8 条发布链，收益（仓库文件与索引字面一致）远小于成本与风险（8 次新 sha、8 次签名/索引同步窗口）。

每条发版的**同批动作清单**（缺一条即该仓未收敛）：

1. `info.json` 的 `depth_level` 改为 `basic`，版本按语义化 bump；
2. 重建 dist、更新 `../kore-plugins/index/plugins.json` 的 `version` / `sha256` / `size_bytes`（`depth_level` 保持 `basic`）、重签索引；
3. 从 `scripts/depth-level-pending.txt` 删除该仓对应行；
4. 在 §4.3 收敛台账追加一行（日期 / 仓 / 版本 / 发版后 `N`）。

禁止：①为 `depth_level` 单独发一个版本（违背第 1–3 条理由）；②改索引去迁就仓库；③只删清单行不改 `info.json`——那会让该仓从 WARN 直接变 FAIL，把「已知偏差」变成「阻断」。

## 4. 收敛条件与检查方法（可核查）

### 4.1 逐仓收敛判据（单仓发版后即可核查）

```bash
id=container   # 换成实际发版的仓
grep -q '"depth_level": "basic"' "../kore-plugin-$id/info.json" && \
  ! grep -qx "$id" scripts/depth-level-pending.txt
echo "exit=$?"   # 0 = 该仓已收敛
```

两条同时成立才算收敛：`info.json` 是 `basic` **且**清单里没有该 id。只剩清单行未删 → 门禁报「陈旧条目」（`presets-check.sh:365-375`）；只剩 `info.json` 未改 → 该仓仍在 WARN，`N` 不下降。

### 4.2 全局收敛判据（`N` 只能单调下降）

```bash
bash scripts/presets-check.sh 2>&1 | grep -E 'depth_level 核对'
# 期望形如：[INFO] depth_level 核对: 24 个已收录插件 · 不一致 N 条（已知待裁决 N / 新增 0）
grep -cvE '^[[:space:]]*(#|$)' scripts/depth-level-pending.txt   # 清单实际条数
```

- **基线：2026-11-24 实测 `N = 8`，清单 8 行。**
- `已知待裁决 N` **只允许单调下降**（8 → 7 → … → 0），**不允许回升**。回升视为违规：说明有仓把 `info.json` 改回 `production`，或把已删除的清单行加了回来；此时该次改动不得记完成，须先定位回升来源。
- 「新增 M」必须恒为 `0`：任何未登记的新不一致都会走 FAIL 分支（`presets-check.sh:361-364`），阻断 `make presets-check`，无法静默混入。

### 4.3 收敛台账（每次发版追加一行）

| 日期 | 仓 | 发版后版本 | 发版后 `已知待裁决 N` |
| --- | --- | --- | --- |
| 2026-11-24 | —（基线，未发版） | — | 8 |

### 4.4 过期条件（M5 收口硬判据）

> **如果 8 条 pending 在 M5 收口时仍未清零，则该里程碑不得收口。**

量化判据（两条同时成立才允许 M5 收口）：

```bash
# ① 清单清零
grep -cvE '^[[:space:]]*(#|$)' scripts/depth-level-pending.txt   # 必须为 0
# ② 门禁自证零待裁决
bash scripts/presets-check.sh 2>&1 | grep -q '已知待裁决 0 / 新增 0'   # 必须 exit 0
```

任一不成立 → 按 G-23「里程碑收口时台账缺条目视为该里程碑未收口」同口径处理：**M5 记未收口**，不得以「WARN 不阻断」为由带账收口。清零只允许通过「发版 + 改 `info.json` + 删清单行」实现；**不允许**用「改索引迁就仓库」「只删清单行」「放宽门禁判据」三种方式制造零值——前两种会被门禁直接判 FAIL，第三种属改尺子，按 G-22 / 本 ADR §5 否决。

## 5. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| A. 一次性发 8 个版本，立即清零 | `depth_level` 只是展示/分级元数据，不改任何行为；索引已 `basic`、商店显示已正确，没有用户可见错误需要止血；`info.json` 在 dist 包体内，必须 bump + 重发 + 重签 = 8 次发版 + 1 次重签，用 8 条发布链换「仓库文件与索引字面一致」，成本与风险（8 次新 sha、签名/索引同步窗口）远大于收益 |
| B. 改索引迁就仓库（索引改回 `production`） | 索引是商店显示的真源，改它等于把 7 个基础级能力标成「生产级」：直接违反 `PLUGIN-CATALOG.md:86` 与 G-20（`basic` 不得标生产级），并让「边界用例 + 故障注入」的升级判据（`PLUGIN-CATALOG.md:90`）失去意义——按仓库自述升级，等于让插件自评等级；还会把当前正确的用户可见信息改错 |
| C. 保持现状、继续挂在 `pending` 里不裁决 | `pending` 设计的本意是「已核实、方向待裁决」的**临时**豁免；无裁决、无 owner、无期限地挂着，等于把「已知不一致」永久合法化，新增不一致与存量不一致在输出里越来越难区分（两者都是不一致，只差一行清单），且 M5 收口时没有任何判据可用——这正是本 ADR 要消灭的状态 |
| D. 只删 `pending` 行、不改 `info.json` / 索引，制造「零待裁决」 | 门禁会立刻把该仓判为 FAIL（`presets-check.sh:361-364`，「未登记；新仓新错不得进商店」），`make presets-check` 退出码非 0；这是用删证据换绿灯，属改尺子 |

## 6. 后果

- M5 收口多一条硬判据：`pending` 清零 + 门禁 `已知待裁决 0`（§4.4）。里程碑表与 REVISE 检查都按此判。
- 8 个仓在各自下次发版前，`info.json` 与索引保持不一致，属**已裁决的已知偏差**：WARN 保留、不阻断日常提交；但 `N` 必须单调下降，上升即违规。
- 商店显示不受影响（索引 `basic` 未变）；用户不会看到等级变化。
- 每次插件发版多一条动作（改 `depth_level` + 删清单行 + 记台账），由 `presets-check` 的 `N` 与「陈旧条目」提示守护，漏做会被门禁点名。
- `PLUGIN-MATURITY.md`「24/24 production」与本裁决并存期间，读者以 CATALOG §6.1 为准；该文件的同步由 owner 另案处理。

## 7. 复审条件

1. **M5 收口时 `pending` 未清零** → 触发复审：要么在收口前集中安排剩余仓发版，要么把 M5 收口时点后移；**不得**改索引、删清单或放宽门禁来清零。
2. **产品决定把某个 `basic` 仓升 `production`** → 属新裁决：必须同时满足 `PLUGIN-CATALOG.md:90` 两条升级判据（边界用例进 CI + 故障注入通过），并同批改 `info.json`、索引与该仓清单行；届时 `N` 仍应单调下降，不得因升级而回升（升级不会重新登记 pending）。
3. **CATALOG §6.1 的 12/8 名单本身被上级裁决修改**（v1.1 目标是 8 个基础级全升生产）→ 本 ADR 的分级前提失效，须新开 ADR 重定口径，并重算 `pending` 收敛目标。
4. **`terminal` / `process` / `discover` 的 §6.1 归属确认**（当前不在 12/8 名单，索引为 `production`）→ 若确认属漏列，由 CATALOG owner 补名单，本 ADR 范围不扩。
5. **`presets-check` 的判据或 `pending` 机制被改动**（例如取消 WARN 分档、把不一致全改 FAIL）→ 本 ADR §4 的检查方法随之失效，须同轮更新本节与 §4，否则收敛判据与门禁脱节。
