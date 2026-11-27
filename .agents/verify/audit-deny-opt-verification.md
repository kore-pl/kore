# 审计 deny 写放大优化 P1+P2 独立验收报告

> G-09：独立 verifier（audit-deny-opt-verifier），非实现者（audit-deny-opt-impl）。task-265（先 claim）。
> 复核对象：`da1a755`（31 文件，DCO 已签，未 push）；方案 `b207a9f`（`docs/DESIGN-AUDIT-DENY-OPT.md`，195 行）。
> 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（只读复跑，未改代码、未启服务、未碰 `.kore-local-*`）。
> 日期：2026-11-28｜总评：**PASS**（含 1 项非阻断观察，见 §7）

---

## 0. 结论先行

方案 b207a9f 采纳的 ①②④ 三项已逐字落地，否决的 ③（异步队列）未以任何形式复活；安全不变量 I1–I6 逐条有代码与测试举证；测试矩阵全绿（build/test 18 包 / -race 5 包零竞态 / vet 三平台 / version-check 24 仓 / docs-check / cross-build 五目标 / make check 21 段）；文档门禁与 git 纪律合规。**总评 PASS**，可移交 P3 真机复验（本卡不涵盖）。

---

## 1. Git 基线（命令 + 退出码）

| 项 | 命令 | 退出码 | 证据 |
| --- | --- | --- | --- |
| HEAD | `git rev-parse HEAD` | 0 | `da1a755ce4cf26dfcb558710817cbf3c02f1cdd4` |
| 提交文件数 | `git diff-tree --no-commit-id --name-only -r da1a755 \| wc -l` | 0 | **31**（与任务卡一致） |
| DCO | `git log -1 --format=%B da1a755 \| grep -i Signed-off-by` | 0 | `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` |
| 未 push | `git branch -vv` | 0 | `main da1a755 [origin/main: 领先 6]` |
| worktree | `git worktree list` | 0 | 仅 1 行主工作树（G-25） |
| go.sum churn | `git diff HEAD -- go.sum go.mod` + commit 文件清单 | 0 | 无 go.sum/mod，工作区亦无改动（已还原） |
| 临时资产 | `git status --porcelain \| grep -iE '\.tmp\|verify-tmp\|…'` | 0（无命中） | 无临时脚本/目录残留 |

他人 dirty 原样未动（验收前后 `git status --porcelain` 完全一致）：`M scripts/usability-pending.txt` + `?? .agents/.agents/`、`?? .agents/verify/{e2e-*,local-update-plan,release-batch-*,release-inject-verify,run-user-model}.md`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`、`?? data/`、`?? dist/`。HEAD 验收前后未变。

> 环境注：默认 `GOCACHE`（`/home/pt/.cache/go-build`）与 modcache 锁文件为只读 FS。全部 Go 门禁在隔离可写缓存（`GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.gocache-audit-deny-verify`、`GOMODCACHE=.../.tmp-acct-gomodcache`，均为工作区内既有/新建目录，不在 kore git 树内）下复跑，`GOPROXY=off` 零联网。该缓存目录为复用既有沙箱模式所建，非仓库内临时资产。

---

## 2. 方案落地逐项（① 读码）

| 方案要求 | 实现锚点 | 结论 |
| --- | --- | --- |
| `deny_burst.go` DenyBurstTracker，纯内存零 goroutine | `internal/core/httpapi/deny_burst.go:88-92`：`sync.Mutex + map[DenyBurstKey]*denyBurstState + calls`；`:112` 每 256 次惰性 sweep；无 `NewTicker`/`AfterFunc`/`go func`（grep 零命中） | ✅ |
| `auditDenied` 唯一出口，一次 Submit 产审计+告警计划 | `middleware.go:277-295`：一次 `s.denyBurst.Submit(...)` → `outcome.Audits` + `outcome.Alerts`；全仓 16 处 deny 埋点均收敛到此函数（`grep auditDenied(` 核对） | ✅ |
| 窗口键 subject+plugin+target+capability+reason，**不含 IP** | `deny_burst.go:24-30` DenyBurstKey 五字段，无 IP（auditDenied 出口无 IP 参数，方案 §2.1 明示） | ✅ |
| 1s / 阈值 10 / MAX_MERGE=1000 转逐条 | `deny_burst.go:15-20` 常量；`:128-153` 分派（1..10 逐条、11 合并、12..999 pending、1000 补段+逐条、>1000 逐条） | ✅ |
| detail 加 `reason/count/window_ms/first_at/last_at`，**不加顶层字段** | `deny_burst.go:162-168` 五键入 `map[string]string`；`serve_audit.go:78-90` 原样透传 `AuditRecord.Detail`；`store.AuditRecord` 无新字段 | ✅ |
| `CapabilityAuditorWithDetail` 旧 5 参保留 | `server.go:198-208` 新接口；`CapabilityAuditor` 旧签名保留（`:196`），`serve_audit.go:71-73` `Audit` 委派 `AuditWithDetail`；`emitCapabilityAudit` 优先新接口、回退旧接口 | ✅ |
| store `PutAlertCounted(n)` + `AlertSinkCounted` 首次拒绝仍立即告警且只派一次 | `store/alerts.go:93-118` 单写事务 `count+=n`；`alerts.go:78-83` 扩展接口；`:118-143` `emitDeniedAlert` — n=1 走 `PutAlertCounted` 一次 + `dispatchAlert` 一次；`Submit` 首次（N=1）`AlertN=1`，突发段累积，触发点一次写 | ✅ |
| config `audit.max_records`（默认 100000 / 0 关闭，全接） | `types.go:142-144,229`；`parse.go:23` keys；`parse_nested.go:224-228`；`validate.go:214-216`（0..1e6）；`reload.go:215-217`（冷字段） | ✅ |
| store `CountAudit` / `TrimAuditToMax`（最旧端 + 批量 + 坏键不删） | `store/audit.go:210-224`（只读计数，坏键也计）；`:230-270`（游标首端删、`target>batch` 截断 + `more=true`、坏键 `continue`） | ✅ |
| scheduler `audit.clean` 按龄后按量 | `scheduler/auditclean.go:169-181`：先 `CleanAudit` 再 `TrimAuditToMax`，`report.More \|\|= trimMore`；`:182-195` 结果/日志带 `trim_deleted`/`max_records`；`scheduler.go:56,93,126` 装配；`serve_runtime.go:179` 从 cfg 注入 | ✅ |

无一处引入 bbolt `Batch`（`grep -rn '\.Batch' internal/core/store/audit.go ...` 零命中），G-19 零 goroutine/ticker 守住。

---

## 3. 安全不变量 I1–I6（DECISIONS.md + SECURITY.md §11 举证）

| 不变量 | 代码举证 | 测试举证 | 判定 |
| --- | --- | --- | --- |
| **I1 每条 deny 可追溯**（谁/何时/什么能力/被拒） | 逐条段带全字段；合并记录同样带 `subject/action=capability.denied/plugin/capability/detail.reason`，时间由 bbolt `%020d-%06d` 键承载 + `first_at/last_at`（`deny_burst.go:162-168`、`serve_audit.go:78-90`） | `TestDenyBurstCountConservation`、`TestAuditDeniedMergedEndToEnd`（断言 reason/first_at/last_at 非空） | ✅ |
| **I2 超 MAX_MERGE 转逐条防掩盖** | `deny_burst.go:148-153`：count≥1000 flush 合并段后余下逐条；窗口固定 1s 不可配无限 | `TestDenyBurstMaxMergeFallsBackToIndividual`（第 1001..1005 全逐条）+ 守恒校验 | ✅ |
| **I3 出口不绕过 / root.action 不并入** | `auditDenied` 唯一汇聚点（16 埋点）；root.action 走 `privilege.Auditor` → `rootActionAuditor`（`serve_runtime.go:138`），fail-closed 独立；`channel.go:104` 通道鉴权失败属 `capability.denied`，与 root.action 决策审计是两条路 | `TestRootActionAuditNotMerged`（30 次逐条、无合并元数据）；`TestDenyBurstOtherKeyNotMerged`（channel 键独立） | ✅ |
| **I4 不引入新绕过面** | 纯内存 `sync.Mutex+map` + 惰性 sweep，键仅用既有标量；`TrimAuditToMax` 只删最旧、坏键不删、阈值 1e5 远大于正常量（`audit.go:230-269`） | `TestTrimAuditToMax`（最旧端/batch/坏键）、`TestDenyBurstDifferentKeysIsolated` | ✅ |
| **I5 不违 G-10/G-01 零侵入** | 无联网/出站/遥测（G-10）；burst 键无业务域名词表（G-01）；`grep syscall.` 于 `internal/core` 零命中；`grep 'plugins/' import` 仅测试/路径字符串、无生产包 import | `make check` 第 3/4/11/13 段全绿 | ✅ |
| **I6 detail 校验不放松** | `store/audit.go:83-108` `validateAudit` 上限（键 ≤16 / 键 ≤32 字符 / 值 ≤256 / 序列化 ≤1KiB）本次未改；合并 detail 5 键短值，仍过原校验 | `go test ./internal/core/store/...` 全绿；未出现放宽常量 | ✅ |

`SECURITY.md` §审计完整性段已逐条写入 I1–I6（含认证后低权 DoS 限定：匿名 401 在 withAuth 短路不写审计）；`DECISIONS.md` 2026-11-28 行含被否决选项③依据（SIGKILL 丢审计 + bbolt Batch 破 G-19 + 队列撑爆新绕过面）。

---

## 4. 测试矩阵复跑（命令 + 退出码）

| 门禁 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 构建 | `GOPROXY=off go build ./...` | **0** | 全仓编译通过 |
| 单测 | `GOPROXY=off go test -count=1 -timeout 300s ./...` | **0** | 17 包 ok + 1 包 no-test = **18 包**（cmd/kored 8.5s、httpapi 6.8s、supervisor 8.9s 等） |
| 竞态 | `GOPROXY=off CGO_ENABLED=1 go test -race -count=1 -timeout 400s ./internal/core/{httpapi,store,scheduler,config}/... ./cmd/kored/...` | **0** | **5 包零 DATA RACE**（httpapi 52s、kored 55s、store 2.4s、scheduler 2.1s、config 1.0s） |
| vet | `go vet ./...`（Linux）；`GOOS=windows GOARCH=amd64 go vet ./...`；`GOOS=darwin GOARCH=arm64 go vet ./...` | **0 / 0 / 0** | 三平台零错误 |
| 版本 | `GOPROXY=off make version-check` | **0** | VERSION=0.1.3 覆盖 **24 仓** `requires_kore` 全在区间 |
| 文档 | `GOPROXY=off make docs-check` | **0** | 5 pass / 1 warn / 0 fail（11 份既有行数越界 WARN 非本次引入；1333 链接全可达） |
| 交叉编译 | `GOPROXY=off make cross-build` | **0** | 五目标（linux amd64/arm64、windows amd64、darwin arm64/amd64）全仓 + kored 真编译全过（20.9s） |
| 聚合门禁 | `GOPROXY=off make check` | **0** | 21/21 段全过，`[OK] 门禁全部通过`（含第 17 段 cross-build、18/19/21 段 race、G-33 第 20 段 WARN 级：502 存量豁免 WARN + 4 条 A1 清单陈旧 WARN，1 条 FAIL 被存量清单豁免口径按 WARN 处理，不阻断） |

> 关于 `make check` 第 20 段 usability：输出含 `usability-check: 0 pass, 502 warn, 1 fail` 与 `[FAIL] G-33 有新违规`，但紧随其后为 `[WARN] usability-check 有 2 处新违规（WARN 级不阻断…）`，聚合门禁仍 exit 0。该 FAIL 为 `scripts/usability-pending.txt`（他人 dirty，A1 存量清单被删过 17 条）造成的存量噪声，**与本次 commit 的 31 文件无关**（本次未碰 web/ 与任何插件仓）。如实标注，不掩盖。

### 10 类新增单测断言覆盖（14 个测试函数，6 个文件）

| 任务卡要求 | 测试函数 | 通过 |
| --- | --- | --- |
| count 守恒 | `deny_burst_test.go:TestDenyBurstCountConservation`（Σ=301 两侧守恒） | ✅ |
| 窗口边界 | `TestDenyBurstWindowBoundary`（<1s 同窗、=1s 新窗双向补齐） | ✅ |
| 超 MAX_MERGE 转逐条 | `TestDenyBurstMaxMergeFallsBackToIndividual` | ✅ |
| 空 detail | `TestDenyBurstEmptyReason`（空串仍保留 reason 键 + 元数据） | ✅ |
| 不同 key 隔离 | `TestDenyBurstDifferentKeysIsolated` + `deny_burst_integration_test.go:TestDenyBurstOtherKeyNotMerged` | ✅ |
| 并发无竞态 | `TestDenyBurstConcurrent`（8×40，守恒 + `-race` 零竞争） | ✅ |
| 真 auditDenied 12 次仅 2 次 PutAlertCounted | `TestAuditDeniedMergedEndToEnd`（断言 `len(sink.counts)==2`、滚窗守恒 13） | ✅ |
| root.action 30 次逐条不并入 | `cmd/kored/deny_burst_test.go:TestRootActionAuditNotMerged` | ✅ |
| PutAlertCounted 单次 | `store/deny_opt_test.go:TestPutAlertCountedSingleTransaction`（count 12→15，n=0 拒绝） | ✅ |
| TrimAuditToMax+config+scheduler 按量 | `TestTrimAuditToMax` + `config/audit_max_records_test.go:TestAuditMaxRecordsDefaultParseValidate` + `scheduler/auditclean_max_test.go:{TestAuditCleanMaxRecordsTrim,TestAuditCleanParamsRejectBadMaxRecords}` | ✅ |

---

## 5. 文档门禁（④）

| 项 | 证据 | 判定 |
| --- | --- | --- |
| 版本 0.1.2→0.1.3 | `Makefile:29 VERSION ?= 0.1.3`、`cmd/kored/main.go:17 version="0.1.3"`、`docs/CORE.md:13 版本基线 0.1.3` 三处一致；version-check 24 仓全绿 | ✅ |
| CHANGELOG 如实 | `CHANGELOG.md` `[0.1.3] 2026-11-28`：明写「并发 16 拒绝实测 p95=158ms 击穿 p95≤50ms 硬红线」「认证后低权 DoS」「不宣称超越竞品，目标只是回到自身红线内」 | ✅ |
| CORE / DATA-MODEL / SECURITY G-06 | CORE §2.2/§2.4/§2.15、DATA-MODEL §5/§9/§11 + 配置表、SECURITY §审计完整性 均同步合并/按量/告警语义与 I1–I6 | ✅ |
| G-23 DECISIONS / DISPATCH 含否决异步队列 | `.agents/LOG/DECISIONS.md` 2026-11-28 行：③「否决」+ 三条依据；`.agents/LOG/DISPATCH.md` 同日行含 task/owner/写域/依赖/交付/commit | ✅ |
| web/audit.js 零改动、G-28 不触发 | commit 31 文件无 `web/`；`git status --porcelain -- web/audit.js` 空；DATA-MODEL §9 明示前端 `detailText` 通用摊平即可显示 | ✅ |

---

## 6. 提交与纪律（⑤）

- `da1a755` 精确 31 文件（§1）：无 web/、无 go.sum、无插件仓、无他人 dirty 文件被夹带。
- 未 push：main 相对 origin/main 领先 6；无 tag / Release 在本轮创建（任务卡未要求）。
- worktree 仅主树（G-25）；他人 dirty 原样（§1）。
- 临时资产：仓库内无残留（§1）；隔离 GOCACHE 位于 kore git 树之外（工作区根，复用既有沙箱模式）。

---

## 7. 非阻断观察（诚实边界，不判 FAIL）

1. **告警 detail 归属（cosmetic）**：`materialize` 构造 `DenyAlertWrite` 时未填 `Detail` 字段，`auditDenied:294` 循环用当前调用的 `alertDetail` 为每个 `AlertWrite` 落库。因此惰性 sweep（每 256 次）补齐的**其他 key** 窗口告警，其 detail 文字取的是当前请求的 subject/plugin/target/reason。影响面：告警明细文案可能与被补 key 不完全对应；**count 守恒、title/source 一致（归并同一告警记录）、通知派发次数均不受影响**，不构成取证或安全问题。建议 P3 或后续补丁把 `DenyAlertWrite.Detail` 用 `d.Key` + 代表 detail 填充并在 `emitDeniedAlert` 使用 `alert.Detail`（本卡只读，不修改）。
2. **P3 真机复验未在范围**：本卡只验 P1+P2（代码/门禁/文档），并发 16 拒绝 p95≤50ms、审计 Δ<N、吞吐 ≥2× 等真机硬指标须按方案 §6.2/§6.3 另卡隔离复验（不碰 8787 / `.kore-local-*`）。本卡不宣称真机性能已达标。
3. **usability 第 20 段噪声来源**：见 §4 注，属他人 dirty 的存量清单口径，非本 commit 引入。

---

## 8. 总评

**PASS** —— P1+P2 实现、安全不变量、测试矩阵、文档门禁、git 纪律五项全数成立；一项非阻断观察（告警 detail 归属）与 P3 真机复验待办如实登记。建议 lead 放行进入 P3 真机复验卡。

> 本验收只读复跑，唯一写入为本报告文件（`git add` 精确路径 + `git commit -s`，`[agent:audit-deny-opt-verifier]`）；未 push / 未联网 / 未启服务 / 未碰主实例。
