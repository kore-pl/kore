# meta: kind=verification task=m4-c date=2026-11-22 owner=m4-c-verify verdict=APPROVE repo=kore role=independent-verifier

# M4-C（audit 查询端点 + CLI）独立复验报告

> 独立 verifier 实跑复验，不复用 implementer 结论。命令均贴原文、退出码与关键输出；未写临时脚本，仅写本报告一个文件，未改代码/测试/其他文档。
> 依据：`.agents/proposals/0004-m4-core-hardening.md` M4-C/R3（:30/:39/:74）、`.agents/reviews/0005-m4-premortem.md` S-03（:34-43）。

## 组1 · TestAudit 定向测试（验收1）

命令：`go test -run 'TestAudit' -v ./internal/core/httpapi/ ./cmd/kored/`　退出码 **0**
关键输出：**15 PASS**（httpapi 9 + kored 6）。

httpapi 9：`TestAuditQuerySinceKeyFilter` / `TestAuditQueryEndToEnd` / `TestAuditQueryNormal` / `TestAuditQueryUnauthorized` / `TestAuditQueryNoCookie` / `TestAuditQueryRequiresSince` / `TestAuditQueryLimitCap` / `TestAuditQueryActionFilter` / `TestAuditQueryNoTicker`。
kored 6：`TestAuditCSVHeader` / `TestAuditRequiresSince` / `TestAuditTextOutput` / `TestAuditLimitCap` / `TestAuditSinceFiltersOld` / `TestAuditMainDispatch`。
四类指定反例均命中：越权（`TestAuditQueryUnauthorized` + `TestAuditQueryEndToEnd` 输出 `WARN capability.denied subject=plugin-site plugin=audit reason="读取审计需要 system:read 能力"`）、无 since（`TestAuditQueryRequiresSince`）、limit 上限（`TestAuditQueryLimitCap`）、CSV 表头（`TestAuditCSVHeader`）。两包 `ok`，退 0。

## 组2 · 全量测试 + 聚合门禁（验收2）

命令：`go test -timeout 200s ./...`　退出码 **0** — 12 个包全 `ok`（无 FAIL/no test files 异常），覆盖 auth/bus/config/envprobe/httpapi/installer/market/registry/store/supervisor/platform/cmd。

命令：`make check`　退出码 **0** — **10/10 全绿**：1 docs-check(6 pass)、2 dep-check(第三方 2/3 + 同仓 module replace)、3 thin-shell-check(4 pass)、4 repo-check(5 pass)、5 canonical-check(9 pass)、6 log-check(8 pass)、7 wt-check(4 pass,1 工作树)、8 oss-check(8 pass)、9 case-check(6 pass)、10 frontend(首屏 4151 B ≤ 307200 B)。`[OK] 门禁全部通过`。

## 组3 · S-03 AUDIT-OPEN 判据原样复跑（验收3）

命令（0005:41 / 0004:39 原文）：
`grep -q 'authorizeTargetAction' internal/core/httpapi/audit*.go 2>/dev/null && bin/kored audit --csv 2>&1 | grep -qiE 'required|limit|上限' && echo OK || echo AUDIT-OPEN`
退出码 **0**，输出：**`OK`**（非 AUDIT-OPEN）。前置确认 `bin/kored` 为 stripped 静态 ELF、可执行。判据两段均命中：grep 命中 `authorizeTargetAction`；无 `--since` 调 CSV 被拒并含"上限"字样（`audit.go:95`）。

## 组4 · 代码逐项核对（验收4）

| # | 核对项 | 证据位置 | 结论 |
| --- | --- | --- | --- |
| 1 | since 必填 + RFC3339 | `handlers_audit.go:74-80`（空值拒绝/`time.Parse(time.RFC3339)`）、`audit.go:94-101` | PASS |
| 2 | limit ≤1000 | `handlers_audit.go:17` `auditMaxLimit=1000`、:87-89 超限拒绝；`audit.go:103-105` `1..1000` | PASS |
| 3 | audit 走 authorizeTargetAction + system:read | `audit_gate.go:19` 先调 `authorizeTargetAction`，:26 `hasCapability(granted,"system:read")` 缺即 401 | PASS |
| 4 | CSV 表头精确 | `audit.go:131` 7 列 `time,subject,action,plugin,target,result,detail`（测试 `TestAuditCSVHeader` 佐证） | PASS |
| 5 | 无 ticker（G-19） | `grep -rnE 'NewTicker\|AfterFunc\|time\.Ticker' audit*.go handlers_audit.go cmd/kored/audit.go` 零命中 | PASS |
| 6 | 无 map[string]any（G-24） | `grep -rn 'map\[string\]any' --include='*.go' internal/ cmd/`（排除 _test/testdata）零命中 | PASS |

**O(n) 全表扫描边界（记录级）**：`store/audit.go:155` `tx.ForEach(bucketAudit)` 全 bucket 遍历，since 过滤在适配器 `cmd/kored/audit.go:32-37`（key 前缀纳秒比较，命中 limit 提前 break），`AuditFilter` 无 Since 字段；git status 确认 store 无改动，与"适配器层过滤、store 未改"一致。R3 缓解文本提及"按时间戳+动作建索引"，实现未建 store 索引，但 since+limit 约束限制导出规模、验收出口未列索引为硬门槛——判为已知技术债/记录级边界，非阻断。

## VERDICT: **APPROVE**

四组验收全绿，无阻断项。

**阻断项**：无。
**记录级（不阻断，留痕）**：① O(n) 全表扫描 + 未建 store 时间戳/动作索引（见组4，R3 已知边界，建议后续里程碑按数据量评估）；② `authorizeAuditRead` 在 `s.auth==nil` 时 `return true`（`audit_gate.go:22-24`，M0 探活骨架未装配鉴权）——非 M4-C 新引入，属骨架兼容路径，请确认 M4 收口时该分支在配好 auth 的生产装配下不会被走到。
