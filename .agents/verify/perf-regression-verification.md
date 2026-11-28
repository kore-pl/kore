# G-09 · perf-regression-r48 终检独立复核（只读 verifier，非 perf-regression）

> verifier: perf-regression-verifier（G-09，G-09 角色独立：非 implementer、非 perf-regression 本人）
> 复核对象: commit `3ad7cf5693ee507cabc77c975410f1c3472b6125`（单文件 `.agents/verify/perf-regression-r48.md`，191 行，父 `0cfc11f`）
> 对照基线: `.agents/verify/perf-baseline-r34.md`（HEAD `ecd66ac`，kored 0.1.2）
> 日期: 2026-11-28｜口径: **只读复核**，不启服务 / 不联网 / 不碰 `.kore-local-*` / 不改生产代码｜唯一写域 = 本报告

## 总评：**PASS**（A/B 证伪成立，无 BLOCKED 条件）

| 复核项 | 判定 | 一句话结论 |
| --- | --- | --- |
| ① 口径对齐 | PASS | 端点集/方法/机器口径逐项对齐，HEAD/version/sha 与原文相符 |
| ② 数字自洽 | PASS | 所有 p95/吞吐/login/启动数字读原文一致，倍数复算无误 |
| ③ A/B 证伪核心 | PASS（成立） | 同二进制 2.18× 抖动 + BASE 反慢 + loadavg 同向，足以支撑「回弹不可归因于 14 轮改动」 |
| ④ 混合负载 mutex | PASS | `Submit` 唯一调用点=`auditDenied`（deny 路径），成功路径不进锁；数据证明确不传导 |
| ⑤ 红线 | PASS | 最慢 p95 2.5011ms，余量 20×，无夸大 |
| ⑥ 清理/git | PASS | 6 目录 GONE / 端口 / sha / 单文件 DCO / 未 push / 他人 dirty 原样 |

> **A/B 证伪成立判定：成立（作为「不可归因」的认识论结论）。** 关键在于逻辑强度：同一二进制在零代码变更下 healthz p95 自身摆动 2.18×，已达到甚至超过 §2 相对基线的 ~3× 回弹量级；因此 3× 的跨构建差异不足以作为「代码回归」的证据。报告未声称「证明绝无回归」——§7 明确「仍无法排除所有环境噪声」并给 lead 保留另派 profiling 卡的选项，属诚实边界，不是逻辑漏洞。无反例推翻该判断（BASE 反慢恰是「新代码更慢」假设的反例，报告已正确采纳）。

---

## ① 口径对齐（PASS）

逐项读两份报告原文 + git 回读，均对齐：

| 项 | round34（基线原文 §1/§2/§4） | r48（报告 §1.1） | 复核 |
| --- | --- | --- | --- |
| 端点集 | healthz / system-info（带+不带会话）/ auth/session（带会话）/ system-info 未带会话 401×50 / login×5 | 声称「完全一致」（§2 逐项） | ✅ 两报告 §2 表格端点逐行对应一致 |
| 方法 | Python 3.14 `http.client`、每请求新 TCP（非 keep-alive）、`perf_counter` 包围 request→read、弃 30 预热、nearest-rank `ceil(q·n)`（n=200→第 190 位=p95） | 声称「完全一致」 | ✅ 基线 §1 + 附录样本数组印证；复算 `ceil(0.95×200)=190` 与基线 healthz p95=0.5748 相符 |
| 吞吐 | healthz、每档独立 3s、1/4/8/16 并发、错误=非 200 | 声称「完全一致」 | ✅ 基线 §4 与报告 §3 同口径 |
| 机器 | i7-13700K / nproc=24 / 61Gi / loadavg `3.90 3.10 2.98` | 同机 / 24 核 / ≈61Gi / loadavg `5.41→5.82` | ✅ 基线 §1 原文为 3.90 3.10 2.98 |
| HEAD/version | ecd66ac / 0.1.2 | 0cfc11f / 0.1.4 | ✅ `git show 0cfc11f:Makefile`=`VERSION ?= 0.1.4`、`main.go:17 version="0.1.4"`；`git show ecd66ac` 对应 0.1.2 |
| 被测二进制 | 仓库 bin/kored 逐字节副本 | HEAD 现场编译（仓外 GOCACHE/GOMODCACHE，GOPROXY=off） | ⚠️ 口径有差异，但报告 §1.1/§7 **已如实披露并声明「更严格」**，且 §4 A/B 用同工具链编译 BASE+HEAD 加以控制，不构成证伪漏洞 |
| 宿主 bin/kored sha | `a6d0eb…`（基线时点） | 声称宿主 sha `3de48562…a648` 未变、未覆盖 | ✅ 实测 `sha256sum bin/kored` = `3de48562e5c726921db809d0241f991f24a8bf7aca7aff4f0360a4d013baa648`，与报告一致 |
| 隔离 | KORE_HOME/CONFIG/STATE_DIR 隔离、TCP 非 8787 | 端口 55241 | ✅ 见 ⑥ 端口复核 |

## ② 数字自洽（PASS）

读基线 §2/§3/§4 与报告 §2/§3 原文，逐数核对（倍数复算）：

| 指标 | 基线原文 | 报告值 | 复算 | 复核 |
| --- | --- | --- | --- | --- |
| healthz p95 | 0.5748 | 1.7521（复跑 1.9281） | 3.05× / 3.35× | ✅ 报告 §2.1 表内即 0.5748→1.7521 |
| auth/session p95 | 0.5954 | 1.7980（复跑 2.5011） | 3.02× / 4.20× | ✅ 报告 §2.1（带会话 auth）与 §2.4 |
| unauth401 p95 | 0.5038 | 2.3842 | 4.73× | ✅ 报告 §2.2 |
| 吞吐 1/4/8/16 req/s | 2590.1 / 3759.0 / 3354.3 / 2583.3 | 1883.2 / 2918.8 / 2725.8 / 2305.2 | −27.3% / −22.4% / −18.7% / −10.8% | ✅ 报告 §3 表内一致，错误全 0 |
| login mean | 76.4088 | 72.60 | 持平/略快 | ✅ 报告 §2.2 mean 72.60 |
| 启动就绪 | 152.29ms | 106.21ms（复跑 103.81ms） | 改善 | ✅ 报告 §2.3 |

全部数字与原文逐位一致，倍数描述（~3×、~4.7×、低 ~11–27%）复算无误。✅

## ③ A/B 证伪核心（PASS — 证伪成立）

报告 §4 表（HEAD1→BASE→HEAD2，同工具链/同缓存/同端口/每次清 state 首启）：

| 运行 | 被测 | healthz p95 | 单并发 req/s | loadavg |
| --- | --- | --- | --- | --- |
| HEAD1 | HEAD 0cfc11f (sha bbea8c12) | 0.7972 | 1888.5 | 4.82 3.78 2.95 |
| BASE | ecd66ac (sha 1b827b44) | 1.5798 | 2320.5 | 5.61 4.00 3.03 |
| HEAD2 | HEAD 同一二进制 | 1.7358 | 1771.2 | 5.82 4.10 3.08 |

复核结论：

1. **同二进制自身摆动 2.18×**：`1.7358 / 0.7972 = 2.177 ≈ 2.18×`，零代码变更。这是全证伪的承重证据——它证明「含建连的 sub-ms 端到端采样」在该负载下本身就有 ~2× 噪声，已达到 §2 相对基线 ~3× 回弹的量级。**故 3× 跨构建差异不能作为代码回归证据**，逻辑成立。✅
2. **BASE 反慢于 HEAD1 1.98×**：`1.5798 / 0.7972 = 1.98×`。若按「新代码更慢」的假设，应见 HEAD 持续慢于 BASE；实测相反，构成对「代码回归」假设的直接反例。报告 §4 结论 2 已正确采纳并据此判定单次采样不足以判回归。✅
3. **loadavg 同向**：基线 3.90 → A/B 内 4.82→5.61→5.82，随 HEAD1→BASE→HEAD2 劣化单调上行，与延迟/吞吐劣化同步，支持「环境/负载主导」归因。✅
4. **吞吐同受噪声支配**：同二进制单并发 1888.5→1771.2（−6%），BASE 2320.5 居中，与「GIL+建连+负载」解释一致。✅
5. **无旁证反例**：`git show` 复核资源锚点（GOGC=50 / GOMEMLIMIT=6MiB / GOMAXPROCS=8）在 BASE `ecd66ac` 的 `serve_limits.go` 已存在（defaultGOGC/defaultMemLimit/maxProcs 逐项命中），非 14 轮新增，排除「新引入 GC 参数导致回弹」。✅

诚实边界（非漏洞，予以记录）：A/B 每位置 n=1（HEAD1/BASE/HEAD2 各一次），且顺序固定 HEAD→BASE→HEAD；但 (a) 承重结论只依赖「同二进制 2.18×」这一个直接观测，n=1 的该观测本身已足以证伪「3× 差异=代码回归」；(b) §2 全量复跑 ×2 与 §3 吞吐复跑提供额外样本；(c) 顺序效应（越跑越慢）恰好支持环境归因而非代码归因。报告 §7 主动声明不能排除所有噪声并保留 profiling 卡选项——结论口径是「不可归因」，不是「证明无回归」，未越界。判定 A/B 证伪**成立**。

## ④ 混合负载 mutex（PASS）

**代码路径（只读 grep + 读原文）**：

- `deny_burst.go:28` = `DenyGlobalIndividualBudget = DenyBurstThreshold`（=10）✅
- `deny_burst.go:98` = `mu sync.Mutex`；`:101-105` = `globalWindowStart / globalIndividuals` 跨 key 预算状态 ✅
- `deny_burst.go:118` = `func (t *DenyBurstTracker) Submit(...)`；`:150-153` = 第一分支 `st.count<=Threshold && globalIndividuals<budget` 与 `t.globalIndividuals++` ✅
- **决定性的唯一性核查**：全仓 grep `denyBurst.Submit` 仅命中 1 处生产调用 = `internal/core/httpapi/middleware.go:281`，位于 `auditDenied()`（`:277`）内。所有 `auditDenied` 调用点（credentials/scheduler/migrate/alerts/audit/sessions/restart/invoke_capability/channel/handlers_metrics 等）**全部是 capability 越权/拒绝分支**；成功路径不调用 `auditDenied`，因此不进 `Submit`、不触碰 `mu`。✅
- 报告 §5 的 4 个真 deny 端点：`credentials` / `scheduler/tasks` / `scheduler/tasks/nonexistent/runs` / `migrate/export`——抽样读 `handlers_credentials.go:23`、`handlers_scheduler.go:66`、`handlers_migrate.go:222`，均在 `!hasCapability(granted,"system:admin")` 分支调 `auditDenied` 并写 401；与报告描述一致。✅

**数据（报告 §5）**：8 并发、每 3s、10% deny——纯成功 p95 6.2684 → 混合 p95 6.0877（−2.9%）；复跑 6.2294→6.0620（−2.7%）；成功非 200=0；deny 810 次非 401=0、deny p95 8.5742ms。成功路径未被拖慢（持平/略低，落在抖动内），deny 的审计/告警落库开销未传导。✅「mutex 不影响成功路径」判定成立。

## ⑤ 红线（PASS）

- G-03 / V1-GOALS `API p95 ≤50ms`：报告 §2.4 取复跑最慢 auth/session p95=2.5011ms；复算 `50 / 2.5011 = 20.0×` 余量，报告表述「余量约 20–28 倍，按复跑最慢 2.501ms 计」准确。✅
- 启动 ≤1000ms：106.21ms，PASS。✅
- 5xx/拒绝放大：全序列 5xx=0、401 fail-closed，PASS。✅
- 无夸大：报告 §2.4 明确写明余量由基线「60–87×」下降为「20–28×」，如实记录，不粉饰。（§0 表格「20–400×」为涵盖 min 值的宽区间表述，操作性 p95 指标以 §2.4 的 20–28× 为准，不构成夸大达标。）未触绝对红线，不满足「p95 超 50ms」硬上报条件。✅

## ⑥ 清理 / git（PASS）

只读复跑（命令 + 结果）：

| 判据 | 报告 §8 声明 | 独立复核实测 | 结论 |
| --- | --- | --- | --- |
| 6 个 /tmp 隔离目录 | 全 GONE | 逐 `test -e`：`perf-r48-iso` / `-b` / `-c` / `-ab` / `-ab2` / `-d` 全部 GONE | ✅ |
| harness 删除 | /tmp 无 `perf-r48*.py` | `ls /tmp/perf-r48*.py` → 无 | ✅ |
| 55241/55242 | FREE | `ss -ltn` 仅见 `:8787`，无 55241/55242 | ✅ |
| 8787 | LISTEN 未动 | `LISTEN 127.0.0.1:8787` 仍在；`pgrep -a kored` 无残留进程 | ✅ |
| bin/kored sha | `3de48562…a648` 未变 | `sha256sum` = `3de48562e5c726921db809d0241f991f24a8bf7aca7aff4f0360a4d013baa648` | ✅ |
| 3ad7cf5 精确单文件 + DCO | 1 文件 191 行 + Signed-off-by | `git diff-tree` → `A .agents/verify/perf-regression-r48.md` 单文件 191 行；`git show --format=fuller` 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` | ✅ |
| 未 push | — | `git branch -r --contains 3ad7cf5` → 空（任何远端跟踪分支均不含） | ✅ |
| 他人 dirty 原样 | 仅存量 dirty + 本报告 | `git status --short` 仍为原 `M scripts/usability-pending.txt` + 存量 `??`（.agents/.agents/、多个 verify/*.md、screenshots、.gocache-kore-014/、data/、dist/），本次复核未新增/未触碰 | ✅ |
| secret-check | exit 0 | 独立复跑 `bash scripts/secret-check.sh` → exit 0（0 FAIL / 31 处匹配合规，1 WARN 为正则片段） | ✅ |

## 交付与纪律核对

- 本 verifier 全程**只读**复核；唯一写入 = 本报告（写域严格等于 task-316 `write_scopes`）。
- 提交方式：精确 `git add .agents/verify/perf-regression-verification.md` + `git commit -s`（不 push、不联网、不启服务）、`-s` 追加 DCO，`[agent:perf-regression-verifier]` 首行前缀。
- G-09 角色独立：本人非 perf-regression implementer，结论基于独立 grep / git 回读 / 脚本复跑，未复用被验者自述。

## 总评

**PASS**。六项复核全部成立，A/B 证伪逻辑成立且无反例推翻；「数字回弹属环境噪声、非代码可归因回归」的判断有承重证据（同二进制 2.18× 摆动 + BASE 反慢 + loadavg 同向 + 资源锚点非新增 + 成功路径无 per-request 改动）支撑，报告诚实边界到位。无 BLOCKED 条件。
