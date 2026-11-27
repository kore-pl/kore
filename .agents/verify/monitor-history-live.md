# 监控历史 P3 真机复验报告（隔离实例）

> 2026-11-27 18:58–19:01 +08:00 · 执行者 `monitor-history-live`（真机验证 worker）· 持续目标 round 22 · 只读验证，不改生产代码、不 bump/发版、不 push、不联网业务、不碰主实例与宿主。
> 对象：`kored` 版本 0.1.1（源码 HEAD `e5150c5`，自编译 `bin/kored` 同源码）；monitor 插件 **0.6.0**（本地离线包 `../kore-plugin-monitor/dist/monitor-0.6.0.tar.gz`，sha `d3c8c154…b738e`，与 P1+P2 报告 `monitor-history-verification.md` 一致）。
> 隔离实例：`--config <iso>/config.yaml`（独立 config / state / run / log 全落 `.agents/verify/.tmp-mlive/iso`，端口 **127.0.0.1:55119**）。**本轮未改动主实例运行态配置**（`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 零写入；8787 仅只读 healthz）。
> 总评：**PASS（5/5 真机断言）**，附 3 项文档/实现口径偏差如实记录（非产品缺陷、不在本卡修复）。

## 0. 执行环境与取证纪律

- 本机 bash 每次调用是独立沙箱，`/tmp` 与后台进程**不跨调用持久**；整场真机验证（构建→启实例→断言 1–5→清理）必须在**单次 bash 调用内**跑完。可复现脚本与各段 stdout 存 gitignored 的 `.agents/verify/.tmp-mlive/`（提交前删净）。
- 默认 `GOCACHE` 只读、默认 `GOMODCACHE` 缺 bbolt v1.5.0 zip；用工作区已有的可写副本 `../.tmp-acct-gomodcache` 复制出隔离 GOMODCACHE + 隔离 GOCACHE，`GOPROXY=off GOWORK=off CGO_ENABLED=0 go build -trimpath -buildvcs=false -o .agents/verify/.tmp-mlive/bin/kored ./cmd/kored`，exit 0。仅构建产物，不提交。
- 登录口令与 CSRF token 只在进程内生成/传递：口令哈希由 Python PBKDF2 运行期生成写入隔离 config（0600），**明文不进 argv、不进本报告**；CSRF 从 cookie jar 读取后只打印长度（43），不打印值。
- 隔离实例主进程日志 `.agents/verify/.tmp-mlive/iso/server.log` 随实例删除；关键行已抄录本报告。

## 1. 基线（启动前）

| 命令 | 输出 | 退出码 |
| --- | --- | --- |
| `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz` | `200` | 0 |
| `sha256sum .kore-local.yaml` | `9d5de744fb685f4f569b6819b4c3e122e98f99e591db09fb68afda4ba43bd56e  .kore-local.yaml` | 0 |
| `stat -c %Y .kore-local-state/state.db` | `1795766210` | 0 |
| `ss -ltnp \| grep ':55119'` | `(no listener)` | 0 |

## 2. 断言 ①：默认态（启动后不建任务、不调采样）

隔离实例启动：`kored install --config <iso>/config.yaml --package <monitor-0.6.0.tar.gz>` → `installed monitor 0.6.0`（exit 0）；`kored serve --config <iso>/config.yaml` → `healthz=200 after 2s`、pid 74、日志 `{"msg":"kore ready","addr":"127.0.0.1:55119"}`。

| 断言 | 命令 | 关键输出原文 | 退出码 | 判定 |
| --- | --- | --- | --- | --- |
| 无 monitor.sample 任务 | `curl -s -b <cookie> http://127.0.0.1:55119/api/v1/scheduler/tasks` | `{"tasks":[{"id":"builtin-audit-clean","method":"audit.clean",...},{"id":"builtin-logs-maintain","method":"logs.maintain",...}]}` —— 仅 2 条内置任务，**无 monitor.sample**（未登录探测为 `401`） | 0 | PASS |
| 无采样落盘 | `find <iso>/state -name history.json` | 空（无输出） | 0 | PASS |
| 无 sample 调用日志 | `grep -ci 'monitor.sample' <iso>/server.log` | `0` | 0 | PASS |
| 出站 0（G-10） | `ss -tnp \| grep 'pid=74' \| grep -v '127.0.0.1'` | `(no outbound)` | 0 | PASS |

**G-19 口径**（`docs/DESIGN-MONITOR-HISTORY.md:28` 明确）：默认态内核仍有 `audit.clean` + `logs.maintain` 两条内置 6h 任务 → 单 scheduler ticker 存在；本方案的守门是「**不因监控新增默认启用的周期任务**」，任务列表已证无 monitor 项，不是宣称全局零 ticker。任务列表两个内置项 `next_run_at=2026-11-28T00:58:33+08:00`，窗口内不会触发。

## 3. 断言 ②：建采样任务

**前置（真机暴露的操作必需步骤）**：离线 `kored install` 只把插件注册为 `enabled:false`；首轮未启用时 scheduler 任务到点失败，原文 `{"status":"failed","error":"E_CONFLICT: 插件 monitor 未启用，请先 POST /api/v1/plugins/monitor/enable"}`。补 `POST /api/v1/plugins/monitor/enable`（CSRF 双提交）→ HTTP 200 + `{"id":"monitor","version":"0.6.0","enabled":true,"method_capabilities":{"monitor.sample":"system:read",...}}`。这是操作口径（非缺陷），如实记录供用户「正式使用」时照做。

| 项 | 命令 / 原文 | 退出码 |
| --- | --- | --- |
| 建任务请求 | `POST /api/v1/scheduler/tasks`，body `{"name":"p3-monitor-sample","plugin":"monitor","method":"monitor.sample","params":{"history_points":720,"history_interval_s":30},"interval_s":30,"enabled":true}`，带 `X-Kore-CSRF` | — |
| 响应 | `HTTP_CODE=200`；body `{"id":"tsk-55fce89c1afa76bb","plugin":"monitor","method":"monitor.sample","params":{"history_points":720,"history_interval_s":30},"interval_s":30,"enabled":true,"timeout_s":300,"next_run_at":"2026-11-27T18:59:04.978622189+08:00"}` | 0 |
| 列表回读 | `curl -s -b <cookie> <url>/api/v1/scheduler/tasks \| python3 ...` → `[{"id":"tsk-55fce89c1afa76bb","name":"p3-monitor-sample","plugin":"monitor","method":"monitor.sample","params":{"history_points":720,"history_interval_s":30},"interval_s":30,"enabled":true,...}]` | 0 |

**口径偏差 1（非缺陷）**：任务卡写「断言 201」，实际 HTTP **200** —— `internal/core/httpapi/handlers_scheduler.go:104` 明确 `writeJSON(w, http.StatusOK, task)`；全仓 scheduler 写端点（create/update/delete）均为 200。任务确实创建且 `enabled=true`。判定按「任务存在且 Enabled」核心判据 PASS；201 期望属任务卡笔误，报 lead 另派文档卡。

`interval_s=30` 取 scheduler 下限（`internal/core/scheduler/task.go:43`）；params `history_interval_s=30` 与之相等，满足设计文档 §3.1「task interval ≥ history_interval_s 否则采了不落点」约束。报告注明：**验证用短 interval（30s）便于本机复验，实际预填入口为每小时（`history_interval_s=3600` + cron `0 * * * *`，见 `web/monitor.js:43-63` SAMPLE_DRAFT）**。

## 4. 断言 ③：真采样点数增长（核心判据）

`history.json` 实际落点：**`<iso>/state/plugins/monitor/history.json`** —— supervisor 注入 `KORE_STATE_DIR=filepath.Dir(inst.manifest.Dir)`（`kore/internal/core/supervisor/start.go:76,169`），即插件安装目录的父目录，而非设计文档 §3.2 所写的 state 根**（口径偏差 2，见 §7）**。

任务创建 `18:58:34.978`，窗口 `18:58:40–19:01:05`（150s，跨 3 个 30s interval）。轮询输出（每 5s，摘录状态变化点）：

| 时间 | points | bytes |
| --- | --- | --- |
| 18:58:40 – 18:59:30（i=1..11） | ABSENT（尚未到点） | — |
| **18:59:35（i=12）** | **1** | 161 |
| 18:59:40 – 19:00:00 | 1 | 161 |
| **19:00:05（i=18）** | **2** | 266 |
| 19:00:10 – 19:00:30 | 2 | 266 |
| **19:00:35（i=24）** | **3** | 369 |
| 19:00:40 – 19:01:05 | 3 | 369 |

点数 **0 → 1 → 2 → 3 单调增长**，文件字节 161 → 266 → 369 同步增长。首点到点比 `next_run_at` 晚约 60s（lazy 插件冷启动握手 + 调度 tick 对齐），非缺陷。

`
stat -c '%a %U %s %n' <iso>/state/plugins/monitor/history.json
→ 600 pt 369 <iso>/state/plugins/monitor/history.json   (exit 0)
`
属主 pt、权限 **0600**，与 `history.go:166-201`（同目录临时文件 → Chmod 0600 → rename 原子写）一致；本轮非 root 内核（日志 `kored 非 root：插件降权未生效，插件与内核同 uid`），降权路径按 DESIGN §3.2 五步验证仍留后续卡，不冒充已验。

最终文件（原文）：
```json
{"version":1,"interval_s":30,"capacity":720,"samples":[{"ts_unix_ms":1795777173752,"cpu_percent":7.98,"memory_percent":37.28,"load1":2.94,"disk_percent":31.5},{"ts_unix_ms":1795777203773,"cpu_percent":10.46,"memory_percent":38.14,"load1":2.84,"disk_percent":31.5},{"ts_unix_ms":1795777233777,"cpu_percent":7.29,"memory_percent":36.9,"load1":2.24,"disk_percent":31.5}]}
```
三点时间戳间隔 30021/30004 ms ≈ 30s，等于 task/policy interval；CPU/内存/负载值各不相同（真实 `/proc`/`sysctl` 采样，非复制粘贴）。

调度执行记录（命令 `GET /api/v1/scheduler/tasks/tsk-55fce89c1afa76bb/runs`，exit 0）：
```json
{"runs":[{"started_at":"2026-11-27T19:00:33.777573672+08:00","status":"ok","dur_ms":202},{"started_at":"2026-11-27T19:00:03.773429497+08:00","status":"ok","dur_ms":201},{"started_at":"2026-11-27T18:59:33.747993602+08:00","status":"ok","dur_ms":210}],"count":3,...}
```
3 次到点执行全部 `status=ok`（dur_ms 201/202/210），与 3 个落点一一对应。**「周期任务确实驱动了采样」真机成立**。`recordHistory` 追加判据（未到间隔不重复落点）由 P1 e2e `TestSampleAppends` 已证（见 P1+P2 报告 §1.3），本轮不重复证。

出站复验：`ss -tnp | grep 'pid=74' | grep -v '127.0.0.1'` → `(no outbound)`，exit 0（G-10 保持）。

## 5. 断言 ④：时间范围显示（诚实边界）

- **浏览器 DOM 切换今天/7 天：本轮未做**。原因：环境无 headless 浏览器可执行文件（`chromium` / `google-chrome` / `playwright` CLI 均不存在），且 30s 短 interval 在 150s 窗口内造不出跨天数据；按任务卡「造不出跨天数据则如实标注，不伪造」执行。
- **本轮真验到今天档**：把 §4 真实落盘的 3 点（storage 形状）转成列式 `HistoryResult` 形状后，喂给真实 `web/monitor.js` 的 P2 分桶纯函数（`window.__koreMonitorChart._bucket/_rangeWindow`，`node vm`，exit 0），用真实抓取时刻 `now=1795777265708`：

```
hook=["count","dispose","_bucket","_rangeWindow","_seriesKeys"]
real samples=3 interval_s=30 capacity=720
todayWindow=[1795708800000,1795777265708]   weekWindow=[1795172465708,1795777265708]
today buckets=2 rawCount=3 bucketMs=300000 series=["cpu_percent","memory_percent","load1","disk_percent"] cpu=[7.98,7.29]
week  buckets=2 rawCount=3 bucketMs=3600000 series=[...] cpu=[7.98,7.29]
ts(today)=["2026-11-27T10:55:00Z","2026-11-27T11:00:00Z"]  ts(week)=["2026-11-27T10:00:00Z","2026-11-27T11:00:00Z"]
```
解释：3 点全在同一天内 → 今天档按 5min 桶、7 天档按 1h 桶，**桶数与 X 轴刻度因窗口/桶宽不同而不同是正确行为**（本例恰同为 2 桶、时间戳落位不同）；跨天今天/7 天数据切换由 P2 分桶单测覆盖（`monitor-history-verification.md` §2.4，9/9 PASS @ `e5150c5`）。本轮没有伪造任何跨天数据。

## 6. 断言 ⑤：清理回读

| 命令 | 输出 | 退出码 |
| --- | --- | --- |
| `kill 74; sleep 2; kill -9 74 2>/dev/null` | `killed=74` | 0 |
| `ps -p 74 -o pid=,args=` | `(pid gone)` | 0 |
| `ss -ltnp \| grep ':55119'` | `(no listener on 55119)` | 0 |
| `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz` | `200` | 0 |
| `sha256sum .kore-local.yaml` | `9d5de744fb685f4f569b6819b4c3e122e98f99e591db09fb68afda4ba43bd56e  .kore-local.yaml`（与基线逐字一致） | 0 |
| `stat -c %Y .kore-local-state/state.db` | `1795766210`（与基线一致） | 0 |
| `rm -rf <iso> && echo deleted-iso` | `deleted-iso` | 0 |

隔离实例 config / state / run / log、cookie jar、响应临时文件、编译缓存与一次性脚本全部随 `.agents/verify/.tmp-mlive/` 删除（提交前复核）；端口 55119 无监听，主实例 8787 未受影响。**未查询主实例 scheduler 列表**（无凭据，遵守「不碰主实例」硬纪律）；以 config sha + state.db mtime 未变 + healthz 200 作为「主实例未被污染」证据。

## 7. 真机暴露的口径偏差（非缺陷，报 lead 另派卡，本卡不修）

| # | 现象 | 代码位置 | 建议 |
| --- | --- | --- | --- |
| 1 | 任务卡期望 POST 建任务 `201`，实际 `200` | `internal/core/httpapi/handlers_scheduler.go:104`（`writeJSON(w, http.StatusOK, task)`） | 修任务卡/API 文档口径，或另卡决定是否改状态码（改属对外契约变更，需评审） |
| 2 | `history.json` 落 `<state>/plugins/monitor/` 而非设计文档 §3.2 所写 state 根 | `kore/internal/core/supervisor/start.go:76,169`（`KORE_STATE_DIR=filepath.Dir(inst.manifest.Dir)`）+ `kore-plugin-monitor/internal/monitor/history.go:63-68` | 修 DESIGN §3.2 / 用户帮助文案（真实落点是插件状态目录，且该目录降权时已移交 `kore-<id>`，反而更安全） |
| 3 | 离线 `install` 后插件 `enabled=false`，用户直接建采样任务会拿到 `E_CONFLICT: 插件 monitor 未启用` | `cmd/kored/install.go`（安装只注册）+ scheduler 到点执行鉴权 | 空态预填/引导补「先启用 monitor 插件」一步，或在任务创建入口给出可执行提示；不改内核行为 |

另：设计文档 §5 P3 的「降权 state 写权限五步验证」本轮**未做**（本机 `kored` 非 root，日志明确「插件降权未生效」）；`history.json` 实测 0600/属主 pt，但那是非降权路径，不冒充降权路径已验，留给后续卡。

## 8. 结论

监控历史 P3 的五项真机断言全部成立：默认态无 monitor 采样任务/无落盘/出站 0 → 建任务后任务存在且 Enabled → 30s 周期任务真实驱动 `/proc` 采样、`history.json` 点数 0→1→2→3 与 3 次 `status=ok` 执行一一对应 → 今天档真机数据经 P2 分桶函数确认正确、跨天 7 天档诚实标注由 P2 单测覆盖 → 实例停、临时资产删、55119 无监听、8787 healthz 200、主配置/状态零改动。用户「用本机测试和正式使用」的最后一环（真机周期驱动采样）已闭环。3 项口径偏差与降权路径留后续卡，不自行修、不 push。

---

**提交**：`[agent:monitor-history-live] docs(verify): 监控历史 P3 真机复验报告（隔离实例 55119，五项断言 PASS）` —— 精确 `git add .agents/verify/monitor-history-live.md` + `git commit -s -- <path>`（只此一文件），不 push。verifier 另派。
