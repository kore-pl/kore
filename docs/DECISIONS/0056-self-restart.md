> 状态: accepted · 归属: architect（perm-design-fix）→ implementer（restart-fix）· 更新: 2026-11-25 · 里程碑: R25 · 门禁关联: G-06 / G-23 / G-29 / G-31
> ADR 状态: accepted（2026-11-25 裁决落地）· 关联: [ADR-0042](./0042-privilege-without-prompt.md)、[ADR-0049](./0049-privilege-direct-execution.md)、[ADR-0018](./0018-privilege-model.md)、[ADR-0023](./0023-zero-intrusion.md) §3.5、[ADR-0024](./0024-repo-topology-and-gitea.md) §7、[实现报告](../../.agents/verify/adr56-restart.md)、[设计草案](../../.agents/verify/permission-design-fix.md)

# ADR-0056：自服务重启 / 自更新闭环——修安装迁移路径与自服务触发，不重造轮子

> 定稿说明：本 ADR 正文来自 [architect 草案](../../.agents/verify/permission-design-fix.md) 的 ADR-0056 节，状态由 draft 转 accepted；草案中与最终实现不一致的细节按 [实现报告](../../.agents/verify/adr56-restart.md) 修正，并在 §实现复核注记逐条列明。

## 1. 背景

产品**已有**自升级 + 自重启链（`cmd/kored/upgrade.go:150-210`、`265-294`，`internal/core/privilege/systemd.go:40-53`），本机不能用是**形态问题**：uid=1000 的 `kored-local.service` 降级形态 + 未装系统 unit + DSH 沙箱无法从外部 agent 操作宿主 systemd。同时还有两个真实缺口：

1. **冷字段无自服务重启入口**：SIGHUP 只应用 `reload.go:8-10` 的热白名单，`paths.index_dir` 在 `:203-216` 被列为冷字段 → 改完配置只能等外部人工重启（原卡点）。
2. **离线安装收尾不闭环**：`install.go:128-134` 明说 `post_upgrade_pending` 要等「下次 serve 启动」补跑；缺一个「装完自己提交重启」的自服务触发。
3. **降级形态下外部 agent 做不到，但 kored 自己做得到**：本会话沙箱不可达用户 bus，而 kored 进程本身由 `systemd-run --user` 拉起、持有用户 bus 凭据 → **让 kored 自己重启自己的 unit** 就能绕开沙箱，不需要任何外部提权。

## 2. 选项对比

| 方案 | 本机可用 | 权限变更 | 需用户授权 | 审计 / 不可回滚护栏 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. 维持人工 systemctl restart | ❌ 沙箱做不到 | 无 | 每次都要 | 无 | **否决**：就是 human gate |
| B. 新增独立 kore root 用户跑 kored | 理论可 | **可逆性差** | 必须 | 需新豁免 | **否决**：用户已否决 + run-user B + ADR-0018:85 矛盾 |
| C. 系统级 User=root 服务 + 自服务重启端点 | ✅（目标形态） | 装 unit（豁免 #1） | **一次性授权** | 复用 confirm + 审计 | **采纳为目标形态** |
| D. 降级形态下 kored 重启自己的 user unit | ✅（本机当前形态） | 无（同 uid 服务控制） | 否 | 同 C | **采纳为当前可用补充路径** |
| E. 用信号（SIGUSR2 等）触发重启 | 部分 | 无 | 否 | ❌ 无法携带 actor / confirm / 审计，且与 SIGHUP 热更混淆 | **否决** |
| F. 外部 agent 在宿主 systemd-run 重启 | ❌ 沙箱做不到 | 无 | 每次 | 无 | **否决**：当前卡点本身 |

## 3. 裁决

**采纳 C + D 组合**：目标形态是 ADR-0042 已定的系统级 root 服务；本机当前降级形态下，由 kored 自服务重启自己的 user unit 作为同权限补充路径。A / B / E / F 否决。

### 设计要点（落地口径）

1. **统一内部原语 `SelfRestart(reason, actor, unit)`**（薄壳：只做规则与编排，不认识插件业务，G-01）：
   - euid==0 且 unit = `kore.service` → 复用 `BuildRestartArgv` / `RestartUnitNoBlock`（`--no-block` 理由见 `upgrade.go:265-272`）；
   - 非 root 且检测到自己的 user unit（配置 / 环境显式指定，如 `kored-local.service`）→ `systemctl --user --no-block restart <unit>`；
   - 无 systemd / 无 unit / bus 不可达 → **结构化失败** `E_NO_SELF_RESTART` + 白话 hint（「本实例不是服务运行，无法自重启；请按 RUNBOOK 重新拉起」），**不允许静默降级或假成功**（G-16）；
   - 原语**只接受 reason、actor 与 unit 标识（来自探测 / 配置），不接受用户提供的命令字符串** → 无注入面；unit 名做保守字符集校验。
2. **触发入口**：
   - **主入口**：`POST /api/v1/system/restart` + `GET /api/v1/system/restart/confirm-token?reason=...`，需登录会话 + `system:admin` + **一次性 confirm 令牌**（绑 `action=system.restart` + reason，5 分钟有效，复用 `privilege/confirm.go`）。依据 ADR-0018:228 把「服务 restart / reload」列为不可逆动作、:230 要求二次确认。沿用 `upgrade.go:265-272` 时序：**先把结论写完再被重启**，`--no-block` 提交，202 = 「已提交」≠「已生效」；生效证据由新进程写 marker / 健康探针给出。
   - **辅入口**：CLI `kored restart --reason "..." [--yes|--confirm]`（同机、同 uid 或 root，走同一 SelfRestart、同一 confirm、同一审计），只解决「没 HTTP 会话时的本机操作」，不是第二套逻辑。
   - **信号**：不用于重启（选项 E 否决）；SIGHUP 继续只做热更。
3. **与冷字段配置联动**：`POST /api/v1/system/config` 写盘后复用 `coldChanged` 同一份判据（`reload.go:155-216`，含 `paths.index_dir`）：命中冷字段 → 响应 `restart_required: true`，可在同一次 confirm 里一步触发 SelfRestart；未命中 → SIGHUP 热更即可。「改 index_dir 后重启生效」在面板内闭环。
4. **与插件升级联动**：运行时商店安装继续走 `reloadOne`；离线 CLI 安装的 `post_upgrade_pending` 由 SelfRestart 后新进程在 `buildService` 里 `resumePendingPostUpgrade()` 补跑。**提交重启前必须 flush 所有 pending 标记**：upgrade-result.json、plugin_state.post_upgrade_pending、配置落盘，避免「重启把未落盘意图丢掉」。
5. **fail-closed 与审计**：审计写不进 → **不提交重启**（对齐 ADR-0018:224）；confirm 缺失 / 过期 / 不绑 reason → 401 `E_UNAUTHORIZED` + deny 审计；重启提交失败 → 明确「已完成 / 待完成」，marker 停留 pending，返回结构化错误码，**不声称成功**；并发重启请求排队、不合并（ADR-0018:233）；新增 `system.restart` 审计事件（actor / reason / unit / decision / flush_state / commit_result / 结果），**不记口令与 token**。
6. **CI / 版本控制硬边界（用户裁决，写死）**：
   - SelfRestart 与自更新**只做本地二进制替换 + 本地 unit 重启**；**绝不执行 git push / tag / PR，绝不访问任何远端**。
   - 远端同步默认关闭（`remote_sync.enabled=false`）；即使是 **Gitea**（权威源，可按版本触发 CI）也要用户**当次明确授权**才开启。
   - **GitHub（镜像）永远只能 workflow_dispatch 主动触发**：任何自动化——含自更新、自重启、定时任务、安装后脚本——不得 push / tag 到 github，不得触发 GitHub Actions。依据用户原话「**gitea 可以按版本 ci，github 必须是主动触发**」；实现事实见 [ADR-0024](./0024-repo-topology-and-gitea.md) §7 与 `.agents/verify/ci-trigger-flip.md`（26 仓 GitHub `on:` 只含 `workflow_dispatch`，Gitea 按 tag + 手动）。
7. **G-31 / ADR-0023 §3.5 边界**：SelfRestart 与凭据文件均**不新增安装目录外写入**，§3.5 豁免清单**无需修改**；从降级形态迁到系统级 root 服务需要装 / 改 `/etc/systemd/system/kore.service` = 豁免 #1，属**需用户一次性明确授权的不可逆系统变更**，本 ADR 不执行、不代授权；不新增独立 kore root 用户（清单外、用户已否决）。
8. **G-11 六项不做自检**：无多用户 RBAC（单管理员 + 一次性 confirm，不是角色体系）；无集群 / 多机（单机 unit）；无模板市场；无厂商云存储深度集成；无拖拽建站；无多语言全量框架。**六项均不命中**。

## 4. 被否决选项与依据

| 选项 | 否决依据 |
| --- | --- |
| A 维持人工重启 | 当前 human gate；沙箱不可达宿主 systemd |
| B 独立 kore root 用户 | 用户已否决；run-user B 三条否决理由成立；ADR-0023 §3.5 清单外；ADR-0018:85 结构矛盾 |
| E 信号触发重启 | 无 actor / confirm / 审计载体，与 SIGHUP 热更语义混淆 |
| F 外部 agent 宿主重启 | 就是当前卡点；用「让 kored 自己重启自己」替代 |
| 自更新后自动 push / tag（含 github） | 用户明令：非主动不触发 CI；github 仅 workflow_dispatch；远端不可干净回退 |

## 5. 复审条件

1. 系统级 root 服务的 `User=root` 前提被推翻（要改回普通用户）→ 按 ADR-0042 §5 第 6 条 + ADR-0018:268 重开权限模型 ADR。
2. 出现需要「无 systemd 也能自重启」的一等需求 → 重新评估（当前 fail-closed 给 hint，不假成功）。
3. 出现跨机 / 批量重启需求 → 命中 G-11「不做集群 / 多机」，退回提案阶段。
4. 用户明确要求开启远端同步 → 必须当次授权并逐条确认 Gitea / GitHub 触发策略；GitHub 自动触发任何情况下都不开。
5. `system.restart` 审计出现 fail-open 或注入面 → 立即停用端点并重开 ADR。

## 6. 实现复核注记（2026-11-25，commit `93fd441`）

实现报告：[.agents/verify/adr56-restart.md](../../.agents/verify/adr56-restart.md)；commit `93fd441` = `[agent:restart-fix] feat(core): ADR-0056 自服务重启闭环（T3+T4）`。**未 push、未触发 CI、未改运行态文件与系统配置**。

### 6.1 草案 → 实现的事实差异（以实现为准）

| 草案表述 | 最终实现事实 |
| --- | --- |
| §3.2 HTTP 主入口只写 `POST /api/v1/system/restart` | 实际另注册 `GET /api/v1/system/restart/confirm-token?reason=...`（同属 ADR-0056 写域）；`POST /api/v1/system/config` 与上述两条合计 3 条新路由 |
| §3.1 原语签名 `SelfRestart(reason, actor)` + unit 来自探测 / 配置 | 实现为 `SelfRestart(reason, actor, unit)`，unit 作为显式参数并做保守字符集校验；薄壳与「不接受用户命令字符串」的边界不变 |
| §3.2 confirm「复用 privilege/confirm.go」 | 新增 `IssueWithReason` / `ConsumeWithReason`，令牌绑 `action=system.restart` + reason 摘要（5 分钟一次性，摘要只在内存，不落盘） |
| §3.4 离线升级收尾由新进程补跑 | 实现为提交前 `flushRestartPending`（校验 upgrade-result.json / plugin_state / 配置落盘）+ 新进程 `buildService` 内 `resumePendingPostUpgrade()` |
| §6「probe-ci-triggers 结论待同步」 | 结论已到：ci-trigger-flip 已落地（`d7d6507`，验收报告 `.agents/verify/ci-trigger-flip.md`），本 ADR §3.6 按实现事实改为「已落地」，硬约束不变 |

### 6.2 验证命令与退出码（实现报告原文口径）

```
GOWORK=off CGO_ENABLED=0 go test -timeout 200s ./...   → exit 0（17 包全 ok）
go vet ./...                                          → exit 0
make secret-check                                     → exit 0（0 FAIL / 23 处合规占位）
```

Mock unit 验证（无真实 systemd、无 8787、不真重启宿主）：`TestSelfRestartRootUsesSystemUnitAndNoBlock`（argv = `systemctl --no-block restart kore.service`）、`TestSelfRestartUserUnit`（`--user --no-block restart kored-local.service`）、`TestSelfRestartNoSystemdFailsClosed`（`E_NO_SELF_RESTART` + hint）、`TestSystemRestartNoConfirm`（401，原语零调用）、`TestSystemRestartNoUnit`（白话 hint）、`TestConfirmReasonBinding`（错 reason / 重用被拒）、`TestColdFieldsChangedIndexDir` 与 `TestWriteConfigUpdatesAtomicAndRestartRequired`（命中冷字段、原子写保留注释）——全部 PASS。

### 6.3 未验证项与残留 human gate

系统级 root 服务真装、Gitea 服务端 Actions / act_runner 注册、真实 systemd 下的 marker pending→success 全链路均未在本机实测；两项需用户当次授权的不可逆变更——**安装系统级 root 服务**与**开启远端同步**——本 ADR 只写边界、不执行、不代授权。
