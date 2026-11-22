# meta: kind=poc-verdict task=ui-confused-deputy date=2026-11-22 owner=ui-poc verdict=RED repo=kore

## 目标
为 UI 集成决策产出可复现越权 PoC：仅授 `site:read` 的插件 JS（同 origin、可读非 HttpOnly `kore_csrf`、浏览器自动带 session cookie）能否启用 `system:admin` 插件。**只产证据，不修产品代码。**

## 证据锚点（已核实）
- `docs/SECURITY.md:99` —— `kore_csrf` 非 HttpOnly，前端可读。
- `docs/SECURITY.md:110-112` —— 能力只在 invoke 帧校验；enable 只做"展示声明+用户确认+写 granted_capabilities"。
- `internal/core/httpapi/middleware.go:24-25` —— 仅 `/api/v1` 查 session；`:56-57` 注明完整中间件链归 M1-14。
- `internal/core/httpapi/handlers_plugins.go:40-66` —— `handleEnable → Backend.Enable(ctx,id)`，无 capability 校验。
- `internal/core/httpapi/handlers_invoke.go:28/59` —— invoke 能力校验归 M1-08，当前未落地。

## 复现命令
```
cd /home/pt/Work/GolandProjects/kore
go vet ./internal/core/httpapi/                                    # 退出码 0
go test -run TestUIConfusedDeputy -v -count=1 -timeout 200s ./internal/core/httpapi/   # 退出码 0，PASS
```
测试文件：`internal/core/httpapi/ui_confused_deputy_poc_test.go`（仅此测试文件 + 本报告，未改产品代码）。

## 三条请求证据（真实 HTTP，httptest.NewServer）
攻击者身份：`site:read`；目标：`POST /api/v1/plugins/system-admin/enable`。

| # | 请求条件 | 状态码 | 响应要点 |
| --- | --- | --- | --- |
| ① | 有效 session + `kore_csrf`(cookie+header) + site:read | **200** | `{"id":"system-admin",...,"enabled":true}`；Enable 被调用 |
| ② | 去掉 csrf（对照） | **200** | 同样成功，Enable 再次被调用 |
| ③ | 带 csrf 但去掉 session（对照） | **401** | `{"code":"E_UNAUTHORIZED","message":"未授权"}` |

原始 t.Logf 输出（逐字）：
```
① session+csrf+site:read → HTTP 200 | body={"id":"system-admin","name":"","version":"","lifecycle":"","depth_level":"","state":"ready","desired":"enabled","restarts":0,"pid":0,"enabled":true}
② 去 csrf            → HTTP 200 | body={"id":"system-admin",...,"enabled":true}
③ 去 session          → HTTP 401 | body={"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
Enable 调用记录: [system-admin system-admin]
```

## 结论：🔴 RED —— 漏洞成立
仅授 `site:read` 的插件身份成功启用 `system:admin` 插件（HTTP 200），确认 confused deputy：插件 JS 与主壳同 origin，可读 CSRF、自动带 session cookie，而 enable 端点无 capability 校验。

对照③（无 session → 401）证明**鉴权层本身在工作**；漏洞定位在**能力层缺失**，不是会话鉴权失效。

## 对照②的如实说明（不预设结论）
目标设计（SECURITY.md §4）要求非 GET 缺 CSRF → 401，但**②实测 200**：当前 M1 代码只落地 req_id 中间件（`middleware.go:56-57`），CSRF 校验归 M1-14 尚未实现。这不是 PoC 缺陷，是现状事实——意味着攻击者**连 CSRF token 都不需要**，越权门槛比设计预期更低。

## 边界声明
- 用 `httptest.NewServer` + 真实 `auth.Manager`（pbkdf2 口令哈希 + bbolt 临时库）起服务，登录取真实 session cookie，非直接调 handler；Backend 为最小内存桩（记录 Enable 调用），不接真实 registry/supervisor。
- 因此证明范围 = **HTTP 层鉴权与能力缺失**；不覆盖真实插件进程拉起、bbolt 持久化 grant 写入、浏览器同 origin cookie 可见性的端到端行为（后者由 SECURITY.md:99 设计事实支撑）。
- 目标插件 id `system-admin` 为桩内标识，代表 SECURITY.md:118 的 `system:admin` 特权级插件；实际仓库 M0 阶段无真实插件包，按设计语义构造。
- Enable 幂等，②的 200 是重复 enable 仍成功，非缓存假象（Enable 调用记录两条可证）。
