# meta: kind=verification task=fix-csrf-and-cap date=2026-11-22 owner=csrf-verify verdict=PARTIAL repo=kore

## 验证目标与口径
独立复验（不复用实现者结论、不写临时脚本、不改代码/测试/文档）：`fix-csrf-and-cap` 是否把 UI 越权 PoC 从 RED(200/200/401) 变 GREEN。
GREEN 判据按委托人给定：①带 session+csrf+site:read → 非401；②去 csrf → 401；③去 session → 401。
本报告只写此文件；所有结论以现有命令的实际退出码与输出为准。

## 证据一：PoC 三条状态码（改前 → 改后）
命令：`go test -timeout 200s -run TestUIConfusedDeputy -v ./internal/core/httpapi/`　退出码 **0**（PASS）
（附跑：`go test -timeout 200s ./...` 退出码 0，全 12 包 green；`make check` 退出码 0，10/10 段全绿）

| # | 请求条件 | 修前 | 修后 | 期望 | 是否符合 |
| --- | --- | --- | --- | --- | --- |
| ① | session+csrf+site:read | 200 | **200** | 非401 | 形式符合，实质仍是越权（见结论） |
| ② | 去 csrf | 200 | **401** | 401 | ✅ 符合（CSRF 双提交生效） |
| ③ | 去 session | 401 | **401** | 401 | ✅ 符合（会话鉴权仍工作） |

修后原始 t.Logf 关键输出（逐字）：
```
① session+csrf+site:read → HTTP 200 | body={"id":"system-admin",...,"enabled":true}
② 去 csrf            → HTTP 401 | body={"code":"E_UNAUTHORIZED","message":"CSRF 校验失败","detail":""}
③ 去 session          → HTTP 401 | body={"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
Enable 调用记录: [system-admin]
结论: RED（漏洞成立：仅 site:read 成功启用 system:admin 插件）
```
注：①仍触发 `Backend.Enable`（记录含 system-admin），PoC 自身判定仍为 RED。测试只硬断言③==401，故整体 PASS——但 PASS ≠ GREEN。

## 证据二：全量测试
`go test -timeout 200s ./...` → 退出码 **0**；12 个包全部 `ok`（cmd/kored、auth、bus、config、envprobe、httpapi、installer、market、registry、store、supervisor、platform），无 FAIL。

## 证据三：make check 10 段
`make check` → 退出码 **0**，10/10 段全绿：
1 docs-check 6 pass；2 dep-check 2 pass（第三方 2/3）；3 thin-shell 4 pass；4 repo-check 5 pass；
5 canonical-check 9 pass；6 log-check 8 pass；7 wt-check 4 pass；8 oss-check 8 pass；
9 case-check 6 pass；10 frontend 首屏 4151 B ≤ 300 KiB。末行 `[OK] 门禁全部通过`。

## 证据四：中间件顺序与白名单（grep + 源码核对）
`grep -n 'withAuth|withCSRF|authorizeTargetAction|isPublicPath|isCSRFExempt' internal/core/httpapi/*.go`
- server.go:63-64 挂载顺序：`handler=withAuth(handler)` 后 `handler=withCSRF(handler)` → 外层先执行，链为 **reqID → CSRF → auth → handler**（注释 58-59 同述）；仅 `s.auth != nil` 时挂载，M0 探活骨架裸路由。
- auth 白名单 `isPublicPath`（middleware.go:36-38）：`/-/healthz`、`/api/v1/auth/login`。（**不含 setup**）
- CSRF 白名单 `isCSRFExempt`（middleware.go:49-52）：`/-/healthz`、`/api/v1/auth/login`、`/api/v1/auth/setup`、`/api/v1/auth/logout`。
- 能力挂点 `authorizeTargetAction`（middleware.go:101-111）：被 handlers_plugins.go:43、handlers_invoke.go:31 调用，但实现仅 `sessionFrom` 验 session 有效即放行（subject 视为 admin），细粒度 capability 校验为 `TODO(M4, 裁决40)`，未落地。

## 结论：分层判定 —— CSRF 层已修（GREEN）、capability 层按裁决40 挂 M4，当前里程碑不阻断
按 Task Contract 分层验收，PoC 的 RED 不能整体判为当前里程碑阻断。依据：裁决40 已白纸黑字把「管理端点按目标操作做 capability 校验」列为 M4 待办、客户端 UI 隔离只是兜底；本轮派工口径明确「M1 最小实现只验 session 有效，细粒度挂 M4」。验收范围以派工口径为准，不临时扩大已裁决范围（裁决42）。

- **CSRF 层：✅ 已修**。②去 csrf 200→401 证明双提交校验确实拦下缺 token 的写请求；③去 session 仍 401，会话鉴权未回退；CSRF 中间件（withCSRF 挂载、双提交校验）本轮已修并验证生效。全量测试与 make check 全绿。当前修复任务（CSRF）的验收范围已达成。
- **capability 层：⏸ 按裁决40 挂 M4**。①带 session+csrf+site:read 仍 200、Enable 仍被调用，属派工范围外的已知延期项——`authorizeTargetAction`（`middleware.go:101-111`）只验 session 有效即放行、细粒度 capability 校验为 `TODO(M4, 裁决40)`，非本轮修复失败；已列为 M4 第一优先级。
- **PoC 整体 RED 的口径**：RED 指「越权仍成立」。该结论在 cap 层仍然成立且已挂账（裁决40 + 裁决42），不掩盖；但 CSRF 这一层的 GREEN 是独立成立的，PoC 整体 RED 不等于「当前修复任务失败」或「当前里程碑阻断」。
- 建议（仅记录，未执行）：M4 补齐 `authorizeTargetAction` 从 session subject 查 `granted_capabilities` 校验 `<target>:<action>`，命中失败写审计并 401；补一条「持有效 session 但无目标能力 → 401」的断言，避免「session 有效即放行」被误判为 GREEN。
