# audit-amp-verification · 审计写放大微基准独立验收（G-09）

> verifier: audit-amp-verifier（独立于 implementer audit-amp-r35）｜日期: 2026-11-28 ~04:00 +08:00
> 被验对象: commit `3a883db3b500966ee01b73553202942146e6aa44`（`.agents/verify/audit-deny-write-amplification-r35.md`，249 行）｜task-262
> 工作目录: `/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）｜**只读复核**：不启服务、不联网、不碰主实例 `.kore-local-*`/8787、不改任何生产代码
> 唯一可写物 = 本报告（精确 `git add` + `git commit -s`，未 push）

## 总评：PASS

四大复核面（①真拒绝构造 ②数字自洽 ③结论与口径 ④隔离清理+git）全部坐实。附录 400 个原始延迟样本逐条重算，所有分位数/倍数/吞吐/写锁判据自洽；所有源码 file:line 锚点与当前源码逐字一致；结论「需优化非健康」有实测+红线文档支撑、未夸大，认证后低权 DoS 的限定如实。仅发现 1 处非阻断的展示性舍入差（均值倍数 4.79 vs 精算 4.80，不影响任何结论，见 §2.5）。

---

## ① 真拒绝构造核查：PASS（确为真 capability.denied，非替代路径）

按调用链逐环回读源码，确认报告 §2 的 deny 构造是**真实 RBAC 能力拒绝**，走的是生产 `auditDenied` sink：

| 环节 | 源码事实（file:line 已回读） | 与报告一致 |
| --- | --- | --- |
| 单管理员恒 admin，会话无法触发真 deny | `server.go:207-229` `defaultCapabilityResolver`：有效 cookie → `return "admin", adminCapabilities`（6 项全权）；`invoke_capability.go:104-106` 注释自认「检查在生产路径恒通过」 | ✅（报告 line 76） |
| read 范围 token 只授只读能力 | `server.go:212-220`：API token `scope=="read"` → `[]string{"system:read","net:read","proc:read"}`（**无** `system:admin`） | ✅（报告 line 76 / 207） |
| `GET /api/v1/credentials` 要求 system:admin | `handlers_credentials.go:65-69` `handleCredentialList` → `authorizeCredentials`；实际能力判定在同文件 `22-26` 行 `hasCapability(granted,"system:admin")` | ✅（报告 line 76 引 66-69、line 200 引 22-26，两处锚点均真实存在） |
| 失败走 auditDenied = 真 capability.denied | `handlers_credentials.go:22-23` `s.auditDenied(subject,"credentials","","","需要 system:admin 能力")` → `middleware.go:274-282` `capAuditor(...)+noteDeniedAlert(...)` → `cmd/kored/serve_audit.go:71-83` `db.PutAudit(AuditRecord{Action:"capability.denied",Result:"denied",Plugin:"credentials",Detail:{reason}})` | ✅（报告 line 90-99） |
| 401 + 审计样本原文在报告 | 报告 line 81 `verify_deny = 401 {"code":"E_UNAUTHORIZED","message":"越权：凭据管理需要 system:admin 能力","detail":"system:admin"}`；line 84-85 审计样本 `plugin=credentials / action=capability.denied / result=denied / detail.reason=需要 system:admin 能力` | ✅ 原文在报告，字段与 `serve_audit.go:71-79` 映射逐字对应 |
| 成功对照 200 | 报告 line 82 同一 read token `GET /api/v1/system/info` = 200（无需 admin） | ✅ |

补充核实：
- 该 deny 出口 `capability` 传空串（`handlers_credentials.go:23` 第 4 参为 `""`），按 `serve_audit.go:69-70`/`AuditRecord.Capability omitempty`（`store/audit.go:48`）「非 invoke 不编造能力名」设计落地——报告审计样本未含 `capability` 字段，**与源码一致，非缺陷**。
- 「匿名 401 短路不写审计」成立：`middleware.go:35-71` `withAuth` 在无有效 cookie/token 时于 `61-63` 行直接 `writeError(401)` + `return`，**不进入** `next.ServeHTTP`，故不会触达任何 `auditDenied` 埋点；deny 审计只在通过认证后的 handler 内产生。报告的认证后低权限定（line 194/214）属实。

**判定：真拒绝构造坐实。** 报告没有用伪造/替代路径冒充真 deny；诚实边界（line 7/214：其他 deny 出口共用同一 sink 但未逐一实测）已如实声明。

---

## ② 数字自洽：PASS（400 个原始样本全量重算）

从报告附录 line 242（拒绝 200 个）/ line 248（成功 200 个）逐字解析原始数组，用 nearest-rank 分位数（`⌈q·n⌉`）独立重算：

| 指标 | 报告值 | 独立重算 | 结论 |
| --- | ---: | ---: | --- |
| 拒绝 n / min / p50 / p95 / p99 / max / mean | 200 / 7.4714 / 11.4745 / 14.0539 / 14.9586 / 15.3767 / 11.467 | 200 / 7.4714 / **11.4745** / **14.0539** / 14.9586 / 15.3767 / **11.467** | ✅ 逐位一致 |
| 成功 n / min / p50 / p95 / p99 / max / mean | 200 / 0.4344 / 2.4554 / 3.8507 / 4.1029 / 4.5093 / 2.391 | 200 / 0.4344 / **2.4554** / **3.8507** / 4.1029 / 4.5093 / **2.391** | ✅ 逐位一致 |
| p50 倍数 | 4.67× | 11.4745/2.4554 = **4.6732×** | ✅ |
| p95 倍数 | 3.65× | 14.0539/3.8507 = **3.6497×** | ✅ |
| 均值倍数 | 4.79× | 11.467/2.391 = **4.7959×**（宜四舍五入 4.80） | ⚠️ 舍入展示差 0.01，非阻断（见 §2.5） |
| 关键样本点存在性 | 7.4714/14.0539/15.3767/14.9586；0.4344/3.8507/4.5093/4.1029 | 全部在对应数组中实测存在 | ✅ 未被篡改/未删样本 |

吞吐倍数独立抽算（报告 line 150-160）：

- 固定 N=300：767.90/98.91=**7.76×**、2460.63/111.64=**22.04×**、1747.77/109.17=**16.01×** → 与报告 7.76/22.04/16.01 ✅
- 5s 稳态：1797.46/104.94=**17.13×**、2470.25/111.68=**22.12×**、2769.05/123.87=**22.35×** → 与报告 17.13/22.12/22.35 ✅
- 5s 计数自洽：525/5=105.00≈104.94、561/5=112.20≈111.68、629/5=125.80≈123.87（实际窗口略 >5s 的抖动脉冲，量级一致）；成功侧 8988/5=1797.6≈1797.46、12353/5=2470.6≈2470.25、13860/5=2772≈2769.05 ✅

写放大与写锁判据：

- 审计 1:1：1322→1622→1922→2222，每档 +300（N=300）✅；告警恒 1→1（Δ=0）与 `mergeAlert` 5 分钟窗口合并（`store/alerts.go:109-141`）一致 ✅；state.db 单调（1M→1M→2M，5s 稳态 4M）✅；4 MiB/1715 条=2446 B/条，落在报告「约 2–3 KiB/条（含页碎片）」口径内 ✅
- Little 定律 `L=λW` 独立验算（λ=拒绝 req/s，W=p50）：c=1 → L=0.97、c=4 → L=3.73、c=16 → L=15.93，**分别≈并发 1/4/16** —— 在途请求数恰等于并发度，坐实「吞吐恒定、等待随并发线性放大」的写锁排队判据 ✅（报告 line 165 论断成立）
- 吞吐封顶 105→112→124（<20% 波动）vs 成功 1797→2470→2769 ✅；p95 14.14→44.38→158.02 ✅

**§2.5 唯一瑕疵（非阻断）**：报告 line 110 写「均值 11.467/2.391 = 4.79×」，精算 4.7959 按四舍五入应为 4.80×。这是一个**展示性舍入差 0.01**，均值倍数不是任务验收核心量、不影响「4–5×」判读与任何结论，也不涉及原始样本或 p50/p95（两者逐位精确）。按「数字不自洽报 BLOCKED」的门槛衡量，此处属可接受的末位舍入，判 PASS；如后续再版报告可顺手改为 4.80×。

**判定：数字全部自洽，无 BLOCKED。** 原始数组未被篡改、分位数可逐位复现、倍数/吞吐/Little 定律全对得上。

---

## ③ 结论与口径核对：PASS（需优化结论不夸大，触发条件如实限定）

**③-1 「需优化非健康」有据、未夸大：**
- 并发 16 拒绝 p95=158 ms 击穿 API p95≤50ms 红线：红线原文已核 `docs/V1-GOALS.md:45`（「API p95 ≤50ms（本地）」）、`docs/PLAN.md:78/245`、`docs/ROADMAP.md:142`（逐字一致）✅
- 1:1 审计写放大 + 每次 `PutAlert` 读改写写事务（`alerts.go:78-95/106-118`、`store/alerts.go:85-141` 已回读，报告归因链成立）✅
- 持续吞吐 1/17–1/22（§2 复算确认）✅
- deny 突发无合并：`auditDenied` 直通 `capAuditor`→`PutAudit`，无 burst 窗口（burst 仅 `recordInvokeAudit`）——与 `perm-system-cost.md:165` 一致 ✅
- 清理按龄按批、突发堆盘：`config/types.go:218-226`（90d/6h/≤1000）+ `auditclean.go:137-170`（`runAuditClean`→`store.CleanAudit(cutoff,batch)`）已实现，但速率无上限，5s 629 条远快于 6h/批 ✅

**③-2 触发条件如实限定为认证后低权 DoS，非匿名：**
报告 line 194 明确「触发条件是已认证的低权 token（非匿名）……认证后低权 DoS 向量，不是开放的无认证放大」；line 190 表「并发下崩塌：三档全 401、零 5xx、零异常」如实记录无崩溃。源码 `withAuth`（`middleware.go:35-71`）确认匿名 401 短路不写审计（见 ①）。**未夸大、未隐瞒。**

**③-3 「清理已实现、修正旧口径」属实：**
`perm-system-cost.md:144/165` 确有「审计保留 90 天**未实现**/代码无删除路径」旧论断；当前 `config/types.go:218-226`（`Retention:90*24h / CleanEnabled:true / CleanInterval:6h / CleanBatch:1000`）+ `internal/core/scheduler/auditclean.go:137-170`（实际删除执行体）已落地。报告 line 15/130/183/206 对旧口径的修正**属实**，非臆造。

**③-4 修复锚点 file:line 全部与源码逐字一致：**

| 报告锚点 | 回读结果 |
| --- | --- |
| `middleware.go:274-282` auditDenied | ✅ 274 行函数签名，275-281 capAuditor + noteDeniedAlert |
| `serve_audit.go:71-83` deny→PutAudit | ✅ 71 行 `func (a *capabilityAuditorFromStore) Audit`，72-79 PutAudit(AuditRecord{...}) |
| `store/audit.go:52-79` Update+fsync 无 Batch | ✅ 52-59 注释明示「用 Store.Update 不用 Batch…NoSync:false」，60-78 `s.Update(...)` |
| `httpapi/alerts.go:78-95`（recordAlert/PutAlert）、`106-118`（noteDeniedAlert） | ✅ 均逐字对应 |
| `store/alerts.go:85-107`（PutAlert）、`109-141`（mergeAlert 读改写合并） | ✅ 均逐字对应 |
| `config/types.go:218-226` + `scheduler/auditclean.go:137-170` | ✅ 均逐字对应 |
| `server.go:212-229`（read token 只授 read 能力） | ✅ 212-220 token 分支，228 会话兜底 |

**判定：结论与口径全部核对通过。**

---

## ④ 隔离清理 + git 纪律：PASS

| 项 | 复核命令 + 结果 |
| --- | --- |
| 隔离端口 55161（非 8787） | 报告 line 29/38/59-60 明示 `127.0.0.1:55161`；本轮回读 `ss -ltn \| grep ':55161 '` → **55161 free**；8787 主实例仍在 LISTEN（只读观测，未触碰）✅ |
| 二进制副本 sha 一致 | `sha256sum bin/kored` = `a6d0ebeb9174b44b7eac80c7fc6c24ba25daad073e921e470d1cf0d520f729c9`，与报告 line 4/58 声明逐字相同（副本已随隔离树删除）✅ |
| 清理回读：no kored | `pgrep -a kored` → **no kored** ✅ |
| 清理回读：55161 free | 见上 ✅ |
| 清理回读：`.tmp/audit-amp-r35` GONE | `test -e .tmp/audit-amp-r35` → **GONE**；`find . -iname '*audit-amp*'` 无残留 ✅ |
| 宿主文件 mtime 未变 | `.kore-local.yaml`=11-25 20:15、`bin/kored`=11-28 00:26、`data/initial-admin-credential`=11-25 20:59、`.kore-local-state/state.db`=11-28 02:03，均**早于**测试窗（~03:53）→ 测试未改运行态资产 ✅ |
| secret-check 0 FAIL | `make secret-check` → `secret-check: 0 FAIL / 25 处匹配（占位写法均合规）`，exit=0 ✅ |
| token 不进 argv / 报告无明文 | 报告 line 31 声明；全文扫描仅见 `***` 占位与 `token:<id>` 形式，无明文口令/token ✅ |
| commit 3a883db 精确单文件 + DCO | `git show --name-only` = 仅 `.agents/verify/audit-deny-write-amplification-r35.md`；`numstat` = 249 行 0 删；提交体含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ✅ |
| 未 push | `git merge-base --is-ancestor 3a883db` 对 origin/github/gitee/gitee 4 端 main 均 exit=1 → **未推送** ✅ |
| 他人 dirty 原样 | `git status --short` 仍为 `M scripts/usability-pending.txt` 及既有 `??`（.agents/verify/*、data/、dist/ 等），本任务未提交任何他人文件 ✅ |
| worktree 卫生 | `git worktree list` 仅主树 1 行 ✅ |
| 被测 HEAD 声明 | `git rev-parse 3a883db^` = `526d2ace17e9211e2a2bd41a29fd233bbb197320`，与报告 line 4 声明的被测 HEAD 一致 ✅ |

**判定：隔离清理与 git 纪律全部合规。**

---

## 验收结论

**总评 PASS。** 四大面全部坐实：真 RBAC 拒绝路径成立（源码逐环可追）、400 样本全量重算自洽（仅 1 处 0.01 的末位舍入展示差，非阻断）、「需优化」结论有红线文档与实测双重支撑且认证后低权限定如实、修复锚点/清理口径与源码逐字一致、隔离清理与 git 纪律合规。该报告的「需优化」结论可作为触发后续生产优化的可靠依据。

未验证项（诚实边界，沿用报告自身声明）：单机单实例、无竞品同口径对照、fsync 归因基于代码+数字同量级推断未直测 syscall、被测二进制非本轮现场编译（沙箱不能 go build；sha 已核）。这些是报告已明示的边界，不影响本次验收判定。
