# G-19 空闲指标真实实例实测（task-312 · round47）

> owner: g19-idle（verifier 另派）｜日期: 2026-11-28 ~11:57–12:00 +08:00｜HEAD: `3fd403ed241b3ba1c23e987cce2a5f1d9ffee9c3`（kored 0.1.4）
> 性质：**隔离实例实测**（单机单实例，127.0.0.1:55231，非 8787）。无联网、不碰主实例运行态、无生产代码改动、不 bump、不发版。
> 结论：G-19 五项在真实跑着的 kored 上**全部 PASS**；此前的「goroutine 未测」缺口已用**真实 NumGoroutine 读数**补齐（非 Threads 代理）。

## 0. 判据来源（阶段一只读）

- `AGENTS.md` G-19：空载 60s CPU ≤60ms（≤0.1%）、goroutine ≤20、fd ≤64、出站 0、定时器仅 `scheduler`（单实例单 ticker，ADR-0019）；禁止轮询。
- `.agents/QUALITY-GATES.md:24`（G14）：`make idle`（约 65s），等价手工 `/proc/<pid>/stat` utime+stime 前后差 + `/proc/<pid>/task|status` 计数 + `/proc/<pid>/fd` + `ss -tnp`；定时器白名单 = `internal/core/scheduler/` + `cert_renew`。
- `Makefile:276-299`（`idle` 目标原文）：CPU 用 `awk '{print $14+$15}' /proc/$pid/stat`，`ms=(b-a)*1000/clk`；线程优先取 `/proc/status Threads`（**只有 Threads 不可得才回落 UDS `/api/v1/system/info` 的 goroutines**）；fd 用 `ls /proc/$pid/fd | wc -l`；出站用 `ss -tnp | grep -c kored`；定时器为 `grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ | grep -v cert_renew | grep -v '^internal/core/scheduler/'`。
- **红线 vs 目标**：上述五项都是**硬红线**（超线判未完成），不是「争取值」；与 VmRSS 8 MiB 目标（红线 16 MiB）不同，不能用「记趋势不返工」处理。

## 1. 阶段一：既有实证清单（grep `.agents/verify/` 全库）

| 报告 | 实测内容 | CPU | 线程/goroutine | fd | 出站 | ticker |
| --- | --- | --- | --- | --- | --- | --- |
| `v1-budget-measure.md:5,20-24,63-93`（11-23，主实例 pid 608004，只读） | 四项直测 + 明确列出缺口 | 0 ms/60s | 线程 16（代理）；**goroutine 未测**：pprof 404 / system-info 401 | 14 | 0 | 1 处命中 `scheduler/loop.go:18`，属白名单，判 `make idle` 门禁误报 |
| `m1-memory-baseline.md:100-109`（60s） | 四项直测 | 0 ms/60s | Threads 7 | 6 | 0 | 未列 |
| `m1-core-acceptance.md:46,60` | 干净 fd 环境四项 + 静态 grep | 0 ms/60s | Threads 12 | 8 | 0 | 源码零命中 |
| `m1-final-acceptance.md:71-74,86` | `make idle` exit 0，5 pass | 0 ms/60s | Threads 13 | 7 | 0 | 零命中 |
| `m3-audit-verification.md:15-30` | `make idle` exit 0，5 pass（事件注入后） | 0 ms/60s | Threads 15 | 7 | 0 | 零命中 |
| `round2-final.md:59` / `final-shots.md:41,61`（主实例监控页） | 真机 **goroutine 11/15–16、fd 22/94** | — | 有读数，但发生在**监控页主动刷新时点**，且实例带 14 插件、3 常驻 | 94（含插件后，**非「空载主壳」口径**） | — | — |
| `local-deploy-test.md:24`、`monitor-history-live.md:33,87` | 30s/运行期四项 | 0 tick/30s | Threads 14（代理） | 76（继承 fd；脚本口径已修正为干净启动） | 0 | — |

**判定**：CPU / fd / 出站 / ticker 早已在真实实例量过且达标，无需重复；**唯一的真缺口是「空闲态 goroutine 直测」**——`v1-budget-measure.md:21,24,105` 明确「goroutine 未测，线程数为代理指标，线程数 ≠ goroutine 数，不能据此判定红线达标」。监控页的 11/15/16 是**带插件主壳 + 主动刷新时点**，不是 G-19 的「空载 + 空闲 60s」口径。故执行阶段二。

## 2. 阶段二：隔离实例与命令（命令 + 退出码 + 原文）

| 步骤 | 命令 / 方式 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 编译当前 HEAD | `GOCACHE=<iso>/gocache GOMODCACHE=<repo>/.tmp/gomodcache GOWORK=off GOPROXY=off GOSUMDB=off CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags='-s -w' -o <iso>/bin/kored ./cmd/kored` | **0** | `kored 0.1.4`，13,451,426 B，sha256 `bbea8c12c16541aea7c18400ec83515342f97b6a843eba0a1a51af8a5dde04cd`。首次尝试用默认 GOMODCACHE 失败（bbolt v1.5.0 只有 .mod 无 .zip、缓存只读，exit 1），改用工作区已缓存的 `.tmp/gomodcache` 离线编译，**全程 GOPROXY=off 无联网**，未覆盖宿主 `bin/kored` |
| 隔离配置 | `<iso>/config.yaml`：`server.addr=127.0.0.1:55231` + 独立 UDS；`paths.{state,run,log,index}` 全落 `<iso>`；口令经 `admin-password --set --stdin` 写入隔离 0600 配置（argv/报告无明文） | **0** | 首启改密闸门在**隔离配置**内置 false（`must_change_password: false`），仅为本测能读 metrics，不改主实例 |
| 启动 | Python `subprocess.Popen(..., close_fds=True, start_new_session=True, env=最小集 PATH/HOME/KORE_HOME/LANG, stdin=DEVNULL)`，单进程 stdout→隔离 log | 后台 | `pgrep` 语义下 PID=9（**沙箱 PID namespace 内的 pid**，非宿主 pid；`/proc/<pid>` 采样与进程同 namespace，读数有效）；日志 `kore ready pid=9 version=0.1.4 addr=127.0.0.1:55231`；`/-/healthz` = **200** |
| 空闲采样 | 启动后 `sleep 5` → T0；`sleep 60` → T1（`ss -Htnp` 过滤 `pid=9` 且排除 LISTEN，两端各采一次） | **0** | 见下表；60s 窗口内**无任何业务请求**（只在就绪探测阶段轮询过 healthz） |
| 真实 goroutine | 窗口后 `POST /api/v1/auth/login` → `GET /api/v1/system/metrics`（该端点由 `internal/core/metrics/metrics.go:58` 调 `runtime.NumGoroutine()`） | login **200** / metrics **200** | `{"cpu_pct":0,"rss_kib":14656,"disk_used_kib":594430780,"disk_total_kib":1966847136,"load1":2.42,"goroutines":9,"fds":12,"uptime_sec":65}` |
| 定时器 | `grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ --include='*.go'` 全量 + 去白名单 | **0 / 0** | 全量仅 1 行：`internal/core/scheduler/loop.go:18: ticker := time.NewTicker(s.tick)`；去 `cert_renew` 与 `^internal/core/scheduler/` 后 **0 行** |

## 3. 与 G-19 红线逐项对比

| 指标 | 判据 | 实测 | 判定 |
| --- | --- | --- | --- |
| ① 空闲 CPU | ≤60 ms/60s | `/proc/9/stat` utime+stime：T0=0 → T1=0 ticks，Δ=0，`CLK_TCK=100` → **0 ms/60s**（metrics 同源 `cpu_pct=0`） | **PASS** |
| ② goroutine | ≤20 | **真实 `runtime.NumGoroutine()` = 9**（经鉴权 `/system/metrics` 直接读到，非 Threads 代理）；旁证 `/proc/9/status Threads` T0=14 → T1=14 | **PASS** |
| ③ fd | ≤64 | `/proc/9/fd` T0=10 → T1=10（干净 close_fds 启动）；鉴权采样时刻 `/system/metrics fds=12`（含本次登录/采样连接） | **PASS** |
| ④ 出站连接 | =0 | `ss -Htnp \| grep 'pid=9' \| grep -v LISTEN`：T0=0 行、T1=0 行（`ss` exit 0）；全程未配任何 webhook/更新源 | **PASS** |
| ⑤ 定时器 | 仅 scheduler 单 ticker | 源码全量命中恰好 1 处：`internal/core/scheduler/loop.go:18`；白名单外 0 命中 | **PASS** |

**无 WARN、无 FAIL，无 file:line 超线项需回派优化卡。** 说明：本次只证「空载主壳 + 空闲」这一 G-19 场景，不覆盖 `final-shots.md:61` 里带 3 常驻插件时的 fd 94（那是另一配置/另一负载，且 `AGENTS.md` G-03 的 fd ≤64 判据表述针对空载；本卡不改口径、不替它下结论）。

## 4. 诚实边界

- **单机单实例隔离实例**：127.0.0.1:55231，非 8787；沙箱 PID namespace 内 pid=9。未碰 `.kore-local.yaml`/`.kore-local-state/`/`.kore-local-run/`/宿主 `bin/kored`，未重启或请求主实例（仅收尾用只读 `ss` 复核 8787 仍在 LISTEN）。
- **goroutine 读数时点**：真实 `NumGoroutine()=9` 采于 60s 窗口刚结束、一次登录 + metrics 请求之后（uptime 65s），实例此前一直空闲无业务流量；不是「零请求后立刻」的 T0 快照。Threads=14 是全程 T0/T1 的旁证代理，二者都 ≤20。
- **CPU 时间口径**： utime+stime 差值，60s 内 0 tick；容器/namespace 下 `CLK_TCK=100`，结果 0 ms。0 不代表「绝对零指令」，而是分辨率内无可测增量。
- 无竞品同口径实测：本报告只证明 kore 自身当前表现，**不构成「性能/资源超越竞品」的证据**。
- 编译依赖工作区缓存 `.tmp/gomodcache` 的 bbolt v1.5.0 离线 zip；默认只读模块缓存不可编译，属本机环境限制，非仓库缺陷。

## 5. 清理回读（逐条）

```
$ ls -d .tmp/g19-idle-live-55231                 → ISO_GONE
$ ls .tmp/g19-idle-live-55231/probe.py           → PROBE_GONE（一次性 harness 脚本随 ISO 自删）
$ ss -ltnp | grep ':55231'                       → 55231_FREE
$ ls -d /proc/9                                  → PID9_GONE（proc.terminate() 正常退出，wait ok）
$ ss -ltnp | grep ':8787'                        → LISTEN 127.0.0.1:8787（主实例未动）
$ git status --short                              → 仅原有他人/在途条目 + 本文件（无临时资产残留）
```

一次性 harness 脚本 `probe.py` 在进程退出后由脚本自身 `shutil.rmtree(ISO)` 删除，未留在工作区；口令只在内存生成并经 stdin 写入隔离 0600 配置，随 ISO 一并删除，未进 argv / stdout / 本报告（G-30 合规）。未联网、未 push。

## 6. 交付

唯一新增文件：`.agents/verify/g19-idle-live.md`（本文件）。不改生产代码、不 bump、不发版。提交：`[agent:g19-idle] docs(verify): ...`（精确 add 本文件，`-s`，不 push）。verifier 另派。
