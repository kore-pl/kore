# depth_level 8 条裁决（G-20 存量不一致 · M5 收口唯一阻断项）

> 类型: 裁决报告 · 归属: architect · 日期: 2026-11-24 · 里程碑: M5 · 关联: [ADR-0045](../../docs/DECISIONS/0045-depth-level-convergence.md)、[PLUGIN-CATALOG](../../docs/PLUGIN-CATALOG.md) §6.1、[PLUGIN-MATURITY](../../docs/PLUGIN-MATURITY.md) §2、[G-20](../../AGENTS.md)、`scripts/depth-level-pending.txt`
> 边界：本报告**只裁决，不改任何值**——索引、各仓 `info.json`、清单文件本轮均未改动；唯一写入是本文件。

## 0. 结论摘要（先给答案）

1. **8/8 应判 `basic`**；索引 `basic` 100% 正确，方向不是「索引改 production」，而是「仓库 `info.json` 回退 basic」。
2. **8/8 的 `tests/fault/` 是真实故障注入测试，且 `go test ./tests/fault/` 全部 PASS**（rc=0）。这解除了 G-20 对 `production` 声明的**禁止性**条件，但不构成升级理由——升级还差 CATALOG:90 的判据 ①（边界用例四类各 ≥1 并进 CI），8 条均无证据。
3. **「现在就能改（索引错、仓库对）」= 0 条。** 唯一能立即做且零风险的动作是文档侧：把 `PLUGIN-MATURITY.md:66` 的「fault 测试未复跑」更新为「2026-11-24 已复跑 8/8 PASS」。
4. 工作量：走「自然发版顺带」= **8 次插件发版（分摊到既有计划，不新增批次）+ 1 次批量重签**；若 M5 收口前无自然发版，则集中 **8 次 patch 发版 + 1 次重签**。改仓库路径**必须 bump**（`info.json` 在 dist 包体内）；改索引路径不需要 bump，但本报告否决该路径。

## 1. 判据声明（为什么不是「有 fault 测试就是 production」）

| 判据 | 原文/出处 | 对本卡的作用 |
| --- | --- | --- |
| G-20 必要性 | `AGENTS.md:56`「`production` 插件必须过故障注入测试」；`tests/fault/` 必须存在 | 无 `tests/fault/` 或测试不过 → `production` 声明**直接违规**，必须回 basic |
| CATALOG 充分性 ① | `docs/PLUGIN-CATALOG.md:90`「边界用例覆盖（异常输入、并发、权限不足、资源耗尽各 ≥1 例并进 CI）」 | 这是 `production` 的**第二个必要条件**；fault 测试通过不能替代它 |
| CATALOG 充分性 ② | `docs/PLUGIN-CATALOG.md:90`「故障注入通过（`kill -9`、超时、磁盘满、cgroup 超限四类各 1 次）」 | 本卡实跑项 |
| CATALOG 分级口径 | `docs/PLUGIN-CATALOG.md:85-86` 12 生产级 / 8 基础级名单 | 产品分级唯一真源（ADR-0045 §2）；8 条全部在基础级名单内 |
| 门禁实现 | `scripts/presets-check.sh:355-364`：不一致且在清单 → WARN；不在清单 → FAIL | 决定「先删清单行」会立刻把 WARN 变成阻断 |

**推论（本卡的关键区分）**：8 条仓库的 `production` 属于**单维度达标的过度声明**——故障注入这一维已由代码事实支撑（见 §2 第 4 列），但 CATALOG:90 ① 的边界用例维度**在 8 个仓均无证据**（见 §3 逐条）。所以「仓库自评 production」不成立，索引 `basic` 不是错值。

## 2. 五列表（8 条全量）

索引列 = `../kore-plugins/index/plugins.json` 的 `depth_level` 行号；仓库列 = `../kore-plugin-<id>/info.json:7`（8 仓该行行号一致，均为第 7 行）；「fault 实跑」= 2026-11-24 在**各仓当前 HEAD 工作树**执行 `go test -count=1 -timeout 180s ./tests/fault/`。

| # | id | 索引（file:line） | 仓库 info.json（file:line） | fault 测试实跑结果 | 应是什么 | 依据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `echo` | `index/plugins.json:8` = basic | `../kore-plugin-echo/info.json:7` = production（0.1.4） | `ok .../tests/fault 6.200s` rc=0；13 个用例 / 677 行 | **basic** | `PLUGIN-CATALOG.md:88`：echo 是 M1 验证件、`basic` 只是 schema 两值约束下的占位，**不参与 12/8 评级**；验证件标 production 会污染商店等级语义 |
| 2 | `integrity` | `index/plugins.json:75` = basic | `../kore-plugin-integrity/info.json:7` = production（0.5.0） | `ok .../tests/fault 0.500s` rc=0；14 个用例 / 875 行 | **basic** | 故障维度齐（权限/超大/磁盘满/kill/超时/恢复），但 CATALOG:90 ① 的**并发**用例 grep 0 命中；`tests/boundary/` 不存在（`boundary_test.go` 在 `tests/fault/` 内，属故障面不是边界矩阵） |
| 3 | `dns` | `index/plugins.json:156` = basic | `../kore-plugin-dns/info.json:7` = production（0.4.1） | `ok .../tests/fault 2.676s` rc=0；14 个用例 / 1078 行 | **basic** | 故障维度较全（状态目录不可写/配置损坏/依赖缺失/kill9/超时/降级），但 ① 的**并发**与**权限不足**无独立用例矩阵；且索引版本 0.4.0 ≠ 仓库 0.4.1（见 §3.3） |
| 4 | `runtime-node` | `index/plugins.json:190` = basic | `../kore-plugin-runtime-node/info.json:7` = production（0.2.4） | `ok .../tests/fault 1.112s` rc=0；8 个用例 / 200 行 | **basic** | 四类故障齐（cgroup/disk/kill/timeout + 2 个 sanity），但 ① 的**并发**用例 0 命中、`tests/boundary/` 不存在 |
| 5 | `runtime-python` | `index/plugins.json:206` = basic | `../kore-plugin-runtime-python/info.json:7` = production（0.3.1） | `ok .../tests/fault 0.005s` rc=0；9 个用例 / 388 行 | **basic** | 四类故障齐 + `pip.killThenRetry` 恢复用例；但 ① 的**并发** 0 命中、无边界目录 |
| 6 | `db-postgres` | `index/plugins.json:240` = basic | `../kore-plugin-db-postgres/info.json:7` = production（0.3.3） | `ok .../tests/fault 2.017s` rc=0；7 个用例 / 389 行 | **basic** | 五类故障（kill9/timeout/二进制缺失/磁盘满/cgroup），但 ① 的**并发**与**权限不足**均 0 命中 |
| 7 | `waf` | `index/plugins.json:309` = basic | `../kore-plugin-waf/info.json:7` = production（0.4.4） | `ok .../tests/fault 0.004s` rc=0；6 个用例 / 266 行 | **basic** | 四类故障齐（内存文件系统 + 注入执行面，非本机已装 WAF），但 ① 的**并发** 0 命中、无边界目录 |
| 8 | `container` | `index/plugins.json:325` = basic | `../kore-plugin-container/info.json:7` = production（0.5.4） | `ok .../tests/fault 0.004s` rc=0；6 个用例 / 258 行 | **basic** | 四类故障齐（faultExecutor 注入 + sanity 反向用例），但 ① 的**并发** 0 命中、无边界目录 |

> 实跑说明：8 个仓**并行执行**，逐仓取 `rc` 与 `ok` 行；无 `--- FAIL`、无 `skip`。`runtime-python` / `waf` / `container` 的 0.004–0.005s 是纯内存注入（无真实子进程）所致，不是空壳：三者均含「故障注入 + 无故障 sanity」成对用例（`TestTimeoutSanity` / `TestSanityNoFault` / `TestCgroupSanity`），反向断言存在。
> CI 覆盖：8 仓 `Makefile:96` 的 `check` 目标含 `GOWORK=off go test -timeout 200s ./...`，`./...` 覆盖 `tests/fault`；`.github/workflows/ci.yml:36-37` 跑 `make check` → **fault 测试在 CI 内**。

## 3. 逐条判定与依据（代码事实）

### 3.1 共同事实：故障注入维度已达标（8/8）

- 8 个仓 `tests/fault/` 均存在，非空，含真实断言（错误码、错误体结构、无 panic、故障后状态完好），不是 `t.Skip` 占位。
- 采样证据：
  - `container/tests/fault/helper_test.go:21`：`faultExecutor` 让 12 个执行面方法统一返回 `NewFaultError`，断言映射为 `E_UPSTREAM`（kill/timeout）、`E_UNSUPPORTED`（cgroup）、`E_INTERNAL`（disk）。
  - `waf/tests/fault/helper_test.go`：内存文件系统 + `Run`/`ReadFile`/`Tail` 注入，`TestSanityNoFault` 反向防假通过。
  - `runtime-python/tests/fault/pip_kill_recovery_test.go:28`：kill 后校验 `venv/bin/pip` 与 marker 未被破坏、可立即重试。
  - `integrity/tests/fault/storage_test.go:29`：磁盘满 → 基线保存失败且回 `E_INTERNAL`，旧基线不被覆盖。
- **这一条推翻了 ADR-0045 之前没人验证过的假设**：8 条不是「拿旧文档自评 production」，故障注入这一维是真的。ADR-0045 §3 的三条理由（元数据不影响功能、索引已正确、改它要 8 次发版）依然成立，且现在多了一条支撑：**fault 测试存在也不改变结论**。

### 3.2 为什么仍判 basic：CATALOG:90 ① 缺证

`docs/PLUGIN-CATALOG.md:89-90` 对生产级的要求是「边界用例 + 故障注入 + 完整错误处理」，升级判据两条都要满足。逐仓实测（`grep -rlE` 于各仓 `*_test.go`）：

| id | 异常输入 | 并发 | 权限不足 | 资源耗尽 | `tests/boundary/` |
| --- | --- | --- | --- | --- | --- |
| `echo` | 1 文件 | 2 文件 | 0 | 0 | 无 |
| `integrity` | 6 | **0** | 4 | 6 | 无（`tests/fault/boundary_test.go` 属故障面） |
| `dns` | 7 | 1 | 2 | 2 | 无 |
| `runtime-node` | 1 | **0** | 1 | 1 | 无 |
| `runtime-python` | 2 | **0** | 1 | 1 | 无 |
| `db-postgres` | 4 | **0** | **0** | 8 | 无 |
| `waf` | 4 | **0** | 3 | 11 | 无 |
| `container` | 3 | **0** | 2 | 3 | 无 |

- **8 个仓全部没有 `tests/boundary/` 目录**；「四类各 ≥1 例」没有任何一个仓能拿一份清单自证。
- 6 个仓「并发」关键词 **0 命中**，`t.Parallel()` 在 6 个仓均 0 命中（`go func(` 命中的是测试内起协程读管道，不是并发调用同一方法的用例）。
- `db-postgres` 的「权限不足」0 命中。
- 结论：`production` 声明在 ① 维度**未被代码事实支撑**；按 CATALOG:86 的既有表述「边界用例与高级配置延到 v1.1」，这 8 条本来就该是 basic。**索引没有错，仓库自评高了一档。**

### 3.3 额外发现（同批处理，但不改变本卡裁决方向）

1. **`dns` 索引版本落后**：`index/plugins.json:153` 版本 0.4.0，`../kore-plugin-dns/info.json:7` 所在文件版本 0.4.1。这不是 `depth_level` 不一致，但同属索引↔仓库漂移，应在 `dns` 下次发版时一并把索引指到实际版本并重算 sha/size。
2. **`echo` 是结构性特例**：`PLUGIN-CATALOG.md:88` 明确它不参与 12/8 评级，但 `presets-check` 按字面比较，只要 `echo` 在索引里就会被比对。两条路：①（推荐）`echo` 下次发版时把 `info.json` 改成 `basic`，与索引占位一致，门禁自然消失；② 给门禁加 echo 白名单（改判据，ADR-0045 §5 已否决「改尺子」类做法，不推荐）。
3. **`PLUGIN-MATURITY.md:66` 的「fault 测试未复跑」已过期**：本轮 8/8 PASS，该句陈述应更新（归该文件 owner，本卡不改）。

## 4. 收敛路径（每条：改哪边、哪个版本）

| id | 改哪边 | 版本 | 同批发版动作（缺一即未收敛） |
| --- | --- | --- | --- |
| `echo` | 仓库 `info.json` → basic | 0.1.4 之后的下一个 patch（0.1.5） | bump + 重建 dist（两打比对）+ 更新索引 sha/size + 删清单行 + 台账 |
| `integrity` | 仓库 → basic | 下一个自然版本（patch） | 同上 |
| `dns` | 仓库 → basic | 下一个自然版本（patch）**并顺带把索引从 0.4.0 对齐到实际版本** | 同上 + 索引 version 修正 |
| `runtime-node` | 仓库 → basic | 下一个自然版本（patch） | 同上 |
| `runtime-python` | 仓库 → basic | 下一个自然版本（patch） | 同上 |
| `db-postgres` | 仓库 → basic | 下一个自然版本（patch） | 同上 |
| `waf` | 仓库 → basic | 下一个自然版本（patch） | 同上 |
| `container` | 仓库 → basic | 下一个自然版本（patch） | 同上 |

**不做「索引改 production」的理由**（与 ADR-0045 §5-B 一致，并补代码事实）：

1. 索引是商店显示真源；改索引等于把 8 个「边界用例未覆盖」的能力标成生产级，直接违反 `PLUGIN-CATALOG.md:86/90`。
2. 会让插件自评等级生效，G-20 的故障注入门槛被绕成「插件说自己是生产级就是」。
3. 8 条里 6 条并发用例 0 命中、1 条权限用例 0 命中，标生产级属于**已知未覆盖却升格**，比当前 WARN 风险高得多。

**版本时点**：维持 ADR-0045 §3「随各仓下次自然发版」，但加一条期限约束——**M5 收口前必须清零**（ADR-0045 §4.4）。若 M5 排期内 8 仓没有自然发版，则触发 ADR-0045 §7.1 复审，改为收口前集中一次 8 仓 patch 发版；**不允许**用「改索引 / 只删清单行 / 放宽判据」制造零值。

**要不要 bump？** 两条路径的答案不同，必须说清：

- **改仓库（本裁决选定）**：`info.json` 在 dist 包体内 → 改它必然改变 dist sha → **必须 bump**（G-17 + `docs/RELEASE.md`「同 `id@version` 只允许一个 sha」）。
- **改索引（已否决）**：索引不是插件包，改 `depth_level` 不涉及 dist → **不需要 bump 插件版本，只需重签索引**。这也是「索引错时现在就能改」这句话在技术上成立的原因——但它现在不成立，因为错的是仓库不是索引。

## 5. 工作量估算

| 方案 | 插件发版次数 | dist 重建 | 索引重签 | 清单/台账 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **A. 自然发版顺带（推荐）** | 8 次（分摊进既有计划，**不新增批次**） | 8 次（每次两打 + 干净树复现一致） | **1 次批量重签**（若 8 仓在同一天完成）～最多 8 次（若分散在不同日子） | 8 行删除 + 8 行台账 | 增量成本≈0，但依赖 8 仓都有发版；M5 收口前未清零则转 B |
| **B. M5 收口前集中清零** | 8 次 patch（一次性排期） | 8 次 | **1 次重签** | 8 行删除 + 8 行台账 | 唯一有风险的动作是重签（签名错会让商店全 401），集中 1 次比分 8 次窗口更安全 |
| C. 改索引（否决） | 0 | 0 | 1 次 | 8 行删除 | 技术上最省，但把未覆盖能力标生产级，违反 CATALOG:90 ① |

- 每仓 patch 发版的实际工作量 = bump + CHANGELOG 一条 + `make dist` + 索引 sha/size + 清单行 + 台账，约 10–15 分钟/仓；8 仓串行约 1.5–2 小时，可并行到 4 个仓/轮。
- **重签次数是索引级的，不是插件级的**：8 仓同批清零只需 1 次重签；这是方案 B 优于「逐仓单独发版」的核心原因。

## 6. 可立即改的清单

**0 条。** 逐条核对「索引 basic / 仓库 production」后，没有一条是「仓库对、索引错」：

- 8/8 的 production 声明都缺少 CATALOG:90 ① 的边界用例证据（§3.2 表），因此索引 `basic` 是正确值，不存在「现在就该改索引」的条目。
- 唯一零风险、可立即做且不涉及发版的动作是**文档侧**：更新 `PLUGIN-MATURITY.md:66` 的「fault 测试未复跑」为「2026-11-24 复跑 8/8 PASS」——这条不改变任何等级，不触发重签，但能消除「仓库自评 production 到底有没有测试支撑」的悬空疑问。

**反证条件（供产品裁决时二选一）**：若产品明确「G-20 的故障注入单条即视为 production 充分条件、不要求 CATALOG:90 ①」，则 8 条全部变成「索引错、仓库对」，可立即改索引为 production——**不需要 bump 插件版本，只需 1 次索引重签**，8 行清单同步删除。本报告不推荐这条路（与 CATALOG:90 ① 冲突），但把它作为显式分支列出，避免「没裁决就挂着」。

## 7. 未确认项（不猜）

1. **并发用例「0 命中」是 grep 口径的否定证据，不等于绝对不存在**——可能存在未含上述关键词的并发断言（如用 channel 间接并发）。要证「确实没有」，需逐仓人工 review 测试文件；本轮为控时未做。
2. **`dns` 索引停在 0.4.0 的原因未追溯**（是未重签、还是 0.4.1 未发布）。索引 sha 与仓库 dist 的对应关系本轮未逐仓核对。
3. **`PLUGIN-MATURITY.md:66` 记录的「升 8 仓」名单含 `ssh-guard`，但 HEAD 实测 `ssh-guard` 已是 `basic`**（ADR-0045 §1.5 已指出）——是后续回退还是盘点误记，未追溯 commit，不在本卡范围。
4. `tests/fault/` 各仓的**故障四类完整性**按用例名判定（kill/timeout/disk/cgroup）；`echo`、`integrity`、`dns` 无 cgroup 用例，是否因其无 cgroup 相关执行面而合理豁免，**未确认**（需按各仓执行面判断，不宜一刀切）。

## 8. 复核命令（谁都能重跑）

```bash
cd /home/pt/Work/GolandProjects
# ① 索引 vs 仓库（8 条应为 basic / production）
for id in echo integrity dns runtime-node runtime-python db-postgres waf container; do
  printf '%-15s idx=%s repo=%s\n' "$id" \
    "$(python3 -c "import json;d=json.load(open('kore-plugins/index/plugins.json'));print([p['depth_level'] for p in d['plugins'] if p['id']=='$id'][0])")" \
    "$(python3 -c "import json;print(json.load(open('kore-plugin-$id/info.json'))['depth_level'])")"
done
# ② fault 实跑（8/8 应 ok）
for id in echo integrity dns runtime-node runtime-python db-postgres waf container; do
  (cd kore-plugin-$id && GOWORK=off go test -count=1 -timeout 180s ./tests/fault/ >/dev/null 2>&1; echo "$id rc=$?")
done
# ③ 门禁基线（应 8 pass / 8 warn / 0 fail，rc=0）
cd kore && bash scripts/presets-check.sh 2>&1 | tail -2
```

本轮实测输出（2026-11-24）：

```
[INFO] depth_level 核对: 24 个已收录插件 · 不一致 8 条（已知待裁决 8 / 新增 0）
presets-check: 8 pass, 8 warn, 0 fail        # rc=0
```
