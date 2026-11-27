> 状态: draft · 归属: token-ip-design（方案，待 lead / architect 审阅） · 更新: 2026-11-27 · 里程碑: R27

# DESIGN-TOKEN-IP-BIND — API token 可选 IP/CIDR 绑定（doc-first 方案）

本文是**纯设计产物**：只定义数据形状、鉴权挂点、管理入口、安全边界、涟漪门禁与分期判据，**本轮不落任何代码**。实施须在本文审阅通过后另开任务卡，按 §6 的门禁逐项交证据。

背景：task-227 竞品一手证据中，1Panel 官方 API Key 文档明确支持「配置 IP 白名单和有效时间」；我方 [SECURITY.md](./SECURITY.md) §3.6 表格自承「token 无 IP/UA 绑定，泄漏即等于对应 scope 的长期权限」。lead 在用户「门槛自主抉择」口径下裁决把这一最小、零新依赖、纯安全增强的差距提前到 v1.1 补齐。UA 绑定与代理信任链不属于本次最小补齐，见 §0.2。

## 0. 分期判据与版本判定

### 0.1 分期判据（哪一项进本期，哪一项延期）

| 判据 | 本期（v1.1 / R27 后续实施卡） | 延期（另开裁决） |
| --- | --- | --- |
| 依赖 | 只用 `net/netip`（Go 1.26 标准库），`go.mod` / `go.sum` 零变化，G-02 三依赖白名单不动 | 任何需要新第三方库、独立服务或常驻进程的方案（G-05）直接退回 |
| 兼容 | 可选字段 `omitempty`，旧 token 记录无字段 = 不限制；不升 schema 版本、不做数据迁移 | 把绑定设为必填或默认拒绝存量 token → 破坏兼容，退回 |
| 威胁面 | 只补「网络来源」一维；Token 哈希 / TTL / scope / 吊销语义一律不改 | UA 绑定、按资源细分 scope、多用户 RBAC（G-11 明确不做）、自动探测公网 IP |
| 代理语义 | 只认 TCP 对端；不读任何转发头；反向代理场景由管理员显式放行代理 IP 或改走 UDS | 「可信代理链配置 / XFF 深度解析」需新配置面与新的信任模型，另开 ADR |
| 交付面 | API + 存储 + 鉴权门 + 现有安全页最小字段 + 文档 + 单测 | CLI 新子命令（当前不存在，见 §4.2）、新 bucket、独立审计事件名 |
| UI 门禁 | UI 若改字段，必须按 G-28 交 PC + 手机双端截图；不愿交截图则 UI 字段拆到下一卡，本期只交 API | 无双端证据的 UI 变更不得声明完成 |

**进入实施卡的前置判据**：本文获审阅；`make docs-check` / `git diff --check` 已绿；实施证据里 `go test` 与 `make check` 全绿、无新增 FAIL。任一不满足即停在方案阶段。

### 0.2 版本 bump 判定（G-23 待登记）

- **本文档提交不 bump**：仅新增 `docs/*.md`，不改变运行时行为、协议与插件兼容区间，`docs` 类改动按 patch 口径也不需要为文档单独发版。
- **实施卡的版本处理**：功能本身是 `feat`（新增可选字段 + 新增一个管理端点），按语义化口径本应 minor `0.1.1 → 0.2.0`；但 24 个插件仓 `info.json.requires_kore` 上界均为 `<0.2.0`（已逐仓核对），`make version-check`（G-14，第 20 段自洽门禁）会把 `VERSION=0.2.0` 判 FAIL，且改 24 仓区间属于跨仓库变更集（G-15），超出本卡写域。
- **裁决候选（供 G-23 台账登记，含被否决项）**：① 立即 bump `0.2.0` —— 否决：24 仓上界阻断、需跨仓变更集；② 实施落地时在该版本线内 bump `0.1.2` —— 可作为「在 0.2.0 协同发版前需要发一个内核补丁版本」时的折中，语义上属 patch，须在 CHANGELOG 说明新增字段是向后兼容的增量；③ 不单独发版，随下一次协调好的 `0.2.0` 波次一起发布 —— **本方案倾向 ③**，零插件抖动、零门禁冲突；若先发补丁版再用 ②。上述选择需在 `.agents/LOG/DECISIONS.md` 留痕（本次写域仅本文档，台账由 lead / scribe 在收口时补记）。
- `pkg/pluginapi` 协议与插件版本**不动**：本改动不触碰帧格式、`info.json`、插件 API，G-14/G-17 不受影响。

## 1. 目标与现状证据

**目标**：让管理员可为每个 API token 指定可选的网络来源范围；token 泄漏到网外后无法复用，未配置的旧 token 行为完全不变。不削弱现有 TTL、scope、吊销、会话与能力判定。

**代码锚点（实施时的唯一事实来源）**：

| 位置 | 现状 |
| --- | --- |
| `internal/core/auth/security.go:85-94` | `APITokenRecord` 显式字段（ID/Name/Hash/Scope/时间戳），存 bbolt `meta` bucket 的 `security.token.<id>` 键 |
| `internal/core/auth/security.go:96-104` | `TokenView` 对外列表视图，显式字段、永不回显 hash |
| `internal/core/auth/security.go:464-509` / `:551-596` | `CreateToken` / `ValidateToken`：sha256 常量时间比对、TTL 校验、LastUsedAt 24h 节流写回；`ValidateToken` 每请求读库，无缓存 |
| `internal/core/auth/security.go:122-145` | `ClientIP`：**本机通道带 XFF 时采信首段**——登录白名单沿用此口径，token 绑定不得复用 |
| `internal/core/httpapi/middleware.go:35-72` / `:112-133` | `withAuth` 的 Bearer 分支 → `authenticateAPIToken`，校验成功后写 `apiTokenActor` 上下文；scope 写入拒绝在 `:125-129` |
| `internal/core/httpapi/server.go:207-230` | `defaultCapabilityResolver` 从 `apiTokenActor` 推导 subject=`token:<id>` 与能力集；能力判定在 handler 内 `authorizeTargetAction` / `authorizeInvoke` |
| `internal/core/httpapi/middleware.go:244-274` | `authorizeTargetAction` 与统一审计出口 `auditDenied`（无注入时 WARN，注入后落 `capability.denied`） |
| `internal/core/httpapi/local_access.go:11-23,57-93` | UDS/loopback 仅用于 CSRF 引导与豁免，**不是认证通道**；`unixLocal` 用 `SO_PEERCRED` 校 uid ∈ {0, kored uid} |
| `internal/core/httpapi/server.go:455-467` | 主监听器 `ConnContext` 把 `net.Conn` 注入请求上下文，UDS 判定依赖它 |
| `internal/core/httpapi/handlers_security.go:53-58,237-286` | token 创建请求体、列表、按 id 吊销；**无更新端点** |
| `internal/core/httpapi/handlers.go:118-120` | 已注册 token 的三条路由（GET/POST/DELETE） |
| `cmd/kored/main.go:35-60` | CLI 子命令仅 serve/version/install/audit/uninstall/status/upgrade/restart/admin-password/help，**无 token 子命令** |
| `web/security.js:212-266` | 安全页 token 表单已有 name/scope/ttl_days 与列表/吊销交互 |

## 2. 配置模型（①）

### 2.1 字段与存储

- `APITokenRecord` 增 `AllowedCIDRs []string \`json:"allowed_cidrs,omitempty"\``；`TokenView` 增同名字段（对外可见，便于管理员回读绑定；不含 hash/明文）。创建响应体 `tokenCreatedBody` 回显同样的绑定字段，便于确认。
- 存储位置不变：`meta` bucket、键 `security.token.<id>`、值为同一条 JSON 记录。字段是 `[]string`（G-24 显式形状，禁止 `object` / `any`）。无新 bucket、无 schema_version 变化。
- 语义：`nil` / 缺失 / 空数组 = **不限制**（与存量 token 兼容）；非空数组 = 仅允许列表内来源。`allowed_cidrs` 不参与 token 明文生成与哈希计算。
- `ValidateToken` 在 LastUsedAt 节流写回时整条记录重新 `json.Marshal`（`security.go:586-593`），因此字段必须挂在 `APITokenRecord` 上，否则一次「更新最后使用时间」就会把绑定悄悄抹掉。这是本设计最关键的实现约束。

### 2.2 语法与规范化（`net/netip`）

在 `internal/core/auth/security.go` 增单一收口函数 `normalizeCIDRs([]string) ([]string, error)`，创建与更新共用：

1. `strings.TrimSpace`；空字符串元素 → 拒绝（不允许「写空等于放行」的静默配置）；整表 `nil` / 长度 0 → 返回 `nil`，表示不限制。
2. 含 `/` → `netip.ParsePrefix`，随后 `prefix.Masked()` 归一到网络地址（例如 `192.168.1.5/24` 落为 `192.168.1.0/24`）；不含 `/` → `netip.ParseAddr` 后按地址族补 `/32` 或 `/128`，等价「单 IP」。
3. `addr.Zone() != ""`（如 `fe80::1%eth0`）拒绝：zone 只在主机本地有意义，写进持久绑定会产生永远匹配不到的规则。
4. `0.0.0.0/0` 与 `::/0` 拒绝：等价于不限制，接受会让管理员误以为有约束（与既有登录白名单 `ErrIPAllowAll` 同型判据）。
5. 上限：**条数 ≤ 16**、**单条 trim 后 ≤ 64 字节**；超出报明确错误。理由：绑定是每请求 O(n) 匹配，且记录来自前端/API 外部输入，必须防 DoS 与胀库；16 条足够覆盖「内网段 + 办公出口 + 回环」的现实组合。
6. 规范化后去重、`sort.Strings` 排序，保证写入幂等与列表稳定。
7. IPv4-mapped IPv6（`::ffff:192.0.2.1`）在解析时用 `Unmap()` 归一，使 `127.0.0.1/32` 能匹配映射形式；前缀同样 Unmap。

错误统一归一为 `E_INVALID` + 人话文案（「请写成 192.168.1.0/24 或 203.0.113.7 这样的形式，最多 16 条」），**不回显 token 内容**。

### 2.3 兼容与即时生效

- 存量 JSON 缺字段 → `json.Unmarshal` 得 `nil` → 不绑定，旧 API 调用方零改动；不需要迁移脚本，不需要重启。
- 无缓存：每次 Bearer 请求都走 `ValidateToken` 的 `store.View`（现状即如此），绑定改动在下一次请求即可见。不新增内存缓存，因此没有缓存失效路径；这是刻意选择——缓存会引入「改了绑定但旧值仍生效」的安全窗口。
- TTL、scope、LastUsedAt 节流、吊销语义一字不改。

## 3. 鉴权链路（②）

### 3.1 挂点与顺序

在 `authenticateAPIToken`（`middleware.go:114-133`）内，`ValidateToken` 成功之后、现有 scope/方法判定与 handler 内 capability 判定之前插入绑定门：

```text
withAuth(Bearer 且非 root-action 路径)
  → authenticateAPIToken
      → ValidateToken(plain)                     // 哈希/TTL/吊销，现状不变
      → 失效 → 401 E_UNAUTHORIZED（原文案不变）
      → tokenPeerAllowed(r, rec)                 // 新增：来源判定
      → 拒绝 → auditDenied(...) + 401 E_UNAUTHORIZED
      → 现有 scope=="read" && !safeMethod → 403（不变）
      → 写 apiTokenActor 上下文 → next
  → handler 内 authorizeTargetAction / authorizeInvoke（能力判定，不变）
```

顺序理由：① token 必须先验签，避免对伪造 token 泄露「来源是否允许」；② 绑定门放在 scope 判定之前，使泄漏 token 从陌生网络发起的任何请求（包括只读）都被同一个 401 拦下，不给攻击者用 403 探测 scope 的机会；③ 能力判定仍在绑定门之后，能力集与拒绝审计口径都不变。

### 3.2 来源 IP、UDS、回环、转发头

新增包内函数 `tokenPeerIP(r *http.Request) (netip.Addr, bool)` 与 `tokenPeerAllowed(r, rec)`：

- **只取 `r.RemoteAddr`**：`netip.ParseAddrPort`，无端口时退到 `netip.ParseAddr`（测试/特殊监听）。解析失败或 zone 非空 → `false`（fail-closed）。**明确不调用 `auth.ClientIP`**：该函数在本机通道采信 XFF（登录白名单的历史口径），不可用于 token 绑定。
- **明确不采用 `X-Forwarded-For` / `X-Real-IP` / `Forwarded`**：任何来源、包括回环与 UDS 都不读。理由：token 是持有即授权的 bearer 凭据，伪造转发头是零成本绕过；反向代理部署下服务端看到的是代理 IP，管理员应显式放行代理地址或让代理走 UDS，不能靠请求头自证。与 [SECURITY.md](./SECURITY.md) §3.6 登录白名单「本机才采信 XFF」的差异须在文档里写清，不能混用同一个 `ClientIP`。
- **回环 `127.0.0.1` / `::1` 没有隐式放行**：把它们当普通对端逐条匹配。只放行 `203.0.113.0/24` 的 token 从回环调用应被拒；需要本机的管理员显式写 `127.0.0.1/32` 与 `::1/128`。这是「不削弱约束」的直接推论。
- **UDS**：UDS 没有 peer IP（`RemoteAddr` 为 `@`/空），IP 匹配对它没有意义。判定：
  1. `rec.AllowedCIDRs` 为空 → 直接沿用现状，不做任何来源门；
  2. 有绑定时，仅当请求确实来自 UDS（`connInfoFrom(r.Context())` 拿到 `net.Conn` 且 `isUnixConn` 为真，或无可解析 IP 且连接为 UDS）且 `s.unixLocal(conn)` 返回 `blocked=false`（`SO_PEERCRED` uid ∈ {0, kored uid}）才视为满足条件；
  3. 取不到连接、取不到对端凭据、uid 不合规 → **401 fail-closed**，不得因为「看起来像本机」就跳过绑定。
  这与 [ADR-0043](./DECISIONS/0043-login-gate-vs-passwordless-ops.md) 一致：本机通道不是认证来源；这里也没有新增身份——UDS 侧的身份仍是「有效 Bearer + 受控 socket + SO_PEERCRED」，只是把一个不适用 IP 匹配的通道从绑定中豁免。ADR-0058 的专用更新端点走独立 server、不过 `withAuth`，本门完全不碰。
- **插件 bearer / root-action 路径**：`withAuth` 的既有分支用 `KORE_PLUGIN_TOKEN` + 独立 `SO_PEERCRED` 校验，不进入本门，行为不变。
- **会话 cookie 路径**：不变。登录 IP 白名单继续只管登录入口，不与 token 绑定互相替代。

### 3.3 拒绝响应与审计

- 响应固定为 `401 {"code":"E_UNAUTHORIZED","message":"API 令牌不允许从此网络地址使用","detail":""}`；不回显绑定列表、不回显对端 IP、不回显 token（与既有「不泄露令牌有效性细节」口径一致）。
- 复用现有出口 `s.auditDenied(subject, plugin, target, capability, reason)`（`middleware.go:262-274`），落 `capability.denied` / `result=denied`：
  - `subject = "token:<id>"`（与 `defaultCapabilityResolver` 的 token subject 同源）；
  - `plugin = ""`、`target = ""`、`capability = ""` —— 绑定门在能力判定之前，没有「以哪个能力授权」的判定来源，按 DATA-MODEL §9 禁止编造能力名；
  - `reason = "token_ip_denied"`（固定字符串）。
- `capAuditor` 未注入时按现状只写 `slog.Warn` + `noteDeniedAlert`；不新增审计事件名、不改 `AuditRecord` schema，因此审计库/告警中心无需迁移。

## 4. 管理入口（③）

### 4.1 HTTP API

| 操作 | 现状 | 本期变更 |
| --- | --- | --- |
| `POST /api/v1/security/tokens` | `tokenCreateRequest{password,name,scope,ttl_days}`（`handlers_security.go:53-58`） | 增 `allowed_cidrs []string`（可省略）；走 `normalizeCIDRs`；非法 → 400 `E_INVALID` + 人话文案；不填 → 无绑定 |
| `GET /api/v1/security/tokens` | `TokenView` 列表 | 视图增 `allowed_cidrs`，管理员可回读当前绑定 |
| `PUT /api/v1/security/tokens/{id}` | 不存在 | **新增**：body `{password, allowed_cidrs}`；`allowed_cidrs` 用 `*[]string` 表达三态：缺省 = 不改、空数组 = 清除绑定、非空 = 规范化后替换。非法 → 400 `E_INVALID`。改当前口令（与创建同口径，因这是安全敏感变更）；id 不存在 → 400 `E_INVALID`。响应回 `TokenView` |
| `DELETE /api/v1/security/tokens/{id}` | 已实现，幂等 | 不变 |

所有变更要求有效会话 + CSRF（现有 `withAuth` / `withCSRF`），绑定字段不参与明文凭据回显；请求体上限沿用 `decodeSecurityBody` 的 1 MiB。新增路由使 CORE.md 端点计数 72 → 73（实施时同步，见 §6.1）。

### 4.2 CLI 判定

`cmd/kored/main.go` 当前没有任何 token 子命令（只有 serve/version/install/audit/uninstall/status/upgrade/restart/admin-password/help），因此**本期无 CLI 改动**，符合「CLI（若现有）」的口径。若后续新增 token CLI，合同必须同步：创建/更新均支持 `--allowed-cidrs`（可重复或逗号分隔），校验与 HTTP 共用 `normalizeCIDRs`，不填 = 无绑定；本方案不预先造 CLI 入口。

### 4.3 安全页最小交互

`web/security.js` 的 token 创建表单增一个可选输入框「允许来源（CIDR，每行一条；留空不限制）」，列表行展示绑定摘要（无绑定显示「不限制」）。错误直接展示服务端 400 的中文文案。若实施卡包含 UI 改动，按 G-28 交 1440×900（或 1280×800）与 390×844 双端截图 + 产品定位自评；否则 UI 单独拆卡，本期只交 API 与文档。

## 5. 安全边界对齐（④）

| 边界 | 本方案的处理 | 依据 |
| --- | --- | --- |
| ADR-0043 登录门 | 不新增身份来源；会话仍是唯一 Web 登录凭据；本机通道不因 token 绑定获得额外权限，也不因绑定被「免登录」 | [ADR-0043](./DECISIONS/0043-login-gate-vs-passwordless-ops.md) §1 |
| UDS 语义 | UDS 无 peer IP；有绑定时只在 `SO_PEERCRED` uid 合规且连接可确认的 UDS 上豁免 IP 匹配；凭据不可取即 401 | `local_access.go:57-93`；ADR-0058 三重鉴权同源 |
| 转发头 | 全面不信任 XFF/X-Real-IP/Forwarded；与登录白名单的 `ClientIP` 口径显式分叉，文档写明原因 | `security.go:122-145`、`middleware.go` 本方案新增门 |
| 现有 token 安全属性 | sha256 存储、常量时间比对、默认 90 天/上限 365 天 TTL、read/admin scope、按 id 吊销全部保留；绑定是叠加的额外门 | `security.go:464-596` |
| 能力模型 | 不改 6 项宿主能力、不改 `<plugin-id>:<action>` 语法；绑定门不写业务域名词表（G-01） | `server.go:184-230` |
| 依赖与资源 | `net/netip` 标准库；`go.mod` 零变化；无新 bucket、无新 goroutine/ticker/定时器、无每请求缓存 | G-02 / G-03 / G-05 / G-19 |
| 审计与隐私 | 复用 `capability.denied` 出口；audit 不记 token、不记完整 IP/UA；无明文凭据进入 docs（G-30） | `middleware.go:262-274`、DATA-MODEL §9 |
| 数据形状 | `[]string` 显式字段，无 `object` / `any` / `map[string]any` | G-24 |

**残余风险（如实披露）**：① 攻击者若已在本机且能读 socket 与 token，UDS 豁免仍允许调用——这是本机已失守的场景，不是本项能解决的；② 反向代理场景下看到的是代理 IP，配置错误会把合法用户挡在外面（fail-closed，可诊断），需管理员显式登记代理地址；③ 绑定不覆盖 UA，token 仍在有效期内可复用，只是被限制在网络维度；④ IPv6 需单独登记，不会随 IPv4 规则自动生效。

## 6. 涟漪与门禁（⑤）

### 6.1 文档同步（G-06，实施卡内完成）

| 文件 | 需同步的点 |
| --- | --- |
| [SECURITY.md](./SECURITY.md) §3.6 第 153 行表格 | 「token 无 IP/UA 绑定」改为「token 可选 `allowed_cidrs`（IPv4/IPv6 CIDR + 单 IP，≤16 条）；未配置 = 不限制；UDS 走 SO_PEERCRED 豁免、仅认 TCP 对端、不读 XFF」；残余风险保留 UA 未绑定 |
| [CORE.md](./CORE.md) §2.6（auth 模块，约 59 行）与 §2.4 端点清单（约 64 行） | 增token 绑定规则与新 `PUT /security/tokens/{id}`；端点计数 72 → 73，同步两处数字，避免再次出现「70/63」漂移 |
| [DATA-MODEL.md](./DATA-MODEL.md) §5 存储桶表（约 168 行起） | `meta` bucket 增 `security.token.<id>` 行，value schema 写明 `allowed_cidrs?: string[]`（omitempty、缺省不限制、≤16 条）；说明不升 schema 版本 |
| 本设计文档 | 实施完成后追加「实现复核」小节：落地 commit、门禁输出、与本文的偏差及原因 |

本轮只写本文件；上述三份真源文档由实施卡在同一检查点内同步，不得留下代码与文档不一致的中间提交。

### 6.2 测试矩阵（实施卡必须补齐）

**配置 schema / 规范化（auth 包）**：合法 CIDR（`192.168.1.0/24`、`2001:db8::/32`）；单 IP 补 `/32`、`/128`；带主机位的 CIDR 归一；重复与空白归一；空/nil = 不限制；非法字符串、`/0`、zone、空元素、>16 条、单条 >64 字节全部报错；旧记录 JSON 无字段 → `nil` 且 `ValidateToken` 的 LastUsedAt 写回不丢绑定；`UpdateTokenCIDRs` 命中/不存在/清空三路径。

**鉴权中间件（httpapi 包）**：

| 场景 | 输入 | 期望 |
| --- | --- | --- |
| 命中 | 绑定 `203.0.113.0/24`，对端 `203.0.113.9` | 放行，进入能力判定 |
| 拒绝 | 同一 token，对端 `198.51.100.7` | 401 `E_UNAUTHORIZED`；auditor 收到 `capability.denied` / `reason=token_ip_denied` / `capability=""` |
| 空兼容 | 无绑定，任意 IP | 放行（与今天一致） |
| 回环不隐式放行 | 只绑 `203.0.113.0/24`，对端 `127.0.0.1` / `::1` | 401 |
| 转发头伪造 | 对端 `198.51.100.7` + `X-Forwarded-For: 203.0.113.9`；回环 + 同类头 | 均按对端判定 → 401 |
| UDS 合规 | 注入 `net.UnixConn` + 合规 `SO_PEERCRED` uid | 有绑定也放行 |
| UDS 不合规 | uid 不合法 / 取不到凭据 / 无 conn | 401 fail-closed |
| 映射地址 | `::ffff:127.0.0.1` 对端 + 绑定 `127.0.0.1/32` | 放行 |
| 解析失败 | `RemoteAddr` 畸形 | 401 |
| 顺序 | 绑定不匹配 + read token 发起 POST | 先 401（不是 403） |
| 不回退 | 过期 token + 有效会话 cookie | 仍 401，语义不变 |

**handler / 集成**：创建带合法字段 → 列表与创建回显一致；非法字段 → 400 `E_INVALID`；不填 → 旧行为；更新后立即生效（改绑定前 A 可用，改后 A 被拒、B 放行）；清空绑定后任意 IP 恢复可用；删除仍幂等。

### 6.3 门禁命令与证据（实施卡）

- `go test -timeout 200s ./...` 与嵌套 module `cd pkg/pluginapi && go test -timeout 200s ./...`（或 `make test`，两者等价覆盖；当前根 module 不遍历嵌套 module）。
- `make check`（21 段聚合门禁，含 `docs-check`、`secret-check`、`version-check`、`cross-build`、`race-full` 等阻断项）与 `make docs-check`；文档类改动至少跑后者。
- `git diff --check`（零输出）、`git status --short`（确认只含本卡写域）、精确 `git add <path>` + 带 `[agent:<name>]` 前缀的 commit，禁 `git add .`（G-12）。
- **本次 doc-only 提交的 docs-check 基线**：`bash scripts/docs-check.sh` exit 0，`5 pass / 1 warn / 0 fail`；唯一 WARN 是既有的 11 份文档行数越界（含 CORE.md 414 行、DATA-MODEL.md 406 行、SECURITY.md 526 行、7 份 DETAIL 语言版 58 行），另有 2 份已登记的豁免（PLUGIN-PROTOCOL.md、SIGNING-KEY-SOP.md）。本文件长度落在 100–400 行区间，不新增行数 WARN。上述 WARN 如实保留，不在本卡内顺手改他人文档。

### 6.4 G-23 留痕（不在本写域）

本方案包含多处「多选一」决定，实施收口时必须由 lead / scribe 写入 `.agents/LOG/DECISIONS.md`（含被否决选项与依据）：① UDS 豁免 IP 匹配 vs 一律拒绝 UDS vs 把 SO_PEERCRED 当 IP；② 不信任 XFF vs 复用 `ClientIP`；③ 绑定门早于 scope/能力判定 vs 晚于；④ 版本 0.2.0 / 0.1.2 / 随协调波次（§0.2）。派发实施卡时另写 `.agents/LOG/DISPATCH.md`（task / owner / 写域 / 依赖 / 交付 / commit）。本次文档提交的写域仅 `docs/DESIGN-TOKEN-IP-BIND.md`，不代写台账。

## 7. 风险与回退

- **主要风险**：把回环或 XFF 当「隐式可信」会让绑定形同虚设；`ValidateToken` 写回整条记录时字段丢失会让绑定静默消失；新增更新端点改变端点计数却漏同步 CORE.md（G-06）。三条都已在上文给出具体防法与测试点。
- **回退**：本轮无代码，回退 = 删除本文档的提交（追加 revert，不改写历史）。实施阶段的回退 = 追加 revert 提交，恢复旧 token 记录即自动回到「不限制」；不做数据删除、不升 schema。
- **验证纪律**：未跑过的命令不得写成通过；docs-check 的既有 WARN 必须随证据一并贴出，不得为了「全绿」修改无关文档。
