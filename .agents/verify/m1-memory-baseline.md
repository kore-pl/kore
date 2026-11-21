# M1 内存基线 · 唯一落盘证据

> 验证者：kore-verifier-mem（独立于 implementer）｜测量窗口 2026-11-21 23:47 – 2026-11-22 00:06
> 口径：`VmRSS` 主值 = `/proc/<pid>/status`；`RssAnon`/`RssFile` **来源 = status**（本机内核 7.0.0-44 的 `smaps_rollup` 已无这两个字段，实测 0 行，按 G-03 回退 status）。
> 统计：n=60，median = 第 30/31 位均值；p95 = nearest-rank ⌈0.95n⌉ = 第 57 位。
> ⚠️ **状态**：§3/§4 的 6300/6372/6304 是 **GC 被关闭**（旧 `serve.go:82` 副作用）状态下的数，**已作废、不作为基线**；修复后基线见 §9（7688，待 `MEM_POINTS=60` 复测收口）。

## 1. 环境与构建

| 项 | 值 |
| --- | --- |
| HEAD | `6fdaedde19f1404fbcc4fe3b2061315b1032520f`（`6fdaedd fix(core): 资源锚点注释改指 ADR/证据文件…`） |
| 二进制 | `bin/kored` 6,209,698 B · sha256 `cb0ceb555e3f1fdc23e7dac37be5d80b2b68dd69b2ad1fb0b27d646eb94be3db` |
| 主机 | i7-13700K · nproc 24 · kernel `7.0.0-44-generic` · go1.26.8 · CLK_TCK 100 |
| 构建 | `make build` → `[OK] 构建完成: ./bin/kored`；测量用只读副本 `/tmp/kore-fixed/kored`（同 sha256，防并发 `make clean` 删除） |

**沙箱（必须写清）**：非 root 无法创建 `/etc/kore`、`/run/kore`、`/var/lib/kore`、`/var/log/kore`（仓库硬编码这四条路径，只有 `--state-dir` 可覆盖）。因此用 `unshare -r -m` + overlay 挂 `/etc`、`/var/lib`、`/var/log` + tmpfs 挂 `/run`（`/run/systemd/system` 回挂保留）。**副作用：state 目录 fs 探测为 overlayfs、socket 在沙箱内、路径字符串不同**；RSS 口径不受影响，但别把这组数字当成 root 直跑的复刻。

## 2. 原始命令（关键部分）

```bash
make build                                  # [OK] 构建完成: ./bin/kored
unshare -r -m /tmp/kore-mem2.sh             # 每档独立进程，脚本内：
  mount -t overlay overlay -o lowerdir=/etc,upperdir=$BASE/etc,workdir=$BASE/w-etc /etc
  mount -t overlay overlay -o lowerdir=/var/lib,upperdir=$BASE/varlib,workdir=$BASE/w-varlib /var/lib
  mount -t overlay overlay -o lowerdir=/var/log,upperdir=$BASE/varlog,workdir=$BASE/w-varlog /var/log
  mount -t tmpfs tmpfs /run; mount --bind $BASE/smp /run/systemd/system
  ( for f in /proc/$BASHPID/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done
    exec env GOGC=50 GOMAXPROCS=8 GOMEMLIMIT=6291456 /tmp/kore-fixed/kored serve --state-dir /var/lib/kore ) &
  sleep 5
  for i in $(seq 1 60); do
    awk '/^VmRSS:/{print $2}' /proc/$pid/status; awk '/^RssAnon:/{print $2}' /proc/$pid/status
    awk '/^RssFile:/{print $2}' /proc/$pid/status; awk '/^Threads:/{print $2}' /proc/$pid/status
    sleep 1; done
  curl -sS --unix-socket /run/kore/kore.sock http://localhost/-/healthz   # HTTP 200 {"status":"ok"}
```

每档启动日志（原样，证明采集条件；`gogc_percent` 的**真实性见 §5**）：
```text
A {"msg":"资源锚点","gomemlimit_bytes":6291456,"gomaxprocs":8,"gogc_percent":50}
B {"msg":"资源锚点","gomemlimit_bytes":6291456,"gomaxprocs":8,"gogc_percent":100}
C {"msg":"资源锚点","gomemlimit_bytes":6291456,"gomaxprocs":8,"gogc_percent":200}
D {"msg":"资源锚点","gomemlimit_bytes":6291456,"gomaxprocs":24,"gogc_percent":50}
```

## 3. 三档 × 60 点（空载，KiB）

| 档 | 运行 | median | min | max | p95 | RssAnon | RssFile | Threads |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A GOGC=50 P=8 | A1 | 6300.0 | 6300 | 6300 | 6300 | 1256 | 5044 | 7 |
| A GOGC=50 P=8 | A2 | 5060.0 | 5060 | 6404 | 5124 | 1296 | 3764 | 7 |
| A GOGC=50 P=8 | A3 | 6976.0 | 6976 | 6976 | 6976 | 1868 | 5108 | 10 |
| A GOGC=50 P=8 | A6（20s 稳定） | 6300.0 | 6300 | 6300 | 6300 | 1256 | 5044 | 7 |
| B GOGC=100 P=8 | B1 | 6372.0 | 6372 | 6372 | 6372 | 1264 | 5108 | 7 |
| C GOGC=200 P=8 | C1 | 6304.0 | 6304 | 6304 | 6304 | 1260 | 5044 | 7 |
| D GOGC=50 P=24 | D1 | 7912.0 | 7912 | 7912 | 7912 | 2804 | 5108 | 17 |

要点：A2 的 `RssFile` 在窗口内从 3764 涨到 5108（文本页尚未全部驻留），VmRSS 末段才到 6404 → **5s 稳定不总够**；A6 改成 20s 稳定后与 A1 完全一致（6300）。A1/B1/C1 三档 median 差 ≤72 KiB，见 §5：**GOGC 档位在运行时并未生效**。

## 4. 单次请求后的增量（请求后 10 点，KiB）

| 运行 | 请求前 median | 请求后 median | Δ | 请求后 RssAnon | 请求后 Threads |
| --- | --- | --- | --- | --- | --- |
| A1 | 6300 | 7276 | +976 | 1976 | — |
| A2 | 5060 | 7016 | +1956 | 1908 | — |
| A3 | 6976 | 7228 | +252 | 1928 | — |
| B1 | 6372 | 6656 | +284 | 1356 | — |
| C1 | 6304 | 7264 | +960 | 1964 | — |
| D1 | 7912 | 8292 | +380 | 2992 | — |
| A4（180s 长窗） | 6284 | 7968 | +1684 | 2668 | 7→13 |
| A5（`gctrace=1`） | 6412 | 7204 | +792 | 1904 | 7→8 |
| A6（20s 稳定） | 6300 | 7228 | +928 | 1928 | 7→10 |

A4 的 6284、A5 的 6412 为稳定常数（A4 在 180s 内 9 个核对点均为 6284；该次汇总脚本 `asort` 不可用，未出形式化 median），A6 为 60 点 median。

增量是**一次性**的：A5 连打 3 次 `GET /-/healthz`，req1 后 7204，req2/req3 仍为 7204（不再上涨）。增量大小取决于首请求那一次 GC 留下了几个 worker 线程（+100~150 KiB/线程）。

## 5. 关键发现：`logRuntimeLimits()` 把 GC 关掉了（GOGC 消融失效；已由 `02d0154` 修复，见 §9）

`cmd/kored/serve.go:82`（HEAD `6fdaedd`）：`"gogc_percent", debug.SetGCPercent(-1)`。按官方文档这不是只读：
`go doc runtime/debug.SetGCPercent` → “**A negative percentage effectively disables garbage collection**, unless the memory limit is reached.”
证据链：
1. 独立小探针（go1.26.8 构建，GOGC=50）：调用 `SetGCPercent(-1)` 后 `returned: 50`，分配 192661 KiB 时 `NumGC=0`；同负载不调用时 `NumGC=11`。**注意：该判别器只在未设 GOMEMLIMIT 时成立**（见 §9.2）。
2. kored 带 `GODEBUG=gctrace=1` 实测：全程只有一行 `gc 1 @5.118s … 0->1->0 MB, 1 MB goal, 8 P`（首请求触发），之后两次请求无 GC。
3. 因此 A/B/C 三档实际都是 **GC-off + GOMEMLIMIT=6MiB 驱动的偶发 GC**；启动日志里的 `gogc_percent=50/100/200` 是“关闭前读到的旧值”，**不能当作生效证据**。`SetMemoryLimit(-1)`（:81）是安全的（文档明确“负数只读取、不调整”）。
> 结论：`GOGC=50` 作为“默认锚点”目前没有真正生效；三档差异是噪声（≤72 KiB），真正的变量是“是否触发过 GC + 留下几个线程”。

## 6. 与四个历史数字的对照

| 历史数字 | 我测到的对应状态 | 差 | 解释 |
| --- | --- | --- | --- |
| 6408（旧注释 GOGC=50） | A2 窗内 max **6404** | −4 | 5s 短窗 + 文本页未驻留完成（`RssFile` 3764→5108）的早期值，不是稳定中位数 |
| 7200（impl-core 最新，Threads 9） | A5 请求后 **7204**（Threads 8） | +4 | p8 + 已触发 1 次 GC；**不是空载**（p8 空载 6300） |
| 7832（impl-core 最初，Threads 13） | A4 请求后 **7968**（Threads 13） | +136 | p8 + 首请求 GC 留下 6 个 worker 线程，同一状态族；差在采样时点 |
| 7820 / 8056（旧注释 GOGC=100 空载/单请求后） | D1（P=24）**7912 / 8292** | −92 / −236 | 旧注释自述“无 GOMAXPROCS 限制”= 24P 档；p8 下空载 6300，**7820 在 p8 不可复现** |
| 8472（ADR 默认 P=24） | D1 7912（Threads 17） | −560 | 同属 24P 档，差异在启动 GC 线程数（13–17）与页驻留 |

**一句话**：四个数字分别来自四个不同状态（早期短窗 / 触发 GC 后的 p8 / 首请求后的 p8 / 24P），不是同一口径的重复测量；且它们**均采集于 GC 被关闭（旧代码副作用）或线程数未收敛/错误的状态**。§3/§4 的 6300/7204–7968 同样如此，**已作废**；修复后基线见 §9。

## 7. 空闲三项（档 A，60s）

| 项 | 实测 | 门禁 |
| --- | --- | --- |
| 空闲 CPU | `utime+stime` 0→0 ticks × 10 = **0 ms / 60s** | ≤60 ms ✅ |
| Threads | **7**（空载；请求后 10–13） | ≤20 ✅ |
| fd | **6**（`ls /proc/<pid>/fd`；干净启动已关闭继承 fd） | ≤64 ✅ |
| 出站连接 | **0**（`ss -Htnp` 无 `pid=` 匹配） | 0 ✅ |

注：若从 DSH 工具 shell 直接启动而不清理 fd，会把编辑器/工具链的 75 个继承 fd 带进 kored（实测 75 且可见 `app.asar` 等），那是宿主继承、不是 kore 打开的；本表按干净启动计。

## 8. 限制与已知干扰

1. 非 root + 固定路径 → userns/overlay 沙箱（§1），state fs = overlayfs；root 直跑需自行复测这四项环境差异。
2. 5s 稳定不足（A2 的证据）；建议 20s 或丢弃前 10 点。
3. 23:42 首轮档 A 结束后 `bin/` 目录被并发构建/清理删除（仓库内只有 `make clean` 会删目录），B/C/D 启动失败（`env: … No such file or directory`）；本轮已用冻结副本重测，全部成功。
4. 23:44–23:49 有他人制造的 `comm=kored` 假进程（pid 51943，`python3 -c … prctl(15,b"kored") … sleep(300)`，cwd=本仓库），非 kore；最终 `pgrep -x kored` 为空，`REAL_KORED_COUNT=0`。

## 9. 修复后附录（HEAD `02d0154`，二进制 sha256 `cca229a1…`）

**9.1 修复内容**：`serve.go` 不再用 `debug.SetGCPercent(-1)` / `debug.SetMemoryLimit(-1)` 回读；新增 `runtimeLimits`（`GOGC` / `MemLimitBytes` / `MaxProcs`）记录“自己设置的值”，`logRuntimeLimits(limits)` 只读入参。`GOMAXPROCS(0)` 仍用于只读查询（无副作用）。G-21 门禁已落地（`AGENTS.md:50`，`grep -rn "SetGCPercent(-1)"` 与 `"SetMemoryLimit(-1)"` 双零命中）。

**9.2 判别器纠正（方法论，必读）**：`NumGC` 不是可靠判别器——本轮探针能测出问题，是因为**探针没设 `GOMEMLIMIT`**；在 `GOMEMLIMIT=6MiB` 下即使 GOGC=off，分配 churn 也会被软上限强制触发 GC（实测 `numgc_delta=15`，GC 次数照样涨）。**唯一可靠判别器是 `/gc/gogc:percent`**：旧代码读作 `MaxUint64`（等价 off），新代码为 `50`（外部设置时等于外部值）。判别“GOGC 是否真正生效”先读该指标，别数 GC 次数；`runtime/metrics` 的路由见 `cmd/kored/serve_test.go:32`。

**9.3 修复后实测**（**由 implementer 提供，本轮未复跑**——用户已明确优先设计、不重复卡测）：

| 指标 | 值 |
| --- | --- |
| VmRSS | median **7688** / min 7608 / max 7688 / p95 7688 KiB |
| RssAnon / RssFile | 2500 / 5108 KiB（status） |
| Threads · 空闲 CPU · fd | 12 · 0 ms/60s · 6 |
| 300 次 `GET /-/healthz` | 触发 **1374 次 GC**（GOGC=50 真正生效的直接证据） |

**9.4 结论改写**：§3/§4 的 6300/6372/6304（空载）与 7204–7968（请求后）是 **GC 被关闭**状态下的数，**已作废，不作为基线**。修复后**当前基线（候选）= 7688 KiB**（Threads 12），待里程碑收口时以 `MEM_POINTS=60` 复测确认；在此之前引用基线请注明“impl-core 提供，未独立复跑”。

**9.5 历史数字补注**：§6 的 6408/7200/7832/7820 **均在 GC 关闭（旧代码副作用）或线程数未收敛/错误的状态下采集**；“状态族”解释仍成立（早期短窗 / GC 后 p8 / 首请求后 p8 / 24P），但都不再是当前可复现基线。
