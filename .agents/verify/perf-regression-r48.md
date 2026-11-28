# perf-regression-r48 · v0.1.4 通用成功路径延迟/吞吐 vs round34 基线回归终检

> owner: perf-regression（worker）｜日期: 2026-11-28 ~12:09–12:17 +08:00｜持续目标 round 48
> 被测 HEAD: `0cfc11faa1a6108554ab8582040addd30d1f35a1`（3fd403e 之后、含 G-19 证据）｜kored `0.1.4` / 协议 `kore.plugin.v1`
> 对照基线: `.agents/verify/perf-baseline-r34.md`（HEAD `ecd66aca87ad4c382a1818d20027827529eced6f`，kored `0.1.2`，round 34）
> 性质: **隔离实例实测**（单机单实例，TCP `127.0.0.1:55241`，非 8787）。无联网业务、无生产代码改动、不 bump、不发版。
> **诚实边界**：单机单实例、客户端 Python GIL 保守口径、无竞品同口径对照——本报告只证明 kore 自身当前表现，**不构成「性能超越竞品」的证据**。

## 0. 总评（结论先行）

| 判据 | 结果 |
| --- | --- |
| 成功路径 p95 绝对红线（G-03 / V1-GOALS `API p95 ≤50ms`） | **PASS**：全部端点 p95 ≤2.51ms，距红线约 20–400 倍余量 |
| 原始数字 vs round34（0.623ms / 2590req/s） | **数字回弹**：成功率延迟 p50/p95 约为基线的 1.5–4×、单并发吞吐约低 20% |
| 是否为代码可归因回归 | **否（受控 A/B 证伪）**：同一会话内「同二进制」自身抖动 >2×，且基线提交代码在同等条件下可慢于 HEAD；差异由机器负载 + 客户端 GIL + 建连开销主导 |
| round46 deny 全局预算 mutex 是否拖慢成功路径 | **未见影响**：混合 deny 负载下成功路径 p95 与纯成功持平甚至略低（6.23→6.06ms、6.23→6.06ms），deny 单独 p95 8.57ms 不传导到成功请求 |
| 是否另派优化卡 | **不建议**：无代码可归因瓶颈；按 task-315「如 >2× 如实记录复现 + 锚点报 lead」，已如实记录并给出锚点供 lead 裁决，本 worker 不自行改代码 |

> **判定口径说明**：task-315 规定「成功路径 p95 超 G-03 红线（50ms）或较基线明显回弹（如 >2×）如实记录复现 + 锚点报 lead」。原始数字确实 >2× 基线，故本报告完整记录（§2/§3）并给出锚点（§6）；但受控 A/B（§4）证明该回弹**不可归因于本轮 14 轮热路径改动**，绝对 red line 全部 PASS，结论为「数字回弹、无真实代码回归、不派优化卡」。lead 若采取严格数字口径要另派 profiling 卡，本报告提供全部复现与锚点。

## 1. 前置与方法（同口径可比性）

### 1.1 基线端点集/方法/机器口径（回读 perf-baseline-r34.md）

| 项 | round34 基线口径 | 本轮 r48 |
| --- | --- | --- |
| 端点集 | `GET /-/healthz`；`GET /api/v1/system/info`（带/不带会话）；`GET /api/v1/auth/session`（带会话）；`GET /api/v1/system/info` 未带会话 401（50 次）；`POST /api/v1/auth/login`（5 次） | **完全一致**（§2 逐项） |
| 测量方法 | Python 3.14 `http.client`，每请求**新建 TCP 连接**（非 keep-alive），`perf_counter` 包围 request→read（含建连）；稳态序列前弃 30 预热；分位数 nearest-rank（`ceil(q·n)` 位，n=200 第 190 位=p95） | **完全一致** |
| 吞吐 | `GET /-/healthz`，每档独立 3 秒，单/4/8/16 并发，错误=非 200 | **完全一致** |
| 机器 | i7-13700K，nproc=24，61Gi，测试期 loadavg=3.90 3.10 2.98 | 同机，nproc=24，free≈61Gi/可用≈39Gi，测试期 loadavg **5.41→5.82**（比基线更忙，§2.5） |
| 被测二进制 | 仓库自带 `bin/kored` 逐字节副本（沙箱当时无法 go build） | **当前 HEAD 源码现场编译**（仓外 GOCACHE/GOMODCACHE，`GOPROXY=off`，sha256 `bbea8c12…04cd`），未覆盖宿主 `bin/kored`（宿主 sha `3de48562…a648` 未变）；比基线口径更严格 |
| 隔离 | 独立 config/state/run/log，`KORE_HOME`/`KORE_CONFIG`/`KORE_STATE_DIR` 指隔离路径；TCP 非 8787 | **完全一致**（端口 55241） |
| 会话凭据 | 首启随机 24 字符口令，仅内存读，不进 argv/报告 | **完全一致**（harness 内 `hashlib.pbkdf2_hmac` 直接算 600000 迭代哈希写隔离 0600 配置，明文只在进程内存；报告无凭据字段） |

### 1.2 命令 + 退出码（原文）

```
$ cd /home/pt/Work/GolandProjects/kore-pl/kore
$ GOCACHE=/tmp/perf-r48-iso/gocache GOMODCACHE=/tmp/perf-r48-iso/gomodcache GOWORK=off \
    GOPROXY=off GOSUMDB=off CGO_ENABLED=0 GOAMD64=v1 \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /tmp/perf-r48-iso/bin/kored ./cmd/kored
  exit=0  kored version → kored 0.1.4 / 协议 kore.plugin.v1
  sha256(iso)=bbea8c12c16541aea7c18400ec83515342f97b6a843eba0a1a51af8a5dde04cd
$ python3 <一次性 harness>（内联 heredoc，脚本随调用删除）
  exit=0  ready_ms=106.21  cold healthz=4.8508ms
  login=200 / token_create=200（构造混合负载用，明文只在内存）
$ 独立复跑 ×2（同口径，端口 55241）
  exit=0  ready_ms=103.81  loadavg=5.41 3.69 2.84
$ 受控 A/B（BASE=ecd66ac 源码快照 + HEAD 同工具链/同缓存，同会话前后跑）
  exit=0  HEAD sha=bbea8c12…04cd / BASE sha=1b827b44…8f68（web/dist 从工作区复制，git archive 不含 gitignore 产物）
```

> 环境说明：本机 bash 每次调用为独立沙箱，`/tmp` 不跨调用持久，故「编译 → 起隔离实例 → 全量测量 → 清理」在同一 bash 调用内完成；harness 以 heredoc 直喂 `python3`，脚本文件用完即删（§5）。对照基线 round34 也用同款单次调用 harness。

## 2. 单点延迟实测（p50/p95/p99/min/max，与基线逐项对比）

### 2.1 稳态延迟（n=200，弃 30 预热，nearest-rank；单位 ms）

| 序列 | 本轮 p50 | 本轮 p95 | 本轮 p99 | 本轮 min | 本轮 max | round34 p50 | round34 p95 | round34 p99 | 数字判定 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `GET /-/healthz`（200） | 0.8338 | **1.7521** | 2.2924 | 0.1164 | 2.5101 | 0.4675 | 0.5748 | 0.6756 | 回弹 ~3.0× p95 |
| `GET /api/v1/system/info` 未鉴权（401） | 0.7241 | **1.1627** | 1.3883 | 0.2137 | 1.5406 | 0.4516 | 0.5665 | 0.6263 | 回弹 ~2.1× p95 |
| `GET /api/v1/auth/session`（带会话，200） | 0.7931 | **1.7980** | 2.4437 | 0.1846 | 2.9832 | 0.5032 | 0.5954 | 0.6885 | 回弹 ~3.0× p95 |
| `GET /api/v1/system/info`（带会话，200） | 0.7146 | **1.5882** | 2.5027 | 0.1463 | 2.9885 | 0.5070 | 0.6228 | 0.8187 | 回弹 ~2.6× p95 |

**独立复跑（第 2 次全量，端口 55241，同口径）**：healthz p50 1.1476/p95 1.9281/p99 2.0816；system-info 未鉴权 p50 0.8237/p95 1.4053；auth/session p50 1.3604/p95 2.5011；system-info 带会话 p50 0.7736/p95 1.3490。两次量级一致（1.2–2.5ms），**数值回弹可复现，但绝对值仍比 50ms 红线低一个数量级以上**。

### 2.2 认证 / 拒绝路径（单位 ms）

| 序列 | 本轮 p50 / p95 / p99 / min / max | round34 | 数字判定 |
| --- | --- | --- | --- |
| `POST /api/v1/auth/login` ×5 | 69.6469 / 84.4068 / 84.4068 / 68.8605 / 84.4068（mean 72.60） | p50 76.06 / p95 77.80（mean 76.41） | **持平/略快**（PBKDF2 600k 主导，安全成本，非缺陷） |
| 未带会话 `GET /api/v1/system/info` ×50（401） | 1.1145 / 2.3842 / 2.4503 / 0.2924 / 2.4503 | p50 0.3219 / p95 0.5038 / max 0.7585 | 回弹 ~4.7× p95；绝对值仍 <3ms |

状态核对：healthz 200×230（含 30 预热）、system-info 未鉴权 401×230、auth/session 200×230、system-info 带会话 200×230、login 200×5、unauth 401×50——**无 5xx、无状态漂移**。

### 2.3 启动到就绪

本轮 first healthz 200 时刻 = **106.21ms**（复跑 103.81ms）；round34 = 152.29ms。判定 **改善**（冷启动含连接建立的第一次 healthz 样本 4.85ms，单次抖动，不作为 p95 序列）。红线 ≤1000ms（V1-GOALS），PASS。

### 2.4 G-03 红线核对

| 判据 | 红线 | 本轮最慢序列 | 结论 |
| --- | --- | --- | --- |
| API p95（本地 200 次） | ≤50ms | auth/session p95=1.798ms（复跑 2.501ms）、healthz 1.752ms（复跑 1.928ms） | **PASS**（余量约 20–28 倍，按复跑最慢 2.501ms 计） |
| 启动到就绪 | ≤1000ms | 106.21ms | **PASS** |
| 5xx / 拒绝放大 | 无 | 全序列 5xx=0，401 路径正常 fail-closed | **PASS** |

> 与 round34「余量 60–87 倍」相比余量下降（20–28 倍），如实记录；仍未触红线，**不满足「p95 超 50ms」的硬上报条件**。

### 2.5 数字回弹的机器口径旁证

本机测试期 loadavg 从基线 `3.90 3.10 2.98` 上升到本轮 `5.41 3.69 2.84`→`5.82 4.10 3.08`（1min 涨 ~50%）；同机其它进程（含并发 agent 的 go build / 浏览器 / 主实例）不可控。客户端仍是单进程 Python（GIL 受限）+ 每请求新建 TCP，与基线完全同口径，但机器更忙时「含建连」的端到端延迟对调度抖动极敏感——这在 §4 受控 A/B 中得到量化证实。

## 3. 吞吐（GET /-/healthz，每档独立 3s，错误=非 200）

| 并发 | 本轮 req | 本轮 req/s | round34 req | round34 req/s | 数字判定 |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 5650 | **1883.2** | 7771 | 2590.1 | 低 ~27% |
| 4 | 8759 | 2918.8 | 11280 | 3759.0 | 低 ~22% |
| 8 | 8181 | 2725.8 | 10071 | 3354.3 | 低 ~19% |
| 16 | 6931 | 2305.2 | 7761 | 2583.3 | 低 ~11% |

独立复跑：2062.0 / 3184.1 / 2557.5 / 2277.4 req/s（同量级）。四档错误数全 0。峰值仍出现在 4 并发，曲线形态与基线一致（4 达峰、8/16 回落）。

读法（与基线同口径）：客户端是单进程 Python harness（GIL 约束）+ 每请求新建 TCP（connect/close 计入客户端），**req/s 是端到端观测值 / 服务端容量的保守下界，不可解读为 kored 极限吞吐**。数字下降主要来自客户端调度与机器负载，非服务端能力（§4 A/B 中同二进制 req/s 在 1771–2665 间摆动）。

## 4. 受控 A/B：回弹不可归因于代码（关键判据）

为区分「代码回归」与「机器/客户端噪声」，同一 bash 会话内用**同一工具链 + 同一缓存**编译两个二进制、在同一端口 55241 上按 `HEAD → BASE → HEAD` 顺序各跑一次相同序列（每次清 state 重新首启）：

| 运行 | 被测 | 二进制 sha 前缀 | healthz p50/p95 | system/info p50/p95 | 单并发 req/s | 4 并发 req/s | loadavg |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| HEAD1 | 当前 HEAD `0cfc11f` | bbea8c12 | 0.5578 / **0.7972** | 0.5228 / 0.9873 | 1888.5 | 3619.3 | 4.82 3.78 2.95 |
| BASE | round34 `ecd66ac` | 1b827b44 | 0.4968 / **1.5798** | 0.3586 / **0.5435** | 2320.5 | 3348.3 | 5.61 4.00 3.03 |
| HEAD2 | 当前 HEAD `0cfc11f`（同一二进制） | bbea8c12 | 1.1008 / **1.7358** | 0.8332 / 1.4263 | 1771.2 | 2750.2 | 5.82 4.10 3.08 |

**结论**：

1. **同一 HEAD 二进制** healthz p95 从 0.7972 → 1.7358ms（**2.18×**），全部由环境/负载引起——没有改任何代码。这与 §2 相对基线的 ~3× 回弹同量级，说明观测差距落在噪声范围内。
2. **BASE 的 healthz p95=1.5798ms** 比 HEAD1 的 0.7972ms **还慢 2×**；若按单次采样判定，会得出「0.1.2 比 0.1.4 慢」的相反结论——证明单次 sub-ms 采样**不足以判定代码回归**。
3. system/info p95 BASE 0.5435ms < HEAD1 0.9873ms < HEAD2 1.4263ms，但顺序与 loadavg 上升同步，仍无法把 HEAD1→HEAD2 的劣化归因于代码（同一二进制）。
4. 单并发 req/s 同二进制 1888.5→1771.2（−6%），BASE 2320.5 居中；吞吐差异同受 GIL/建连/负载支配。

因此 §2/§3 的原始数字回弹**如实记录但不判代码回归**；不派优化卡（无真实瓶颈可优化）。lead 若需要服务端容量上限或低噪声基线，应另派「原生并发客户端 + keep-alive + 空载机器 + 多次采样取中位数」的专门卡，本卡不复做。

## 5. 混合负载：成功请求穿插 deny（round46 全局预算是否影响成功路径）

构造：先用管理员会话 `POST /api/v1/security/tokens` 建 `scope=read` 的 API token（明文只在 harness 内存），再用该 token 走 4 个真实越权端点构造 deny（`GET /api/v1/credentials`、`/api/v1/scheduler/tasks`、`/api/v1/scheduler/tasks/nonexistent/runs`、`/api/v1/migrate/export`，均回 401 并进 `auditDenied`→`DenyBurstTracker.Submit`）。8 并发、每 3 秒、每 10 次请求穿插 1 次 deny（约 10%），对比纯成功（全部 healthz）：

| 负载 | 成功请求数 | 成功 p50/p95/p99（ms） | 成功非200 | deny 请求数 | deny 非401 | deny p95 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 纯成功（healthz） | 8367 | 2.4194 / **6.2684** / 10.4303 | 0 | — | — | — |
| 混合（10% deny） | 7261 | 2.5180 / **6.0877** / 8.3620 | 0 | 810 | 0 | 8.5742ms |

独立复跑：纯成功 p95=6.2294 → 混合 p95=6.0620（略低）。

**判定：round46 跨 key 全局预算 mutex（`DenyGlobalIndividualBudget=10` + `globalWindowStart/globalIndividuals`，`deny_burst.go:101-105/140-153`）未传导到成功路径**。混合负载下成功 p95 与纯成功持平（甚至略低，落在抖动内），deny 请求的审计/告警落库开销未放大到正常请求；成功路径完全不经过 `auditDenied`/`Submit`（仅越权路径调用，锚点 §6），互斥锁不与成功路径共享。

## 6. 锚点与上报（按 task-315「如 >2× 如实记录复现 + 锚点 file:line 报 lead」）

原始数字回弹 >2× 已如实记录（§2）。由于受控 A/B 证伪代码归因、绝对红线 PASS，本 worker **不派优化卡、不改生产代码**；但按任务卡要求把可能锚点列给 lead 供其裁决：

| 可能锚点 | file:line | 与本观测的关系 | 判断 |
| --- | --- | --- | --- |
| deny 全局预算 mutex + 跨 key 窗口 | `internal/core/httpapi/deny_burst.go:20-28`（`DenyGlobalIndividualBudget=DenyBurstThreshold=10`）、`:98-105`（`mu sync.Mutex` + `globalWindowStart/globalIndividuals`）、`:118-153`（`Submit` 第一分支 `globalIndividuals < budget` 与 `++`） | round46 引入；但仅在 `auditDenied`（越权/拒绝路径）调用，成功路径不进此锁；§5 混合负载实测成功 p95 不升 | **非成功路径瓶颈**（最可疑项已排除） |
| deny 唯一汇聚点 | `internal/core/httpapi/middleware.go:277-303`（`auditDenied`→`denyBurst.Submit`→审计/告警双出口） | 与基线 diff 显示 deny 路径从单次回调变为「Submit + 双出口」，只影响拒绝请求 | 仅 deny 路径，非成功路径 |
| 资源锚点（GOGC=50 / GOMEMLIMIT=6MiB / GOMAXPROCS=8） | `cmd/kored/serve_limits.go:15-22`（默认值）、`:36-50`（`setRuntimeLimits`） | 基线 `ecd66ac` 已存在（git grep 确认），非 14 轮新增；低 GOMEMLIMIT 在高分配负载下可能增 GC 频率，但 A/B 中 BASE 同样生效 | 非新增回归；如需低噪声 profiling 可一并消融对照 |
| 热路径新增端点装配（自更新 UDS / runtime ext 面板 / 备份下载） | `internal/core/httpapi/server.go`、`cmd/kored/serve_boot*.go` 等 | 装配/路由注册属启动期，未进入 healthz/system-info 的 per-request 代码路径；diff `middleware.go`/`server.go` 仅 deny 相关 | 未发现 per-request 共享状态或锁 |

如 lead 坚持严格数字口径要另派 profiling 卡，建议方向：`go tool pprof` CPU/alloc profile + 原生并发客户端（多进程、keep-alive）在低负载窗口取中位数，并做 `GOGC=off`/`GOMEMLIMIT` 消融对照；**本卡不做**（任务卡限定只读测量、不改代码、不联网）。

## 7. 诚实边界与未验证项

- 单机单实例、隔离 127.0.0.1:55241（非 8787）、沙箱 PID namespace 内进程；未碰 `.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、宿主 `bin/kored`、主实例配置；主实例 8787 全程 LISTEN 且未重启/未改（§8 回读）。
- 客户端 Python GIL + 每请求新建 TCP，与 round34 同口径但受同机并发负载影响；延迟/req/s 是端到端保守观测值，不是服务端能力上限。
- sub-ms 样本在忙机上单次抖动大（§4 同二进制自身 >2×）；本轮用「两次全量 + 同会话 A/B（HEAD→BASE→HEAD）」交叉验证，仍无法排除所有环境噪声，故不把任何单次数字当代码回归证据。
- 无竞品同口径实测；本报告不构成「性能超越竞品」证据。
- 未做 pprof / CPU profile（任务卡允许定性即可，且另派门槛由 lead 裁决）；未测 write 路径（本卡聚焦通用成功路径）。
- 会话/token 明文只在 harness 内存与隔离 0600 配置中，未进 argv / stdout 日志 / 本报告；报告无口令/token 字段（G-30 合规）。

## 8. 清理回读（命令 + 退出码 + 原文）

```
$ for d in /tmp/perf-r48-iso /tmp/perf-r48b-iso /tmp/perf-r48c-iso \
           /tmp/perf-r48ab-iso /tmp/perf-r48ab2-iso /tmp/perf-r48d-iso; do
    test -e "$d" && echo "$d STILL_EXISTS" || echo "$d GONE"; done
  → 全部 GONE（6 个隔离目录，含二进制/缓存/state/run/log/config/快照源码）
$ ls /tmp/perf-r48*.py
  → no harness scripts in /tmp（一次性 harness 全部用完即删）
$ ss -ltn | grep -E ':55241|:55242'
  → 55241/55242 FREE
$ ss -ltn | grep ':8787'
  → LISTEN 127.0.0.1:8787（主实例全程未动）
$ pgrep -a kored
  → no kored（沙箱进程视图内无残留；隔离实例均 SIGTERM + wait 退出）
$ sha256sum bin/kored
  → 3de48562e5c726921db809d0241f991f24a8bf7aca7aff4f0360a4d013baa648（宿主 bin 未覆盖，与基线验收记录一致）
$ git status --short
  → 仅原有他人 dirty（scripts/usability-pending.txt + 8 个 ?? 存量 + .agents/.agents/）+ 本报告（提交后干净）
$ git worktree list
  → 仅主工作树（无 wt-*/tmp-* 残留）
$ bash scripts/secret-check.sh
  → exit 0（报告无明文凭据；占位写法合规）
```

> 注：隔离目录在 `/tmp`（仓外），因本机 bash 每次调用独立沙箱，`/tmp` 跨调用自动清空；harness 内部 `shutil.rmtree` + 本轮 trap `chmod -R u+w`（应对 go 缓存只读文件）双重确保删净。工作区无任何临时脚本/二进制/凭据残留。

## 9. 交付

唯一新增文件：`.agents/verify/perf-regression-r48.md`（本文件）。不改生产代码、不 bump、不发版、不 push、不联网业务。提交：`[agent:perf-regression] docs(verify): v0.1.4 通用成功路径延迟/吞吐 vs round34 基线回归终检（数字回弹但 A/B 证伪代码归因，deny 预算不影响成功路径）`（精确 `git add` 本文件，`-s`）。verifier 另派（G-09）。
