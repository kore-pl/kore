# deny-burst-fix-verification · deny 合并跨 key 轮换修复独立验收（task-308）

> verifier: deny-burst-fix-verifier（G-09，独立于 audit-deny-redteam 与 deny-burst-fix）｜日期 2026-11-28 ~11:30 +08:00
> 被测：`04fffc6a5c0333c68b68edf5dcee9b1ae1116735`（`[agent:deny-burst-fix] perf/httpapi: 修 deny 突发合并跨 key 轮换 p95 红线回弹（全局逐条写预算）`）
> 性质：只读复核 + 隔离实例独立复跑；不改生产代码、不 push、不联网业务、不启主流程 CLI、不碰 `.kore-local-*`。
> 唯一写入＝本报告（精确 `git add` + `commit -s`）。

---

## 0. 总评：**PASS**

| 维度 | 结论 | 关键证据 |
| --- | --- | --- |
| ① 读码核修法 | ✅ 成立 | 全局 1s 预算 `DenyGlobalIndividualBudget=DenyBurstThreshold=10`、预算耗尽走 pending、`MAX_MERGE` 触发点补合并记录；双出口守恒在代码与单测/真机皆成立；通知/fail-closed/G-19/G-01/零新依赖全部守住 |
| ② p95 独立复跑 | ✅ 达标 | 4-key 轮换 c16/N=300 连续 5 次 p95 **12.63 / 24.24 / 35.15 / 25.41 / 22.62 ms，5/5 ≤50ms**；单 key 22.79ms 不回归；双出口守恒 **1804 = 1804 = 1804** 精确 |
| ③ 3 个 make check FAIL 归因 | ✅ 全部成立 | a) secret-check FAIL = 5664049 文档中的反例探针，非真凭据、与 04fffc6 无关；b) 20/21 A1 waf = 他人在途 untracked + 只读 GOCACHE 环境噪声；c) G-33 = 他人 dirty 存量台账——三个均非本改动引入 |
| ④ 版本/CHANGELOG | ✅ 如实 | 0.1.3→0.1.4 perf patch，<0.2.0 上界；`make version-check` 24 仓全绿；CHANGELOG 明确 p95 回弹修复动机、不夸大竞品 |
| ⑤ git 边界 | ✅ 合规 | 精确 8 文件 + DCO、未 push（origin 落后 3）、他人 dirty 原样、临时 harness 删净 |

---

## 1. ① 读码核修法（deny_burst.go）

**改动锚点**（`git show --format='' 04fffc6 -- internal/core/httpapi/deny_burst.go`）：

- 新增常量 `DenyGlobalIndividualBudget = DenyBurstThreshold`（:20-28，值 10）。
- `DenyBurstTracker` 增 `globalWindowStart/globalIndividuals` 两字段（:101-105），随 1s 全局窗口滚动重置（:140-143）。
- `Submit` switch 第一分支加 `&& t.globalIndividuals < DenyGlobalIndividualBudget`（:150）与 `t.globalIndividuals++`（:153）：全局逐条写次数受预算约束。
- 新增第二分支（:162-171）：预算耗尽后的早期拒绝 `st.pending++` 不逐条写审计；首拒仍 `DenyBurstAlertOnly AlertN=1`（保持「拒绝即告警」语义），其余 `st.alertPending++`。
- 触发点（:172-181）：合并记录 `Count = st.pending + 1` 并清零 pending，确保此前因预算转 pending 的早期拒绝全部被合并记录覆盖，**守恒不破**。

**守恒证明**：

- 审计侧：逐条分支每次 `Count=1`；预算耗尽分支早期拒绝 `pending++` 无审计写出，触发点 `mergedCount=st.pending+1` 一次补齐；窗口滚动 / 每 256 次 sweep / `MAX_MERGE` 触发点 `flushDenyBurst(st)` 补余量。Σ(逐条+合并 count) = 提交数。
- 告警侧：每个分支的 `AlertN`（首拒立即 1 + 触发点 `alertPending+1` + 逐条/默认分支 1 + flush 余量）累加等于提交数。`materialize`（:195-216）把 decision 翻译成 `DenyAlertWrite{N}`，`emitDeniedAlert`（alerts.go）一次 `PutAlertCounted(n)` 落库 + 一次派发。
- 真机复跑（§2）审计 Σ 与告警 Σ 各 1804 = 发出 deny 1804，精确守恒。

**通知语义**：首拒 `st.count==1` 无论走逐条还是预算耗尽分支，都写 `AlertN=1`，「拒绝即告警」不破坏。

**fail-closed**：`root.action` 走独立 `rootActionAuditor`（`middleware.go:277-282` 注释 + 单测 `TestRootActionAuditNotMerged`），本改动未触碰；deny 唯一汇聚点 `auditDenied` 仍是一次 Submit 产两出口计划，出口个数/调用点不变。

**G-19 零新 ticker/goroutine**：`git show 04fffc6 | grep -E '^\+.*(go func|NewTicker|AfterFunc|time\.After)'` → **零命中**。`deny_burst.go` 的 `go func` 零命中（测试里 `go func` 位于父提交 `:182`，非新增）。仅 `sync.Mutex + map + 惰性 sweep`，零后台计时器。

**G-01 薄壳**：`grep 'plugins/' internal/core/httpapi/deny_burst.go` → 零命中；key 只用既有审计标量字段，无业务域名词表。

**零新依赖**：`git diff 04fffc6^ 04fffc6 --name-only | grep 'go\.(mod|sum)'` → 零命中。

**单测覆盖（独立复跑）**：`GOCACHE=<工作区> GOMODCACHE=<已缓存> GOWORK=off GOPROXY=off go test -count=1 -timeout 200s ./internal/core/httpapi/... ./internal/core/store/...` → **exit 0**（httpapi ok 6.980s / store ok 1.233s）。新增 `TestDenyBurstGlobalBudgetConservation`（4 key×176 次 + 4 次滚窗，逐条写 ≤10、双出口守恒 708）、`TestDenyBurstDifferentKeysIsolated`（改为预算耗尽口径、守恒 22=22）绿。

---

## 2. ② p95 独立复跑（隔离 kored，非 8787）

**被测二进制**：当前 HEAD 源码现场编译 `.tmp/deny-burst-fix-verify/kored-live`，`kored version` → `0.1.4 / 协议 kore.plugin.v1`，sha256 `3de48562…baa648` ≠ 宿主 `bin/kored` `870b54f6…b65261`（0.1.3，8787 在用，未覆盖）。

**隔离边界**：独立 config/state/run/log/index 全在 `kore/.tmp/deny-burst-fix-verify/`；TCP `127.0.0.1:55211` + 独立 UDS；`KORE_CONFIG`/`KORE_STATE_DIR`/`KORE_HOME` 全指隔离路径；空 index_dir。测试前后 8787 healthz 均 200、无 kored 残留、55211 FREE、未碰 `.kore-local-*`、未联网、口令与 token 明文只在内存（落盘只留 token id sha 前缀 `bc38c2`）。

**真拒绝构造**（非替代路径）：首启随机口令（0600 凭据文件）→ `login=200` + CSRF → 建 read token `token_create=200` → 同 token `GET /api/v1/credentials` → **401「越权：凭据管理需要 system:admin 能力」**；同 token `GET /api/v1/system/info` → 200。与红队 task-306 / round35 完全同口径。

**轮转 4 端点**（同单 read token）：`/api/v1/credentials`、`/api/v1/scheduler/tasks`、`/api/v1/scheduler/tasks/nonexistent/runs`、`/api/v1/migrate/export`；c16、每轮 N=300、Python `http.client`+`ThreadPoolExecutor`、每请求新建 TCP（GIL 保守口径，与基线一致）、轮次间隔 1.2s 让窗口滚转。分位数 nearest-rank。

### 2.1 p95 结果（连续 5 次）

| trial | **p95** | p99 | HTTP |
| ---: | ---: | ---: | --- |
| 1 | **12.63** | 93.07 | 401×300 |
| 2 | **24.24** | 235.11 | 401×300 |
| 3 | **35.15** | 242.77 | 401×300 |
| 4 | **25.41** | 173.17 | 401×300 |
| 5 | **22.62** | 172.51 | 401×300 |

（以上 p95/p99 为最终一次自洽复跑 `results.json` 实读值；每轮 300 次请求全部 HTTP 401，无 5xx。）

**5/5 p95 ∈ [12.63, 35.15] ms，全部 ≤50ms 红线**（修复前红队基线 79.7–105ms、10/10 越线）。单次 p99 达 93–243ms 尾部尖峰如实标注——与 round35 P3 验收同现象（16 线程冲击单 bbolt 写者的排队长尾），**本卡判据按任务卡为 p95，不宣称 p99 达标**。第一次试跑（未补 flush 触发、守恒读数不完整）的 p95 亦为 8.28–41.26ms 全 ≤50ms，两轮 p95 结论一致；其逐条 p50/max/req/s 未逐项归档，故只列已实读核定的 p95/p99。

### 2.2 单 key 不回归

单 key（credentials）c16/N=300：**p95=22.79ms**（HTTP 401×300），与 round35 单 key 19–41ms 基线一致，未被全局预算拖慢。

### 2.3 双出口守恒真机复算

窗口 pending 在内存、须请求驱动的滚窗触发落库（与 round35/46 口径一致）：5 轮 + 1 单 key = 1800 次 deny，滚窗后对 4 端点各补 1 次 flush 触发 deny（共 +4），合计发出 1804。

| 出口 | 前值 | 后值 | Δ | 期望 |
| --- | ---: | ---: | ---: | ---: |
| 审计 Σ(逐条+合并 detail.count) | 1 | 1805 | **1804** | 1804 ✅ |
| 告警 `count_sum`（title=能力校验被拒绝）| 1 | 1805 | **1804** | 1804 ✅ |

**审计 1804 == 告警 1804 == 发出 deny 1804**，精确守恒，零丢零重复。审计 rows 从 1→106（合并生效、远非 1:1）；告警 rows 恒 1（store 按 title+source 5min 窗归并），通知语义不变。

> 诚实边界：第一次试跑因未补齐 flush 触发，读数 1511/1800，复算发现是**测量时点问题**（pending 尚在内存未落库，且未计入 4 次 flush 触发 deny），补上滚窗触发并修正分母后同法复跑得 1804 精确守恒；该过程如实披露，不掩盖。

---

## 3. ③ 3 个 make check FAIL 归因独立核实

### a) 12/21 secret-check FAIL — `.agents/verify/clean-clone-gate-fix-verification.md:45` ADMIN_PASSWORD

`bash scripts/secret-check.sh` → exit 1，原文：
```
[FAIL] .agents/verify/clean-clone-gate-fix-verification.md:45 ADMIN_PASSWORD 疑似明文凭据（值已隐藏）
[WARN] .agents/verify/backup-download-verification.md:125 ADMIN_PASSWORD grep 正则模式片段（非凭据）
secret-check: 1 FAIL / 29 处匹配
```

**判定：非真凭据；真无关（相对 04fffc6）；但属需另派修复的既存文档缺陷（非本次改动引入）。**

- 该行是 round43 独立验收报告记录的**反向测试探针**：`ADMIN_PASSWORD=***` 是「真实赋值必须 FAIL」的示例字面量（原探针哑值已脱敏为占位，非本机口令），同段还有同类哑值。文档原文明确写「全部 rc=1 FAIL…豁免不泛化，真实凭据零漏放」——该行**就是要被判 FAIL**，不存在误放行真凭据。
- 归属：`git ls-files` 确认该文件是 HEAD 已跟踪，由 `5664049`（gate-fix-verifier）引入；`git show 5664049:... | sed -n 45p` 与 HEAD 第 45 行逐字一致；`git status --short` 该文件**干净**；`git show --name-only 04fffc6` **未触及**该文档或 `scripts/secret-check.sh`。与 04fffc6 零关系。
- round43 `is_pattern_context` 为何未豁免（`scripts/secret-check.sh:96-105` 三条件）：直接采用脚本同款 `ENV_RE` 捕获该行 → `val=[***]`；`has grep=yes`、`has -E=yes`（`grep -nE`），但第三条件「value 含正则元字符 `| \ [ ] ( ) <…> + ? …`」**不满足**（哑值纯字面量）→ `is_pattern_context` 返回 1 → FAIL。**豁免设计本身正确**：若豁免纯字面量值，反向探针「真实赋值 FAIL」的判据就被架空，真凭据可能漏过。round43 修法不是漏改，而是有意保留。
- round43「干净 clone secret-check 0 FAIL」与现脏树 1 FAIL 不矛盾：round43 报告（:88/:123）的干净 clone 是**从父提交快照克隆**（文档尚未落盘或匹配数 28），现树含 5664049 新增的探针文档（匹配数 29）才多出这一条；其报告 :128 亦如实记「脏树 20/21 存量违规」。
- 是否需补/另派：**已在后续修复卡中处理**：把该文档里 `ADMIN_PASSWORD=***` 的探针字面量改为占位写法（原探针哑值已脱敏），保留「真实赋值 FAIL」的语义证据；**不建议放宽 `is_pattern_context`** 去豁免纯字面量值（会削弱 G-30）。本卡不因此 BLOCKED——它不是 04fffc6 的回归。

### b) 20/21 usability A1 waf zeroparam_test.go（untracked 他人）

**判定：真无关。**

- `kore-plugin-waf` 仓 `git status --short` → `?? internal/wafop/zeroparam_test.go`（**untracked**，未被任何 commit 纳入）；`stat` mtime `2026-11-24 21:14:33`，早于本改动（11-28）数日。
- 04fffc6 写域只在 `kore` 仓 8 文件，从未触及 waf 仓。
- 本卡复跑 `bash scripts/usability-check.sh`：默认只读 GOCACHE 下 19 个 A1 FAIL **全部是 `open /home/pt/.cache/go-build/...: read-only file system` 的环境噪声**，覆盖 18 个插件（含 app-deploy/backup/…/waf），非 waf 独有；换可写 GOCACHE + `GOPROXY=off` 后仍为同 19 条（`module lookup disabled`），同样与 04fffc6 无关。

### c) G-33 他人 dirty `scripts/usability-pending.txt`

**判定：真无关（既有存量）。**

- `git status --short scripts/usability-pending.txt` → ` M`（他人未提交 dirty）；`git diff` 显示 2026-11-24 的三批 A1 移出清单注释（+3/-17 行），mtime/内容均早于本改动。
- 04fffc6 的 8 文件清单不含该文件；该 dirty 自 11-24 起即为共享工作区存量（round43/44 报告已多次记录），本卡只读、未改。

---

## 4. ④ 版本 0.1.3→0.1.4 / CHANGELOG

- `Makefile:29 VERSION ?= 0.1.4`、`cmd/kored/main.go:17 var version = "0.1.4"`、`docs/CORE.md` 版本基线同步 0.1.4（0.1.3 修写放大击穿、0.1.4 修跨 key 轮换 p95 回弹）。
- perf→patch 符合 semver（非新功能，回到自身红线）；`make version-check` exit 0：`内核 VERSION=0.1.4 覆盖 24 个插件，全部落在 requires_kore 区间内`（插件区间 `>=0.1.x <0.2.0`，0.1.4 在上界内）。
- `CHANGELOG.md` 0.1.4 条目如实记动机：红队场景④ p95 从单 key 19–41ms 抬回 79.7–105ms（10/10 越线）、全局预算修法、单 key 不回归、守恒不变；明确「不是新功能，目标只是回到自身红线内，不宣称超越竞品」。条文实测数字（69.2–78.5→10.5–13.7ms）为实现者自测口径，本卡独立复跑数字（12.63–35.15ms）量级一致、方向一致（均 ≤50ms），未相互矛盾。

---

## 5. ⑤ git 边界 / 清理

- `git show --stat --format=fuller 04fffc6`：8 文件精确（`CHANGELOG.md`、`Makefile`、`cmd/kored/main.go`、`docs/CORE.md`、`docs/SECURITY.md`、`internal/core/httpapi/{deny_burst.go,deny_burst_integration_test.go,deny_burst_test.go}`）；无 `go.mod/go.sum`、无临时资产。
- DCO：`Signed-off-by: pengtang1024 <pengtang1024@qq.com>` 存在。
- 未 push：`git rev-list --count origin/main..HEAD` = 3（5664049→HEAD 的 7b70e11/48c833a/04fffc6）；`origin/main` 仍为 5664049，远端未变。
- 他人 dirty 原样：测试前后 `git status --short` 一致（`M scripts/usability-pending.txt` + 8 个 `??` 存量 + `.agents/.agents/`），本卡除本报告外零新增工作区文件。
- 隔离 harness 已 `rm -rf .tmp/deny-burst-fix-verify`（含二进制/harness.py/results.json/state/run/log/config），回读 GONE；`git status` 无临时资产；`.git/info/exclude` 未新增行；`git worktree list` 仅主树、无 `wt-*`/`tmp-*` 分支。

---

## 6. 诚实边界

1. **单机单实例、单节点 bbolt**，无竞品同口径对照——本卡数字只证明 kore 自身当前 HEAD 表现，不构成「超越竞品」证据。
2. **单管理员用 read token 构造真 deny**（认证后低权向量），非多用户 RBAC（G-11 明确不做）；多 token subject 轮换（红队记录 p95 226.5ms）未在本次复跑范围，本卡按 task-308 口径只测单 token 轮转 4 端点。
3. **客户端 Python GIL 保守口径**：req/s 与 p95 是端到端观测值，非服务端极限；p99/max 尾部尖峰如实标注、不宣称 p99 达标。
4. **MAX_MERGE(1000) 转逐条 / root.action fail-closed** 真机难构造，本卡以读码与既有单测（`TestDenyBurstMaxMergeFallsBackToIndividual`、`TestRootActionAuditNotMerged`）覆盖，如实标注、不伪造真机数据。
5. p95 数字为一次隔离会话内连续 5 次，未跨机器/跨负载复现；CHANGELOG 的实现者自测数字未逐字节复算（量级一致，已如实披露）。
6. 本卡只读复核 + 一次隔离复跑；未 `make check` 全 21 段整条重跑（3 个 FAIL 已逐项独立归因并给出判定），未 push、未联网业务、未执行 install/serve/upgrade 主流程 CLI、未碰 `.kore-local-*` 与宿主 8787 配置。
