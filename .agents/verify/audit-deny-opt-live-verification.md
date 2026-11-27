# audit-deny-opt-live-verification · 审计 deny 写放大优化 P3 独立验收

> owner: audit-deny-opt-live-verifier（G-09，独立于实现者 audit-deny-opt-live 与 P1/P2 实现/验收者）｜日期: 2026-11-28 ~05:50 +08:00｜持续目标 round 35
> 任务: task-267（先 claim）｜工作目录: `/home/pt/Work/GolandProjects/kore-pl/kore`
> 被测对象: 报告 commit `7fd5f41`（277 行，`.agents/verify/audit-deny-opt-live.md`）的只读独立复核
> 性质: 全程只读复跑 + 数字抽算 + 源码/文档锚点核对；未改生产代码、未启/停服务、未碰 8787 / `.kore-local-*`、未联网、未 push。

---

## 0. 总评：PASS（数字全自洽、结论未夸大、隔离清理到位、git 纪律合规）

五组复核（前置 / 数字 / 诚实边界 / 隔离清理 / git）全部成立，无一项需报 BLOCKED。核验方法与证据逐节如下。

---

## 1. 前置与真 deny 构造复核

| 项 | 报告声称 | 本轮只读核验（命令 + 退出码 + 关键输出） | 判定 |
| --- | --- | --- | --- |
| 被测 HEAD | 测试时 `7cad293800d50ca7ec6948aa402912a5f0a10885` | `git rev-list --parents -n1 7fd5f41` → 父提交 `7cad293800d50ca7ec6948aa402912a5f0a10885`（= 报告提交的父，即测试时 HEAD）exit 0 | ✅ |
| 版本 0.1.3 | Makefile / main.go 均 0.1.3 | `grep -n VERSION Makefile` → `VERSION ?= 0.1.3`（:29）；`grep -n 'var version' cmd/kored/main.go` → `var version = "0.1.3"`（:17）；exit 0 | ✅ |
| 临时二进制 sha 与宿主不同 | 临时 `5ffc2337…` ≠ 宿主 `a6d0ebeb…`（0.1.2 未覆盖） | `sha256sum bin/kored` → `a6d0ebeb9174b44b7eac80c7fc6c24ba25daad073e921e470d1cf0d520f729c9`，与报告 §2 记录一致；临时二进制沿用的编译命令（§2 原文 `go build … -X main.version=0.1.3 -o .tmp/audit-deny-opt-live/kored-live`）口径合理，且临时目录已删（§5 核 GONE）；两 sha 前缀不同，宿主未被覆盖 | ✅ |
| 真 deny 构造 | read token 调 `GET /api/v1/credentials` → 401「越权：凭据管理需要 system:admin 能力」；同 token `system/info`=200 | `grep -n "需要 system:admin 能力\|越权：凭据管理" internal/core/httpapi/handlers_credentials.go` → :23 `s.auditDenied(subject,"credentials","","","需要 system:admin 能力")`、:25 `"越权：凭据管理需要 system:admin 能力"，"system:admin"`；报告 §3 原文 `verify_deny=401`/`verify_success=200`，确为 `authorizeCredentials → auditDenied` 真落库路径，非 400/非法参数替代路径 | ✅ |
| 优化代码锚点 | 阈值10/窗口1s/MAX_MERGE=1000；detail=count/window_ms/first_at/last_at/reason | `grep deny_burst.go` → :16 `DenyBurstThreshold=10`、:17 `DenyBurstWindow=time.Second`、:18 `DenyMergeMax=1000`；:162-167 detail 写入 `reason/count/window_ms/first_at/last_at`；`store/alerts.go:89-93 PutAlertCounted` 存在。与报告 §3 写链路一致 | ✅ |

> 前置结论：被测对象、版本、真 deny 构造与优化代码事实全部对得上，无「用替代路径冒充真 deny」或「拿旧二进制冒充优化版」的迹象。

---

## 2. 硬断言数字自洽复核（抽算 + 读原文数组）

用 Python 独立抽算（本轮只读、未复用实现者脚本）：

**2.1 并发 16 拒绝 p95 ≤50ms（报告 §4）**

- `158.02 / 22.9034 = 6.899×` ≈ 报告「6.9×」✅
- 5 次独立复跑 p95 `[21.4168, 22.8036, 27.8577, 19.2048, 12.5058]`，`all(≤50)=True`，min 12.5058 / max 27.8577 → 报告「12.51–27.86ms、5/5 ≤50ms」✅
- 固定 N=300 c1/c4/c16 p95 = 2.9040/4.9362/22.9034ms，与报告「2.90/4.94/22.90」及任务卡给定值一致 ✅
- 5s 稳态 `n/rps` 反推耗时：c1 `4824/964.61=5.001s`、c4 `5216/1043.13=5.000s`、c16 `4994/998.72=5.000s` → 与「5s 稳态」口径自洽 ✅

**2.2 1:1 写放大打破 + count 守恒（报告 §5）**

- 守恒实验：`expected=300+1=301`，`conserved_delta=301` → 相等 ✅；`records_delta=12 < 301` → 1:1 被打破 ✅；合并元数据 `merged_meta_delta=2` ✅
- 合并样本 detail 含 `count=290 / window_ms=1000 / first_at / last_at / reason`，五项齐全（报告 §5.2 原文）✅，与 §1 源码字段一致
- 全量守恒：`denies_issued=17737 == audit_conserved_sum=17737` ✅；`alerts_record_count=1`、`alert_count_field_sum=17737 == denies` ✅；合并比 `17737/609=29.1` ≈ 报告「≈29:1」✅
- 交叉重建：性能表可见拒绝数 = 固定 900 + 复跑 1500 + 稳态 15034 + 守恒实验 301 = 17735，与 grand_total 17737 差 2（verify 阶段 2 次拒绝未列入性能表）。差额可解释且方向合理（grand_total 为权威计数 ≥ 性能表子集），非数字矛盾 ✅

**2.3 吞吐 ≥2× 与告警无风暴（报告 §6）**

- `964.61/104.94=9.19×`、`1043.13/111.68=9.34×`、`998.72/123.87=8.06×` → 报告「9.2/9.3/8.1×」✅，均 ≥2× ✅
- 固定 N=300 c16 `109.17→1309.44=12.0×`，与报告 §6.1 一致 ✅
- 告警：`alerts_record_count=1` 恒 1、`count=17737`、`alert_delta=0`，无风暴 ✅；通知派发次数未真机观测，报告如实标单测覆盖（见 §3）✅

> 数字结论：所有声称值与其原文数组/基线对照可逐项复算吻合，未发现不自洽；无 BLOCKED 触发。

---

## 3. 诚实边界与结论口径核对

| 边界项 | 报告标注 | 核验 | 判定 |
| --- | --- | --- | --- |
| p95 红线来源 | §8 引 V1-GOALS/PLAN/ROADMAP ≤50ms | `grep` 三文档：`docs/V1-GOALS.md:45`（API p95 ≤50ms 本地）、`docs/PLAN.md:245`（≤50ms 表）、`docs/ROADMAP.md:142`（≤50ms 退出条件）——均确证原文存在 ✅ | ✅ |
| p99/max 尾部尖峰 | §4.3 注 + §8#4：96–231ms 尖峰、不宣称 p99 达标、红线判据为 p95 | 复跑表 p99 96.94–204.48ms / max 153.88–231.53ms，报告如实标注「p95 达标但 p99/max 未达 50ms、不宣称 p99 达标」——未掩盖、未夸大 ✅ | ✅ |
| 超 MAX_MERGE 真机未构造 | §7 I2：本轮单窗口最大 300<1000，单测覆盖 | `deny_burst_test.go:108 TestDenyBurstMaxMergeFallsBackToIndividual` 存在；报告如实标「未真机构造、单测覆盖」✅ | ✅ |
| root.action fail-closed 真机难构造 | §7 I3：需 systemd transient unit，单测覆盖 | `cmd/kored/deny_burst_test.go:14 TestRootActionAuditNotMerged` 存在；报告如实标「未实测、单测覆盖」✅ | ✅ |
| 通知每窗口真机难观测 | §6.2：隔离实例未装配外部通知通道，单测覆盖 | `deny_burst_integration_test.go:51 TestAuditDeniedMergedEndToEnd` 存在；报告如实标「不伪造真机数据」✅ | ✅ |
| 审计可查 detail.reason | §7 I1：真机确认 | `TestDenyBurstCountConservation`（:39）、`TestAuditDeniedMergedEndToEnd` 存在；报告 §5.2 有原文样本 ✅ | ✅ |
| 单机单实例无竞品对照 | §8#1：不构成超越竞品证据 | 报告明确「只证明自身当前 HEAD 表现、不构成超越竞品证据」✅ | ✅ |
| 单管理员 read token 真 deny 边界 | §8#2：认证后低权向量、非多用户 RBAC | 如实标注，且未声称匿名可触发 ✅ | ✅ |
| 被测对象差异 | §8#6：本轮 0.1.3 现场编译 vs 基线 0.1.2 副本 | 如实标注为验证目的而非口径漂移 ✅ | ✅ |

> 诚实边界结论：报告对「p95 达标但 p99/max 未达标、三项不变量真机难构造由单测覆盖、无竞品对照」均如实披露，无夸大宣称（未把 6.9× 说成超越竞品、未把单测说成真机实测）。无 BLOCKED 触发。

---

## 4. 隔离与清理回读（本轮独立只读复测）

| 项 | 报告 §9 声称 | 本轮独立复测（命令 + 退出码 + 关键输出） | 判定 |
| --- | --- | --- | --- |
| 55171 端口 | FREE | `ss -ltn \| grep ':55171 '` → 无输出（`55171 FREE`）exit 0 | ✅ |
| kored-live 进程 | 无 | `ps -eo comm= \| grep -x kored-live` → 无（`no process named kored-live`）；`pgrep -af '[k]ored-live' \| grep -v 'bash -c'` → 无。注：初次 `pgrep -af kored-live` 命中的是本轮核验 shell 自身命令行文本，排除后无真实进程 | ✅ |
| 临时目录 | `.tmp/audit-deny-opt-live` GONE | `test -e .tmp/audit-deny-opt-live && echo STILL_EXISTS \|\| echo GONE` → `GONE`；`results.json`/`harness.py` 逐路径核 → 均 `GONE` exit 0 | ✅ |
| 宿主二进制未变 | sha `a6d0ebeb…729c9` | `sha256sum bin/kored` → `a6d0ebeb9174b44b7eac80c7fc6c24ba25daad073e921e470d1cf0d520f729c9`，与报告测试前/后一致 | ✅ |
| 8787 主实例 | healthz 200 | `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz` → `HTTP=200` exit 0 | ✅ |
| `.kore-local.yaml` 未动 | 未碰 | `stat .kore-local.yaml` → mtime `2026-11-25 20:15:44`（远早于本轮 11-28 测试），未被本轮改写 ✅ | ✅ |
| 明文凭据 | 0 FAIL、报告无明文 | `GOPROXY=off make secret-check` → `secret-check: 0 FAIL / 25 处匹配`，exit 0；报告内 grep 明文 pattern → `no plaintext credential pattern`；token 仅以哈希前缀 `token:dfe5e2...` 脱敏出现 ✅ | ✅ |

> 隔离结论：端口、进程、临时目录、宿主二进制、主实例、配置文件、凭据七项回读全部到位，清理干净，无主实例污染。无 BLOCKED 触发。

---

## 5. Git 纪律复核

| 项 | 核验命令 + 退出码 + 关键输出 | 判定 |
| --- | --- | --- |
| 被测提交精确单文件 + 277 行 | `git show --stat --format=... 7fd5f41` → `.agents/verify/audit-deny-opt-live.md \| 277 +++++`（1 file changed, 277 insertions）exit 0 | ✅ |
| DCO | 同上 message body 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ✅ | ✅ |
| agent 前缀 | commit 首行 `[agent:audit-deny-opt-live] docs(verify): …`（非本 verifier，符合 G-09 角色分离）✅ | ✅ |
| 父提交 = P1/P2 验收 HEAD | `git rev-list --parents -n1 7fd5f41` → 父 `7cad293…`，与任务卡预期一致 ✅ | ✅ |
| 未 push | `git rev-parse origin/main`/`github/main`/`gitee/main` 均 `ecd66ac…`；`git merge-base --is-ancestor 7fd5f41 <各远端>/main` 均返回 NO → 远端 ref 不含 7fd5f41；`rev-list --count origin/main..HEAD`=8（本轮前序文档批次均未推）exit 0 ✅ | ✅ |
| worktree 仅主树 | `git worktree list` → 仅 `/home/pt/.../kore 7fd5f41 [main]` 一行 ✅ | ✅ |
| 他人 dirty 原样 | `git status --short` → `M scripts/usability-pending.txt` + 多条 `?? .agents/verify/e2e-*.md`、`data/`、`dist/` 等，均为他人既有未跟踪/修改项，本轮未提交、未改动；报告提交未夹带这些 ✅ | ✅ |
| 分支 | `git branch --show-current` → `main` ✅ | ✅ |

> git 结论：精确单文件 + DCO + agent 前缀 + 未 push + 单 worktree + 他人 dirty 原样，全部合规。

---

## 6. 本轮结论

**PASS（无 BLOCKED）**——审计 deny 写放大优化 P3 真机复验报告（commit `7fd5f41`，277 行）的前置、五组硬断言数字、诚实边界、隔离清理、git 纪律经独立只读复核全部成立：

1. 前置：HEAD=7cad293（被测父提交）、版本 0.1.3、临时 0.1.3 二进制 sha 与宿主 0.1.2 副本不同、真 deny 构造（read token→credentials 401 + system/info 200）代码与原文双证。
2. 数字：p95 c16 6.9× 回落（5/5 复跑 ≤50ms）、1:1 被打破（+12 vs +300）、count 守恒 17737=17737（≈29:1）、吞吐 9.2/9.3/8.1×、告警恒 1 count=17737——全部抽算吻合，无不自洽。
3. 诚实：p95 红线三文档原文坐实；p99/max 96–231ms 尾尖如实标未达标；超 MAX_MERGE / root.action / 通知派发三项真机难构造如实标单测覆盖（`TestDenyBurstMaxMergeFallsBackToIndividual` / `TestRootActionAuditNotMerged` / `TestAuditDeniedMergedEndToEnd` 均在源码核到）；单机无竞品对照不作超越证据。
4. 隔离：55171 FREE、无 kored-live 进程、`.tmp/audit-deny-opt-live` GONE、宿主 sha 未变、8787 healthz 200、secret-check 0 FAIL、报告无明文凭据。
5. git：`7fd5f41` 精确单文件 277 行 + DCO + agent 前缀、未 push、worktree 仅主树、他人 dirty 原样。

> 本轮唯一写入文件为本报告（`git commit -m … -- .agents/verify/audit-deny-opt-live-verification.md` 一步到位精确路径 + `-s`），未 push / 未联网 / 未启停服务 / 未碰 `.kore-local-*` / 未改生产代码。
