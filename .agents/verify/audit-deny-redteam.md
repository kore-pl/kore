# audit-deny-redteam · round46 审计 deny 突发合并对抗测试（红队）

> owner: audit-deny-redteam（worker，非 round35/36 实现者、非其 verifier，G-09）｜日期: 2026-11-28 ~10:12 +08:00｜持续目标 round 46
> 任务: task-306（先 claim）｜工作目录: `/home/pt/Work/GolandProjects/kore-pl/kore`
> 被测: 当前 HEAD `7b70e11` 现场编译二进制（fix 提交 `da1a755` 未改 `deny_burst.go`/`middleware.go`/`serve_audit.go`）；sha256 `870b54f6...b65261`，与仓库 `bin/kored` 逐字节一致
> 性质: 隔离实例真机对抗实测，逐场景命令 + 退出码 + 原文数据齐备；未碰 8787 / `.kore-local-*`、未联网、未改生产代码、未 bump/未 push。

---

## 0. 结论先行

**发现 1 个真实绕过（性能红线回弹），未发现「单 token 可无限变换 key 重新引入 1:1 写放大」的全量绕过。**

| 对抗项 | 结论 | 证据摘要 |
| --- | --- | --- |
| ① key 变换（target/plugin/capability/reason/URL） | **未发现单 token 的无限 key 膨胀**；单 read token 只能触达 **4 个固定 key** | 400 次跨端点拒绝 → 51 条审计（4 key），非 1:1；URL 可控的 confirm-token 路径对 read token 不产生审计（Δ=0） |
| ② MAX_MERGE 边界 | **未真机命中**（客户端吞吐限制），设计行为未被证伪 | 单窗内合并 count 上限实测 988；1400 拒绝 → 129 条审计、守恒 1402；转逐条由既有单测覆盖，不伪造真机数据 |
| ③ subject/IP | 不含 IP（源码 + 实测）；同一 token 稳定命中同 key 被合并；多 token 各自独立 key | 300 同 token → 12 条、1 key；60 token → 66 key，300 拒绝 p95=226.5ms |
| ④ p95 回弹（红线 ≤50ms） | ❌ **真实回弹，10/10 次越线** | 4-key 轮换 c16/N=300：p95 **79.7–105.0ms**（顺序无关）；单 key 同口径 19–41ms。修复后 22.9ms 的收益在 key 轮换下大部分丢失 |
| ⑤ 双出口守恒 | ✅ 成立 | 704 拒绝：审计 Σcount +704 == 告警 count +704 == N，精确守恒 |

**绕过性质**：不是「审计记录数 1:1 线性膨胀」（单 token 下 key 集合有界），而是**合并收益被 key 轮换抵消 → 写事务数随活跃 key 数成倍增加 → p95 重新击穿 50ms 红线**。这与 round35 修复的性能目标直接冲突，属真实对抗发现，须另派修复卡；本卡不改生产代码。

---

## 1. 前置代码研判（只读，供归因与复现锚点）

| 事实 | 源码位置 |
| --- | --- |
| key = subject+plugin+target+capability+reason，**不含 IP** | `internal/core/httpapi/deny_burst.go:24-30`、`middleware.go:277-282` |
| 每 key 独立窗口状态（map）；每次窗口滚动/flush 产生独立落库决策 | `deny_burst.go:88-92,104-155,181-207` |
| N≤10 逐条、N=11 合并 count=1、12..999 pending、≥1000 补段转逐条 | `deny_burst.go:128-153` |
| 一次 Submit 同时产出审计+告警计划，同源守恒 | `deny_burst.go:71-75,157-179`、`middleware.go:277-293` |
| 每个 outcome.Alerts 项 = 一次 `PutAlertCounted` 写事务 + 一次通知派发 | `internal/core/httpapi/alerts.go:124-140` |
| read token 只能 GET/HEAD（非 GET 在 token 门 401， Handler 不可达） | `middleware.go:133-137` |
| root-action 路径的 Bearer token 走 `pluginIdentity`，不走 API token 门 | `middleware.go:44-59`、`server.go:299-326` |
| read token 可触达的 GET deny 出口（4 个固定组合） | `handlers_credentials.go:14-29`（plugin=credentials,target=""）；`handlers_scheduler.go:77,135`（scheduler/list、scheduler/runs）；`handlers_migrate.go:278`（migrate/export） |
| URL 可控的 `plugin` 只在 root-action 路径（对 read token 不可达） | `server.go:321`、`handlers_rootaction.go:94-103` |

**推论**：单一 read token 的 key 维度全部是代码常量（plugin/target/capability/reason 均非请求参数），不存在「每次请求换一个 key」的原语；可轮换的只有 **subject**（需多 token）与 **跨端点固定 4 key**。

---

## 2. 隔离环境、编译与生命周期（命令 + 退出码）

| 项 | 值 |
| --- | --- |
| 机器 | 13th Gen Intel i7-13700K，`nproc`=24，`go version go1.26.8 linux/amd64`，Python 3.14.4 |
| 被测二进制 | 当前 HEAD 现场编译 `.tmp/audit-deny-redteam/kored-rt`，sha256 `870b54f6...b65261` == `bin/kored`；`kored version` → `0.1.3 / 协议 kore.plugin.v1` |
| 隔离实例 | 独立 config/state/run/log 全落 `kore/.tmp/audit-deny-redteam/`；`KORE_CONFIG`/`KORE_STATE_DIR`/`KORE_HOME` 指隔离路径；TCP `127.0.0.1:55191` + 独立 UDS；`profile: portable`；空 index_dir |
| 未触碰 | 8787 主实例（测试前后 healthz 均 200）、`.kore-local-*`、宿主 `data/initial-admin-credential`、宿主 `bin/kored`、任何网络出站 |
| 会话凭据 | 首启自动生成随机口令落隔离 `state/initial-admin-credential`（0600）；harness 仅内存读取；read token 明文只在内存，**不进 argv / results.json / 日志 / 本报告**（落盘仅 token id 前 6 位哈希前缀） |

命令原文与退出码：

```
$ CGO_ENABLED=0 GOAMD64=v1 GOMODCACHE=.../.tmp-acct-gomodcache \
    GOCACHE=.../.gocache-audit-deny-verify GOPROXY=off GOWORK=off \
    go build -trimpath -buildvcs=false -ldflags '-s -w -X main.version=0.1.3' \
    -o .tmp/audit-deny-redteam/kored-rt ./cmd/kored
  exit=0
$ sha256sum .tmp/audit-deny-redteam/kored-rt bin/kored
  exit=0  两行相同 870b54f6...b65261
$ ss -ltn | grep ':55191 '   → FREE；pgrep -a kored → NONE（测试前）
$ python3 -m py_compile .tmp/audit-deny-redteam/harness.py   exit=0
$ python3 .tmp/audit-deny-redteam/harness.py                exit=0
    bootstrap: ready=true ready_ms=204.403 login=200 csrf=true token_create=200
               verify_deny=401 "越权：凭据管理需要 system:admin 能力" verify_success=200
    shutdown={"sigterm":"ok","exit":0}
```

> harness 一次进程内完成「启动 → 登录 → 建 read token → 验证真 deny → 五场景 → SIGTERM」，byproducts 落 `results.json`；`last_err=ConnectionRefusedError` 为首次轮询未 listen 的首拍，非失败（与 round35/36 同口径）。

---

## 3. 真拒绝构造（非替代路径）

read 范围 API token（`defaultCapabilityResolver` 只授 `system:read/net:read/proc:read`，`server.go:224-241`）调 `GET /api/v1/credentials`（要求 `system:admin`），服务端 `authorizeCredentials` → `auditDenied` 真落库：

```
verify_deny    = 401 {"message":"越权：凭据管理需要 system:admin 能力"}
verify_success = 200  （同 token GET /api/v1/system/info）
login_status=200  token_create_status=200
```

与 round35/36 完全同口径；这是「认证后低权」向量，非伪造路径。

---

## 4. 逐场景对抗结果（命令 + 退出码 + 行为 + 是否绕过）

### 场景① key 变换（target/plugin/capability/reason/URL）

命令：`python3 harness.py` 内 `phases.key_variation_target_plugin`（一次进程，exit=0）。同一 read token 轮转 4 个 GET deny 端点各 100 次（共 400）：

```
endpoints = [/api/v1/credentials, /api/v1/scheduler/tasks,
             /api/v1/scheduler/tasks/nonexistent/runs, /api/v1/migrate/export]
denies_issued=400  records_delta=51  conserved_delta=404  distinct_keys_after=4
审计分组（原文）：
  plugin=credentials target=""         reason="需要 system:admin 能力"       25 条
  plugin=migrate     target="export"   reason="缺少 system:admin 特权能力"   13 条
  plugin=scheduler   target="list"     reason="缺少 system:admin 特权能力"   13 条
  plugin=scheduler   target="runs"     reason="缺少 system:admin 特权能力"   13 条
```

对照单 key 基线（同 token，300 次 credentials）：`denies=300 records_delta=12 conserved_delta=301 keys=1`（1 条合并 count=290）。

**URL 可控字段探测**（`phases.confirm_token_url_variation_attempt`，exit=0）：20 个不同 `{id}` 的 `GET /api/v1/plugins/probe-NNN/root-action/act/confirm-token` → 状态全 401、审计 **Δ=0**。原因：root-action 路径 Bearer token 走 `pluginIdentity`（`middleware.go:44-59`），不进 API token 门也不进 `auditDenied`；对 read token 不构成 key 变换面。

**判定：未发现单 token 的无限 key 变换绕过。** 400 拒绝仅 51 条审计（远非 1:1），key 数被锁死在 4 个代码常量组合。**不绕过（该类）**。

### 场景② MAX_MERGE 边界（单 key >1000/窗）

命令：`python3 maxmerge2.py`（fresh state，48 线程 keep-alive，1400 请求，exit=0）与 `python3 maxmerge3.py`（HTTP pipelining，24 连接×100，2400 请求，exit=0）：

```
maxmerge2: n=1400 workers=48 wall=1.3514s req/s=1036 fits_one_window=false
           snapshot(since隔离): records=129 individual=125 merged=4 conserved=1402
           merged_counts=[988, 287, 1, 1]  max_detail_count=988
maxmerge3: n=2400 conns=24 wall=2.1393s req/s=1121.86 fits_one_window=false
           records=366 individual=356 merged=10 conserved=3804 max_detail_count=988
主 harness maxmerge_boundary: n=1300 c16 wall=1.2783s req/s=1017 records_delta=73
           conserved_delta=1301
```

**判定：客户端吞吐上限 ~1100 req/s，单 key 在 1s 窗内达不到 1000 次，MAX_MERGE「≥1000 转逐条」分支未被真机直接命中**；实测合并 count 天花板 988 与逐条记录随窗口滚动增长，与该设计一致但不等于命中。诚实标注：此分支由既有单测 `TestDenyBurstMaxMergeFallsBackToIndividual`（`deny_burst_test.go:105`）覆盖，本卡**未真机验证、不伪造**。窗口内审计增长速率受控（1400→129 条），无失控。**未发现绕过（该类）**。

### 场景③ subject / IP

命令：`harness.py` 内 `subject_token_variation`（exit=0）。以管理员口令另建 5 个 read token（**需 admin 口令**，非纯低权自晋升），各发 60 次 credentials 拒绝：

```
tokens_created=5  denies=305  records_delta=65  conserved_delta=305  distinct_keys_after=9
token_id 前缀(脱敏): eeee4c / 7c5cf1 / ddd2e0 / c009c5 / 4d9ff1
审计分组：5 个新 subject 各 13 条（独立 key），原 4 key 各自累积
```

最坏情况（`python3 manytokens.py`，60 token 各一次拒绝，c16，exit=0）：

```
tokens_created=60  300 拒绝 → p50=84.1ms p95=226.5ms p99=233.8ms
audit: records=962 individual=906 merged=56 conserved=6848 distinct_keys=66
```

**判定**：key 不含 IP（源码 `deny_burst.go:24-30` + 实测无 IP 维度）。同一 token 稳定命中同 key 被合并（单 key 1:12 合并比）；**不同 token = 不同 subject key**，可成倍增加活跃 key 与写事务——但**发放 token 需 admin 口令**，纯低权 token 不能自行扩大 subject 集合。作为「持有多个 token 的调用者」模型，这是真实的性能放大面（p95 226.5ms）。**部分绕过（性能维度，依赖持有多 token）**。

### 场景④ p95 回弹（红线 ≤50ms）——**真实绕过**

命令：`harness.py` 内 `p95_under_key_rotation`；`python3 p95_repeat.py`；`python3 p95_order.py`（均 exit=0）。同口径 c16 / N=300 / Python `http.client`+`ThreadPoolExecutor` / 每请求新建 TCP（GIL 保守口径）：

| 口径 | rotation p95 (ms) | single-key p95 (ms) | 越线 |
| --- | --- | --- | --- |
| 主 harness（rotation 先） | **81.513** | 2.663（c1） | rotation 越线 |
| p95_repeat ×5（rotation 先） | 79.74 / 80.99 / 87.75 / 88.31 / 87.34 | 19.32 / 40.84 / 35.83 / 23.35 / 27.69 | rotation **5/5** 越线 |
| p95_order ×5（single 先，顺序对照） | 94.68 / 92.19 / 87.03 / 84.94 / **105.04** | 41.44 / 28.36 / 29.41 / 21.23 / 26.60 | rotation **5/5** 越线 |

**10/10 次 rotation p95 ∈ [79.7, 105.0] ms，全部 >50ms 红线；single-key 同进程同并发 19–41ms（多数达标）。顺序反转后结论不变，排除冷启动/顺序偏差。**

对比 round35/36 基线：并发 16 拒绝 p95 158ms（击穿）→ round35 修复后 22.9ms → 本轮 4-key 轮换 79.7–105ms，**性能收益大部分丢失，红线再次击穿**；60-token subject 轮换更达 226.5ms。

机制（源码）：`deny_burst.go:88-92` 每 key 独立状态 → 轮换使窗口内同时存在多个 pending 段；`deny_burst.go:181-207` 每次窗口滚动为每个 key 各产生一次 flush 决策；`middleware.go:283-292` 逐条 emit → `alerts.go:124-140` 每个 Alerts 项一次 `PutAlertCounted` 写事务 + 派发。活跃 key 数 × 写事务数，叠加 bbolt 单写者排队，抬升 p95。

**判定：真实绕过（性能红线），须另派修复卡。**

### 场景⑤ 双出口守恒

命令：`python3 dualoutlet.py`（exit=0）。变换 key 下 400 跨端点 + 300 单 key + 4 flush = 704 次拒绝：

```
denies_issued=704
alert: rows=1 count_sum 7478 → 8182  Δ=704
audit: conserved_sum 7552 → 8256     Δ=704
audit_conserved_delta == alert_count_delta == 704  → conservation_ok=true
```

**判定：守恒在变换 key 下仍成立（Σ审计 count == Σ告警 count == N），无丢计数/重复。不绕过。**

---

## 5. 绕过清单与建议（报 lead，另派修复卡；本卡不改生产代码）

| # | 绕过 | 严重度 | 复现 | 锚点 |
| --- | --- | --- | --- | --- |
| 1 | **key 轮换击穿 p95 ≤50ms 红线** | P1（性能目标回归） | 单一 read token 轮转 4 个可 deny 的 GET 端点，c16/N=300，p95 79.7–105ms（10/10）；多 token subject 轮换 226.5ms | `deny_burst.go:24-30,88-92,104-155,181-207`、`middleware.go:277-293`、`alerts.go:124-140`、`handlers_scheduler.go:77,135`、`handlers_migrate.go:278` |

**建议修复方向（不在本卡写域，供另派卡参考）**：让突发合并的落库节律受「全局/出口级」预算约束而非仅按 key 独立窗口（例：跨 key 的批量 flush 合并为一次写事务、或给 deny 审计写设统一节流/批量上限），并对告警聚合写做同样的跨 key 合并；验收须重跑本卡场景④，要求 4-key 轮换 c16 p95 ≤50ms 且守恒不破。

**未构成绕过项**：单 token 无限 key 膨胀（key 字段均为代码常量，无请求可控维度）、MAX_MERGE 分支失控（未真机命中，设计行为未被证伪）、双出口守恒破坏（精确守恒）。

---

## 6. 诚实边界

1. **单机单实例、单节点 bbolt**；无集群/多机；无竞品同口径对照，本报告只证明 kore 自身当前 HEAD 表现，**不构成「超越竞品」证据**。
2. **read token 真 deny 非多用户 RBAC**：单管理员模式默认全权，靠 read token 才触发真 `capability.denied`；G-11 明确不做多用户 RBAC。多 token subject 轮换需 admin 口令发放，不是纯低权自晋升。
3. **客户端 GIL 保守口径**：Python 单进程 + 每请求新建 TCP，req/s 与 p95 是端到端观测值，不是服务端极限；p99/max 尖峰（最高 416ms）不宣称达标，红线判据按任务卡为 **p95**。
4. **MAX_MERGE 转逐条分支未真机命中**（客户端 ~1100 req/s，单 key 1s 窗内达不到 1000），以既有单测覆盖如实标注，不伪造真机数据。
5. confirm-token URL 字段对 read token 不可达（Bearer 走插件身份），故「URL 可控 plugin 进 key」在 read token 攻击面下**未成立**；未测试 admin 会话/插件 bearer 身份下的同类变换（超出 read token 模型）。
6. **被测二进制**为当前 HEAD 现场编译且与 `bin/kored` 逐字节一致（fix 提交已包含），未 bump/发版、未 push、未碰生产代码。

---

## 7. 清理回读（命令 + 退出码 + 原文）

harness 及其派生的 `finally` 块均对隔离实例 SIGTERM + `wait`（原文 `shutdown={"sigterm":"ok","exit":0}`，部分复跑 `exit=3`/`exit=0` 为 SIGTERM 后进程退出码）。一次性脚本与全部 byproducts 已删净：

```
$ ss -ltn | grep ':55191 '                 → 55191 FREE
$ pgrep -a kored                           → no kored
$ test -e .tmp/audit-deny-redteam && echo STILL_EXISTS || echo GONE  → GONE
$ curl 127.0.0.1:8787/-/healthz            → HTTP=200（主实例未受影响）
$ sha256sum bin/kored                      → 870b54f6...b65261（与测试前一致，未覆盖）
$ git status --short                       → 无本任务临时残留（harness/results/隔离 state/二进制副本全删）
```

已删净的一次性资产：`.tmp/audit-deny-redteam/` 整树（`kored-rt` 副本、隔离 config/state/run/log、空索引、`harness.py` / `p95_repeat.py` / `p95_order.py` / `maxmerge.py` / `maxmerge2.py` / `maxmerge3.py` / `manytokens.py` / `dualoutlet.py` 及 `__pycache__`、`results.json` / `p95-results.json` / `p95-order-results.json` / `maxmerge*-results.json` / `manytokens-results.json` / `dualoutlet-results.json`、`kored.stdout.log`、初始凭据文件）。唯一保留物为本报告。

```
$ grep -nEi '(password|secret|token)[[:space:]]*[:=]....' .agents/verify/audit-deny-redteam.md
  → 无明文口令/token（仅 token id 6 位哈希前缀，非秘密）
```

---

> 本轮唯一写入文件为本报告（精确 `git add` + `git commit -s`，`[agent:audit-deny-redteam]`）；发现 1 个真实绕过已报 lead 另派修复卡，本卡不自行改生产代码。verifier 由 lead 另派。
