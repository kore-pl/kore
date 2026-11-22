# meta: kind=verification task=m4-cap-fix date=2026-11-22 owner=m4-cap-verify verdict=APPROVE repo=kore role=independent-verifier

# m4-cap-fix 独立复验报告

> 独立 verifier 实跑复验，不复用 implementer 结论；命令均贴原文退出码与关键输出。未写任何临时脚本，仅写本报告一个文件，未改代码/测试/文档。

## 组1 TestUIConfusedDeputy（验收1）
命令：`go test -run TestUIConfusedDeputy -v ./internal/core/httpapi/`　退出码 **0**
- ① session+csrf+site:read → **401** `E_UNAUTHORIZED 越权：管理端点需要 system:admin 能力 / detail=system:admin`（capability 层拦截）
- ② 去 csrf → **401** `E_UNAUTHORIZED CSRF 校验失败`（withCSRF 中间件拦截）
- ③ 去 session → **401** `E_UNAUTHORIZED 未授权`（withAuth 中间件拦截）
- `Enable 调用记录: []`（空，越权未触达 backend）；WARN `capability.denied subject=plugin-site plugin=system-admin`；结论行 `GREEN（漏洞不成立：enable 被拒）`；`--- PASS`（0.02s）
判据：三条均 401 且分层正确、Enable 空记录 → PASS。

## 组2 TestCapability（验收2）
命令：`go test -run TestCapability -v ./internal/core/httpapi/`　退出码 **0**
- `TestCapabilityDeniedWritesAudit` PASS：低权 401 + Enable 未调用 + 审计一条（subject=plugin-site / plugin=system-admin）
- `TestCapabilityAdminAllowed` PASS：默认 admin → 200，Enable 记录 [system-admin]
- `TestCapabilityInvokeUnaffected` PASS：低权 resolver 下 invoke 仍 200（方法合法即放行）
判据：admin 放行 / 低权 401 / invoke 不受影响 / 审计 denied 有记录 → PASS。

## 组3 全量测试（验收3）
- `go test -timeout 200s ./...` → **0**，12/12 包 ok
- `go test -race -count=1 ./...` → **0**，12/12 包 ok（httpapi 1.129s / supervisor 7.075s / cmd/kored 11.369s），无 DATA RACE
判据：两条退出码 0、全包绿、race 无告警 → PASS。

## 组4 make check（验收4）
命令：`make check`　退出码 **0**
10/10 段全绿：docs-check 6 pass / 依赖白名单 2 pass / 薄壳 4 pass / repo-check 5 pass / canonical 9 pass / log 8 pass / wt 4 pass / oss 8 pass / case 6 pass / frontend 4151 B ≤ 300 KiB。
末行 `[OK] 门禁全部通过`。
判据：退出码 0 且 10 段全通过 → PASS。

## 组5 代码核对（验收5）
- `wc -l`：middleware.go **200**（≤200，卡线）｜server.go 185｜cap_auth_test.go 177｜PoC 183
- resolver 来源：`defaultCapabilityResolver`（server.go:63-69）只读 `r.Cookie(auth.CookieName)`；全包 `.Header.Get` 仅 csrf（middleware.go:74）与 X-Request-ID（:145），**不读请求头 subject** → 只从服务端 session 推导 ✓
- fail-closed：`authorizeTargetAction` middleware.go:102 `if subject == "" { 401 }` ✓
- 审计出口：`auditDenied` middleware.go:116-121，注入优先、否则 `slog.Warn`；httpapi 包内无 `PutAudit` 调用（仅 server.go:46 注释挂点说明）→ 未伪造持久化 ✓
- 调用点：enable/disable 经 handleLifecycle 前置调用（handlers_plugins.go:43）、invoke 前置调用（handlers_invoke.go:31）→ 生产路径已挂、非空转 ✓
- 6 特权能力定义唯一处 server.go:58，无业务域名词表（G-01）✓

## VERDICT: **APPROVE**

五组证据全部满足，无阻断项。能力校验在 capability 层正确拦截低权管理请求，默认生产语义不变（admin 放行、invoke 不受影响），审计只记 WARN 未伪造持久化，全量测试与 10 段门禁通过。

## 阻断 / 记录分级
- **阻断项**：无。
- **记录项 R1**（非阻断，implementer 报告措辞瑕疵）：`.agents/verify/m4-cap-fix-verification.md:32` 把②去 csrf 的 body 照抄成①的越权文案；实测② body 为 `CSRF 校验失败`。状态码 401 一致，判定不受影响，建议后续修正措辞。owner=implementer(m4-cap-fix)。
- **记录项 R2**（非阻断，边界口径）：审计持久化挂点（cmd/kored 注入 store.PutAudit）未落地，当前仅 slog WARN；属已知边界而非能力校验缺陷，真实审计入库待 lead 后续注入。owner=lead。
