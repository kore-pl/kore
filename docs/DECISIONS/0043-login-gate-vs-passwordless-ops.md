> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5 · 关联: [0041-passwordless-server-admin](./0041-passwordless-server-admin.md)、[0042-privilege-without-prompt](./0042-privilege-without-prompt.md)、[SECURITY](../SECURITY.md) §3.2、[QUICKSTART](../../QUICKSTART.md) §2

# ADR-0043: 面板登录门与「操作免密」分层（更正 ADR-0041 的「免密 = 免登录」）

## 0. 用户裁决（原话）

> 「面板必须要有登录页面，我是说操作必须免密，也就是 root 权限」
> 「登录是 web，这是咱们自己的登录体系。」

ADR-0041 把「服务器管理不该每次输密码」实现成了「本机通道不经登录即管理员」：`withAuth` 对 UDS 与 loopback TCP 直接跳过会话校验，`defaultCapabilityResolver` 对这两类请求直接授予 6 项 admin 能力，并为此在幂等请求上补发 CSRF 令牌（`csrf_local.go`）。真机后果：面板打开**没有登录页**，未登录也能操作全部管理 API。这是对用户需求的误读——**「操作免密」指登录一次后的所有动作不再要口令，不是「不登录」**。

## 1. 决策

认证只有一个入口：**kore 自己的 Web 登录**（`POST /api/v1/auth/login`，凭据 = `auth.admin_password_hash`，单管理员、无用户名、非 PAM / 非系统账号）。

| 层 | 决策 |
| --- | --- |
| 鉴权 | `withAuth` 对全部 `/api/v1/*` 一律会话校验；UDS / loopback **不再跳过**；只有 `/-/healthz`、`/api/v1/auth/login` 与主壳静态壳放行（登录页需要能加载） |
| 能力 | `defaultCapabilityResolver` 只认 `kore_session` cookie，删除「本机通道 = admin 全权」的旁路 |
| 会话 | 保留 ADR-0041 成果：默认 7 天 TTL + 滑动续期（剩余 < min(24h, ttl/2) 时续期，绝对上限 30 天） |
| CSRF | 保留双提交校验与登录后下发；保留 `csrf_local.go` 的幂等补发（它只发令牌，不放行请求——`withAuth` 在 `withCSRF` 内层） |
| 本机通道 | 仅剩两个**非认证**用途：CSRF 令牌引导、UDS 的 CSRF 豁免；`local_access.go` 删除 `local.access` 审计与 context actor |
| root 动作 | 不变：会话授权后由内核（ADR-0042：系统级 root 服务）执行，运行期不出现本机账号口令 / polkit / sudo |

## 2. 被否决的选项

| 选项 | 否决理由 |
| --- | --- |
| A. 维持 ADR-0041（本机免登录） | 直接违反用户「面板必须要有登录页面」；未登录即可操作管理 API，登录门形同虚设 |
| B. 恢复登录但把 root 动作改回每次 sudo/polkit | 违反用户「操作必须免密」；ADR-0042 已定 root 服务形态 |
| C. 本机 UDS 保留免登录、只给浏览器加登录页 | 留下第二套身份来源，能力解析与审计都会分叉；且用户明确「登录是 web，咱们自己的登录体系」，不接受系统身份当凭据 |
| D. 引入 PAM / 系统账号 | 非目标（G-11 不做多用户 RBAC），且把面板凭据绑到宿主账号 |

## 3. 后果

**正确**：未登录 → 登录页 + 管理端点 401（含 UDS / loopback）；登录一次 → 7 天滑动会话，所有操作（含 root 特权动作）免密。

**代价 / 已知缺口**：未设置 `admin_password_hash` 的实例会显示登录页但没有任何凭据可登录（`Verify` 对空哈希恒 false → 登录 401「口令错误」）。当前靠启动提示一行 + `kored admin-password --generate` 解决；**首启引导流程属另一张卡，本 ADR 不设计**。

**测试口径变更**：`TestUDSAccessBypassesSessionTCPDoesNot` 断言的是旧契约（UDS 无 cookie → 200），已按本 ADR 重写为 `TestLocalChannelsRequireSession`（UDS / loopback / 远程未登录一律 401，登录后 200）；这是契约反转，不是放宽断言。

## 4. 验收证据（2026-11-23，隔离实例 127.0.0.1:18787，默认 7 天 TTL）

| 项 | 结果 |
| --- | --- |
| 未登录 loopback `GET /api/v1/plugins` | `401 {"code":"E_UNAUTHORIZED","message":"未授权"}` |
| 未登录 UDS 同一端点 | `401` 同上 |
| 登录 | `200`；`Set-Cookie: kore_session=...; Max-Age=604800; HttpOnly; SameSite=Strict` |
| 登录后 loopback / UDS | `200` / `200` |
| 写请求无 CSRF 头 | `401 CSRF 校验失败`；双提交后到业务层（`404 插件未安装`） |
| 管理动作 `DELETE /api/v1/plugins/nope`（需 `system:admin`） | `200 {"already_absent":true}`（无口令提示） |
| 未设口令实例登录 | `401 {"message":"口令错误"}`；启动提示「尚未设置管理员口令——面板会显示登录页但无法登录」 |

## 5. 复审条件

- 首启引导卡落地后，§3 的「已知缺口」应删除并改为指向该卡文档。
- 若将来要把本机通道重新定义为认证来源，必须先回答「登录页是否仍然必须存在」，并与本 ADR 的 §1 鉴权行冲突即退回提案阶段。
