# depth_level 口径核查（索引 vs 24 仓 info.json）

- 执行：`depth-level-audit`（只读核查）
- 时间：2026-11-23 23:50–00:05（+0800）
- 范围：`../kore-plugins/index/plugins.json` + `../kore-plugin-*/info.json` 24 仓；`tests/fault/` 仅作存在性与可追溯性统计
- 纪律：**未改代码、未改索引、未改任何插件仓、未起服务、未动运行态**；本文件是唯一写入
- 口径：索引与 `info.json` 均取 **工作树**（已核对 `kore-plugins` 工作树干净、HEAD == 工作树；各插件仓 `info.json` 无未提交改动）

---

## 0. 结论（先给判断）

1. **索引与 24 仓 `info.json` 有 8 处不一致，方向全部是「索引低、仓库高」**：`container` / `db-postgres` / `dns` / `echo` / `integrity` / `runtime-node` / `runtime-python` / `waf`。其余 16 仓一致（15 个 production + `ssh-guard` 双方均 basic）。
2. **两份实测都不假，测的不是同一份数据**：商店读**索引**（9 basic），`198e94e` 审计读**各仓 `info.json`**（当时 24/24 production）。矛盾来自两套数据源，不是某一方算错。
3. **不一致不是"随手写错"，而是三套口径从未合并**：
   - `docs/PLUGIN-CATALOG.md` §6.1 + `docs/V1-GOALS.md`：**12 生产级 / 8 基础级**（产品分级，2026-11-21 定稿）；
   - 各仓 `info.json.depth_level`：8 仓在 **2026-11-23 15:05–17:27 自行提升为 production**（代码侧声明）；
   - 索引：按 12/8 产品分级写入，**此后 48 次索引提交里 `depth_level` 值被改动 0 次**。
4. **门禁全链路不校验「索引 == info.json」**：`validate-index.sh` 只校验枚举；`store-check.sh` 只校验存在；24 个 `Makefile` 的 `dist` 只比对 manifest 的 5 个键（不含 `depth_level`）；`presets-check.sh` 完全没有 `depth_level`/`out_of_box` 逻辑。重签只签名，不重读仓库。
5. **`198e94e` 的 P0 实际是 4 条：app-deploy / logs / terminal / ssh-guard——container 与 waf 从未被列为 P0**（container 判 ✅、waf 判 ⚠️）。因此「把 container/waf 列为 P0」这一说法与原文不符，**没有可撤回的 container/waf P0**。
6. **按现状逐条判定**：P0-1 app-deploy **维持**（工作树有未提交补测，属在途）；P0-2 logs **撤回**（22:01 已补并提交）；P0-3 terminal **维持但降级为 P1**（fault 无覆盖，e2e 有覆盖）；P0-4 ssh-guard **撤回**（21:55 已按审计第二选项降 basic，索引一致）。
7. **G-20 真实分布**：仓库声明 **23 production / 1 basic（ssh-guard）**；索引/商店 **15 production / 9 basic**；产品分级 **12 production / 8 basic + echo 验证件**。三者各自成立，判据见 §6。

---

## 1. 方法与复跑

只读命令（全部可复跑，见 §9）：`jq` 读索引与 `info.json`；`git show HEAD:<file>` 读插件仓已提交状态；`git log -p` 查 `depth_level` 值变更史；`git ls-tree`/`git show` 读 `tests/fault/` 的已提交内容（避免把并发 agent 未提交文件算成现状）。

`tests/fault/` 的「方法级可追溯性」统计口径：

- 声明方法集 = `info.json.method_capabilities` 的键（`<plugin>.<action>`）；
- 命中 = `tests/fault/**`（HEAD 已提交文件）正文出现该方法全名，**或**其 action 段转 CamelCase 后作为 Go 调用/标识符出现（同时覆盖 `rt.Call("app-deploy.upload")` 与 `store.Add(...)` 两种测试风格）；
- 该方法只衡量「故障套件能否追溯到方法」，**不等于覆盖率**：黑盒 UDS 测试、内部 service 直接调用会低估（见 §6.3 的 C 档说明）。

---

## 2. 逐仓对照表（24 行）

索引取值行号 = `kore-plugins/index/plugins.json` 的 `"depth_level"` 行；仓库取值行号 = 该仓 `info.json`。

| # | 仓 | 索引 depth_level | info.json depth_level | 是否一致 |
| --- | --- | --- | --- | --- |
| 1 | app-deploy | production（L341） | production（L7） | ✅ |
| 2 | backup | production（L275） | production（L7） | ✅ |
| 3 | container | **basic**（L325） | **production**（L7） | ❌ 索引低 |
| 4 | cron | production（L91） | production（L7） | ✅ |
| 5 | db-mysql | production（L222） | production（L7） | ✅ |
| 6 | db-postgres | **basic**（L240） | **production**（L7） | ❌ 索引低 |
| 7 | discover | production（L398） | production（L7） | ✅ |
| 8 | dns | **basic**（L156） | **production**（L7） | ❌ 索引低 |
| 9 | echo | **basic**（L8） | **production**（L7） | ❌ 索引低 |
| 10 | file | production（L41） | production（L7） | ✅ |
| 11 | firewall | production（L292） | production（L7） | ✅ |
| 12 | integrity | **basic**（L75） | **production**（L7） | ❌ 索引低 |
| 13 | logs | production（L140） | production（L7） | ✅ |
| 14 | monitor | production（L123） | production（L7） | ✅ |
| 15 | process | production（L378） | production（L7） | ✅ |
| 16 | redis | production（L258） | production（L7） | ✅ |
| 17 | runtime-node | **basic**（L190） | **production**（L7） | ❌ 索引低 |
| 18 | runtime-php | production（L173） | production（L7） | ✅ |
| 19 | runtime-python | **basic**（L206） | **production**（L7） | ❌ 索引低 |
| 20 | site | production（L24） | production（L7） | ✅ |
| 21 | ssh-guard | basic（L107） | basic（L8） | ✅ |
| 22 | ssl | production（L58） | production（L7） | ✅ |
| 23 | terminal | production（L358） | production（L7） | ✅ |
| 24 | waf | **basic**（L309） | **production**（L7） | ❌ 索引低 |

**汇总**：一致 16（15 production + 1 basic）；不一致 8，**全部是索引低于仓库**，没有一处索引高于仓库。索引版本与仓库版本 24/24 相同（`jq .version` 逐一核对），不存在「索引旧版本」干扰。

---

## 3. 不一致清单与方向

| 仓 | 仓库提升 production 的提交 | 时间 | 索引是否同步 |
| --- | --- | --- | --- |
| container | `98db3ee`「提升为 production（故障注入已覆盖）」+ `e840ae2` bump 0.4.1 | 11-23 15:05 | 否 |
| db-postgres | `39db74d` bump 0.3.1 | 11-23 15:11 | 否 |
| dns | `628015e` bump 0.3.1 | 11-23 15:12 | 否 |
| integrity | `213301e` bump 0.3.2 | 11-23 15:12 | 否 |
| runtime-node | `e966b58` 0.2.3 | 11-23 15:12 | 否 |
| runtime-python | `d23d52b` 0.2.3 | 11-23 15:13 | 否 |
| waf | `dae8d32` bump 0.3.1 | 11-23 15:13 | 否 |
| echo | `2e813de`「补故障注入并升 production」0.1.4 | 11-23 17:27 | 否 |

方向均为「仓库高 / 索引低」。**唯一需要单独讨论的是 `echo`**：`PLUGIN-CATALOG.md` §6.1 与 `V1-GOALS.md` 明确「echo 为验证件、不评级；索引中 `depth_level=basic` 仅为 schema 两值约束下的占位」（`PLUGIN-CATALOG.md:88,233`）。对 echo 而言，**索引的 basic 可能才是应保留的口径**，仓库 0.1.4 的提升反而需要产品侧确认。

---

## 4. 机制解释：为什么会不一致

### 4.1 三套口径，各自演进，从未合并

| 口径 | 载体 | 数值 | 最近变更 |
| --- | --- | --- | --- |
| 产品分级（治理意图） | `docs/V1-GOALS.md:22-23`、`docs/PLUGIN-CATALOG.md` §6.1 | 生产级 12 / 基础级 8 / echo 不评级 | 12/8 行写于 2026-11-21 22:47（`7404ad1`），**此后未更新**；CATALOG 最后改动 11-23 16:11（`e048bcf`），仍写 12/8 |
| 代码声明（G-20 判据） | 24 仓 `info.json.depth_level` | 23 production / 1 basic | 8 仓在 11-23 15:05–17:27 自行提升；ssh-guard 21:55 降 basic |
| 商店展示 | `kore-plugins/index/plugins.json` → 市场页/预设/商店 API | 15 production / 9 basic | 48 次索引提交中 `depth_level` **值变更 0 次**（只有新增） |

**索引的 9 个 basic 不是随机漂移**，而是与产品分级逐字对齐：8 个基础级（`runtime-node` `runtime-python` `db-postgres` `waf` `ssh-guard` `integrity` `dns` `container`）+ `echo` 占位；12 个生产级全部 production；后加的 `terminal` / `process` / `discover` 入库时按 production 写入。12 + 8 + 1 + 3 = 24，完全闭合。所以真正的问题是：**8 个仓在 11-23 下午自行升级，索引仍停在 11-21 的产品分级，而两边都没有触发对方更新。**

### 4.2 门禁逐项：没有任何一处能发现这种不一致

| 门禁 | 实际校验 | 能否发现 |
| --- | --- | --- |
| `kore-plugins/scripts/validate-index.sh:69,89-90` | `depth_level` 必填 + 取值 ∈ {production,basic} | ❌ 只校验枚举，不与仓库比对 |
| `kore/scripts/store-check.sh`（REQ_FIELDS 含 `depth_level`） | 插件仓 `info.json` 字段**存在性** | ❌ 不读索引、不校验取值（`store-check-description.md` 亦记录"未校验 ∈ {production,basic}"） |
| 24 仓 `Makefile` 的 `dist` 目标 | `manifest.json` 与 `info.json` 比对 `id`/`version`/`protocol`/`requires_kore`/`capabilities` | ❌ `depth_level` 不在比对键内，且 dist 不接触索引；24 个 Makefile 该段逐字相同（已核对） |
| `kore/scripts/presets-check.sh` | id 可解析 / 版本区间 / 常驻 RSS / 体积 | ❌ 全文无 `depth_level`、无 `out_of_box`（尽管 Makefile 注释写「basic 不开箱」） |
| `kore-plugins/scripts/sign-index.sh` | 只对 `index/plugins.json` 做 ed25519 签名 | ❌ 不重读仓库、不重算字段 |
| `kore-plugins/scripts/build-market.sh:37,53` | 从索引白名单取 `depth_level` 生成市场页 | ❌ 单向消费，放大而非纠正 |

`kore` 侧商店同样读索引：`.agents/verify/main-restart-live.md:88-93` 的 `GET /api/v1/store/plugins` 原始返回为 `ssh-guard=basic`、`container=basic`、`waf=basic`、`logs=production`，与索引逐字一致——**这是索引问题，不是商店缓存或显示 bug。**

### 4.3 时间线（解释两份"实测"为何对立）

| 时间 | 事件 |
| --- | --- |
| 11-21 22:47 | V1-GOALS / CATALOG 定 12 生产级 / 8 基础级 |
| 11-22 13:14 | 索引收录首批插件（当时各仓骨架均为 basic，`4e20ce9`） |
| 11-23 15:05–17:27 | 8 个仓逐个把 `info.json` 提升为 production（索引未动） |
| 11-23 21:00 | `PLUGIN-MATURITY.md` 写入「`depth_level` 24/24 production、basic 0」——与同目录 CATALOG 的 12/8 **直接冲突**，此后 CATALOG/V1-GOALS 未回改 |
| 11-23 21:50 | `198e94e` 审计按「各仓 HEAD `info.json`」统计 → 24/24 production（准确；当时 ssh-guard 仍为 production） |
| 11-23 21:55 | ssh-guard 按该审计 P0-4 的第二选项降为 basic（0.3.1） |
| 11-23 22:34 | 第 47 次重签收录 ssh-guard 0.3.1；**8 个陈旧 basic 被原样签名**，成为官方值 |

结论：`198e94e` 的「24/24」在其截止时刻对**仓库**成立；商店的「9 个 basic」对**索引**成立。两者都不是伪造数据，缺的是一次口径裁决与一条一致性门禁。

---

## 5. P0 判定：维持 / 撤回 / 改级

### 5.1 先纠正一个事实

`198e94e`（`.agents/verify/plugin-capability-gaps.md:83-90`）的 P0 只有 4 条：**app-deploy、logs、terminal、ssh-guard**。container 在表中 fault 判 **✅**，waf 判 **⚠️（generic 套件未按方法覆盖）**，二者**从未被列为 P0**。因此本卡「把 container、waf 等列为 P0」的描述与原文不符；不存在需要因「它们实际是 basic」而撤回的 container/waf P0。

同时，**「container/waf 实际是 basic」这一前提本身不成立**：它们的 `info.json` 声明是 production（索引的 basic 是产品分级/陈旧值，不是仓库声明）。所以：

- 任何以「声明 production」为前提的指控，对 container/waf 而言**前提成立**（它们确实声明 production），不能因索引显示 basic 而说前提不成立；
- 但按 `198e94e` 原文，它们没有 P0，只有「container ✅ / waf ⚠️」。

### 5.2 逐条判定

| P0 | 仓 | 判定 | 依据 |
| --- | --- | --- | --- |
| P0-1 | app-deploy | **维持** | HEAD 的 `tests/fault/` 只有 `cgroup/disk/helper/kill/timeout`（5 文件），无 artifact 用例；`upload`/`deployFromArtifact`/`upgrade`/`jobs` 在已提交 fault 中 0 引用。**注**：工作树有未提交的 `tests/fault/artifact_test.go`（23:46 创建、7 个 Test，覆盖四方法），属并发在途修复，未提交即未闭环 |
| P0-2 | logs | **撤回** | `86b5a76`（22:01「补 clean/clean.restore 等故障注入覆盖（G-20 P0）」）已提交；fault 内 `clean`×8、`usage`×3、`retention`×6 引用。原指控的 5 个方法已有故障路径 |
| P0-3 | terminal | **维持，建议降为 P1** | HEAD `tests/fault/` 5 文件（四类故障），`history`/`attach`/`history.clear` 在 fault 中 0 引用；但 `tests/e2e/reconnect_history_test.go` 与 `internal/terminal/reconnect_test.go` 已覆盖 attach 失败/游标越界。G-20 原文要求 `tests/fault/`，故判定不变；从"生产级完全无故障证据"降为"fault 层单点缺口"更准确 |
| P0-4 | ssh-guard | **撤回** | 审计给的两选项，仓库已在 21:55 选第二项：`fa8cd84` 降 `depth_level=basic`（0.3.1），`fault_test.go` 注释自述「basic 级磁盘满/cgroup 延 v1.1」。声明与证据已对齐，索引亦为 basic，前提消失 |

**若坚持以「产品分级」为准**（即 CATALOG 的 12/8 才是权威）：8 仓应回退 basic 或补齐 CATALOG §6.1 的升级判据（边界用例 + 四类故障注入）后再升；此时 P0-1（app-deploy）与 P0-3（terminal）仍在 12 生产级名单内，**不受影响**。两条路都需要一次显式的口径裁决，不能靠索引与仓库各说各话。

---

## 6. G-20 现在的真实状况

### 6.1 三种分布（都对，但回答的问题不同）

| 统计口径 | production | basic | 用途 |
| --- | --- | --- | --- |
| 仓库 `info.json` 声明 | **23** | **1**（ssh-guard） | G-20 的判据对象（"插件必须声明…"） |
| 索引 / 商店展示 | 15 | 9 | 用户可见标签、预设 `out_of_box` 判定输入 |
| CATALOG §6.1 产品分级 | 12 | 8（+echo 不评级） | 路线图与验收承诺（V1-GOALS §22-23） |

按 G-20 原文（`production` 插件必须过故障注入），当前有 **23 个仓**处于"必须自证"的位置。

### 6.2 故障注入套件的客观事实（HEAD）

- **24/24 都有 `tests/fault/`**，无空目录。
- 19 仓四类齐备（kill / timeout / disk / cgroup）：app-deploy、backup、container、cron、db-mysql、discover、file、firewall、logs、monitor、process、redis、runtime-node、runtime-php、runtime-python、site、ssl、terminal、waf。
- 5 仓为定制套件：db-postgres（3 文件/7 用例）、dns（4/7）、echo（2/11）、integrity（3/8，kill + 权限/超限/短帧/磁盘满/基线损坏）、ssh-guard（1/4，仅 kill/timeout）。
- 用例数最多：cron 27、logs 15、terminal 13、echo 11、ssl 10。

### 6.3 方法级可追溯性（脚本口径，含低估说明）

| 档位 | 仓（命中/声明） |
| --- | --- |
| **A ≥80%** | container 13/13、monitor 4/4、runtime-node 5/5、runtime-php 5/5、runtime-python 9/9、redis 19/21、db-mysql 13/15、backup 11/13、db-postgres 11/13、file 19/23 |
| **B 30–79%** | discover 3/4(75%)、firewall 5/7(71%)、terminal 6/9(67%)、process 5/9(56%)、app-deploy 4/8(50%)、cron 5/10(50%)、logs 6/15(40%)、waf 4/12(33%) |
| **C <30%** | dns 3/11(27%)、ssl 5/20(25%)、integrity 1/7(14%)、site 2/22(9%)、ssh-guard 0/9（basic）、echo 0/0（无 `method_capabilities`，仅插件级 capability） |

**C 档不等于"没覆盖"**（已抽查）：`site` 是黑盒二进制 + UDS 帧协议，按 `site.create` 等操作注入四类故障，方法名不出现在测试源码；`ssl` 直接调内部 `svc.SelfSign/Renew/HTTPSStatus/RenewalTask`（fault 内 12 处 `svc.*` 调用，且有 `new_methods_test.go`）；`dns` 按 zone 写路径/坏配置/依赖缺失/kill/超时注入；`integrity` 按权限/超限/短帧/磁盘满/基线损坏注入。缺的是**方法名可追溯性**，不是零用例。真正的方法级缺口就是 §5 的 P0-1/P0-3 与 waf 的写方法（`ban/unban/rule.add/remove/toggle` 仅 method table 4 条）。

### 6.4 一句话结论

**G-20 的"字面条件"（production 有 `tests/fault/`）23/23 成立；"实质条件"（故障注入覆盖到方法）只有约 10 个仓能自证到 ≥80%，其余靠通用四类套件或黑盒路径撑着，4 条 P0 里 2 条已闭、2 条仍开（其中 1 条在途）。**

---

## 7. 对 G-20 判定的直接影响（已发生的污染）

索引的陈旧 basic 已经写进预设与文案：

| 预设 | `out_of_box` | 含索引 basic 成员 | 后果 |
| --- | --- | --- | --- |
| `db-only.json` | **true** | `db-postgres` | 按索引语义**违反 G-20**「basic 不得被预设标为开箱可用」；`presets-check.sh` 不查此项，门禁静默放过 |
| `security.json` | false | `ssh-guard` `integrity` `waf` | description 直接写「含基础级 ssh-guard/integrity/waf」——integrity/waf 仓库实为 production，文案被索引带偏 |
| `full.json` | false | 9 个索引 basic | 不违规，但"基础级"标签同样失真 |
| `dev.json` / `gateway.json` | false | 多个 | 同上 |
| `minimal.json` / `web-lite.json` / `web-pro.json` | true | 无 | 无影响 |

反向不成立：没有任何预设把索引 production 的插件标成 basic，也没有索引高于仓库的情况。

---

## 8. 建议（本卡不改，供后续裁决）

1. **先裁决口径**：`info.json.depth_level` 与 CATALOG §6.1 的 12/8，哪个是权威。二者必须有一个被另一方同步，不能继续并存。
2. **索引 8 条按裁决结果同步**（随下次重签），并把 `PLUGIN-MATURITY.md` 的「24/24 production」与 CATALOG/V1-GOALS 的 12/8 对齐（当前同一 docs 树内互相矛盾）。
3. **加一致性门禁**（择一）：`validate-index.sh` 增加可选 `--plugin-repos ../` 逐仓比对 `depth_level`；或在 `make check` 里加一段「索引 vs info.json」比对。这是唯一能防止再次漂移的手段。
4. **`presets-check.sh` 补 G-20**：索引 `depth_level=basic` 的成员所在预设 `out_of_box` 必须为 false（当前 `db-only` 会被它抓出）。
5. **`make dist` 可选加 `depth_level` 到 manifest 比对键**——注意 `manifest.json` 当前不含该字段，直接加会要求 24 仓同时改 manifest + bump，成本高，建议随下次发版滚动。
6. **P0 关单条件**：P0-1 待 app-deploy `artifact_test.go` 提交；P0-3 补 terminal 的 attach/history fault 用例（或经裁决把该证据标准改为"e2e 可覆盖"）。

---

## 9. 复跑命令

```bash
cd /home/pt/Work/GolandProjects
# 1) 24 行对照
for d in kore-plugin-*; do id=${d#kore-plugin-};
  echo -e "$id\t$(jq -r --arg i "$id" '.plugins[]|select(.id==$i)|.depth_level' kore-plugins/index/plugins.json)\t$(jq -r .depth_level $d/info.json)";
done
# 2) 索引 depth_level 值变更史（应为 0 次删除/替换）
git -C kore-plugins log -p -- index/plugins.json | grep -cE '^-[[:space:]]+"depth_level"'
# 3) 索引提交总数
git -C kore-plugins log --oneline -- index/plugins.json | wc -l
# 4) 8 仓提升提交
git -C kore-plugin-container log --oneline -S'"depth_level": "production"' -- info.json
# 5) 门禁缺口
grep -n "depth_level" kore-plugins/scripts/validate-index.sh kore/scripts/store-check.sh
grep -c "depth_level\|out_of_box" kore/scripts/presets-check.sh   # 期望 0
grep -o '"requires_kore","capabilities"' kore-plugin-*/Makefile | wc -l  # 24
# 6) 商店读索引的证据（既有实测）
sed -n '88,93p' kore/.agents/verify/main-restart-live.md
# 7) P0 现状
git -C kore-plugin-app-deploy ls-tree -r --name-only HEAD tests/fault
git -C kore-plugin-logs log --oneline -3 -- tests/fault
git -C kore-plugin-terminal grep -l "History\|Attach" HEAD -- tests/fault   # 期望无输出
git -C kore-plugin-ssh-guard show HEAD:info.json | jq -r .depth_level       # basic
```

---

## 10. 未确认项

| 项 | 缺什么证据 |
| --- | --- |
| 8 仓提升 production 是否经过产品侧批准 | 只看到仓库提交与 CHANGELOG，未见 `.agents/LOG/DECISIONS.md` 中的对应裁决条目 |
| `db-only.json` 的 `out_of_box=true` 是有意还是顺手 | 需预设作者确认；按当前索引语义它是 G-20 违规 |
| app-deploy 的 `artifact_test.go` 能否通过 | 未提交、未运行（本卡禁止跑测试），只做了静态阅读 |
| waf 的 `rule.add/remove/toggle` 是否有黑盒故障路径 | 只看到 method table 4 条（status/rules/logs/toggle），未逐文件读完 6 个用例 |
| 商店 UI 是否另有"验证件"展示分支 | 只核到 API 返回 `depth_level`，未核前端渲染分支 |

---

核查口径：只读；未改任何代码/索引/插件仓；未构建、未跑测试、未起服务；`tests/fault/` 统计均取 `git show HEAD:`，工作树未提交文件单独标注。
