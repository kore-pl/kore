> 状态: accepted · 归属: architect（perm-design-fix）→ implementer（credential-fix）· 更新: 2026-11-25 · 里程碑: R25 · 门禁关联: G-06 / G-23 / G-30
> ADR 状态: accepted（2026-11-25 裁决落地）· 关联: [ADR-0043](./0043-login-gate-vs-passwordless-ops.md)、[ADR-0042](./0042-privilege-without-prompt.md)、[ADR-0023](./0023-zero-intrusion.md)、[USABILITY](../USABILITY.md) §8、[实现报告](../../.agents/verify/adr55-credential.md)、[设计草案](../../.agents/verify/permission-design-fix.md)

# ADR-0055：安装期一次性管理员凭据交付，消除口令 human gate

> 定稿说明：本 ADR 正文来自 [architect 草案](../../.agents/verify/permission-design-fix.md) 的 ADR-0055 节，状态由 draft 转 accepted；草案中与最终实现不一致的细节按 [实现报告](../../.agents/verify/adr55-credential.md) 修正，并在 §实现复核注记逐条列明。

## 1. 背景

本地更新的第一个 human gate 是「管理员口令未交付」。根因不是「忘记告诉用户命令」，而是三处结构性缺口：

1. **打印时机与安装解耦**：`cmd/kored/install.go` 完全不生成 / 不打印凭据；只有 serve 首启才尝试（`admin_password.go:249`）。
2. **非 TTY 一律不交付**：`admin_password.go:263` 明令非 TTY 不生成不打印明文，只给 CLI 指引；本机正是非 TTY，于是配置里没有哈希、终端上没有任何输出，形成「HANDOFF 记未交付」的死结。
3. **无法找回、重置生效路径分叉**：明文单向哈希不可恢复；`reload.go:78-81` 把哈希列入热更白名单，但 `serve_signals.go` 只同步限速 / 审计、不把新哈希推给内存中的 `auth.Manager`，于是 CLI 重置还得重启。

用户那句「**安装时不是应该打印吗**」的明确设计口径：**是的，安装期必须交付一次性凭据**；但交付不能只靠「往终端打一行」——非 TTY / 服务化安装会把明文送进 journald 或 CI 日志，直接踩 G-30。正确形态是「安装期统一入口 + 一次性凭据文件 + TTY 明文附加打印 + 非 TTY 只给路径」。

## 2. 选项对比

| 方案 | 安装期交付 | 非 TTY 可用 | G-30 边界 | 首登改密 | 老实例找回 / 重置 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A. 维持现状（仅 serve 首启 TTY 打印） | ❌ 无 | ❌ 非 TTY 直接放弃 | 合规但无交付 | 无 | 仅 CLI 重置 | **否决**：正是当前卡死点 |
| B. install 时直接往 stdout 打明文 | ✅ | ❌ 自动化 stdout 会被采集 | ❌ 明文可能进日志 / CI | 无 | 无 | **否决为主路径**；TTY 分支作为 C 的附加输出保留 |
| C. 一次性凭据文件 + 安装 / 首启统一入口 + TTY 明文打印 + 首登强制改密 | ✅ | ✅ 只暴露文件路径 | ✅ 文件在 install 内 0600；明文不入库 / 日志 | ✅ | ✅ | **采纳** |
| D. 纯 Web 首访设口令（无令牌） | ⚠️ 打开面板即设 | ✅ | ✅ | ✅ | ❌ | **否决**：未认证首访者可抢占管理员口令（接管风险） |
| E. 明文写入 config / state.db / 审计 | ✅ | ✅ | ❌ 直接违反 G-30 / ADR-0023 | — | — | **否决**：红线 |

## 3. 裁决

**采纳 C**；B 的「TTY 终端打印」降级为 C 内的附加交付通道，不作为独立方案。

### 设计要点（落地口径）

1. **统一入口 `ensureInitialAdminCredential`**：
   - 由 `kored install --package` 在 `resolveCLITargets` 之后、**打开 state.db 之前**调用（凭据只写 config 与 install 内 data，不碰被 serve 独占的 state，规避锁冲突）；
   - 由 serve bootstrap 在 `loadConfig` 之后调用（幂等兜底）：实际落地保留 `firstRunBootstrap` 名字作薄封装，内部委托同一函数，不越界改 `serve.go`；
   - 触发条件以「哈希为空」为准；已有哈希的实例一行不打、一字节不写（保持 ADR-0043 的升级行为）。
2. **生成与落盘**（复用既有实现，不新造算法）：`generateAdminPassword(24)` → `auth.HashPassword`（PBKDF2-HMAC-SHA256，600000 次）→ `writeAdminBootstrapHash`（原子 0600），并把 `auth.must_change_password=true` 写进**同一次原子写**。
3. **交付通道（双通道，边界不同）**：
   - **一次性凭据文件**：`install/data/initial-admin-credential`，权限 0600，仅写一次，内容只有明文口令一行。属**运行态资产**（与 `.kore-local-state/` 同类），必须 gitignore；不属于 `docs/` 或 `.agents/verify/`，不进 make secret-check 扫描面。首次登录并改密成功后由内核删除 / 标记 consumed。
   - **TTY**：安装 / 首启结束时在**操作者当前终端**打印一次性提示，可含明文，同时打印凭据文件路径。
   - **非 TTY**（systemd / journald / 重定向 / CI / agent）：**绝不打印明文**，只打印「初始凭据已生成，请在自己的终端读取：<path>（权限 0600）」。
4. **首次登录强制改密**：新增 `auth.must_change_password` 布尔（与哈希同文件、同原子写）；登录校验通过且该标志为 true → 只发**受限会话**：仅允许改密端点、登出与静态壳，其余 `/api/v1/*` 返回 403 + 白话「首次登录请先设置新口令」（USABILITY 原则 4）。改密成功后：清标志、吊销全部旧会话、删除一次性凭据文件、写 `auth.password_initial_changed` 审计（只记元数据）。API token / 插件 bearer 在 `withAuth` 前序分支处理，不走本闸门。**G-11 边界声明**：这是单管理员账号上的一次性状态机，不是多用户系统——没有用户列表、角色、权限组，不命中「多用户 RBAC」。
5. **老安装如何找回 / 重置**（不靠「重新初始化」丢数据）：
   - hash 为空的老实例：下一次 install / serve 自动走统一入口补交付凭据文件；**不动** state.db / plugins / index，不存在重新初始化。
   - hash 已存在但口令遗忘：**不可找回**（单向哈希，设计上明确不提供找回）；CLI `kored admin-password --generate/--set [--stdin]` 或登录后 Web 改密 → 原子写新哈希 + `must_change=true` + 吊销会话。
   - **生效路径收口**：`serve_signals.go` 的 SIGHUP 处理里同步 auth 快照（新哈希 + must_change 推给 `auth.Manager`，仅在真变化时吊销会话），使 CLI 重置无需重启即生效；重启（ADR-0056 提供自服务入口）仍是兜底。
   - **禁止**把「清 state / 重装 / 删 .kore-local-state/」当找回手段——那会丢数据，正是用户点名的反模式。
6. **G-30 边界（写死）**：终端明文 = 瞬时、仅当前 TTY、不重定向进文件、不入版本库；凭据文件 = install 内运行态资产、0600、gitignore、消费后删除；日志 / 审计只记事件元数据（时间、路径、决策），**不记明文、不新增哈希副本**；文档中的口令一律写 `***` / `<placeholder>`，make secret-check 保持阻断级。
7. **USABILITY 四问**：①默认入口 = 安装完成即给凭据文件 + 终端提示；②自动探测 = 配置路径与 serve 同一解析；③点击数 = 读文件 → 登录 → 改密（3 步）；④文案 = 白话「打开面板输入这个口令，登录后必须改一个新口令」。

## 4. 被否决选项与依据

| 选项 | 否决依据 |
| --- | --- |
| A 维持现状 | install.go 无 bootstrap、非 TTY 不交付，就是当前 human gate 的成因 |
| B install 直接打明文到 stdout | 自动化 stdout 会进 CI / 日志，踩 G-30；且非 TTY 场景仍无持久交付载体 |
| D 纯 Web 首访设口令 | 无令牌的未认证端点 = 任意首访者可抢占管理员凭据；ADR-0043 刚把「本机免登录」纠正掉，不能回退 |
| E 明文入库 / 日志 | G-30 红线（历史事故：明文口令写进验收报告并推送公开仓库） |
| 多用户 / 角色化凭据 | 命中 G-11「不做多用户 RBAC」，需求退回提案阶段 |

## 5. 对既有 ADR 的修订（append-only）

| 目标 | 修订内容 |
| --- | --- |
| ADR-0043 §3 / §5 | 追加「首启凭据引导已被 ADR-0055 取代为『安装期统一交付 + 一次性凭据文件 + 首登强制改密』；非 TTY 交付不再只给 CLI 指引」 |
| ADR-0043 §5 复审条件第 1 条 | 追加「若改为 Web 一次性引导须连 ADR-0055 一起复审（未认证抢占风险）」 |
| ADR-0043 §1 鉴权表 | 补一行说明 `must_change_password` 是单管理员状态机，非 RBAC，§1「单管理员、无用户名」不变 |
| ADR-0042 / ADR-0049 / ADR-0018 / ADR-0023 §3.5 | 不改；本 ADR 不新增安装目录外写入、不改变执行机制 |
| QUICKSTART §2.1 / RUNBOOK-INSTALL §7 / USABILITY §8 / CORE §2.3 | 下游文档同步（安装后读凭据文件、首登改密、must_change 字段） |

## 6. 复审条件

1. 若要把凭据交付改成「Web 一次性引导」→ 必须先解决未认证抢占，并与 ADR-0043 §5 联合复审。
2. 若凭据文件出现在版本控制、日志或审计 → 立即停用该通道并重开 ADR（G-30 事故级）。
3. 若出现多管理员 / 角色需求 → 命中 G-11，退回提案阶段，不在本 ADR 打补丁。
4. 若 PBKDF2 参数或哈希算法出现 CVE / 升级 → 复审生成与校验链路。

## 7. 实现复核注记（2026-11-25，commit `99754fd`）

实现报告：[.agents/verify/adr55-credential.md](../../.agents/verify/adr55-credential.md)；commit `99754fd` = `[agent:credential-fix] feat(core/auth): ADR-0055 安装期一次性凭据交付与首登强制改密（T1+T2）`。**未 push、未触发 CI、未打印任何真实口令值**。

### 7.1 草案 → 实现的事实差异（以实现为准）

| 草案表述 | 最终实现事实 |
| --- | --- |
| §3.1「由 serve bootstrap 在 loadConfig 之后调用统一入口」 | `serve.go` 未改；`firstRunBootstrap` 保留为薄封装并委托 `ensureInitialAdminCredential`，满足「两处共用同一函数」且不越界改写域 |
| §3.1「触发条件 = 哈希为空 / auth.initialized=false」 | 以按原始 YAML 文本粗判 `admin_password_hash` 非空为准：非空即静默返回、不动文件、不打印（保持 ADR-0043 升级行为） |
| §3.4「改密成功后发完整会话（或要求重新登录）」 | `ApplyCredentialSnapshot(hash,false)` 清标志 + 吊销旧会话 + 删一次性凭据文件 + 写 `auth.password_initial_changed` 审计；未再自动签发新会话 |
| §3.5「SIGHUP 把新哈希推给 auth.Manager 并吊销会话」 | 增加 `ApplyCredentialSnapshot` 变化检测：仅在哈希 / 标志真变化时 `RevokeAll`，普通热更不误踢全员 |
| §3.6「凭据文件在 install 内 0600」 | 落点 `<install>/data/initial-admin-credential`，gitignore 规则 `/data/initial-admin-credential`；测试全在 `t.TempDir()`，工作区无凭据文件残留 |

### 7.2 验证命令与退出码（实现报告原文口径）

```
GOWORK=off GOCACHE=<工作区>/.tmp-cred-gocache GOMODCACHE=<工作区>/.tmp-cred-gomodcache \
  go build ./cmd/kored/... ./internal/core/auth/... ./internal/core/config/... ./internal/core/httpapi/...   → BUILD_EXIT=0
同上 go vet ...                                                                                      → VET_EXIT=0
go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/auth/... ./internal/core/config/... ./internal/core/httpapi/... → TEST_EXIT=0（4 包全 ok）
bash scripts/secret-check.sh                                                                         → SECRET_EXIT=0
bash scripts/docs-check.sh                                                                           → DOCS_EXIT=0（5 pass / 1 warn / 0 fail）
git check-ignore -v data/initial-admin-credential                                                    → .gitignore:68:/data/initial-admin-credential
```

关键用例：`TestFirstRunBootstrapNonTTYPrintsNoSecret`（非 TTY 无明文 / 文件 0600 / 消费后删除）、`TestFirstRunBootstrapGeneratesOneTimeCredential`、`TestMustChangeGateBlocksNonPasswordEndpoints`（403 白话 / 改密可用 / 标志清 / 旧会话失效）、`TestApplyCredentialSnapshot`（SIGHUP 同步）、`TestFirstRunBootstrapWriteFailureKeepsSecretOut`。

### 7.3 未验证项

隔离实例的 SIGHUP 全链路以 `ApplyCredentialSnapshot` 单测 + `serve_signals.go` 调用点覆盖；真实 systemd 实例的信号注入属运行态，按 G-29 未碰主实例。
