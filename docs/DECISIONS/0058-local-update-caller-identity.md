> 状态: accepted · 归属: designer（task-41 方案细化，用户 U1 裁决）· 更新: 2026-11-26 · 里程碑: R26 · 门禁关联: G-06 / G-10 / G-12 / G-23 / G-29 / G-30 / G-31
> ADR 状态: accepted（2026-11-26 用户裁决 U1=A+B；草案来源 [self-update-design-draft.md](./self-update-design-draft.md) §2.1/§6.2）· 关联: [ADR-0043](./0043-login-gate-vs-passwordless-ops.md)（公开会话门，不改）、[ADR-0056](./0056-self-restart.md)（本地边界）、[ADR-0042](./0042-privilege-without-prompt.md)（root 服务目标形态）、[ADR-0002](./0002-uds-length-prefix-json.md)、[实现任务图](./self-update-implementation-plan.md)
> 纪律: 只写文档 / 台账；不 push、不联网、不执行 install/serve/upgrade；不碰已 accepted ADR 正文；品牌 Kore/kore。

# ADR-0058：本机静默更新的调用身份——UDS 专用端点 + SO_PEERCRED + 单一专用能力，进程内调用为辅

## 1. 背景与问题陈述

静默自更新需要一条「本机触发、零凭据输入」的写通道，但现状的认证分层不允许「本机 = 管理员」：

- `withAuth` 对 `/api/v1/*` 一律会话校验，UDS / loopback 未登录一律 401；这是 ADR-0043 更正 ADR-0041「免登录 = 免密」误读后的结构性结论（`internal/core/httpapi/middleware.go:26-30` 注释、`:36-72` 实现；`0043-login-gate-vs-passwordless-ops.md:10,18-23`）。
- UDS 的 `SO_PEERCRED` 校验只判断「uid==0 或 socket 属主（kored 自身）」，仅决定 CSRF 引导是否被 blocked，**不是身份，也不授予能力**（`internal/core/httpapi/local_access.go:75-93`）。
- 因此现有 `POST /api/v1/store/install` 等写端点必须有人登录拿会话；把这条公开门直接放宽给本机通道，等于回退 ADR-0043 已否决的选项 C（「本机 UDS 保留免登录」，其否决理由见 `0043-login-gate-vs-passwordless-ops.md:31`）。

**必须吸收的反面教训**：1Panel CVE-2025-54424（`tls.RequireAnyClientCert` 只验「有证书」不验 CA 导致 RCE）说明「只要连上来就放行」的静默通道是高危形态；本机身份必须**连接来源 + 进程身份 + 专用能力**三重校验（草案 §5 第 8 条，`self-update-design-draft.md:153`）。

## 2. 选项对比（多选一，含被否决项）

| 选项 | 做法 | 优点 | 代价 / 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **A. UDS 专用端点 + 进程身份 + 专用能力** | 新增仅绑定 UDS 的更新端点，校验 `SO_PEERCRED` uid ∈ {0, kored 运行 uid}，授予**单一专用能力** `system:self_update`（只可更新，不含 6 项 admin 能力）；公开 HTTP 门完全不变 | 复用既有 UDS / peer-cred 机制（A2）；能力最小化；Web 触发与本机进程走同一入口，统一审计 | 需界定可信 uid 集合、UDS 文件权限与反向鉴权；必须双向严格校验（CVE 教训） | **采纳（主）** |
| **B. 进程内调用（in-process）** | 自更新器作为 kored 内部模块，直接调用 installer / upgrade 原语，不经 HTTP | 无新网络面、无 UDS 鉴权难题；最贴合「薄壳只做规则」（G-01）；内核编排器天然走此路 | 内核升级无法在进程内替换自身（需 exec 本地新二进制 + `--no-block` 重启）；仍需解决「谁来触发」 | **采纳（辅）**：仅用于 kored 自身编排逻辑，不替代 A 的外部入口 |
| C. 一次性 token 文件（confirm-token 模式） | 安装期生成一次性 token，本机进程读取后调用更新端点 | 复用 ADR-0056 既有的 confirm-token 模式 | token 落盘即长期凭据，泄露面大；每次更新要换 token，违背「零凭据」承诺；把「身份」退化成「凭据」 | **否决**：见 §4 |
| D. 放宽 ADR-0043 公开会话门（UDS/loopback 免会话或本机即 admin） | 让本机请求跳过 `withAuth` 或对本机授予 6 项 admin 能力 | 改动最少 | 直接回退 ADR-0041 的错误、违反 ADR-0043 §1/§2-C；本机身份当 Web 登录凭据正是用户否定的形态 | **否决**：红线，不在本 ADR 重开 |
| E. 独立 root helper 二进制 / setuid 通道 | 另起高权进程专门受理更新请求 | 与 kored 主进程隔离 | 多一个特权二进制 + 新安装目录外写入（G-31）、多一份提权面；ADR-0042 已定 root 服务为目标形态 | **否决** |

## 3. 裁决（用户 U1=A+B，2026-11-26）

**采纳 A+B**：UDS 专用更新端点 + `SO_PEERCRED` 进程身份 + 单一专用能力为主入口；kored 进程内调用为辅，仅供自身编排逻辑使用。**不放宽 ADR-0043 公开会话门**；C / D / E 否决。

### 3.1 专用端点与鉴权链

1. **独立路径**：新增仅绑定 UDS 的更新端点（建议 `POST /api/v1/system/self-update`，v1 取 `system:` 特权前缀，最终路径在实现任务卡锁定）。不复用 `store/install` 等公开端点；公开 HTTP 面的 `withAuth` 行为一字不改（ADR-0043 §1）。
2. **连接来源**：只接受 `net.UnixConn` 且 `LocalAddr.Network()=="unix"`（`local_access.go:95` 的 `isUnixConn` 同口径）；拒绝 loopback TCP / 远程地址。
3. **进程身份**：`transport.PeerCred(conn)` 取 `SO_PEERCRED`，uid 必须 ∈ {0, `os.Getuid()`}（与 `local_access.go:75-93` 的 `unixLocal` 判据一致）；取不到凭据即 fail-closed（该处 `:81-88` 已是此口径）。UDS socket 文件权限收紧到仅属主可写（0600），创建时不 chown。
4. **专用能力**：引入单一能力 `system:self_update`，只覆盖「读更新索引 → 下载校验 → 安装/替换 → 触发 reload/自重启」这一条链，**不包含** 6 项 admin 能力，也不作为 Web 登录凭据（能力解析器不得把它计入会话能力集）。公开会话即使有 admin 也不自动拥有此能力——两条通道相互独立，双向校验，吸收 CVE-2025-54424 教训。
5. **审计**：每次调用写 `system.self_update` 审计（actor=uid / 通道 / 专用能力 / 目标版本 / 结果），不记口令与 token（G-30）；fail-closed：鉴权失败、能力缺失、审计写不进 → 不执行更新。

### 3.2 进程内调用（B）的边界

1. kored 自己的编排器直接调用内部 installer / upgrade 原语，不走 HTTP，也不给自己发 UDS 请求（无自连接死循环、无二次鉴权开销）。
2. B **不是**第二套逻辑：与 A 共用同一份「更新编排服务」，A 只是进入该服务的受控入口；结果结构、审计事件、fail-closed 语义一致。
3. 内核二进制升级在进程内只能做到「校验 + 原子替换 + 落 pending + 提交重启」（`cmd/kored/upgrade.go:150-208,265-295`），最终生效由新进程 `finalizePendingUpgrade`（`:340-379`）确认；不假装在进程内替换自己。

### 3.3 与既有 ADR 的关系

| ADR | 关系 |
| --- | --- |
| ADR-0043 | **不改**。公开门、会话、CSRF 口径原样保留；本 ADR 是旁路 identity，不是放宽会话门。 |
| ADR-0056 | **继承**。审计、confirm、fail-closed、本地写边界（`:39-49`）继续适用；新端点不引入 git push / tag / 远端访问。 |
| ADR-0042 | **目标形态**。root 服务下 uid=0 自然在可信集合内；portable 形态按草案 fail-closed 给白话提示（`0056-self-restart.md:36`、`upgrade.go:137`）。 |
| ADR-0002 | **复用**。UDS 帧格式不变，新端点沿用既有长度前缀 JSON 协议，不另起线格式。 |

## 4. 被否决选项与依据

| 选项 | 否决依据 |
| --- | --- |
| C 一次性 token 文件 | 与「零凭据」承诺冲突：token 是落盘凭据、需轮换、泄露面大；身份问题应用进程身份解，不应用凭据解。 |
| D 放宽公开会话门 | ADR-0043 §1/§2-C 明确否决「本机免登录 / 系统身份当登录凭据」；放宽即回退 ADR-0041 已被纠正的错误。 |
| E 独立 root helper | 多一个特权二进制 + 安装目录外写入（G-31/ADR-0023 §3.5 清单外），与 ADR-0042「内核即 root」的既有形态重复。 |
| 仅 A 不放 B | 编排器在 kored 内部却要绕 UDS 给自己发请求，徒增鉴权与死锁面；且无法表达「进程内替换 + 重启提交」。 |
| 仅 B 不放 A | 外部本机进程 / 面板无统一入口，未来必然有人再开一条「方便的本机通道」，重新踩 ADR-0043 的坑。 |

## 5. 后果

**正面**：零凭据、统一审计、能力最小化；公开门零变化；UDS 既有机制复用（无新依赖，G-02）；与 G-01 相容（专用能力是规则标识，不是插件业务）。

**代价 / 风险**：新增一个 HTTP 端点（docs/CORE.md 端点计数需同步，G-06）；UDS 文件权限与 `SO_PEERCRED` 是安全关键代码，需红队反例测试（伪造 uid、loopback TCP 冒用、弱凭据形态）；「专用能力 ≠ 会话能力」要在能力解析器处显式隔离，避免误并集。

## 6. 验收标准（实现期，命令 + 退出码 + 关键输出）

```bash
go test -timeout 200s ./internal/core/httpapi/... ./cmd/kored/...   # exit 0，鉴权正反例全通过
make secret-check                                                   # exit 0，审计无口令/token
make docs-check                                                     # exit 0，端点计数与文档同步
```

反例必测：未登录 UDS / loopback 访问公开 `store/install` 仍 401；专用端点以非可信 uid 调用被拒；以 loopback TCP 调用专用端点被拒；审计中不得出现凭据字段。

## 7. 复审条件

1. 若要把专用能力并入会话能力集或扩大能力范围 → 必须重开 ADR-0043 与本 ADR（G-23）。
2. 若 UDS 通道需要跨用户 / 跨进程身份（如独立命令行工具以非 kored uid 调用）→ 复审可信 uid 集合与「能力最小化」前提。
3. 若出现第二个本机专用端点或通用 token 通道需求 → 复审是否应改为统一 capability broker（避免第二套身份来源）。
4. 若 ADR-0042 的 root 服务目标形态改变（回退普通用户运行或降级路径 A 成为默认）→ 复审 §3.1 的 uid=0 前提。
