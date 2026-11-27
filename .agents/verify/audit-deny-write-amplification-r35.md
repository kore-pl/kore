# audit-deny-write-amplification-r35 · 审计 deny 写放大微基准（round 35）

> owner: audit-amp-r35（worker）｜日期: 2026-11-28 ~03:53 +08:00｜持续目标 round 35
> 任务: task-261｜HEAD: `526d2ace17e9211e2a2bd41a29fd233bbb197320`｜被测二进制: 仓库自带 `bin/kored`（v0.1.2 / 协议 kore.plugin.v1）逐字节副本，sha256 `a6d0ebeb9174b44b7eac80c7fc6c24ba25daad073e921e470d1cf0d520f729c9`（副本与原件一致）
> 性质: **隔离实例实测**，命令 + 退出码 + 原文数据齐备；无联网、无竞品、无生产代码改动、不 bump/不 push。

> **诚实边界**：单机单实例；本轮用「read 范围 API token 调仅 system:admin 可见的端点」触发了**真实 capability.denied**（服务端 capResolver 判定能力不足后走 `auditDenied` 落库），不是伪造/替代路径；但该路径只是多个 deny 出口中的一个（`token_ip_denied`、invoke 能力不足、root.action 拒绝等共用同一 `auditDenied` sink，未逐一测）。无竞品同口径对照——本基线只证明 kore 自身当前表现，**不构成「超越竞品」证据**。

## 0. 前置回读（task-261 要求，避免误解/重复）

只读回读两份前置文档，确认论断与未覆盖范围：

| 文档 | 与本卡相关的原文论断 | 本卡定位 |
| --- | --- | --- |
| `perm-system-cost.md:165` | 「每次拒绝 = 1 条 audit（bbolt `Update`，`NoSync:false` 即 fsync）+ 1 条 alert（`PutAlert` 再读改写）；**deny 路径无 burst 合并**（合并只覆盖 `recordInvokeAudit`）；audit 保留 90 天**未实现**」；口径「确定（代码）/ 需实测（QPS 与日增字节）」 | 本卡测 QPS / 每请求审计记录增长 / 并发劣化，坐实或修正该论断 |
| `perm-system-cost.md:206` | 「审计写放大……不会在功能验收时暴露，只会在长期运行后以磁盘/延迟形式出现」 | 本卡短窗微基准直接暴露延迟与写事务 |
| `perf-baseline-r34.md:122` | 「`perm-system-cost.md` 提的『审计 deny 路径 fsync 写放大 QPS』仍需单独微基准，不在本卡范围」 | 本卡正是该遗留项；round34 只测成功路径（healthz/system/info/alerts 写） |

**结论**：无重复。round34 唯一未覆盖的性能+安全交叉项由本卡承接。

## 1. 方法、环境与隔离（命令 + 退出码）

| 项 | 值 |
| --- | --- |
| 机器 | 13th Gen Intel i7-13700K，`nproc`=24，`free` 61Gi / 可用约 42Gi，测试时 `/proc/loadavg`≈2.0（非空载） |
| 工具链 | `go version go1.26.8 linux/amd64`；Python 3.14.4 `http.client` + `ThreadPoolExecutor`（一次性 harness，用完删净） |
| 被测二进制 | 仓库自带 `bin/kored` → 逐字节复制进 `.tmp/audit-amp-r35/kored-amp`；sha256 原件==副本（见上） |
| 为何不 go build | 沙箱内 Go build cache / mod cache 只读，round34 已实测 `go build` exit=1（`read-only file system`）；沿用已构建产物副本口径，与 r34 一致 |
| 隔离实例 | 独立 config/state/run/log 全落 `kore/.tmp/audit-amp-r35/`；`KORE_HOME`/`KORE_CONFIG`/`KORE_STATE_DIR` 均指向隔离路径；TCP `127.0.0.1:55161` + 独立 UDS；`profile: portable`；空 `index_dir` |
| 未触碰 | 8787 主实例、`.kore-local-*`、宿主 `data/initial-admin-credential`、`bin/kored`（只读复制）、任何网络出站 |
| 会话凭据 | 首启自动生成随机口令落隔离 `state/initial-admin-credential`（0600），harness 仅内存读取；创建 read token 明文只在内存，**不进 argv / 不进 results.json / 不进日志/报告**（已用脚本比对确认口令与 token 均不在落盘结果中） |

隔离配置（原文，`.tmp/audit-amp-r35/isolated.yaml`，口令哈希为脱敏占位显示）：

```
profile: portable
server:
  addr: "127.0.0.1:55161"
  socket: "<isolated>/run/kore.sock"
auth:
  session_ttl: "12h"
  cookie_secure: "auto"
  admin_password_hash: "***"（首启生成，报告脱敏）
  admin_username: "admin"
  initialized: true
  must_change_password: true
paths:
  state_dir: "<isolated>/state"
  run_dir:   "<isolated>/run"
  log_dir:   "<isolated>/log"
  index_dir: "<isolated>/empty-index"
```

命令 + 退出码（harness 一次进程内完成实例生命周期 + 全部请求， byproducts 落 `results.json` / `sustained.json`）：

```
$ sha256sum bin/kored .tmp/audit-amp-r35/kored-amp
  exit=0  两行 sha256 完全相同 a6d0ebeb...729c9
$ ss -ltn | grep ':55161 '     （测试前）
  → 55161 free
$ pgrep -a kored               （测试前）
  → no kored
$ python3 .tmp/audit-amp-r35/harness.py
  exit=0  startup.ready_ms=54.036  shutdown={'sigterm':'ok','exit':0}
          login_status=200  token_create_status=200  verify_deny=401  verify_success=200
$ python3 .tmp/audit-amp-r35/sustained.py
  exit=0  shutdown={'ok':True,'exit':0}  （5s×3 并发×2 路径）
$ python3 harness.py  第二次复跑（复现性）
  exit=0  deny p50 11.1004→11.4745 / p95 14.0444→14.0539（两轮同量级）
```

> `startup.last_err` 字段保留首次轮询的 `ConnectionRefusedError`（进程尚未 listen 的第一拍），不是失败；`ready_ms` 在首次 200 时打点，与 r34 口径一致。SIGTERM 后 `wait(timeout=10)` exit=0，进程已停。

## 2. 拒绝路径构造：真实 capability.denied（非替代路径）

单管理员模式默认 `CapabilityResolver` 对任意会话返回 6 项全权（`server.go:207-229`、`invoke_capability.go:104-106` 自认「检查在生产路径恒通过」），**会话方式无法触发真拒绝**。本卡改用系统自带的 **read 范围 API token**（`defaultCapabilityResolver` 对 read token 只返回 `system:read/net:read/proc:read`，`server.go:212-220`）调用 `GET /api/v1/credentials`（要求 `system:admin`，`handlers_credentials.go:66-69`）——服务端 `hasCapability(granted,"system:admin")` 判定失败后走 `auditDenied`，是**真实 RBAC 能力拒绝**。

原文验证（results.json）：

```
verify_deny   = 401 {"code":"E_UNAUTHORIZED","message":"越权：凭据管理需要 system:admin 能力","detail":"system:admin"}
verify_success= 200 {"os":"linux",...}   # 同 read token GET /api/v1/system/info（无需 admin）
audit 抽样（capability.denied 最新一条）：
{"at":"...","subject":"token:<id>","action":"capability.denied","plugin":"credentials",
 "target":"","result":"denied","detail":[{"key":"reason","value":"需要 system:admin 能力"}]}
```

成功对照组 `GET /api/v1/system/info` 为纯内存读 + 新连接（无审计写；`noteSlotAlerts` 常驻数 0 不写告警），两路径用**同一 token / 同一连接策略 / 同一进程**，只差「是否触发审计写」。

写链路（代码事实，供归因）：

```
handlers_credentials.go:22-26  → auditDenied(subject,"credentials","","","需要 system:admin 能力")
middleware.go:274-282          → capAuditor(...) + noteDeniedAlert(...)
cmd/kored/serve_audit.go:71-83 → db.PutAudit(AuditRecord{Result:denied,...})
internal/core/store/audit.go:60-79 → s.Update(bbolt 写事务，NoSync:false 提交即 fsync)
internal/core/httpapi/alerts.go:106-118 → noteDeniedAlert → recordAlert → PutAlert（每次拒绝都调用）
internal/core/store/alerts.go:85-107,109-141 → PutAlert 写事务内 mergeAlert（同 title+source 5 分钟窗口 delete+rewrite + count++）
```

## 3. 单请求延迟（并发 1，fresh TCP connection，n=200/路径，预热 10 次）

每请求新建连接、`time.perf_counter()` 包围 `request→read` 全链路；分位数 nearest-rank（升序 `⌈q·n⌉`）。**丢弃任何样本未做**。

| 序列 | n | min | p50 | p95 | p99 | max | mean | HTTP |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 拒绝 `GET /api/v1/credentials`（read token） | 200 | 7.4714 | **11.4745** | **14.0539** | 14.9586 | 15.3767 | 11.467 | 401×200 |
| 成功 `GET /api/v1/system/info`（同一 token） | 200 | 0.4344 | **2.4554** | **3.8507** | 4.1029 | 4.5093 | 2.391 | 200×200 |

**额外成本倍数**：p50 `11.4745/2.4554 = 4.67×`，p95 `14.0539/3.8507 = 3.65×`，均值 `11.467/2.391 = 4.79×`。

复跑一致性（第二次独立进程）：拒绝 p50 11.1004→11.4745 / p95 14.0444→14.0539；成功 p50 2.1149→2.4554 / p95 3.6358→3.8507——结论稳定，抖动在样本内。

**判读**：单请求拒绝比成功慢约 4–5 倍，绝对增量 ~9 ms（p50）。这 ~9 ms 正是「一次额外 bbolt `Update`+fsync 写审计 + 一次 `PutAlert` 读改写事务」的成本——与 round34 §5 单次告警写 **4.8163 ms**（同样 bbolt fsync）同量级，两次写事务叠加 ≈ 9–10 ms，归因自洽。

## 4. 写放大量化（结论先行：**线性写放大，1:1 审计记录/拒绝**）

### 4.1 审计记录数 & 告警记录数（GET 审计/告警端点，admin 会话计数）

对并发 1/4/16 各发 N=300 次拒绝，前后读 `GET /api/v1/audit?action=capability.denied` 的 `total`（筛选后分页前精确计数）与 `GET /api/v1/alerts` 的 `count`：

| 并发 | 拒绝请求数 | audit 前→后 | audit Δ | alerts 前→后 | alerts Δ |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 300 | 1322→1622 | **+300** | 1→1 | 0 |
| 4 | 300 | 1622→1922 | **+300** | 1→1 | 0 |
| 16 | 300 | 1922→2222 | **+300** | 1→1 | 0 |

**严格 1:1**：每次拒绝恰好多一条 `capability.denied` 审计（无合并、无丢失、无重复），坐实 `perm-system-cost.md:165` 的「audit 每次拒绝 1 条、无 burst 合并」。

**对 alert 部分的修正**：`perm-system-cost.md:165` 称「+ 1 条 alert（PutAlert 再读改写）」，本轮实测告警**记录数不增长**（恒 1）——持久层 `mergeAlert`（`store/alerts.go:109-141`）在同一 title+source 的 5 分钟窗口内 delete+rewrite、`count++`，故告警库不会线性膨胀。但**`PutAlert` 每次拒绝仍被调用、仍走一次读改写写事务 + fsync**（`alerts.go:78-95`），因此写 I/O 成本仍是「2 个 bbolt 写事务/拒绝」，只是 alert 记录数被合并收敛。这是「记录数不放大、写事务仍放大」的区别。

### 4.2 审计库文件大小增长

`stat state/state.db`（bbolt 按页批量预分配，故文件大小阶跃增长，精确增长以 4.1 的记录数为准）：

| 并发 | 拒绝前 | 拒绝后 | Δ | 同 N 成功只读 Δ |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1048576 | 1048576 | 0（落在已分配页内） | 0 |
| 4 | 1048576 | 2097152 | +1048576（+1 MiB） | 0 |
| 16 | 2097152 | 2097152 | 0（落在已分配页内） | 0 |

另一次 5s×3 并发稳态压测后 `state.db` 达 4194304（4 MiB），累计审计记录 525+561+629=1715 条 —— 按此口径每条约 2–3 KiB 的**文件空间占用含 bbolt 页碎片/空闲页**，实际 JSON 值约 200 B/条。结论：**审计库单调增长、无并发写时的回收**，长期高频拒绝会持续吃磁盘（保留期清除见 §5）。

### 4.3 拒绝 vs 成功吞吐（固定 N=300 与 5s 稳态两套口径）

固定 N=300（含连接开销，Python GIL 客户端，保守下界）：

| 并发 | 拒绝 req/s | 成功 req/s | 倍数（成功/拒绝） | 拒绝 p50(ms) | 拒绝 p95(ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 98.91 | 767.90 | 7.76× | 9.82 | 14.14 |
| 4 | 111.64 | 2460.63 | 22.04× | 33.37 | 44.38 |
| 16 | 109.17 | 1747.77 | 16.01× | 145.88 | 158.02 |

5s 稳态（各档跑满墙钟 5s，更能反映持续写入的饱和点；`sustained.json`）：

| 并发 | 拒绝 req/s（401 数） | 成功 req/s（200 数） | 倍数 | 拒绝 audit Δ |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 104.94（525） | 1797.46（8988） | 17.13× | +525（1:1） |
| 4 | 111.68（561） | 2470.25（12353） | 22.12× | +561（1:1） |
| 16 | 123.87（629） | 2769.05（13860） | 22.35× | +629（1:1） |

**并发劣化判据（写锁竞争特征）**：

- 拒绝吞吐在 1→4→16 并发下**几乎不增长**（105 / 112 / 124 req/s，波动 <20%，卡在 ~100–124 req/s 的单一写入者上限）；而成功只读吞吐随并发升到 1800–2770 req/s。这是**典型的 bbolt 单写者（single-writer）+ fsync 串行化**：加并发不涨吞吐，只排队。
- 拒绝延迟 p50 随并发 **9.82 → 33.37 → 145.88 ms**（×3.4 / ×14.9，近似随并发线性放大），p95 14.14 → 44.38 → 158.02 ms；平均延迟同向增长。按 Little 定律 `L=λW`：吞吐 λ 恒定、并发数（在途请求）增加 ⇒ 单请求等待 W ∝ 并发数——**与实测吻合，是写锁排队的判据，不是 CPU 计算瓶颈**。
- 判据表：

| 判据 | 期望特征 | 实测 | 判定 |
| --- | --- | --- | --- |
| 线性写放大 | 记录数 ∝ 请求数，比例恒定 | 1/4/16 均 300 请求 → +300 记录（1:1） | ✅ **成立** |
| 超线性劣化（写锁竞争） | 并发↑吞吐不升、延迟随并发放大 | 吞吐 105→124 持平；p50 9.8→145.9 ms，p95 14→158 ms | ✅ **成立**（延迟超线性、吞吐饱和） |
| 无写放大 | 拒绝路径不写审计/库文件不变 | 记录数 +300/300、库单调增长 | ❌ **排除** |

**综合判定：存在明确的线性审计写放大（1 条审计/拒绝），并在并发下表现为写锁串行化的超线性延迟劣化。**

## 5. 归因与 DoS 判据

**写放大花在哪（定性，有代码与数字支撑）**：

1. **审计库 fsync 主导**：每次拒绝一次 `store.PutAudit` → `s.Update` bbolt 写事务，`NoSync:false`，提交即 fsync（`store/audit.go:52-79`，注释明示）。单条审计 JSON ≈ 200 B，但一次 fsync ~数 ms，与 r34 单次告警写 4.8 ms 同量级；单请求拒绝-成功增量 ~9 ms = 审计写 + 告警写两次事务。
2. **告警写事务未省**：`auditDenied` 无条件 `noteDeniedAlert` → `PutAlert`（`middleware.go:281`、`alerts.go:78-95`），即使 5 分钟合并也仍执行一次 delete+rewrite 写事务 + fsync（`store/alerts.go:111-141`）。所以「alert 记录数不涨」≠「alert 不写盘」。
3. **锁竞争**：bbolt 全局单写事务串行；并发拒绝全部堆在同一个写锁上 → 吞吐封顶 ~100–124 req/s，延迟随并发线性放大（§4.3）。
4. **保留/容量**：审计清理走 scheduler 内置任务 `builtin-audit-clean`，默认 `audit.retention=90d`、`clean_enabled=true`、`clean_interval=6h`、`clean_batch=1000`（`config/types.go:218-226`，**已实现**，修正 perm-system-cost.md:165「保留 90 天未实现」的旧口径——该论断在后续轮次已被落地）。但清理是**按龄、按批**，没有按速率/容量的上限：短时高频拒绝（如本轮 5s 内 629 条）远快于 6h 一次、每次 ≤1000 条的清理，磁盘在此期间单调增长。

**DoS 风险判据**：

| 判据 | 阈值/口径 | 实测 | 结论 |
| --- | --- | --- | --- |
| 拒绝比成功慢一个数量级以上 | req/s ≥10× 或 p95 ≥10× | 持续 req/s 17–22×（满足）；单请求 p95 3.65×（不满足）；并发 16 拒绝 p95 158 ms | **部分满足**：持续吞吐维度超一个数量级 |
| 并发下崩塌 | 5xx / 进程退出 / 状态漂移 | 三档全 401、零 5xx、零异常；进程 SIGTERM 正常退出 | 不满足（无崩溃） |
| 触性能红线 | API p95 ≤50ms（`docs/V1-GOALS.md`） | 并发 1 p95 14 ms（PASS）；并发 4 p95 44 ms（临界）；并发 16 p95 **158 ms（超红线）** | **并发拒绝下击穿红线** |
| 磁盘无上限增长 | 单位时间审计库增长 | 1:1 记录、库单调增长、清理按龄按批（6h/≤1000） | 高频拒绝下短期可堆积 |

**结论：需优化（不是「健康」）。** 依据：①拒绝路径存在确证的 1:1 审计写放大 + 每次告警读改写写事务，持续吞吐仅为成功只读路径的 1/17–1/22；②并发 16 拒绝时 p95=158 ms，击穿 API p95 ≤50ms 红线，且吞吐封顶 ~124 req/s 呈写锁串行化；③审计无 deny 突发合并、清理只按龄按批，高频拒绝可短期堆积磁盘。触发条件是**已认证的低权 token**（非匿名）——匿名请求在 `withAuth` 短路、不写审计（round34 §3 已测 401 更快），故这是**认证后低权 DoS 向量**，不是开放的无认证放大。

**给 lead 的优化建议（本卡不自行改，另派卡）**：把 deny 审计并入 1s/10 次窗口（与 `recordInvokeAudit` 同思路），alert 在内存先合并再落库、避免每次拒绝都 `PutAlert`，并给 audit bucket 增加按量上限（问题根因与修复点见下）。

**复现锚点（file:line）**：

- `internal/core/httpapi/handlers_credentials.go:22-26`（read token 触发 `system:admin` 拒绝）
- `internal/core/httpapi/middleware.go:274-282`（`auditDenied` = capAuditor + noteDeniedAlert）
- `cmd/kored/serve_audit.go:71-83`（deny → `db.PutAudit`）
- `internal/core/store/audit.go:52-79`（`s.Update` bbolt 写事务 + fsync，无 Batch 合并）
- `internal/core/httpapi/alerts.go:78-95,106-118`（每次拒绝调用 `PutAlert`）
- `internal/core/store/alerts.go:85-107,109-141`（5 分钟读改写合并，记录数不涨但写事务不省）
- `internal/core/config/types.go:218-226` + `internal/core/scheduler/auditclean.go:137-170`（清理按龄按批、默认 90d/6h/≤1000）
- `internal/core/httpapi/server.go:212-229`（read token 只授 read 能力 → 真拒绝得以触发）

**另派优化卡建议写域**（不在本卡写域内，仅报 lead）：`internal/core/httpapi/middleware.go`（deny 突发合并）、`internal/core/httpapi/alerts.go`（内存合并后再 PutAlert）、`internal/core/store/audit.go`（可选容量上限）、相关 `_test.go`；验收需重跑本微基准对比 req/s 与审计记录增长（1:1 应被打破）。

## 6. 诚实边界与未验证项

- 单机单实例、单节点 bbolt；无竞品同口径对照，结论只证明 kore 自身当前表现。
- 真 `capability.denied` 用「read token → 仅 admin 端点」触发（凭据端点）。其他 deny 出口（`token_ip_denied`/invoke/`root.action`）共用同一 `auditDenied` sink，预期同行为，但**未逐一实测**；单管理员会话方式确实无法触发真拒绝（已按事实改用 token，非伪造）。
- 客户端为单进程 Python（GIL）+ 每请求新建 TCP 连接；req/s 是**端到端保守观测值**，不是服务端极限。服务端真实写入上限可能高于 124 req/s（客户端侧也有限制），但「加并发不涨吞吐、延迟线性放大」的写锁特征在多轮/两口径一致出现。
- 文件大小增长是 bbolt 页分配阶跃值，不是精确字节/记录；精确增长以审计记录数（1:1）为准。
- 被测二进制为仓库自带 `bin/kored` 逐字节副本（沙箱不能 go build，原因见 §1），非本轮从 HEAD 现场编译；HEAD 与该产物一致性由仓库构建纪律保证，未在本次测量中重新编译验证。
- 未做 pprof / CPU profile（任务允许定性）；fsync 归因基于代码注释 + 数字同量级推断，未直测 syscall 耗时。
- 告警记录数不增长但写事务仍发生，是本轮对 `perm-system-cost.md:165` 的**实测修正**，不是否证该文档的核心「审计写放大」论断。

## 7. 清理回读（命令 + 退出码 + 原文）

harness 两个脚本 `finally` 块均对隔离实例 SIGTERM + `wait(timeout=10)`，随后手工删除整树。收尾复核原文见交付消息；要点：

```
$ pgrep -a kored                → no kored
$ ss -ltn | grep ':55161 '      → 55161 free
$ rm -rf .tmp/audit-amp-r35     → exit=0
$ test -e .tmp/audit-amp-r35 && echo STILL_EXISTS || echo GONE  → GONE
$ git status --short            → 无本任务临时残留（harness.py / results.json / 二进制副本 / 隔离 state 全删）
```

已删净的临时资产：`.tmp/audit-amp-r35/` 整树（隔离 config、二进制副本、一次性 `harness.py`/`sustained.py`、隔离 state/run/log、`results.json`/`sustained.json`/`run2-summary.json`、`kored.stdout.log`、凭据文件）。唯一保留物为本报告。

`make secret-check` 与本报告的口令/token 脱敏核对见交付消息；报告内无明文凭据。

## 附录 · 原文样本数组（ms，未删任何样本，来自最后一轮 results.json）

**拒绝延迟 200 次（ms）**

```
12.1833, 13.8993, 11.6803, 13.6552, 10.4823, 9.2551, 8.873, 9.2078, 11.1412, 10.7302, 9.5132, 10.6481, 15.3767, 12.8709, 12.1925, 13.4421, 14.488, 14.196, 10.6983, 12.5009, 11.67, 11.2306, 11.2873, 10.0231, 10.8868, 13.65, 13.0201, 12.4251, 8.0794, 7.4714, 9.1324, 13.0808, 9.6134, 9.1272, 9.8296, 12.3499, 12.4604, 12.5903, 11.3248, 13.4506, 11.7032, 11.4359, 10.333, 11.9286, 12.2055, 11.9645, 15.2005, 12.4225, 11.6486, 13.7602, 10.9326, 10.9523, 11.2959, 12.0591, 13.3864, 12.0883, 11.4745, 11.5633, 11.0833, 10.696, 13.8213, 9.3982, 12.0541, 11.9729, 12.1807, 12.7987, 12.5198, 12.7024, 13.2242, 12.8047, 11.8327, 13.8308, 11.5718, 13.3589, 11.8609, 11.2541, 11.3385, 12.8676, 10.8274, 12.4319, 11.9301, 11.1117, 10.4341, 14.6733, 8.7354, 12.1651, 11.6814, 11.1716, 12.2355, 11.4651, 13.1133, 11.2886, 14.2056, 10.3355, 13.3231, 11.4179, 10.689, 9.1327, 10.3633, 11.6952, 11.9903, 12.676, 8.6559, 9.6104, 10.7922, 11.2161, 13.9925, 9.8631, 10.9444, 13.8449, 10.7146, 10.1167, 10.0487, 10.4509, 10.1783, 10.7177, 12.7239, 11.7971, 14.3243, 10.5613, 11.9323, 12.0187, 10.8981, 11.4657, 9.9563, 13.4894, 12.4776, 13.094, 11.0691, 11.303, 13.5197, 10.4478, 10.2098, 13.272, 12.0264, 9.0984, 10.8925, 11.9951, 12.0769, 11.3425, 8.468, 9.2362, 8.8307, 11.9875, 12.3579, 9.786, 8.3771, 8.9243, 8.817, 11.3338, 14.0539, 12.0343, 11.174, 11.6299, 13.9341, 9.1527, 8.7227, 11.0632, 9.1485, 9.0643, 9.5387, 8.4926, 10.0653, 11.1048, 12.0513, 11.9011, 14.1653, 13.4009, 10.5497, 12.6992, 14.0288, 10.7428, 8.8907, 9.3403, 9.6591, 9.3534, 9.2615, 7.5959, 9.2558, 7.7473, 9.2076, 10.6584, 10.6012, 11.106, 13.9474, 14.9586, 12.1276, 12.1958, 13.3498, 11.6953, 9.0215, 10.8173, 14.4, 13.1783, 12.636, 13.4135, 12.4063, 12.2866, 13.3666, 12.5832
```

**成功延迟 200 次（ms）**

```
3.8507, 2.1435, 2.4078, 3.1476, 0.8571, 1.0529, 1.2047, 2.6896, 1.5102, 1.9255, 1.8173, 2.9684, 3.0047, 3.5245, 2.7471, 3.0987, 2.3312, 3.0435, 3.4109, 2.2493, 2.9407, 3.1243, 3.0901, 1.5424, 2.4059, 3.0316, 3.0538, 1.5746, 0.6156, 1.1194, 1.4914, 3.6257, 1.2106, 2.1435, 2.0518, 3.4711, 3.353, 2.2924, 2.7153, 2.1951, 2.3728, 1.891, 2.4592, 3.7667, 3.7466, 2.6101, 3.9469, 3.9399, 2.7092, 2.688, 2.9371, 2.6832, 1.8863, 2.6808, 1.9814, 2.5219, 2.3938, 2.9089, 3.553, 3.5102, 0.8641, 2.384, 3.9054, 3.7736, 3.5638, 3.1046, 2.7958, 1.3593, 2.7998, 2.6321, 3.993, 4.1129, 2.6975, 2.1554, 2.779, 2.7045, 2.9471, 3.092, 2.0384, 2.0355, 2.7163, 3.6265, 2.827, 1.2707, 1.9144, 2.4742, 2.6931, 1.8191, 3.0139, 2.5749, 3.2937, 3.2832, 3.325, 2.6313, 2.7672, 2.8114, 0.9862, 1.8963, 2.2513, 2.4253, 4.5093, 1.2399, 0.5909, 1.3954, 2.823, 1.967, 1.9989, 3.1019, 2.692, 2.7394, 1.7577, 2.0174, 1.5745, 1.7559, 1.6248, 3.5478, 2.0519, 3.7485, 3.0153, 2.1543, 1.9649, 3.1249, 2.4125, 2.031, 2.3779, 2.023, 2.8703, 2.6462, 2.7063, 2.2301, 1.6628, 1.9247, 2.9469, 3.2335, 1.0389, 1.7557, 3.8522, 3.7603, 4.093, 1.6283, 0.9651, 1.2985, 1.8048, 2.0348, 1.7462, 1.4528, 1.2422, 1.2419, 2.7755, 1.9822, 3.9235, 2.7994, 2.4554, 2.2177, 2.4008, 1.2565, 2.7653, 0.9027, 0.765, 0.6777, 1.5265, 1.9701, 1.1127, 2.0606, 2.271, 3.452, 2.8207, 3.2939, 3.171, 2.2023, 2.7107, 0.9856, 0.6432, 0.521, 0.6237, 0.6349, 0.4415, 0.6296, 0.4344, 0.9981, 1.3244, 1.2557, 1.2469, 4.1029, 2.9527, 2.2166, 3.7272, 2.567, 3.761, 0.9713, 1.4315, 1.9987, 2.6511, 3.4455, 2.5246, 3.2475, 3.7967, 3.0458, 3.0846, 3.4892
```
