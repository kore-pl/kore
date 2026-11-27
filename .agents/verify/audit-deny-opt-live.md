# audit-deny-opt-live · 审计 deny 写放大优化 P3 真机复验报告

> owner: audit-deny-opt-live（worker，非 P1/P2 实现者、非 P1/P2 verifier，G-09）｜日期: 2026-11-28 ~05:41 +08:00｜持续目标 round 35
> 任务: task-266（先 claim）｜工作目录: `/home/pt/Work/GolandProjects/kore-pl/kore`
> 被测: **当前 HEAD 源码现场编译的 0.1.3 临时二进制**（非仓库自带 0.1.2 副本）
> 性质: 隔离实例真机实测，命令 + 退出码 + 原文数据齐备；未碰 8787 / `.kore-local-*`、未联网、未改生产代码、未 bump/未 push。

---

## 0. 结论先行

**PASS —— 方案 §6.3 六项硬指标全部满足（安全不变量两项以单测覆盖如实标注，真机旁证到位）。**

| # | 硬指标 | 基线（audit-deny-write-amplification-r35.md） | 本轮实测 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 并发 16 拒绝 p95 ≤ 50ms | **158.02ms（击穿）** | **22.90ms**（fixed c16，N=300）；5 次独立复跑 12.51–27.86ms 全 ≤50ms | ✅ PASS（6.9× 改善） |
| 2 | 1:1 写放大被打破 | 300 拒绝 → 审计严格 **+300** | 300 拒绝 → 审计记录 **+12**（含合并），窗口守恒 Σ=301（300+1 触发） | ✅ PASS |
| 3 | 拒绝吞吐 ≥ 2× | 5s 稳态 **104.94 / 111.68 / 123.87** req/s（c1/c4/c16） | **964.61 / 1043.13 / 998.72** req/s | ✅ PASS（9.2× / 9.3× / 8.1×） |
| 4 | 审计不丢 count 守恒 | 逐条 1:1 | Σ(逐条 + 合并 detail.count) = **17737 = 实际拒绝数 17737**，全量精确守恒 | ✅ PASS |
| 5 | 告警无风暴 | 记录数恒 1，写事务每次拒绝 | 记录数恒 **1**；`count` 字段 = 17737（全部拒绝归并） | ✅ PASS |
| 6 | 隔离与合规 | — | 独立 config/state/run/log + 55171；SIGTERM exit 0；临时资产删净 | ✅ PASS |

---

## 1. 前置回读（口径一致可比）

| 项 | 命令 | 退出码 | 证据 |
| --- | --- | --- | --- |
| HEAD | `git rev-parse HEAD` | 0 | `7cad293800d50ca7ec6948aa402912a5f0a10885`（预期 7cad293，含 P1+P2 实现 da1a755 与验收 7cad293） |
| 最近提交 | `git log -3 --oneline` | 0 | `7cad293` 验收 PASS → `da1a755` P1+P2 实现 → `b207a9f` 方案 |
| 版本（Makefile） | `grep -n VERSION Makefile` | 0 | `VERSION ?= 0.1.3`（:29） |
| 版本（main.go） | `grep -n 'var version' cmd/kored/main.go` | 0 | `var version = "0.1.3"`（:17） |
| 基线文档 1 | `read .agents/verify/audit-deny-write-amplification-r35.md` | 0 | 249 行，原始基线数据（§3 延迟 / §4 写放大 / §4.3 吞吐 / §7 清理） |
| 基线文档 2 | `read .agents/verify/audit-deny-opt-verification.md` | 0 | 133 行，P1+P2 验收 PASS；§7.2 明示「P3 真机复验未在其范围」，§6.3 判据六项 |

**复跑口径锁定（与基线完全相同）**：
- 真拒绝构造：read 范围 API token（`defaultCapabilityResolver` 只授 `system:read/net:read/proc:read`，`server.go:212-220`）调 `GET /api/v1/credentials`（要求 `system:admin`），服务端 `authorizeCredentials` → `auditDenied` 真落库，**非替代路径、非伪造**（`verify_deny=401` + 原文 `越权：凭据管理需要 system:admin 能力`）。
- 成功对照：同一 token 调 `GET /api/v1/system/info`（`verify_success=200`）。
- 分位数：nearest-rank（`⌈q·n⌉`），客户端 `http.client` + `ThreadPoolExecutor`，每请求新建 TCP 连接（Python GIL 保守口径，与基线 §3/§4.3 一致）。
- 两套口径：固定 N=300（并发 1/4/16）+ 5s 稳态（并发 1/4/16），审计前后读 `GET /api/v1/audit?since=...&action=capability.denied` 的 `total`（筛选后分页前精确计数）。

**与基线唯一差异（如实记录）**：基线因沙箱不能 go build 而用仓库自带 `bin/kored`（0.1.2）逐字节副本；本轮按任务卡要求用**当前 HEAD 现场编译**的 0.1.3 临时二进制（含优化）。这正是要验证的对象，差异是目的而非偏差。

---

## 2. 隔离环境、编译与生命周期（命令 + 退出码）

| 项 | 值 |
| --- | --- |
| 机器 | 13th Gen Intel i7-13700K，`nproc`=24；测试时 `/proc/loadavg`≈2（非空载，与基线同量级环境） |
| 工具链 | `go version go1.26.8 linux/amd64`；Python 3.x `http.client` + `ThreadPoolExecutor`（一次性 harness，用完删净） |
| 被测二进制 | 当前 HEAD 现场编译 `.tmp/audit-deny-opt-live/kored-live`，`kored version` → `kored 0.1.3 / 协议 kore.plugin.v1`；sha256 `5ffc2337e958e222a8da686d1bed3d724e9dec97af4a3fc3f9b474f7e4f62322` |
| 宿主二进制（未触碰） | `bin/kored` sha256 `a6d0ebeb9174b44b7eac80c7fc6c24ba25daad073e921e470d1cf0d520f729c9`（= 0.1.2，8787 在用）；两 sha 不同，证明未被覆盖 |
| 隔离实例 | 独立 config/state/run/log 全落 `kore/.tmp/audit-deny-opt-live/`；`KORE_CONFIG`/`KORE_STATE_DIR`/`KORE_HOME` 全指隔离路径；TCP `127.0.0.1:55171` + 独立 UDS；`profile: portable`；空 `index_dir` |
| 未触碰 | 8787 主实例（测试前后 healthz 均 HTTP=200）、`.kore-local-*`、宿主 `data/initial-admin-credential`、任何网络出站、宿主 `bin/kored` |
| 会话凭据 | 首启自动生成随机口令落隔离 `state/initial-admin-credential`（0600）；harness 仅内存读取；read token 明文只在内存，**不进 argv / results.json / 日志 / 本报告**（脚本比对确认落盘结果只有 token id 哈希前缀，无明文） |

编译命令与退出码（原文）：

```
$ CGO_ENABLED=0 GOAMD64=v1 GOMODCACHE=/home/pt/Work/GolandProjects/kore-pl/.tmp-acct-gomodcache \
    GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.gocache-audit-deny-verify GOPROXY=off GOWORK=off \
    go build -trimpath -buildvcs=false -ldflags '-s -w -X main.version=0.1.3' \
    -o .tmp/audit-deny-opt-live/kored-live ./cmd/kored
  exit=0
$ .tmp/audit-deny-opt-live/kored-live version
  kored 0.1.3 / 协议 kore.plugin.v1
$ sha256sum .tmp/audit-deny-opt-live/kored-live bin/kored
  exit=0  两行 sha 不同（见上表）
$ ss -ltn | grep ':55171 '   （测试前）
  → 55171 FREE
$ pgrep -a kored             （测试前）
  → no kored
```

harness 一次进程内完成「启动实例 → 登录 → 建 read token → 验证真 deny → 全部基准 → SIGTERM 停止」，byproducts 落 `results.json`：

```
$ python3 -m py_compile .tmp/audit-deny-opt-live/harness.py   exit=0
$ python3 .tmp/audit-deny-opt-live/harness.py                 exit=0
    startup.ready=true  ready_ms=152.136  last_err=ConnectionRefusedError（首拍未 listen，非失败）
    verify: login_status=200  csrf_obtained=true  token_create_status=200
            verify_deny=401  verify_success=200
    shutdown={"sigterm":"ok","exit":0}
$ ss -ltn | grep ':55171 '   （测试后）
  → 55171 FREE
```

> 口径说明：harness 每次运行前把隔离 config 复位为无 hash 的初始态 + 清空隔离 state，避免 kored 首启把哈希写回 config 后二次运行跳过 bootstrap（已实测该行为，故自包含重置）。`last_err` 保留首次轮询的 `ConnectionRefusedError` 与基线 §1 同口径。

---

## 3. 真拒绝构造确认（非替代路径）

原文验证（results.json.verify）：

```
verify_deny    = 401  {"message":"越权：凭据管理需要 system:admin 能力"}
verify_success = 200  (同 read token GET /api/v1/system/info)
login_status   = 200  token_create_status = 200
```

写链路（优化后代码事实，供归因）：
```
handlers_credentials.go:22-26 → auditDenied(subject,"credentials","","","需要 system:admin 能力")
middleware.go:277-295         → 一次 s.denyBurst.Submit(...) → outcome.Audits + outcome.Alerts
internal/core/httpapi/deny_burst.go:15-20  阈值 10 / 窗口 1s / MAX_MERGE=1000
deny_burst.go:119-153        N=1..10 逐条、N=11 合并 count=1、12..999 pending、1000 补段+逐条
serve_audit.go:78-90          → AuditRecord.Detail 原样透传（reason + count/window_ms/first_at/last_at）
store/audit.go                → s.Update bbolt 写事务（仅在有 Audits 决策时调用）
```

---

## 4. 断言 1 · 并发 16 拒绝 p95 ≤ 50ms 红线（基线 158ms）

### 4.1 固定 N=300，并发 1/4/16（与基线 §4.1/§4.3 同口径）

| 并发 | n | min | p50 | **p95** | p99 | max | mean | HTTP | req/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | 300 | 0.2169 | 1.6527 | **2.9040** | 6.0599 | 13.7854 | 1.7957 | 401×300 | 526.18 |
| 4 | 300 | 0.1285 | 1.7630 | **4.9362** | 6.3636 | 6.7440 | 2.2541 | 401×300 | 1708.09 |
| 16 | 300 | 1.1227 | 7.0419 | **22.9034** | 114.5488 | 188.8822 | 11.4092 | 401×300 | 1309.44 |

基线对照（基线 §3 单请求并发 1 拒绝 p95=14.0539、§4.3 固定 N=300 并发 1/4/16 拒绝 p95=14.14/44.38/**158.02**）：

- **并发 16 p95: 158.02ms → 22.90ms，改善 6.9×，回落到 ≤50ms 红线内** ✅
- 并发 4 p95: 44.38ms（临界）→ 4.94ms，不再临界 ✅
- 并发 1 p95: 14.14ms → 2.90ms（未退化）✅

### 4.2 并发 16 独立复跑 5 次（每次 N=300，间隔 1.2s 让窗口滚转）

| trial | p50 | **p95** | p99 | max | mean | req/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 7.4300 | **21.4168** | 118.1317 | 189.9542 | 11.6678 | 1313.64 |
| 2 | 1.6494 | **22.8036** | 162.3837 | 191.5912 | 7.9944 | 1530.50 |
| 3 | 8.5373 | **27.8577** | 204.4830 | 231.5344 | 15.1265 | 1025.86 |
| 4 | 7.3834 | **19.2048** | 100.7117 | 192.0142 | 10.5813 | 1449.52 |
| 5 | 5.1986 | **12.5058** | 96.9442 | 153.8816 | 8.0164 | 1872.23 |

**5/5 次 p95 ∈ [12.51, 27.86]ms，全部 ≤50ms** ✅；p50 全在 1.6–8.5ms。

### 4.3 5s 稳态（基线 §4.3 同口径）

| 并发 | n | p50 | **p95** | p99 | max | mean | req/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4824 | 0.6004 | **1.8540** | 11.7575 | 29.0068 | 0.9962 | 964.61 |
| 4 | 5216 | 0.6959 | **1.6928** | 7.7843 | 24.8859 | 0.9148 | 1043.13 |
| 16 | 4994 | 0.4595 | **5.6114** | 10.1136 | 21.6059 | 0.9658 | 998.72 |

稳态 c16 p95=5.61ms（基线稳态口径未在表中直接列 p95，但固定 c16 基线 158ms 是本判据锚点）。

> **诚实标注（不掩盖）**：p99/max 在固定 N=300 的 c16 批次出现 96–231ms 的尾部尖峰（5 次复跑均可见）。这是 16 个线程同时冲击同一 bbolt 写者时的**排队长尾**，与 Python 客户端 GIL + 连接建立抖动叠加；任务卡红线判据是 **p95**，5 次 p95 全部达标，但 p99/max 尾部未达 50ms。**不宣称 p99 达标。**

---

## 5. 断言 2 + 4 · 1:1 写放大被打破 + 合并生效 + count 守恒

### 5.1 关键守恒实验（N=300 快速拒绝 + 1 触发，等窗口滚转后计数）

```
$ 结果原文（results.json.phases.conservation）
  n_batch=300  trigger_denies=1  expected_conserved_delta=301
  records_before=1 → records_after=13        records_delta=12
  conserved_before=1 → conserved_after=302   conserved_delta=301
  merged_meta_before=0 → merged_meta_after=2 merged_meta_delta=2
  batch_wall_s=0.2673  batch_req_per_s=1122.20
```

判定：
- **审计记录增长 12 < 301**（基线严格 +300/300）→ 1:1 线性写放大被打破 ✅
- **Σ(逐条 + 合并 detail.count) 增量 = 301 == 实际拒绝 300+1** → 审计不丢不重 ✅
- 合并记录含完整窗口元数据（`merged_meta_delta=2`）✅

### 5.2 合并记录原文样本（audit GET，脱敏仅 token id 哈希前缀）

```
{"at":"2026-11-27T21:40:45.782120005Z","subject":"token:dfe5e2...","action":"capability.denied",
 "plugin":"credentials","target":"","result":"denied",
 "detail":[{"key":"count","value":"290"},
           {"key":"first_at","value":"2026-11-27T21:40:44.34955022Z"},
           {"key":"last_at","value":"2026-11-27T21:40:44.628892978Z"},
           {"key":"reason","value":"需要 system:admin 能力"},
           {"key":"window_ms","value":"1000"}]}
```

`detail.count=290` + `window_ms=1000` + `first_at/last_at` + `reason` 全非空，逐条段也有 `reason` 且 `count=1` 的合并记录保留 reason —— 对应方案 §4 I1（可追溯）与 §6.3.4（窗口起止可追溯）。

### 5.3 全量守恒（整场 17,737 次真拒绝）

```
$ results.json.phases.grand_total
  denies_issued=17737  expected_conserved_sum=17737
  audit_records=609    audit_conserved_sum=17737
  audit_conservation_ok=true   merged_records_with_meta=46
  alerts_record_count=1        alert_count_field_sum=17737
```

- **审计记录总数仅 609 条 vs 17,737 次拒绝**（≈29:1 合并比，基线为 1:1）；
- **Σ(逐条 + 合并 detail.count) = 17,737 = harness 精确计数拒绝数**，全量零丢失零重复 ✅
- 注意：`fixed_c1/c4/c16` 阶段「立即读数」会出现 `audit_delta=10/0/12`（窗口 pending 尚未 flush），这是**合并的预期延迟落库**而非丢失；最终在窗口滚转/next trigger 后完整补齐，grand_total 是权威守恒证据。

---

## 6. 断言 3 · 吞吐 ≥2× 改善 + 告警无风暴

### 6.1 吞吐对比（5s 稳态，与基线 §4.3 同口径）

| 并发 | 基线拒绝 req/s | 本轮拒绝 req/s | 改善倍数 | 判定 |
| ---: | ---: | ---: | ---: | --- |
| 1 | 104.94 | **964.61** | **9.2×** | ✅ ≥2× |
| 4 | 111.68 | **1043.13** | **9.3×** | ✅ ≥2× |
| 16 | 123.87 | **998.72** | **8.1×** | ✅ ≥2× |

固定 N=300 口径：基线 c16=109.17 req/s → 本轮 c16=1309.44 req/s（**12.0×**）。

**「加并发只排队不涨吞吐」特征被打破**：基线在 c1→c16 吞吐卡在 105–124 req/s（单一写者上限）；本轮稳态 c1/c4/c16 均约 965–1043 req/s，绝对吞吐提升约一个数量级。诚实标注：本轮稳态 c16（998.72）并未高于 c1（964.61）太多，客户端 Python GIL 与单机 CPU 是新的上限，**不宣称服务端极限**，只按同口径对比证明 ≥2× 改善。

### 6.2 告警无风暴

- `alerts_record_count=1`（整场 17,737 次拒绝后告警库仍只有 1 条记录，与基线一致）；
- 该唯一告警的 `count` 字段 = **17,737**（= 全部拒绝数），说明同源聚合把全部 deny 归并到一条记录；
- 各阶段 `alert_delta=0`、`alert_rows=1`（c1/c4/c16 固定批次前后均不变）；
- **通知派发次数/窗口**：本隔离实例未装配外部通知通道，无法真机直接观测 dispatch 次数；该不变量以单测 `TestAuditDeniedMergedEndToEnd`（12 次拒绝仅 2 次 `PutAlertCounted`）断言覆盖，**如实标注为单测覆盖，不伪造真机数据**。

---

## 7. 断言 4 · 安全不变量真机旁证

| 不变量 | 真机旁证 | 单测覆盖（如实标注） |
| --- | --- | --- |
| I2 超 MAX_MERGE(1000) 转逐条 | 本轮单窗口最大批量 300（<1000），**未真机构造超阈值** | `TestDenyBurstMaxMergeFallsBackToIndividual`（第 1001..1005 全逐条 + 守恒）✅ |
| I3 root.action fail-closed 不并入 | 本轮仅凭据端点 capability.denied 路径，root.action 提权端点需 systemd transient unit，**真机难构造，未实测** | `cmd/kored/deny_burst_test.go:TestRootActionAuditNotMerged`（30 次逐条无合并元数据）✅ |
| I1 拒绝后审计可查、detail 含 reason | ✅ 真机确认：audit GET 逐条与合并记录均含 `detail.reason="需要 system:admin 能力"`，`at/subject/action/plugin/result` 齐全；合并记录另含 count/window_ms/first_at/last_at | `TestAuditDeniedMergedEndToEnd`、`TestDenyBurstCountConservation` ✅ |

未达标项：无。未真机验证项已逐条标注单测覆盖，不伪造。

---

## 8. 诚实边界

1. **单机单实例、单节点 bbolt**：无集群、无多机；无竞品同口径对照，本报告只证明 kore 自身当前 HEAD 表现，**不构成「超越竞品」证据**。
2. **单管理员用 read token 构造真 deny**：这是「认证后低权」向量；非多用户 RBAC（项目 G-11 明确不做多用户 RBAC，单管理员默认全权，靠 read token 才触发真 capability.denied）。其他 deny 出口（`token_ip_denied`、invoke 能力不足、root.action）共用同一 `auditDenied` sink，本轮未逐一真机测。
3. **客户端 Python GIL 保守口径**：req/s 是端到端观测值（每请求新建 TCP），不是服务端极限；p95 受客户端调度影响，观察值偏保守。
4. **p99/max 尾部未达红线**：见 §4.3 注——p95 全达标，p99/max 仍有 96–231ms 尖峰，不宣称 p99 达标；红线判据按任务卡为 p95。
5. **快照口径**：固定批次「立即读数」因窗口 pending 延迟落库会低估审计 Δ；守恒以窗口滚转后的全量计数为准（§5.3）。
6. **被测对象差异**：本轮是当前 HEAD（0.1.3，含优化）现场编译；基线为 0.1.2 仓库副本。差异即验证目标，非口径漂移。
7. **未做** pprof/syscall 直测、未 bump/发版、未 push、未碰生产代码。

---

## 9. 清理回读（命令 + 退出码 + 原文）

harness 的 `finally` 块对隔离实例 SIGTERM + `wait(timeout=10)`（原文 `shutdown={"sigterm":"ok","exit":0}`），随后手工删除整树：

```
$ ss -ltn | grep ':55171 '        → 55171 FREE
$ pgrep -af kored-live            → no kored-live process
$ rm -rf .tmp/audit-deny-opt-live → exit=0
$ test -e .tmp/audit-deny-opt-live && echo STILL_EXISTS || echo GONE  → GONE
$ sha256sum bin/kored             → a6d0ebeb...729c9（与测试前一致，宿主 0.1.2 未覆盖）
$ curl 127.0.0.1:8787/-/healthz   → HTTP=200（主实例全程未受影响）
```

已删净的临时资产：`.tmp/audit-deny-opt-live/` 整树（临时 0.1.3 二进制、隔离 config/state/run/log、空索引、一次性 `harness.py`（含 `__pycache__`）、`results.json`、初始凭据文件）。唯一保留物为本报告。

```
$ grep -nEi '(password|secret|token)[[:space:]]*[:=]...' .agents/verify/audit-deny-opt-live.md
  → no plaintext credential pattern
$ GOPROXY=off make secret-check   → exit=0  secret-check: 0 FAIL / 25 处匹配（占位写法均合规）
```

报告内只有 token id 哈希前缀（`token:dfe5e2...` 已截断脱敏），无明文口令/token。

---

> 本轮唯一写入文件为本报告（`git add` 精确路径 + `git commit -s`，`[agent:audit-deny-opt-live]`）；未 push / 未联网业务 / 未启主流程 CLI / 未碰宿主实例。verifier 由 lead 另派。
