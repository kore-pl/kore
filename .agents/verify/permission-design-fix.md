# 权限设计修复提案：口令交付 + 自重启闭环（ADR 级草案）

> 角色：architect（perm-design-fix） · 日期：2026-11-25 · 工作区：/home/pt/Work/GolandProjects/kore-pl
> 纪律：**只出设计、不写实现代码、不改现有代码/配置/系统、不打印任何真实凭据**。唯一写入是本报告。
> 用户定性（原话）：「是权限设计本来就有问题，你用有问题的设计一直卡进度」「口令/token 安装的时候不是应该打印吗？，自动重启都做不了，权限设计还是有问题。」
> 本报告的立场：**修设计**，不再论证现状合理。两份 ADR 是草案，放在本报告内待用户审阅；不直接改 docs/DECISIONS/ 正式文件。

---

## 0. 两个阻断点与证据基线（全部 path:line，先读后设计）

| # | 阻断 | 核实事实（证据） | 归属 |
| --- | --- | --- | --- |
| 1 | 管理员口令从未交付 → store/install 与 system/info 需登录，复核 BLOCKED | HANDOFF:155/242/321/383/448 多处「未交付 / 登录态 BLOCKED」；probe-password 已回报并入本提案 | ADR-0055 |
| 2 | paths.index_dir 是冷字段，改后必须重启；本地沙箱无法在宿主侧重启 | internal/core/config/reload.go:8-10 白名单不含 paths.*；:203-216 coldPathsChanged 明列 paths.index_dir；cmd/kored/config.go:71 注释「不可热更字段由 Reload 保留旧值」；HANDOFF:684/697 | ADR-0056 |

### 0.1 口令侧（probe-password 结论 + 我独立只读复核）

- cmd/kored/install.go 全文（1–187 行）**只做包校验 + 安装**，没有任何 firstRunBootstrap 调用 → **安装时不打印口令**。
- 唯一「打印一次」时机是 serve 首启且 stderr 是 TTY：admin_password.go:249 firstRunBootstrap、:263 门控 firstRunTerminal()、:292-293 打印到 stderr；或显式 kored admin-password --generate（:111）。
- 本机以 systemd-run --user 非 TTY 启动（RUNBOOK:91），按 :263 逻辑**当初大概率根本没打印过**；HANDOFF 全部记「未交付」，无「曾打印」证据。
- 凭据存配置文件 auth.admin_password_hash（非 state.db），PBKDF2-HMAC-SHA256 600000 次；明文不留存、不可找回，只能重置（admin-password --set/--generate/--hash/--stdin）。
- **用户「安装时应该打印」的诉求 = 真实设计缺口**：打印时机与安装解耦、非 TTY 启动就拿不到。

### 0.2 重启侧（probe-restart 结论 + 我独立只读复核）——纠正错误前提

**产品已经有自升级 + 提交自重启链，不是漏设计**：

| 事实 | 证据 |
| --- | --- |
| kored upgrade 校验 → 原子替换 → 落 marker → systemctl --no-block restart <unit> | cmd/kored/upgrade.go:150-210、:265-294 submitUpgradeRestart |
| 重启原语 | internal/core/privilege/systemd.go:40-53 BuildRestartArgv / RestartUnitNoBlock |
| HTTP 入口已装配 | cmd/kored/serve_upgrade.go:119-137 StartUpgrade；probe-restart 报告的 selfupdate 入口 |
| 三道前置 | upgrade.go:135-143 euid!=0 → exit 6；默认 unit kore.service；需新二进制 + sha256 |
| 设计意图 | ADR-0042:26-44 选系统级 root 服务正是为内核零口令升级/重启；FEATURE-PARITY.md:78 列为「做 M3」 |

**本机跑不通的根因**：uid=1000 的 kored-local.service 降级形态（HANDOFF:684/697）+ 未装系统 unit + DSH 沙箱（NNP=1 / 私有 PID namespace / 私有 /proc / 用户 bus 不可达），**不是产品缺功能**。
→ 要修的是「从降级形态到系统级服务的安装/迁移路径 + 自服务触发入口 + 安全边界」，**不是重新发明自重启**。

### 0.3 已被用户否决的方向（不再重试）

「新增独立 kore root 用户」：**不采纳**。run-user 报告 B 选项的三条否决理由成立：①清单外需改 ADR-0023 §3.5（G-31「新增路径/用户/unit 一律退回」）；②与 ADR-0018:85「内核非 root 与插件独立 uid 不可同时成立」矛盾，要补 capability/polkit 又撞 ADR-0042 被否决的 A 方案；③涉及不可逆系统变更（/etc/passwd、unit User=、chown -R），用户已明确质疑。本提案**不需要**它。

### 0.4 并行探针纳入状态

- probe-password：已回报，事实已并入 §0.1 与 ADR-0055。
- probe-restart：已回报，纠正前提已并入 §0.2 与 ADR-0056。
- probe-ci-triggers（task-102）：结论未到；§ADR-0056「CI / 版本控制硬边界」按用户最新口径**先写死**，结论到达后只做证据补强，不改硬约束。

---

# ADR-0055（草案）：安装期一次性管理员凭据交付，消除口令 human gate

> 状态：**draft（待用户审阅）** · 归属: architect · 日期: 2026-11-25 · 关联: ADR-0043、ADR-0042、ADR-0023、USABILITY.md、G-30

## 背景

本地更新的第一个 human gate 是「管理员口令未交付」。根因不是「忘记告诉用户命令」，而是三处结构性缺口：

1. **打印时机与安装解耦**：install.go 完全不生成/不打印凭据；只有 serve 首启才尝试（admin_password.go:249）。
2. **非 TTY 一律不交付**：admin_password.go:263 明令非 TTY 不生成不打印明文，只给 CLI 指引；本机正是非 TTY，于是配置里没有哈希、终端上没有任何输出，形成「HANDOFF 记未交付」的死结。
3. **无法找回、重置生效路径分叉**：明文单向哈希不可恢复；reload.go:78-81 把哈希列入热更白名单，但 serve_signals.go 只同步限速/审计、不把新哈希推给内存中的 auth.Manager，admin_password.go:114 才会说「需重启」。

用户那句「**安装时不是应该打印吗**」的明确设计口径：**是的，安装期必须交付一次性凭据**；但交付不能只靠「往终端打一行」——非 TTY/服务化安装会把明文送进 journald 或 CI 日志，直接踩 G-30。所以正确形态是「安装期统一入口 + 一次性凭据文件 + TTY 明文附加打印 + 非 TTY 只给路径」。

## 选项对比

| 方案 | 安装期交付 | 非 TTY 可用 | G-30 边界 | 首登改密 | 老实例找回/重置 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A. 维持现状（仅 serve 首启 TTY 打印） | ❌ 无 | ❌ 非 TTY 直接放弃 | 合规但无交付 | 无 | 仅 CLI 重置 | **否决**：正是当前卡死点 |
| B. install 时直接往 stdout 打明文 | ✅ | ❌ 自动化 stdout 会被采集 | ❌ 明文可能进日志/CI | 无 | 无 | **否决为主路径**；TTY 分支作为 C 的附加输出保留 |
| C. 一次性凭据文件 + 安装/首启统一入口 + TTY 明文打印 + 首登强制改密 | ✅ | ✅ 只暴露文件路径 | ✅ 文件在 install 内 0600；明文不入库/日志 | ✅ | ✅ | **采纳** |
| D. 纯 Web 首访设口令（无令牌） | ⚠️ 打开面板即设 | ✅ | ✅ | ✅ | ❌ | **否决**：未认证首访者可抢占管理员口令（接管风险） |
| E. 明文写入 config / state.db / 审计 | ✅ | ✅ | ❌ 直接违反 G-30 / ADR-0023 | — | — | **否决**：红线 |

## 裁决

**采纳 C**；B 的「TTY 终端打印」降级为 C 内的附加交付通道，不作为独立方案。

### 设计要点（落地口径，非实现代码）

1. **统一入口**（建议名 ensureInitialAdminCredential）：
   - 由 kored install --package 在 resolveCLITargets 之后、**打开 state.db 之前**调用（凭据只写 config，不碰被 serve 独占的 state，规避 install.go:98-105 的锁冲突）；
   - 由 serve bootstrap 在 loadConfig 之后调用（幂等兜底）；
   - **两处共用同一函数**，从设计上消除「打印时机与安装解耦」。
   - 触发条件仍为「哈希为空 / auth.initialized=false」；已有哈希的实例一行不打、一字节不写（保持 ADR-0043:38 的升级行为）。

2. **生成与落盘**（复用既有实现，不新造算法）：generateAdminPassword(24)（admin_password.go:219-231）→ auth.HashPassword（PBKDF2-HMAC-SHA256 600000）→ writeAdminBootstrapHash（:301-312，原子 0600），并把 auth.must_change_password=true 写进**同一次原子写**。

3. **交付通道（双通道，边界不同）**：
   - **一次性凭据文件**：install/data/initial-admin-credential，权限 0600，仅写一次，内容只有明文口令一行。属**运行态资产**（与 .kore-local-state/ 同类），必须 gitignore；不属于 docs/ 或 .agents/verify/，不进 make secret-check 扫描面。首次登录并改密成功后由内核删除/标记 consumed。
   - **TTY**：安装/首启结束时在**操作者当前终端**打印一次性提示，可含明文（admin_password.go:292-297 既有口径），同时打印凭据文件路径。
   - **非 TTY**（systemd/journald / 重定向 / CI / agent）：**绝不打印明文**，只打印「初始凭据已生成，请在自己的终端读取：<path>（权限 0600）」——延续 :263 的 G-30 纪律，解决「服务化安装拿不到凭据」。

4. **首次登录强制改密**（回答「是否需要打印一次+首登改密」：**需要**）：
   - 新增 auth.must_change_password 布尔（与哈希同文件、同原子写）。
   - 登录校验通过且该标志为 true → 只发**受限会话**：仅允许改密端点、登出与静态壳；其余 /api/v1/* 返回 403 + 白话「首次登录请先设置新口令」（USABILITY 原则 4）。
   - 改密成功后：清标志、吊销全部旧会话、发完整会话（或要求重新登录）；写 auth.password_initial_changed 审计。
   - **G-11 边界声明**：这是**单管理员账号上的一个一次性状态机**，不是多用户系统——没有用户列表、没有角色、没有权限组，不命中「多用户 RBAC」。

5. **老安装如何找回/重置**（不靠「重新初始化」丢数据）：
   - hash 为空的老实例：下一次 install/serve 自动走统一入口补交付凭据文件；**不动** state.db / plugins / index，不存在重新初始化。
   - hash 已存在但口令遗忘：**不可找回**（单向哈希，设计上明确不提供找回）；CLI kored admin-password --generate/--set [--stdin] 或登录后 Web 改密 → 原子写新哈希 + must_change=true + 吊销会话。
   - **生效路径收口**：在 serve_signals.go 的 SIGHUP 处理里增加 auth 同步（把快照里的新哈希与 must_change 推给 auth.Manager 并吊销会话），使 CLI 重置无需重启即生效；重启（ADR-0056 提供自服务入口）仍是兜底。
   - **禁止**把「清 state / 重装 / 删 .kore-local-state/」当找回手段——那会丢数据，正是用户点名的反模式。

6. **G-30 边界（写死）**：
   - 终端明文 = 瞬时、仅当前 TTY、不重定向进文件、不入版本库；
   - 凭据文件 = install 内运行态资产、0600、gitignore，消费后删除；
   - 日志/审计只记事件元数据（时间、路径、决策），**不记明文、不新增哈希副本**；
   - 本报告及后续文档中的口令一律写 *** / <placeholder>，make secret-check 门禁保持阻断级。

7. **USABILITY 四问**：①默认入口 = 安装完成即给凭据文件 + 终端提示；②自动探测 = 配置路径与 serve 同一解析（adminPasswordConfigPath）；③点击数 = 读文件 → 登录 → 改密（3 步）；④文案 = 白话「打开面板输入这个口令，登录后必须改一个新口令」。

## 被否决选项与依据

| 选项 | 否决依据 |
| --- | --- |
| A 维持现状 | install.go 无 bootstrap、非 TTY 不交付，就是当前 human gate 的成因（§0.1） |
| B install 直接打明文到 stdout | 自动化 stdout 会进 CI/日志，踩 G-30；且非 TTY 场景仍无持久交付载体 |
| D 纯 Web 首访设口令 | 无令牌的未认证端点 = 任意首访者可抢占管理员凭据；ADR-0043 刚把「本机免登录」纠正掉，不能回退 |
| E 明文入库/日志 | G-30 红线（历史事故：明文口令写进验收报告并推送公开仓库） |
| 多用户/角色化凭据 | 命中 G-11「不做多用户 RBAC」，需求退回提案阶段 |

## 对既有 ADR 的修订（明确写出，不偷偷改口径）

| 目标 | 修订内容 |
| --- | --- |
| ADR-0043 §3「代价 / 已知缺口」段 | 追加：「首启凭据引导已被 ADR-0055 取代为『安装期统一交付 + 一次性凭据文件 + 首登强制改密』；非 TTY 交付不再只给 CLI 指引」 |
| ADR-0043 §5 复审条件第 1 条 | 追加：「若改为 Web 一次性引导须连 ADR-0055 一起复审（未认证抢占风险）」 |
| ADR-0043 §1 鉴权表 | 补一行说明 must_change_password 是单管理员状态机，非 RBAC，§1「单管理员、无用户名」不变 |
| internal/core/config/reload.go mergeHot / serve_signals.go | 把 auth.must_change_password 纳入热更白名单并在 SIGHUP 同步 auth.Manager（纯代码任务，不是 ADR 口径变更） |
| QUICKSTART §2.1 / RUNBOOK-INSTALL §7 / USABILITY §8 P0-1 | 下游文档同步（安装后读凭据文件、首登改密），列为实施任务卡，不在本提案改 |

## 复审条件

1. 若要把凭据交付改成「Web 一次性引导」→ 必须先解决未认证抢占，并与 ADR-0043 §5 联合复审。
2. 若凭据文件出现在版本控制、日志或审计 → 立即停用该通道并重开 ADR（G-30 事故级）。
3. 若出现多管理员 / 角色需求 → 命中 G-11，退回提案阶段，不在本 ADR 打补丁。
4. 若 PBKDF2 参数或哈希算法出现 CVE / 升级 → 复审生成与校验链路。

---

# ADR-0056（草案）：自重启 / 自更新闭环——修安装迁移路径与自服务触发，不重造轮子

> 状态：**draft（待用户审阅）** · 归属: architect · 日期: 2026-11-25 · 关联: ADR-0042、ADR-0049、ADR-0023 §3.5、ADR-0018 §不可回滚操作护栏、G-11 / G-31

## 背景

产品**已有**自升级 + 自重启链（§0.2 证据），本机不能用是**形态问题**：uid=1000 的 kored-local.service 降级形态 + 未装系统 unit + DSH 沙箱无法从外部 agent 操作宿主 systemd。同时还有两个真实缺口：

1. **冷字段无自服务重启入口**：SIGHUP 只应用 reload.go:8-10 的热白名单，paths.index_dir 在 :203-216 被列为冷字段 → 改完配置只能等外部人工重启（当前卡点）。
2. **离线安装收尾不闭环**：install.go:128-134 明说 post_upgrade_pending 要等「下次 serve 启动」补跑；缺一个「装完自己提交重启」的自服务触发。
3. **降级形态下外部 agent 做不到，但 kored 自己做得到**：本会话沙箱不可达用户 bus，而 kored 进程本身由 systemd-run --user 拉起、持有用户 bus 凭据 → **让 kored 自己重启自己的 unit** 就能绕开沙箱，不需要任何外部提权。

## 选项对比

| 方案 | 本机可用 | 权限变更 | 需用户授权 | 审计/不可回滚护栏 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. 维持人工 systemctl restart | ❌ 沙箱做不到 | 无 | 每次都要 | 无 | **否决**：就是 human gate |
| B. 新增独立 kore root 用户跑 kored | 理论可 | **可逆性差** | 必须 | 需新豁免 | **否决**：用户已否决 + run-user B + ADR-0018:85 矛盾 |
| C. 系统级 User=root 服务 + 自服务重启端点 | ✅（目标形态） | 装 unit（豁免 #1） | **一次性授权** | 复用 confirm + 审计 | **采纳为目标形态** |
| D. 降级形态下 kored 重启自己的 user unit | ✅（本机当前形态） | 无（同 uid 服务控制） | 否 | 同 C | **采纳为当前可用补充路径** |
| E. 用信号（SIGUSR2 等）触发重启 | 部分 | 无 | 否 | ❌ 无法携带 actor/confirm/审计，且与 SIGHUP 热更混淆 | **否决** |
| F. 外部 agent 在宿主 systemd-run 重启 | ❌ 沙箱做不到 | 无 | 每次 | 无 | **否决**：当前卡点本身 |

## 裁决

**采纳 C + D 组合**：目标形态是 ADR-0042 已定的系统级 root 服务；本机当前降级形态下，由 kored 自服务重启自己的 user unit 作为同权限补充路径。A / B / E / F 否决。

### 设计要点（落地口径，非实现代码）

1. **统一内部原语** SelfRestart(reason, actor)（薄壳：只做规则与编排，不认识插件业务，G-01）：
   - euid==0 且 unit = kore.service → 复用 BuildRestartArgv / RestartUnitNoBlock（systemd.go:40-53，--no-block 理由见 upgrade.go:265-272）；
   - 非 root 且检测到自己的 user unit（配置/环境显式指定，如 kored-local.service）→ systemctl --user --no-block restart <unit>；
   - 无 systemd / 无 unit / bus 不可达 → **结构化失败** E_NO_SELF_RESTART + 白话 hint（「本实例不是服务运行，无法自重启；请按 RUNBOOK 重新拉起」），**不允许静默降级或假成功**（G-16）。
   - 原语**只接受 reason 与 unit 标识（来自探测/配置），不接受用户提供的命令字符串** → 无注入面。

2. **触发入口**：
   - **主入口**：HTTP POST /api/v1/system/restart，需登录会话 + system:admin + **一次性 confirm 令牌**（绑 action=system.restart + reason，5 分钟有效，复用 privilege/confirm.go）。依据 ADR-0018:228 把「服务 restart/reload」明确列为不可逆动作、:230 要求二次确认。沿用 upgrade.go:265-272 的时序：**先把结论写完再被重启**，--no-block 提交，exit 0 = 「已提交」≠「已生效」；生效证据由新进程写 marker / 健康探针给出。
   - **辅入口**：CLI kored restart --reason "..."（同机、同 uid 或 root，走同一 SelfRestart，同样 --yes confirm，落同一审计）。它只解决「没 HTTP 会话时的本机操作」，不是第二套逻辑。
   - **信号**：不用于重启（选项 E 否决）；SIGHUP 继续只做热更。

3. **与冷字段配置联动**：配置写入端点写盘后，用 coldChanged 的同一份判据（reload.go:155-216，含 paths.index_dir）判断：命中冷字段 → 响应 restart_required: true，可在同一次 confirm 里一步触发 SelfRestart；未命中 → SIGHUP 热更即可。**「改 index_dir 后重启生效」在面板内闭环**。

4. **与插件升级联动**：运行时商店安装继续走 reloadOne（serve_boot.go:86、serve_runtime.go:257）；离线 CLI 安装的 post_upgrade_pending（install.go:128-134）由 SelfRestart 后新进程补跑（HANDOFF:490-496）。**提交重启前必须 flush 所有 pending 标记**：upgrade-result.json、plugin_state.post_upgrade_pending、配置落盘，避免「重启把未落盘意图丢掉」。

5. **fail-closed 与审计**：
   - 审计写不进 → **不提交重启**（对齐 ADR-0018:224 root.action fail-closed）；
   - confirm 缺失 / 过期 / 不绑定 → E_UNAUTHORIZED + deny 审计；
   - 重启提交失败 → 明确「已完成 / 待完成」，marker 停留 pending，返回结构化错误码，**不声称成功**；
   - 并发重启请求排队、不合并（ADR-0018:233）；
   - 新增 system.restart 审计事件（actor / reason / unit / decision / commit_result / flush_state / 结果），**不记口令与 token**。

6. **CI / 版本控制硬边界（用户最新口径，写死）**：
   - SelfRestart 与自更新**只做本地二进制替换 + 本地 unit 重启**；**绝不执行 git push / tag / PR，绝不访问任何远端**。
   - 远端同步默认关闭（remote_sync.enabled=false）；即使是 **Gitea**（权威源，可按版本触发 CI）也要用户**当次明确授权**才开启。
   - **GitHub（镜像）永远只能 workflow_dispatch 主动触发**：任何自动化——含自更新、自重启、定时任务、安装后脚本——不得 push/tag 到 github，不得触发 GitHub Actions。
   - 依据：用户原话「**gitea 可以按版本 ci，github 必须是主动触发**」；GitHub 对 push/tag/PR 立即触发 Actions，远端 history 在禁 force-push 下无法干净回退。现有 .github/workflows/ci.yml:6-11 的 push(main/tags) / pull_request 触发器属于**仓库工作流**，kored 运行时一律不得主动制造这些事件（probe-ci-triggers 结论待同步，本条先作为硬约束，结论到达后只补证据）。

7. **G-31 / ADR-0023 §3.5 边界**：
   - SelfRestart 与凭据文件均**不新增安装目录外写入**，§3.5 豁免清单**无需修改**；
   - 从降级形态迁到系统级 root 服务需要装/改 /etc/systemd/system/kore.service = 豁免 #1，属**需用户一次性明确授权的不可逆系统变更**，本提案不执行、不代授权；
   - 不新增独立 kore root 用户（清单外、用户已否决）。

8. **G-11 六项不做自检**：无多用户 RBAC（单管理员 + 一次性 confirm，不是角色体系）；无集群/多机（单机 unit）；无模板市场；无厂商云存储深度集成；无拖拽建站；无多语言全量框架。**六项均不命中**。

## 被否决选项与依据

| 选项 | 否决依据 |
| --- | --- |
| A 维持人工重启 | 当前 human gate；沙箱不可达宿主 systemd（§0.2） |
| B 独立 kore root 用户 | 用户已否决；run-user B 三条否决理由成立；ADR-0023 §3.5 清单外；ADR-0018:85 结构矛盾 |
| E 信号触发重启 | 无 actor / confirm / 审计载体，与 SIGHUP 热更语义混淆 |
| F 外部 agent 宿主重启 | 就是当前卡点；用「让 kored 自己重启自己」替代 |
| 自更新后自动 push/tag（含 github） | 用户明令：非主动不触发 CI；github 仅 workflow_dispatch；远端不可干净回退（§6） |

## 复审条件

1. 系统级 root 服务的 User=root 前提被推翻（要改回普通用户）→ 按 ADR-0042 §5 第 6 条 + ADR-0018:268 重开权限模型 ADR。
2. 出现需要「无 systemd 也能自重启」的一等需求 → 重新评估（当前 fail-closed 给 hint，不假成功）。
3. 出现跨机 / 批量重启需求 → 命中 G-11「不做集群/多机」，退回提案阶段。
4. 用户明确要求开启远端同步 → 必须当次授权并逐条确认 Gitea/GitHub 触发策略；GitHub 自动触发任何情况下都不开。
5. system.restart 审计出现 fail-open 或注入面 → 立即停用端点并重开 ADR。

---

## 1. 对既有 ADR 的修订映射（汇总）

| 文档 / 段落 | 修订性质 | 内容 |
| --- | --- | --- |
| ADR-0043 §3 / §5 | **追加段落** | 首启凭据引导升级为 ADR-0055（安装期交付 + 凭据文件 + 首登改密） |
| ADR-0043 §1 | **补说明** | must_change_password 是单管理员状态机，非 RBAC |
| ADR-0042 | **不改** | User=root 目标继续有效；ADR-0056 的降级自重启是同 uid 补充路径，不替代 root 形态 |
| ADR-0049 | **不改** | 直接 exec 的执行机制不变；自重启沿用 --no-block 提交 |
| ADR-0018 §不可回滚护栏 | **不改（复用）** | restart 已列不可逆动作 → 直接复用 confirm + 审计 fail-closed |
| ADR-0023 §3.5 | **不改** | 两份提案均不新增安装目录外写入；「独立 kore root 用户」不采纳，故不需新豁免 |
| config reload.go / serve_signals.go | **纯代码** | 加 must_change_password 热更 + auth 同步 |
| QUICKSTART §2.1 / RUNBOOK-INSTALL §7 / USABILITY §8 | **下游文档同步** | 列为实施任务卡 |

## 2. 授权边界 vs 纯代码/配置（验收点 3、4）

### 2.1 需要用户明确授权（不可逆系统变更，本提案一项都不做）

| 项 | 归属 |
| --- | --- |
| 安装/修改 /etc/systemd/system/kore.service + enable；从 kored-local.service 迁到系统级 User=root 服务 | ADR-0023 §3.5 #1、G-31 |
| 任何 useradd / chown -R 属主迁移 / /etc/sudoers* / /etc/polkit-1/rules.d/ 写入 | ADR-0023 §3.5 #2/#3、run-user B |
| 新增独立 kore root 用户 | **不采纳**；若用户坚持，须单独授权并重开 ADR-0023 + ADR-0018 |
| 开启任何远端同步 / push / tag（尤其 GitHub） | 默认关闭；当次明确授权；GitHub 仅 workflow_dispatch |

### 2.2 纯代码 / 配置可完成，不需要用户线下操作

| 项 | 证据落点 |
| --- | --- |
| 安装期统一凭据入口 + 一次性凭据文件 + TTY/非 TTY 分支 | install.go / admin_password.go 复用既有函数 |
| must_change_password 状态机 + SIGHUP 同步 auth.Manager | config reload.go / serve_signals.go / auth / httpapi |
| POST /api/v1/system/restart + CLI kored restart + confirm + system.restart 审计 | cmd/kored/upgrade.go 既有原语复用，不新造执行链 |
| 冷字段联动重启 + 离线升级收尾 | 配置写入端点 / serve_boot.go / install.go 收尾 |
| 文档同步（QUICKSTART / RUNBOOK-INSTALL / USABILITY） | 实施任务卡 |

## 3. 落地任务卡拆解（验收点 1：两个阻断各有明确答案）

| 卡 | 目标（对应阻断） | 验收判据 | 写域 |
| --- | --- | --- | --- |
| T1 | ADR-0055 交付通道：install 与 serve 共用入口、凭据文件 0600、TTY/非 TTY 分支 | 非 TTY 安装后凭据文件存在且 0600、stderr 无明文；TTY 安装打印一次；make secret-check 绿 | cmd/kored/{install,admin_password}.go |
| T2 | ADR-0055 首登强制改密 + 重置生效 | must_change=true 时非改密端点 403；改密后标志清除、旧会话失效；CLI 重置 SIGHUP 即生效 | config / auth / httpapi / serve_signals |
| T3 | ADR-0056 自服务重启原语 + HTTP/CLI 入口 + 护栏 | 登录后带 confirm 触发 → 原 unit 重启、marker pending→success；无 confirm 401；审计失败不重启；无 unit 返回结构化失败 | cmd/kored / internal/core/privilege / httpapi |
| T4 | ADR-0056 冷字段联动 + 离线升级收尾 | 改 paths.index_dir 返回 restart_required；重启后 system/info 路径相等；post_upgrade_pending 新进程补跑 | config 写入端点 / serve_boot / install |
| T5 | 文档同步 + G-23 判断留痕 | QUICKSTART / RUNBOOK-INSTALL / USABILITY 更新；.agents/LOG/DECISIONS.md 登记两份 ADR 与被否决选项 | docs / .agents/LOG |

## 4. 一句话结论（验收点 5）

**两份 ADR 的设计按纯代码/配置部分落地后，本地更新流程（构建 → 安装期交付凭据 → 登录复核 → 改配置 → kored 自重启生效 → 插件升级 reload）不再依赖用户线下传口令、也不依赖外部 agent 在宿主侧手动 systemd-run，从而变成可自主闭环；唯一残留 human gate 是「一次性安装系统级 root 服务」与「开启远端同步」这两项需用户当次授权的不可逆变更，而 GitHub 在任何情况下都只能主动触发、绝不自动 push/tag。**
