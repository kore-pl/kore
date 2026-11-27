# perf-baseline-r34 独立验收报告（G-09）

> verifier: perf-r34-verifier（非 perf-r34 实现者）｜日期: 2026-11-28 ~03:33 +08:00
> 复核对象: commit `f1db0f1b1d5e0c901d3ecee17076cbdff71ec46f` 单文件 `.agents/verify/perf-baseline-r34.md`（190 行）
> 硬纪律: 全程只读复跑；唯一可写 = 本报告；不改代码、不启服务、不 push、不联网、不碰 `.kore-local-*`。
> **总评: PASS**（数据自洽、方法可靠、判据诚实、隔离清理合规、git 纪律合规；无 BLOCKED 项）

---

## 1. git 纪律

| 项 | 命令 | 退出码 / 证据 | 判定 |
| --- | --- | --- | --- |
| commit 存在且为 HEAD | `git rev-parse HEAD` | `f1db0f1b1d5e0c901d3ecee17076cbdff71ec46f`，`git merge-base --is-ancestor f1db0f1 HEAD` exit=0 | PASS |
| 精确单文件 | `git show --stat --format='' f1db0f1` / `git diff-tree --name-status -r f1db0f1` | `A .agents/verify/perf-baseline-r34.md`，`1 file changed, 190 insertions(+)`；`git show --numstat` → `190 0` | PASS |
| 行数吻合任务卡 | `wc -l .agents/verify/perf-baseline-r34.md` | `190` | PASS |
| DCO | `git log -1 --format='%B' f1db0f1 \| grep -c 'Signed-off-by: ...'` | `1`；署名 `pengtang1024 <pengtang1024@qq.com>`；commit message 首行带 `[agent:perf-r34]` | PASS |
| 未 push | 各远端 `git rev-parse <r>/main`（本地缓存 ref，未 fetch） | origin=`ecd66ac`、github=`a2f0b70`、gitee=`a2f0b70`、gitea=`812f9fc`，均 ≠ HEAD `f1db0f1`；`git branch -a --contains f1db0f1` 仅 `* main` | PASS |
| worktree 仅主树 | `git worktree list` | 单行 `/home/pt/Work/GolandProjects/kore-pl/kore f1db0f1 [main]` | PASS |
| 他人 dirty 原样 | `git status --short` | ` M scripts/usability-pending.txt`；`?? .agents/.agents/`、`?? .agents/verify/e2e-*.md`、`?? .agents/verify/local-update-plan.md`、`?? .agents/verify/release-*.md`、`?? .agents/verify/run-user-model.md`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`、`?? data/`、`?? dist/`；本报告之外无本任务残留；f1db0f1 未夹带任何他人文件 | PASS |

> 报告 line 4 声称测量时 HEAD=`ecd66aca87ad…`；`git rev-parse f1db0f1^` = `ecd66aca87ad4c382a1818d20027827529eced6f`，即测量基于父提交树，报告作为独立验收文档提交在其之上，因果一致。

## 2. 数据自洽性（nearest-rank 独立复算）

方法：从报告附录原始样本数组（ms，未删样本）重解析，按报告自身声明的 nearest-rank（升序 `ceil(q·n)` 位，1-based）复算。全程 python3 stdin，未写任何脚本文件。

| 组 | n | 报告 p50/p95/p99/max | 独立复算 nearest-rank | 差异 | 判定 |
| --- | --- | --- | --- | --- | --- |
| healthz 稳态 | 200 | 0.4675 / 0.5748 / 0.6756 / 0.9714 | 0.467 / 0.575 / 0.676 / 0.971 | ≤0.0005（附录数组已四舍五入到 3 位） | PASS |
| system/info 未鉴权 | 200 | 0.4516 / 0.5665 / 0.6263 / 0.652 | 0.452 / 0.567 / 0.626 / 0.652 | ≤0.0005 | PASS |
| auth/session（带会话） | 200 | 0.5032 / 0.5954 / 0.6885 / 0.7241 | 0.503 / 0.595 / 0.689 / 0.724 | ≤0.0004 | PASS |
| system/info（带会话） | 200 | 0.507 / 0.6228 / 0.8187 / 3.9462 | 0.507 / 0.623 / 0.819 / 3.946 | ≤0.0004 | PASS |
| unauth 401 | 50 | 0.3219 / 0.5038 / 0.7585 / 0.7585 | 0.322 / 0.504 / 0.758 / 0.758（n=50 时 `ceil(0.99·50)=50`=max） | ≤0.0005 | PASS |
| login | 5 | 76.0591 / 77.804 / 77.804 / 77.804 | 76.059 / 77.804 / 77.804 / 77.804 | ≤0.0001 | PASS |

- 任务卡给出的取整数字（healthz 0.468/0.575/0.676/0.971；system/info 0.507/0.623/0.819/3.95 单抖；auth/session 0.503/0.595/0.689；unauth401 0.322/0.504/0.758；login 76.06/77.8）与复算/报告表格逐项一致。报告 line 51 自证「n=200 第 190 位 = 0.575ms」与复算吻合。
- 佐证：报告 min 亦与数组一致（healthz 0.1122↔数组 0.112；system/info 未鉴权 0.1243↔0.124；auth/session 0.1644↔0.164；system/info authed 0.1419↔0.142；unauth 0.1269↔0.127；login 75.9086↔75.909）。mean 复算 0.4360/0.4201/0.3462/76.4090/0.4921/0.5086 与报告表格逐项一致（末位舍入差 ≤0.0001）。

**吞吐自洽**（`python3 -c 'req/elapsed'`）：

| 并发 | req | 显示时长 | req/显示时长 | 报告 req/s | 反推精确时长 round3 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 7771 | 3.0 | 2590.3 | 2590.1 | 3.000 → 3.0 | PASS（差来自显示时长 3 位取整） |
| 4 | 11280 | 3.001 | 3758.7 | 3759.0 | 3.001 | PASS |
| 8 | 10071 | 3.002 | 3354.8 | 3354.3 | 3.002 | PASS |
| 16 | 7761 | 3.004 | 2583.6 | 2583.3 | 3.004 | PASS |

四档错误数全 0（报告 §4 表格），无 5xx（§2/§6），PASS。写路径 `POST /api/v1/alerts` 单次 4.8163ms（§5），任务卡 4.82ms 与之吻合；为受控单次样本，无数组可复算，全文一致。机器环境（§1）：i7-13700K / `nproc`=24 / 61Gi，独立复跑 `nproc`→24、`free -h`→61Gi 总量/41Gi 可用，与报告吻合，PASS。

## 3. 方法可靠性

| 判据 | 报告原文 | 独立核对 | 判定 |
| --- | --- | --- | --- |
| 每请求新连接 + 保守口径 | §1「每请求一条全新 TCP 连接（http.client，非 keep-alive），perf_counter 包围 request→read 全链路，含连接建立，比浏览器 keep-alive 略高」；§7 同口径复述 | 方法陈述完整，未把含建连延迟误称为纯服务端耗时 | PASS |
| 200 次弃 30 预热 + nearest-rank | §1「稳态序列前丢弃 30 次预热」「nearest-rank 升序 ceil(q·n)，n=200 第190位=0.575 与统计 0.5748 一致」 | 与附录 n=200 数组 + 本报告复算吻合（见 §2） | PASS |
| 冷/稳态区分 | §2 表格分列「冷启动首次」与「稳态 200 次」，正文「冷/稳态同量级，无首请求异常慢」 | 冷 0.4735–0.6198ms vs 稳态 p50 0.4516–0.507ms，一致 | PASS |
| 异常抖动如实标注 | §2 正文「system/info authed max=3.95ms 偶发调度/GC，未超阈值，样本保留未删」；数组内 `3.946` 单点（全数组仅 1 次），§7 未隐藏 | 数组中 3.946 唯一出现；p50/p95/p99 不受污染，报告未删样本也未夸大 | PASS |
| login 76ms 归因 | §3「PBKDF2-SHA256 600,000 次迭代（password.go:32 HashIterations）主导，经单飞串行化（handlers_auth.go:110-119），属预期安全成本不是缺陷；每会话仅一次」 | 读码：`internal/core/auth/password.go:32` `HashIterations = 600000`；`:90` `pbkdf2.Key(...)`；`docs/SECURITY.md:65`「600,000 次迭代」；`handlers_auth.go:110-119` `BeginVerify` 单飞 + `Verify`；归因真实且明确非缺陷 | PASS |
| 4 并发后回落归因 | §4「客户端单进程 Python GIL + 每请求新建 TCP 连接是客户端侧瓶颈，不是服务端能力上限；req/s 是端到端观测值/服务端容量的保守下界，不可解读为极限」；§7 复述 | 报告明确标注「保守观测 / 下界 / 非极限」，未冒充服务端极限 | PASS |
| 其余归因可核对 | §6：system/info 读启动期缓存 envprobe + 内存 supervisor 统计（`handlers.go:165-180`）；会话 Validate/Touch/Slide（`middleware.go:297-323`）；写告警 bbolt fsync | 读码核对：`handlers.go:164-179` handleSystemInfo 仅 Stats + 内存字段，无文件/网络 I/O；`middleware.go:297-323` Validate/Touch/Slide 与 5 分钟节流吻合 | PASS |

## 4. 判据与诚实边界

- **红线原文核对**：`docs/V1-GOALS.md:45`（sed 40-50 回读）「启动到就绪 ≤1s（不含插件 ready）；lazy 冷启动 p95 ≤300ms；API p95 ≤50ms（本地）」；`docs/PLAN.md:244-245`（sed 240-248 回读）「启动到就绪 ≤1s，`kored` 进程启动→首次 `GET /-/healthz` 200；API p95 ≤50ms，`GET /api/v1/auth/session` 或 `/system/info` 连续 200 次取 p95」；`docs/ROADMAP.md:142`（sed 138-146 回读）M1 退出条件同口径 + lazy p95 ≤300ms「M1 无 lazy 插件、M2 起生效」。报告 §6 line 107 引用三处行号与判据**逐字吻合**，且正确说明 lazy 不在本卡范围。PASS。
- **余量计算**：最慢 p95 = system/info authed 0.6228ms → 50/0.6228 ≈ **80.3 倍**；healthz p95 0.5748ms → 50/0.5748 ≈ **87.0 倍**。报告 §6「余量约 60–87 倍」的上界 87 与复算吻合；下界 60 较保守（对应 p99 0.819ms → 61 倍，而非 p95 最慢序列的 80 倍），属**向下取整的保守表述、未夸大**。结论「PASS」成立。PASS。
- **「健康无需优化 / 未发现值得另派优化卡的真实瓶颈」**：报告 §6 结论有四条依据（p95/p99 距红线两个数量级、启动 152ms、零错误、login 为安全成本），并受 §7 边界限定（单机单实例、仅 HTTP 面、无 pprof、吞吐为下界）。属**带作用域的结论**，未声称"所有场景健康"，不算夸大。PASS（作用域内）。
- **竞品边界**：§0 line 7 与 §7 line 119 明确「单机单实例、无竞品同口径对照，不能作为性能超越竞品的证据」。如实。PASS。
- **未验证项**：§7 line 122「未做 pprof / CPU profile；`perm-system-cost.md` 提的『审计 deny 路径 fsync 写放大 QPS』仍需单独微基准，不在本卡范围」；§7 line 123「被测二进制为仓库自带 bin/kored 逐字节副本，沙箱无法 go build，HEAD 源码一致性未在本次测量中重新编译验证」。两项均如实披露，未掩盖。PASS。

## 5. 隔离与清理

| 项 | 独立复跑命令 | 结果 | 判定 |
| --- | --- | --- | --- |
| 隔离目录 | `test -e .tmp/perf-r34 && echo STILL_EXISTS \|\| echo GONE` | `GONE` | PASS |
| 隔离实例已停 | `pgrep -a kored` | `no kored`（本沙箱进程视图；报告口径为"隔离实例已停、主实例本轮未起/未碰"） | PASS |
| 55151 释放 | `ss -ltn \| grep ':55151 '` | 无输出（无 55151 监听） | PASS |
| 8787 主实例未变 | `ss -ltn \| grep ':8787 '` + `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz` | `127.0.0.1:8787 LISTEN` 仍在，`http=200`；未起/停/改主实例 | PASS |
| 关键文件 mtime 未变 | `stat -c '%y %n' bin/kored data/initial-admin-credential .kore-local.yaml` | `2026-11-28 00:26:23`（bin，与报告一致）、`2026-11-25 20:59:10`（凭据）、`2026-11-25 20:15:44`（.kore-local.yaml）——与报告 §8 回读逐字一致 | PASS |
| bin 副本 sha | `sha256sum bin/kored` | `a6d0ebeb9174b44b7eac80c7fc6c24ba25daad073e921e470d1cf0d520f729c9`，与报告 §1 line 43 `sha256(host)=a6d0ebeb…` 一致 | PASS |
| 口令不进 argv/报告 | 全文 grep `"password"/"secret"/"token"/PASSWORD=/ADMIN_PASSWORD/REDIS_/MYSQL_` 于报告 | 无命中；报告 §1 line 34 为 0600 随机口令仅内存读取的口径陈述，无明文 | PASS |
| 无残留脚本/二进制 | `grep -rl 'perf-r34\|harness.py\|kored-perf' --include='*.py' --include='*.sh' .` | 无命中；`.tmp/` 现存文件均为 2026-11-25 既有资产（gocache/gomodcache/install-*.json 等），非本任务残留 | PASS |
| secret 门禁 | `make secret-check` | exit=0；`secret-check: 0 FAIL / 25 处匹配（占位写法均合规）`，与报告 §8 line 150 一致 | PASS |

> 备注：沙箱内 `pgrep -a kored` 无输出但 8787 仍 200，说明主实例运行在我进程视图之外的宿主命名空间；这**不改变**报告结论（报告只声称隔离实例停止、主实例未被本轮触碰），文件 mtime 与端口状态佐证了这一点。

## 6. 结论

- 五项复核域（数据自洽 / 方法可靠 / 判据边界 / 隔离清理 / git 纪律）全部 PASS，无自相矛盾数字、无证据不成立项。
- 仅有两处**保守表述**级观察（非缺陷、不判 BLOCKED）：① §6「60–87 倍」下界 60 来自 p99（≈61 倍）而非 p95 最慢序列（≈80 倍），未夸大；② 8787 主实例在本沙箱进程视图外，结论依据文件 mtime + 端口/健康态回读，与报告一致。
- **总评：PASS**。本报告作为唯一可写产物精确提交，不 push。
