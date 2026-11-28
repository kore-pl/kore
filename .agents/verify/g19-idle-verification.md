> 状态: 独立验收 · 归属: g19-idle-verifier（G-09，非 g19-idle）· 更新: 2026-11-28 · 里程碑: v1.0
> 对象: task-313 / 被验报告 `.agents/verify/g19-idle-live.md`（commit `f76155f`，74 行）
> 纪律: 只读复核；不启实例/不联网/不 push/不碰 `.kore-local-*`；唯一可写 = 本报告。
> 总评: **PASS**——五项红线证据自洽，goroutine=9 坐实为 `runtime.NumGoroutine()` 真实读数（非 Threads 代理），清理与 git 合规。

# G-19 空闲指标实测独立验收（task-313）

## ① 阶段一：既有实证与缺口判定（成立）

| 核实项 | 证据（file:line） | 结论 |
| --- | --- | --- |
| CPU / fd / 出站 / ticker 早测达标 | `g19-idle-live.md:18-24` 汇总表引 `v1-budget-measure.md:5,20-24,63-93`（主实例 pid 608004 只读）：CPU 0ms/60s、fd 14、出站 0、ticker 1 处属白名单 | 成立，四项已在真实实例量过且达标，无需重复 |
| 唯一缺口 = goroutine 直测 | `v1-budget-measure.md:21`（线程 16 代理；goroutine 未测）、`:24`（pprof 404 / system-info 401，goroutine 未测）、`:105`（「线程数 ≠ goroutine 数，不能据此判定红线达标」） | 成立，被验报告 `:26` 的判定与原文一致；Threads 16 仅为代理、不等价 |
| 监控页 11/15/16 非同口径 | `g19-idle-live.md:23,26`：带 14 插件主壳 + 主动刷新时点，非「空载 + 空闲 60s」 | 成立，未混入 G-19 口径 |
| G-19 五项均硬红线 | `AGENTS.md` G-19 行（CPU≤60ms/60s、goroutine≤20、fd≤64、出站 0、定时器仅 scheduler；违反「判为未完成」）、`.agents/QUALITY-GATES.md:24`（G14 等价手工取证 + 白名单）、`Makefile:276-299`（idle 目标逐项判据与阈值） | 成立，五项均为阻断级红线，非「争取值」（被验报告 `:12` 已正确区分 VmRSS 8MiB 目标 vs 16MiB 红线） |

## ② goroutine=9 真实性坐实（可信，非 Threads 代理）

核验了从 runtime 到 JSON 字段的完整取数链，逐跳有源码证据：

1. `internal/core/metrics/metrics.go:58`：`snap := Snapshot{TakenAt: time.Now(), Goroutines: runtime.NumGoroutine()}` —— **直接调用**，无任何 Threads/proc/status 折算。
2. `internal/core/metrics/metrics.go:31`：`Snapshot.Goroutines int`；`internal/core/httpapi/handlers_metrics.go:47,62`：`snap, err := s.metrics.Collect()` → `metricsBody{... Goroutines: snap.Goroutines ...}`；`internal/core/httpapi/types.go:122-123`：`Goroutines int`（JSON tag `goroutines`）；`handlers.go:73` 注册 `GET /api/v1/system/metrics`（`:20-35` 要求 `system:read`，fail-closed）。
3. 被验报告 `:36` metrics 原文：`{"cpu_pct":0,"rss_kib":14656,"disk_used_kib":594430780,"disk_total_kib":1966847136,"load1":2.42,"goroutines":9,"fds":12,"uptime_sec":65}` —— 字段名与 `types.go` 契约一致。
4. **代理区分铁证**：报告 `:44` 明写 `goroutines=9` 来自鉴权 `/system/metrics`，旁证 `/proc/9/status Threads` T0=14→T1=14。**9 ≠ 14**：若读数取自 Threads 代理必为 14，`Makefile:286-288` 的 idle 目标才是 `g="$$th"`（Threads 优先、UDS goroutines 兜底）的代理口径。故 9 是独立真实读数。
5. 编译/验签一致性：报告 `:3` 所测 HEAD `3fd403ed…` == `git rev-parse f76155f^` 实测 `3fd403ed241b3ba1c23e987cce2a5f1d9ffee9c3`，代码与报告自洽。

诚实边界（与报告 `:54` 一致）：隔离实例已按纪律清理、本卡禁启实例，故 **9 无法被本 verifier 独立重测**；坐实依据是「源码取数链直连 NumGoroutine + JSON 契约对应 + 数值与 Threads 旁证相异 + 时点/口径自述」。这是只读约束下可得的最强证据，读数可信，不构成 BLOCKED。

## ③ 五项红线逐条复算（全部 PASS）

| 指标 | 红线 | 报告实测（`:43-47`） | 本卡复核 |
| --- | --- | --- | --- |
| ① 空闲 CPU | ≤60 ms/60s | `/proc/9/stat` utime+stime T0=0→T1=0 ticks，Δ=0 | 算术复核 `(0-0)*1000/100 = 0 ms` ≤60；metrics `cpu_pct=0` 同源旁证。**PASS** |
| ② goroutine | ≤20 | 真实 `NumGoroutine()=9`（Threads 旁证 14） | 9≤14≤20，取数链见②。**PASS** |
| ③ fd | ≤64 | `/proc/9/fd` T0=10→T1=10；鉴权采样 `fds=12` | 10/12 均 ≤64。**PASS** |
| ④ 出站 | =0 | `ss -Htnp \| grep pid=9 \| grep -v LISTEN`：T0=0 行、T1=0 行 | 0=0；未配 webhook/更新源（报告 `:46`）。**PASS** |
| ⑤ 定时器 | 仅 scheduler 单 ticker | 全量 1 行 `internal/core/scheduler/loop.go:18` | 本卡实跑复现（见下）：全量恰好 1 行且落在白名单，去白名单后 0 行。**PASS** |

定时器实跑复核（命令 + 退出码）：

```
$ grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ --include='*.go'
internal/core/scheduler/loop.go:18:	ticker := time.NewTicker(s.tick)
TICKER_GREP_EXIT=0
$ grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ --include='*.go' | grep -v cert_renew | grep -v '^internal/core/scheduler/'
（无输出）
DENYLIST_GREP_EXIT=1        # grep 无命中 → 0 行，与 Makefile:295 判据一致
```

补充：报告 `:49` 主动声明本测只覆盖「空载主壳 + 空闲」，不替 `final-shots.md:61` 带 3 常驻插件 fd 94 下结论——诚实边界成立，无超范围推断。

## ④ 隔离清理回读（逐条成立，只读命令）

```
$ ss -ltnp | grep ':55231'                       → 无输出 → 55231_FREE
$ ls -d /proc/9                                  → No such file or directory → PID9_GONE
$ ls -d .tmp/g19-idle-live-55231                 → No such file or directory → ISO_GONE
$ ls .tmp/g19-idle-live-55231/probe.py           → No such file or directory → PROBE_GONE
$ ss -ltnp | grep ':8787'                        → LISTEN 127.0.0.1:8787（主实例未动）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz → 200
```

口令（G-30）：被验报告 `:33,70` 仅描述「经 `admin-password --set --stdin` 写入隔离 0600 配置、内存生成、随 ISO 删除、未进 argv/stdout/报告」，无任何明文值。本卡实跑 `make secret-check` → `secret-check: 0 FAIL / 31 处匹配（占位写法 / grep 正则模式均合规，1 WARN）`，**SECRET_CHECK_EXIT=0**（唯一 WARN 是 `backup-download-verification.md:125` 的 grep 正则片段，与本报告无关）。口令未进 argv / 报告的声明成立。

## ⑤ git 完整性（成立）

| 项 | 证据 | 结论 |
| --- | --- | --- |
| 精确单文件 74 行 | `git show --numstat f76155f` → `74 0 .agents/verify/g19-idle-live.md`；`git diff-tree --name-only f76155f` 仅该文件 | 成立 |
| DCO | `git log -1 --format=%B f76155f` 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` | 成立 |
| 未 push | `git status -sb` → `## main...origin/main [领先 1]` | 成立 |
| 他人 dirty 原样 | `git status --short` 仅既有条目：`M scripts/usability-pending.txt`、`?? .agents/.agents/`、`?? .agents/verify/{e2e-content-write,e2e-deploy-write,e2e-system-write,local-update-plan,release-batch-plan,release-batch-prep,release-inject-verify,run-user-model}.md`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`、`?? .gocache-kore-014/`、`?? data/`、`?? dist/` —— 均为他人/在途存量，本卡未改 | 成立 |
| worktree 卫生（G-25） | `git worktree list` → 仅 1 行主树 `... f76155f [main]` | 成立 |
| 临时资产 | g19-idle 的 ISO 树 / probe.py / 55231 进程全 GONE（见④）；上述 `.gocache-kore-014/` 等为他人存量，非本卡/本测产物，不属本卡清理范围 | 成立 |

## 总评

**PASS**。G-19 五项硬红线在真实隔离实例上全部达标；核心诉求「goroutine=9 是真实 `runtime.NumGoroutine()` 读数而非 Threads 代理」已由源码取数链（metrics.go:58 → handlers_metrics.go:47,62 → types.go:123 `json:"goroutines"`）+ 数值 9≠Threads 14 双重坐实；隔离清理、G-30 口令、git 精确单文件 74 行 + DCO 未 push、他人 dirty 原样均成立。无 BLOCKED 项，无超线项需回派优化卡。

唯一诚实保留：goroutine=9 无法由本 verifier 独立重测（禁启实例 + ISO 已清理），坐实依据为源码链与原文自洽，已在②明示。
