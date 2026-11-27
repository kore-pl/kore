# DESIGN-AUDIT-DENY-OPT · 审计 deny 写放大优化方案（doc-first）

> 状态: 方案待审阅（doc-first，本轮只出方案、不写生产代码）｜里程碑: R35
> owner: audit-deny-opt-design（worker）｜日期: 2026-11-28｜持续目标 round 35｜task-263
> 证据基线: `.agents/verify/audit-deny-write-amplification-r35.md`（微基准）+ `.agents/verify/audit-amp-verification.md`（独立验收 PASS）
> 性质: 内核改动 + 审计语义变化；先方案供审阅，代码 / 门禁 / 发版属后续分期，不在本卡写域内。

## 0. 结论先行（本方案回答什么）

微基准与独立验收已坐实：真 `capability.denied` 路径存在**线性审计写放大（1 条审计/拒绝）**，并发 16 拒绝 `p95=158ms` **击穿 API `p95 ≤ 50ms` 硬红线**（`V1-GOALS.md:45` / `PLAN.md:245` / `ROADMAP.md:142`），且是**认证后低权 DoS 向量**（非匿名）。触发器在 `withAuth` 之后，匿名 401 短路不写审计。

本方案结论：**选「deny 突发合并（候选①）+ alert 内存聚合（候选②）+ audit 按量上限（候选④）」三项组合；否决「audit 异步队列 + batch flush（候选③）」**。理由：审计不可丢不可伪造是合规底线，异步队列会引入「进程崩溃窗口内审计丢失」与 bbolt `Batch` 破 G-19 的双重风险；而①②直接在同步写路径上把「N 次写事务」压成「≤阈值+1 条」，既破 1:1 写放大、又不放松 fail-closed，且与内核既有的 `invoke.burst` 合并范式同构。④是磁盘兜底，不参与延迟优化，但必须随①②一起落地以防高频拒绝短期堆盘。

`detail` 里以**纯增字段**承载合并元数据（`count` / `window_ms` 等），因此**纯后端可解、前端零改动、不触发 G-28 双端截图义务**（见 §3）。

---

## 1. 根因与约束

### 1.1 写链路与修复锚点（file:line 均按当前源码逐字回读）

| 锚点 | 代码事实 | 在写放大中的角色 |
| --- | --- | --- |
| `internal/core/httpapi/middleware.go:274-282` `auditDenied` | `capAuditor(...)` + `noteDeniedAlert(...)` **每次拒绝无条件直调**，无突发合并（合并只覆盖 `recordInvokeAudit`） | deny 出口：一次拒绝同时触发审计写 + 告警写 |
| `cmd/kored/serve_audit.go:71-83` `capabilityAuditorFromStore.Audit` | 每次构造 `AuditRecord{Action:"capability.denied", Result:"denied", Capability, Detail:{reason}}` → `db.PutAudit` | 把 deny 出口接到 store 的唯一装配点（合并状态宜落在此适配器层，见 §2.1） |
| `internal/core/store/audit.go:52-79` `PutAudit` | `s.Update`（bbolt 写事务）单条 put；`NoSync:false` 提交即 fsync；注释明示**不用 bbolt Batch**（破 G-19） | 审计写事务本体，1 次/拒绝，fsync 是单次 ~数 ms 主因 |
| `internal/core/httpapi/alerts.go:78-95,106-118` `recordAlert` / `noteDeniedAlert` | `noteDeniedAlert` 每次拒绝构造 detail（含 subject/plugin/target/reason）→ `recordAlert` → `PutAlert`，并 `dispatchAlert` 通知通道 | 告警写入口，1 次/拒绝 |
| `internal/core/store/alerts.go:85-107,109-141` `PutAlert` / `mergeAlert` | 写事务内 `mergeAlert`：同 `title+source` 5 分钟窗口 **delete+rewrite + count++** | **只减记录数、不减写事务**——告警库恒 1 条，但每次仍一次读改写 + fsync |
| `internal/core/config/types.go:218-226` + `internal/core/scheduler/auditclean.go:137-170` | `audit.retention=90d` / `clean_enabled=true` / `clean_interval=6h` / `clean_batch=1000`，按龄按批清理**已实现** | 清理是「按龄、按批」，无速率/容量上限，高频拒绝短期堆盘（5s 629 条远快于 6h/批） |
| `internal/core/httpapi/audit_http.go:128-212` `recordInvokeAudit` / `bumpInvokeBurst` | 同一方法 1s 超 10 次 → 前 10 逐条、第 11 条 `invoke.burst`（count/window_ms 入 detail），纯内存 `sync.Mutex` + 惰性 sweep，**零 goroutine/ticker** | 本方案要复用的「代码原生合并范式」 |

### 1.2 延迟归因：Little 定律写锁排队

bbolt 全局单写事务串行。`L = λW`：拒绝吞吐 λ 在并发 1/4/16 下几乎恒定（105→112→124 req/s，波动 <20%），并发（在途请求 L）随档位升到 1/4/16，则单请求等待 `W ∝ 并发度`——与实测 p50 `9.82→33.37→145.88ms`、p95 `14→44→158ms` 完全吻合（verifier 独立复算 L≈0.97/3.73/15.93）。**这是写锁排队判据，不是 CPU 计算瓶颈**：加并发不涨吞吐只排队。故优化目标是「减少写事务次数 / 缩短写锁持有」，不是调 GC 或加 CPU。依 G-22，先在**设计层**改触发方式（合并），不在代码层调参。

### 1.3 约束（不可协商）

1. **审计不可丢、不可伪造是合规底线**：每条 deny 仍须可回答「谁 / 何时 / 什么能力 / 被拒」（§4 安全不变量）；任何优化不得让攻击者绕过审计或让证据链条断裂。
2. **合并不能掩盖攻击**：必须有窗口长度上限 + burst 阈值后转逐条写；不得无限聚合把高频攻击压成一条看不见的计数。
3. **`detail` 受控校验不放松**：`store.validateAudit`（`audit.go:81-110`）键 ≤16 / 键 ≤32 字符 / 值 ≤256 字符 / 序列化 ≤1 KiB；合并元数据以标量字符串入 detail，仍过原有校验（`audit.go:52-79` 不改校验逻辑）。
4. **禁用 bbolt `Batch`**：`DATA-MODEL.md:218` 与 `store/audit.go:55-58` 明确禁止（bbolt 内部起 `time.AfterFunc` + goroutine，破 G-19、破「审计写入不起 goroutine/ticker」）。所有候选不得复活被作废的「≤200 条/100ms 合批 flush」口径。
5. **零侵入 / G-10 / G-01**：不新增安装目录外写入、不联网、不出站、不引入常驻组件；`internal/core` 只比较能力字符串、不维护业务域名词表。

---

## 2. 优化候选逐条评估（可行性 / 收益 / 风险 / 取舍）

### 候选① deny 突发合并（同 subject/IP/能力 短窗口 N 次合并为 1 条带 count 字段）—— **采纳（核心）**

- **可行性**：高。复刻 `invoke.burst` 范式（`audit_http.go:180-212`）：以「subject + plugin + capability + reason」为键（key 里只放**已有审计字段**，不新增业务词表），纯内存 `burstMu + map + 惰性 sweep`，零 goroutine。合并状态宜放在 `capabilityAuditorFromStore`（`serve_audit.go:64-83`）这一装配层适配器内，使 `httpapi.auditDenied` 与 `store` 都不感知合并细节（保持 G-01 薄壳）。**注意 IP**：`auditDenied` 出口当前未携带客户端 IP（detail 里没有 ip 字段），故窗口键**不含 IP**，只用 subject/plugin/capability/reason；理由见 §3。
- **收益**：直接把「N 次 `PutAudit` fsync 写事务」压成「阈值 T 条逐条 + 1 条合并」，并发 16 下写事务数从 ~300 降到 ≤T+1，写锁排队长度骤降，p95 有望回落到红线内。1:1 写放大被打破。
- **风险**：合并后单条记录代表多次拒绝，需保守的窗口/阈值参数与可追溯字段（§4 证明）；窗口状态纯内存，进程重启即重置——这是可接受的（重启后重新逐条审计，不会丢已落库的合并记录）。
- **参数（建议初值，实现期据复验微调）**：窗口 `1s`（与 `invoke.burst` 同）、阈值 `T=10`；第 T+1 次写一条 `capability.denied` 合并记录（`detail.count` 累计、《窗口》）并抑制本窗口后续逐条写。

### 候选② alert 内存聚合后再落库（替代每次 `PutAlert` 读改写事务）—— **采纳**

- **可行性**：高。`noteDeniedAlert`（`alerts.go:108-118`）每次拒绝都构造 detail 并调 `recordAlert`→`PutAlert`（写事务 + fsync），而 `mergeAlert`（`store/alerts.go:109-141`）只做记录数合并、事务不省。在 `noteDeniedAlert` 与 `recordAlert` 之间加一层**与候选①同源的 deny 突发窗口**：窗口内只在「窗口触发点」调用一次 `PutAlert`，携带聚合后的次数（告警 `count` 语义已存在）；`dispatchAlert` 通知通道也只在触发点派发一次（避免通知风暴）。可与候选①共用同一突发状态（同为 deny 出口、同一窗口键），一次判断同时决定「审计写不写」与「告警写不写」。
- **收益**：消除「每拒绝一次 delete+rewrite 写事务 + fsync」，与①叠加后从「2 写事务/拒绝」降到「窗口内 0 或 1 组」。告警记录数本就不涨，合并语义与现有 `mergeAlert` 5 分钟窗口并存不冲突（内层一个 deny 窗口聚合，外层 `mergeAlert` 仍按 title+source 收敛）。
- **风险**：告警「最新一次」detail 可能被窗口内后续拒绝覆盖——与现有 `mergeAlert` 行为一致（detail 取最新），不引入新语义；通知延迟 ≤窗口长度（1s），对「能力校验被拒绝」这类 critical 告警可接受，且失败仍记 WARN。

### 候选③ audit 异步队列 + batch flush —— **否决**

- **可行性**：低/中。需在内存中缓冲审计事件并异步批量落库。
- **风险（否决主因）**：①**审计不可丢底线破口**——进程被 SIGKILL / 崩溃 / 断电时，队列中的审计事件全部丢失，与「审计不可丢、fail-closed」直接冲突；② bbolt `Batch` 内部起 `time.AfterFunc` + goroutine（`DATA-MODEL.md:218` / `store/audit.go:55-58`），破 G-19「零 goroutine/ticker」与「审计写入不起 goroutine」硬约束；③引入队列就有容量上限与丢弃策略，等于给攻击者「撑爆队列 → 审计丢」的新绕过面；④与零侵入/单 ticker 架构相悖。**结论：不采纳，且明确不复活已作废的合批口径。**

### 候选④ audit 按量上限（配合已实现的按龄清理）—— **采纳（磁盘兜底，非延迟优化）**

- **可行性**：高。现有清理只按龄按批（`audit.retention=90d` / `clean_interval=6h` / `clean_batch=1000`，`config/types.go:218-226` + `auditclean.go:137-170`），高频拒绝短期可堆盘。增加一个**按量上限**：当 audit bucket 记录数超过配置阈值（如 `audit.max_records`，建议初值 100000，落在 DATA-MODEL §406「审计 <100 万」舒适区内）时，由清理任务优先删除最旧记录直到回到阈值以内（复用既有 `CleanAudit` + 单 ticker，不新增定时器）。合并（①②）大幅降低增长速率，④负责封顶，二者互补。
- **收益**：把「审计库单调增长」变成「高水位封顶」，消除高频拒绝的磁盘 DoS 维度。
- **风险**：按量删除会提前删除未到期的审计记录——需在 `AuditCleanReport` 里记录删除原因（按龄 vs 按量）并写 `audit.clean` 审计，让「因容量删了什么」可追溯；阈值必须足够大，正常运维不触发。属**配置新增**，须同步 `DATA-MODEL.md` §配置表 + `CORE.md` + `SECURITY.md`（G-06）。
- **取舍**：④不参与 p95 延迟优化（清理走后台 ticker），但必须与①②同期落地，否则「合并降低了但仍非零增长 + 无速率上限」的磁盘维度仍留缺口。若发版窗口紧张，④可拆到紧随其后的补丁，但需在方案里明确它是**必做项**而非可选项。

### 取舍汇总

| 候选 | 决策 | 主因 |
| --- | --- | --- |
| ① deny 突发合并 | **采纳** | 直击 1:1 写放大与写锁排队，复用代码原生范式，不破不可丢底线 |
| ② alert 内存聚合 | **采纳** | 消除每拒绝一次读改写事务/通知风暴，与①同源同窗一次判断 |
| ③ audit 异步队列 + batch flush | **否决** | 审计丢失破口 + bbolt Batch 破 G-19 + 新绕过面 |
| ④ audit 按量上限 | **采纳（兜底）** | 补按龄清理无速率上限的磁盘维度，复用单 ticker |

---

## 3. 数据结构 / API 涟漪

### 3.1 审计记录字段：不新增顶层字段，合并元数据入 `detail`

- **决定**：`AuditRecord`（`store/audit.go:41-50`）**不新增顶层字段**（不加 `count` / `window` 顶层列）。合并信息全部以**受控字符串键**进现有 `detail map[string]string`：`reason`（保留原拒绝原因）、`count`（窗口内累计拒绝次数）、`window_ms`（窗口长度）、`first_at` / `last_at`（窗口起止，RFC3339Nano 字符串，增强可追溯，可选）。这与 `invoke.burst` 的 `detail={method,count,window_ms}` 完全同构，且 `detail` 已是 DATA-MODEL §9 受控字段。
- **为什么不加顶层字段**：加顶层字段要改 `AuditRecord` 结构体、`json.Marshal/Unmarshal` 契约、`DATA-MODEL.md` §9 字段表、CLI CSV 列（`kored audit --csv` 现 8 列）、查询导出与前端列——涟漪大且对「合并语义」没有必要（它就是 detail 级的附加信息）。入 detail 则向后兼容：旧记录无这些键、前端 `detailText` 通用摊平即可显示、CSV 的 detail 列自然包含。
- **DATA-MODEL 契约同步（G-06）**：在 `DATA-MODEL.md` §9 审计动作表为 `capability.denied` 增加说明——「同一 subject+plugin+capability+reason 1s 窗口超 10 次时，前 10 条逐条、第 11 条起合并为 detail 带 count/window_ms 的 denied 记录，抑制本窗口后续逐条；`count` 是该合并记录代表的实际拒绝次数」。§9.1 字段表补 detail 可选键说明。**不升 schema 版本**（`store.go:27 SchemaVersion=1`）：纯加法、旧记录兼容、无迁移。
- **查询/导出语义**：`total` 是「筛选后、分页前**记录条数**」；合并后「记录条数 < 实际拒绝次数」是预期语义变化，需在 `DATA-MODEL.md` §9 查询口径补一句「`capability.denied` 合并记录的 `detail.count` 才是实际拒绝次数，`total` 计的是记录条数」。CLI `kored audit --csv` 的 detail 列会自然包含 count/window_ms（8 列结构不变）。**不新增查询参数**（subject/action/plugin 过滤已够，merge 记录仍带原字段）。

### 3.2 前端审计页：不需要改动 → 不触发 G-28

- 事实：`web/audit.js` 用 `detailMap` / `detailText`（`web/audit.js:60,99,123`）把 detail 数组通用摊平成「键：值」多行，CSV 导出也走同一 `detailText`（`:98`）。合并记录仍带 `action=capability.denied`、`result=denied`、`detail.reason/count/window_ms`，**现有前端自动可读、无需改一行代码**。
- `action` 不新增值（沿用 `capability.denied`，不另造 `capability.denied.burst`），避免前端动作下拉/facet 与新值同步（`web/audit.js:300` 的 action 选项来自 `facets.actions` 动态派生，虽能自动出，但保持动作名稳定更省涟漪）。
- **结论**：纯后端可解，前端零改动、零截图义务；**G-28 不触发**。若后续产品侧要求「合并次数」在列表列显式高亮展示（而非藏在详情里），那属于新的 UI 需求，届时另行按 G-28 出双端截图——本方案不把它列为当前范围。

### 3.3 API 端点与版本契约

- **不新增 HTTP 端点**：无新路由（`/api/v1/audit` 等不变），内核端点计数仍 73（`AGENTS.md` §6 / `CORE.md` §2.4）。
- **不新增配置端点**：④的 `audit.max_records` 走既有配置加载路径（冷加载，重启生效，与其余 `audit.*` 一致），`SIGHUP` 报 ignored。
- **`requires_kore` 上界不受影响**：见 §5.1。

---

## 4. 安全不变量证明

对每条被拒请求，优化后仍满足以下不变量（逐条给出机制与证据锚点）：

**I1 — 每条 deny 可追溯（谁 / 何时 / 什么能力 / 被拒）。** 逐条审计的 T 条保留完整 `subject` / `action=capability.denied` / `plugin` / `result=denied` / `capability` / `detail.reason`；合并记录同样带这些字段（值取窗口内首次/代表事件），时间由 bbolt 键 `%020d-%06d` 承载（`store/audit.go:52-58,112-128`），`detail.first_at/last_at` 补窗口起止。故任一被拒请求要么落在逐条记录里，要么落在其所属合并记录里并可定位到毫秒级窗口——**不丢「谁/何时/什么能力/被拒」四要素**。

**I2 — 合并不掩盖攻击（窗口上限 + burst 阈值后转逐条）。** 窗口固定 `1s`（上限，不可配到无限；实现期不得开放超长窗口配置）；阈值 `T=10`：前 T 次逐条、第 T+1 条合并并写 count。**关键**：当某窗口拒绝数超过「单窗口可聚合上限」（建议 `MAX_MERGE=N`，如 1000）时，**转为逐条写**——即 burst 不是无限吸收器，攻击者持续高频拒绝时，超出上限的部分仍逐条落库，审计量随攻击强度上升（可观测、不可隐藏）。这保证「合并只压突发毛刺，不吞持续攻击」。

**I3 — 不绕过审计。** `auditDenied`（`middleware.go:274-282`）是唯一 deny 出口，①在 `capabilityAuditorFromStore`（`serve_audit.go:64-83`）内部做合并，**出口个数与调用点不变**，攻击者无法通过任何路径绕过——合并状态是内部实现细节，不改变「拒绝必走 auditDenied」的不变量。②的告警合并同理，不改 `noteDeniedAlert` 的调用点。

**I4 — 不引入新绕过面。** 合并状态是进程内 `sync.Mutex + map`（`invoke.burst` 范式），无外部输入可控的键长度爆炸（subject/plugin/capability/reason 都有既有上限；reason 来自固定文案或受控能力名），惰性 sweep 防内存膨胀。④按量清理的阈值远大于正常量，且删除写 `audit.clean` 审计可追溯；不存在「攻击者触发清理 → 删掉自己攻击证据」的窗口（清理只删**最旧**记录、按保留期优先，攻击当下的新记录在窗口内不会被删）。

**I5 — 不违 G-10 / G-01 / 零侵入。** ①②纯内存 + 同步写路径，无联网、无出站、无遥测、无常驻组件（G-10）；不 import 插件、不维护业务域名词表（burst 键只用已有审计标量字段，G-01）；无安装目录外写入、无新用户/unit、无宿主变更（G-31 零侵入）；审计写仍走 `Store.Update` 同步提交、**不引入 bbolt Batch / goroutine / ticker**（G-19 / `DATA-MODEL.md:218`）。

**I6 — fail-closed 不变。** 鉴权判定在 `withAuth` / `hasCapability` 之前已完成，失败即 401 + 写审计；合并只影响「写几条」，不影响「拒绝这个决定」。审计写失败仍 `slog.Warn` 留痕（`serve_audit.go:80-82`），不因合并而静默放行（登录/提权等 fail-closed 出口本就不走此合并路径）。

---

## 5. 门禁涟漪

### 5.1 版本 bump 判定：perf → patch，**0.1.2 → 0.1.3**

- 按 `RELEASE.md` 与 `version-sync` 口径：perf 优化 → **patch**。当前 `Makefile:29 VERSION ?= 0.1.2`、`cmd/kored/main.go:17 version="0.1.2"`、`docs/CORE.md` 版本基线同步 bump 到 **0.1.3**。
- **约束核对**：24 个插件仓 `info.json.requires_kore` 上界一律 `<0.2.0`（抽查 echo/file 均 `>=0.1.0 <0.2.0`），`0.1.3 < 0.2.0`，不触上界阻断；`make version-check` 应继续全绿。与 0.1.2「feat 压成 patch」的例外不同，本次**本就是 perf**，patch 是 semver 正解，无张力。
- **注意**：本次协议仍是 `kore.plugin.v1`（无新 RPC / 无破坏性改动），不需要 ADR 升主版本；`pkg/pluginapi` 版本不动。

### 5.2 CHANGELOG 如实记

- 在 `CHANGELOG.md` 新增 `## [0.1.3] - <发布日>` 段，under `### Performance` 如实写：「优化 `capability.denied` 审计/告警写放大：同 subject+plugin+capability+reason 的 1s 突发窗口合并审计与告警落库，打破 1:1 审计写放大；并发 16 拒绝 p95 从 158ms 回落到 ≤50ms 红线内；审计记录 detail 增 count/window_ms（纯加法、旧记录兼容）」。不得隐去「击穿红线」这一修复动机，也不得夸大为「超越竞品」。

### 5.3 文档同步（G-06，同一检查点）

| 文档 | 同步内容 |
| --- | --- |
| `docs/DATA-MODEL.md` | §9 审计动作表 / 字段表 / 查询口径补合并语义（§3.1）；§配置表补 `audit.max_records`（④）；§11 清理补按量维度 |
| `docs/CORE.md` | 版本基线 0.1.2→0.1.3；审计模块段补「deny 突发合并」说明（不新增端点） |
| `docs/SECURITY.md` | 审计完整性段补「合并不掩盖攻击」不变量（窗口上限 + MAX_MERGE 后转逐条 + count 守恒），说明认证后低权 DoS 的缓解 |
| `docs/PLAN.md` / `docs/ROADMAP.md` / `docs/V1-GOALS.md` | 红线数字不变（仅引用，不改判据）；如有「审计写放大遗留项」表述则标注已解决 |

### 5.4 验证门禁（实现期执行，本方案卡不跑）

- `go test -timeout 200s ./...` + 嵌套 module `pkg/pluginapi`（`make test`）全绿；新增断言见 §6.3。
- `go vet ./...`（`make vet`）零错误；`make race-full`（第 19 段）+ `make pluginapi-race`（第 21 段）零 `DATA RACE`（合并状态有锁，重点断言）。
- `make docs-check` exit 0（既有行数 WARN 如实标注，不新增 FAIL）；`make secret-check` 0 FAIL；`make check` 聚合门禁全绿（尤其 G-14 version-check、G-06 文档同步、G-19 零 goroutine/ticker）。
- `make cross-build`（G-16 五目标真编译）通过——合并不引入平台专有 API。

### 5.5 G-23 留痕

- 本次「多选一」决定（采纳①②④ / 否决③；加 detail 不加顶层字段；窗口 1s/阈值 10/MAX_MERGE 转逐条；版本 patch 0.1.3）写入 `.agents/LOG/DECISIONS.md`，含被否决选项与依据。
- 派发信息（task / owner / 写域 / 依赖 / 交付 / commit）写入 `.agents/LOG/DISPATCH.md`。
- 本方案文档本身即 doc-first 留痕，审阅通过后按分期派实现 / verifier 卡。

---

## 6. 分期与判据

### 6.1 分期

| 期 | 范围 | 写域 | 通过判据 |
| --- | --- | --- | --- |
| P0（本卡） | 方案文档 | `docs/DESIGN-AUDIT-DENY-OPT.md` | docs-check exit 0 + diff --check 净 + 覆盖①-⑥ + commit |
| P1（实现） | ①deny 突发合并（审计适配器）+ ②alert 同源聚合 + ④按量上限（清理任务） | `cmd/kored/serve_audit.go`、`internal/core/httpapi/alerts.go`、`internal/core/store/audit.go`、`internal/core/config/types.go`、`internal/core/scheduler/auditclean.go` + 相关 `_test.go` | §5.4 门禁全绿；单测断言：窗口内 N 次拒绝 → 逐条 T + 1 合并记录、`detail.count` 守恒、`detail.reason` 保留、超 MAX_MERGE 转逐条；`-race` 零竞争 |
| P2（门禁/文档） | CHANGELOG + CORE/DATA-MODEL/SECURITY 同步 + 版本 bump + G-23 留痕 | `CHANGELOG.md`、`Makefile`、`cmd/kored/main.go`、`docs/*`、`.agents/LOG/*` | 版本 0.1.3 落在 24 仓 requires_kore 区间；`make check` / docs-check / secret-check 全绿 |
| P3（真机复验） | 独立 verifier 重跑 audit-amp 微基准 | 隔离实例（如 `.tmp/audit-amp-opt/`），不碰 8787 / `.kore-local-*` | §6.3 判据全达；验收报告 PASS；清理隔离树 |

> P1 写域为多个文件但属**同一写域**（公共审计出口/合并状态的涟漪穿过多文件），按 AGENTS §4「同 module 内公共接口/测试替身涟漪视为同一写域」**单卡串行派发、不并行**。

### 6.2 真机复验方案（P3）

复用 `audit-amp-r35.md` 的隔离实例方法：仓库自带 `bin/kored` 逐字节副本（或 P2 新构建产物），独立 config/state/run/log 落隔离目录、独立端口（非 8787）、read 范围 token 调 `GET /api/v1/credentials` 触发真 `capability.denied`，同一 token 调 `GET /api/v1/system/info` 作成功对照。并发 1/4/16、N=300 + 5s 稳态两口径，前后读 `GET /api/v1/audit?action=capability.denied` 的 `total` 与告警 `count`。verifier 独立于 implementer（G-09）。

### 6.3 真机判据（硬指标，全部满足才 PASS）

1. **红线**：并发 16 拒绝 `p95 ≤ 50ms`（当前 158ms）；并发 4 不应临界（当前 44ms）；成功路径 p95 不劣化（保持 ~3.85ms 量级）。
2. **1:1 写放大被打破**：同样 N=300 次拒绝，审计**记录数增长 < N**（合并生效）；实现期以单测精确断言 count 守恒，真机以 `audit Δ < N` 佐证。
3. **吞吐改善**：拒绝吞吐不再封顶于 ~100–124 req/s 的单一写入者上限，较基线有**倍数改善**（目标 ≥2×）；加并发不再「只排队不涨吞吐」。
4. **审计不丢（count 守恒）**：`Σ(逐条记录数 + 合并记录 detail.count)` == 实际拒绝次数（N），既不丢也不重复；`detail.reason` 非空、可定位拒绝原因；窗口起止可追溯。
5. **告警侧**：告警记录数仍收敛（恒 1 或按既有 5 分钟窗口），`PutAlert` 调用次数随合并下降（以单测计数断言为主），通知通道无风暴。
6. **隔离与合规**：隔离实例不碰 8787 / `.kore-local-*`，临时资源用后删净；零明文凭据入库（`make secret-check` 0 FAIL）；未 push。

---

## 7. 诚实边界与未覆盖

- 本卡是 **doc-first 方案**，只产出文档；P1–P3 的实现、门禁与真机复验不在本卡写域，也未执行——不得据此声称「已修复 / 已达标」。
- 微基准只测了「read token → 凭据端点」一个 deny 出口；其他出口（`token_ip_denied` / invoke 能力不足 / `root.action` 拒绝）共用同一 `auditDenied` sink，方案按 sink 统一设计，但**未逐一实测**，P3 复验应至少补一例交叉验证。
- 单机单实例 bbolt，无竞品同口径对照；本方案目标是回到自身 `p95 ≤ 50ms` 红线，**不构成超越竞品证据**。
- 参数（窗口 1s / 阈值 10 / MAX_MERGE / max_records）是建议初值，须在 P3 真机复验中按判据微调；调整只改常量 / 冷配置，不改方案结构。
- `root.action` 提权审计是 fail-closed 出口（写审计失败则拒绝执行），**不纳入本 deny 合并路径**——避免把 fail-closed 语义卷入窗口合并；其性能另案评估。
