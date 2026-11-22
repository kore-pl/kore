# meta: kind=verification task=m4-cap-fix date=2026-11-22 owner=m4-cap-fix verdict=GREEN repo=kore

## 验证目标
把 `authorizeTargetAction` 从"session 有效即放行"改为按目标操作校验 capability，
使管理端点（`/api/v1/plugins/{id}/enable|disable`）要求 `system:admin` 特权能力。

## 关键事实澄清（重申裁决40/42，不夸大战果）
1. **原 PoC 的 RED 部分是测试构造产物，不是已存在的生产越权**。
   `site:read` 在原 `ui_confused_deputy_poc_test.go` 里只是 `t.Logf` 叙事标签，
   请求实际带的是 admin 会话 cookie，服务端从请求里读不到任何低权凭证。
   真实插件身份走 UDS 的 `KORE_PLUGIN_TOKEN` + `kore.hello`，不经 HTTP session；
   G-11 明确不做多用户 RBAC，session 只有 admin 一种主体。
2. **本次 cap 校验的价值是纵深防御 + 为未来 UI 桥/多身份预留正确挂点**，
   不包装成"修了一个已存在的真实漏洞"。默认 resolver 仍按单管理员全权语义，
   生产路径行为不变。
3. **红转绿的口径**：测试注入"持有效 session 但 granted 仅 `site:read`"的低权身份
   后，按 `system:admin` 校验被拒（401），这才是本次验证的边界；不能外推为
   "真实插件能经 HTTP 越权已被堵住"。

## PoC 三条状态码（修前 → 修后）
命令：`go test -run TestUIConfusedDeputy -v -count=1 ./internal/core/httpapi/`　退出码 **0**

| # | 请求条件 | 修前 | 修后 | 判定 |
| --- | --- | --- | --- | --- |
| ① | 有效 session + csrf + 低权 site:read | 200 | **401** | 红转绿，越权被拒 |
| ② | 去 csrf（对照） | 401 | **401** | 保持 |
| ③ | 去 session（对照） | 401 | **401** | 保持 |

修后 t.Logf 逐字：
```
① session+csrf+site:read → HTTP 401 | body={"code":"E_UNAUTHORIZED","message":"越权：管理端点需要 system:admin 能力","detail":"system:admin"}
② 去 csrf → 401 | ③ 去 session → 401
Enable 调用记录: []        （修前为 [system-admin]）
WARN capability.denied subject=plugin-site plugin=system-admin
```
结论行由 RED 变 GREEN；`Enable` 不再被调用是空记录可证。

## 实现要点（原文见代码）
- `Options` 注入 `CapabilityResolver func(*http.Request)(string,[]string)` 与
  `CapabilityAuditor func(subject,plugin,reason string)`；`New` 中 resolver 缺省
  取 `defaultCapabilityResolver`（有效 session → admin + 6 特权能力）。
- `authorizeTargetAction`：`s.auth==nil` 放行（M0 骨架）；subject 为空 → 401；
  管理路径且无 `system:admin` → `auditDenied` + 401 `E_UNAUTHORIZED` +
  readable message；invoke 路径不拦截，保持现有方法合法性校验。
- `hasCapability` 精确匹配；6 特权集只在 server.go 定义一处，不重复业务域名词表（G-01）。
- 无新依赖、不改协议、无 `any`/`map[string]any`（G-24）、中文注释。

## 全量验收（命令 + 退出码）
- `go test -timeout 200s ./...` → **0**，12 包全 ok。
- `go test -race -count=1 ./...` → **0**，12 包全 ok。
- `make check` → **0**，10/10 段全绿，末行 `[OK] 门禁全部通过`。
- 新增单测 `cap_auth_test.go`：低权 401+审计、admin 放行、invoke 不受影响，均 PASS。
- 行数：middleware.go **200**、server.go 185、cap_auth_test.go 177；函数均 ≤50 行。

## 边界与未完成项（如实披露）
- **审计只到 slog WARN**：真实 `store.PutAudit` 写入在 cmd/kored 装配层，
  写域禁碰 cmd/kored。挂点已在 server.go `CapabilityAuditor` 注释标明，
  需 lead 后续注入；本次不伪造持久化。
- **低权身份载体是测试注入**：生产默认 resolver 为 admin 全权；未来 UI 跨站桥
  落地时需注入真实 resolver 才能对多身份生效。
- 冻结证据 `.agents/verify/ui-confused-deputy-poc.md` 未改；
  `ui_confused_deputy_poc_test.go` 仅加 resolver 注入，未放宽/删除任何断言。
- git 未提交，由 lead 统一处理。
