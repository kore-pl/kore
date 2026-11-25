> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: accepted · 日期: 2026-11-23 · 决策者: lead · 关联: ../RESOURCE-MODEL.md、../CORE.md、../DATA-MODEL.md

# ADR-0019: 定时任务模型——单一 ticker + state.db 任务表，不引第三方调度器

## 背景

三个插件的成熟度缺口都要"到点执行一个动作"，但内核**没有调度器**：

| 缺口（PLUGIN-MATURITY §3.5） | 需要的定时能力 | 当前事实 |
| --- | --- | --- |
| #3 `backup` 定时备份 + 保留 7 份 | 每天 03:00 触发一次备份动作 | 只有手动 `create/list/restore/delete/verify` |
| #4 `cron` 任务类型 + 执行日志 + run-now | 到点执行、可查历史、可立即执行 | 只做系统 crontab 的增删（4 方法） |
| #5 `ssl` ACME 自动续期 | 周期性检查到期并触发续期 | `issue` 返 `E_UNSUPPORTED`，无 ACME |

G-19 的白名单只有 `cert_renew` 一个周期源，且它是"专用定时器"（到点只发一个事件）。任何其它模块想定时只能自己起 ticker——**被 G-19 直接禁止**，这正是三个缺口卡住的同一个结构性原因：缺一个**通用的到点执行机制**，而不是缺三套定时器。

同时必须承认边界：`cron` 插件管理的是**系统 crontab**（一个业务插件的职责），而内核要提供的是**调度的通用机制**——"在某个时刻调用 `{plugin, method, params}`"。前者是业务，后者是基础设施，两者不是一回事，也不应合并。

## 备选方案对比

| 方案 | 一个 ticker 管全部 | 非 root 可用 | 任务可查/可停/可手动触发 | 状态在 kore | 是否违反 G-19 |
| --- | --- | --- | --- | --- | --- |
| A. 内核通用 scheduler | 是 | 是 | 是 | 是 | 否（泛化白名单） |
| B. 每插件自起 ticker | 否（N 个） | 是 | 否 | 各插件自管 | **是，直接违反** |
| C. 写 /etc/cron.d | 否（交给系统） | **否**（需 root） | 借助系统 | 否 | 否，但不可用面太大 |
| D. 外部触发器（用户 cron 调 HTTP） | 否（无） | 是 | 否 | 否 | 否，但不开箱可用 |

**A. 内核通用 scheduler（推荐）**
- 优点：单一 ticker 覆盖全部定时需求；任务可列表/暂停/删除/手动执行；任务表落 `state.db`，可审计、可跨重启；内核只搬运 `{plugin, method, params}`，不认业务语义（守 G-01）；非 root 也能工作——权限由被调插件自己处理（与 ADR-0018 提权模型不冲突）。
- 缺点：内核需要知道"调哪个插件的哪个方法"；但这与 `POST /invoke/{plugin}/{method}` 是同一类数据，`{plugin, method, params}` 是**数据**而不是词表；代价是一个常驻 goroutine（仅在有启用任务时存在）与一次 ticker 唤醒（30s）。
- 尖锐的反对意见：这会不会让内核开始"懂业务"？不会——scheduler 不认识"备份/续期/crontab"任何一词，它只认表达式与三元组；业务参数原样透传，校验交插件。

**B. 每个插件自己 ticker**
- 优点：插件完全自治，内核零改动。
- 缺点：**违反 G-19**（多个周期源）；每个插件都要各自实现时区、错过补跑、持久化、并发互斥，重复造轮子且口径必然漂移；lazy 插件为定时续命会直接破坏"空闲即退出"的资源锚点；空载 CPU/fd 随插件数线性增长。**不采纳。**

**C. 操作系统 cron（写 /etc/cron.d）**
- 优点：复用系统能力，内核零开销，系统级可靠。
- 缺点：**需要 root 写 `/etc`**，与"kore 以启动用户身份运行、插件保持低权"（ADR-0018）冲突；容器/非 root 环境完全不可用；任务状态在系统里而不在 kore，`GET`/暂停/手动触发都要另造一套；发行版差异（cronie / systemd-cron / 无 cron）会变成兼容性矩阵。**不采纳为主路径。**

**D. 外部触发器（用户自己的 cron 调 kore API）**
- 优点：内核零开销、零新代码，用户可完全控制。
- 缺点：要求用户自己配外部 cron + 令牌 + 凭据轮换，**不是开箱可用**；三处缺口一个都补不上（插件仍不知道自己"该在 3 点备份"）；错误处理与执行记录仍在用户侧。**不采纳为主路径**，但作为可选增强保留（HTTP 端点即触发器）。

## 决策

采用 **A：内核通用 scheduler**。理由三条：

1. **单一 ticker 满足 G-19 精神**：把 `cert_renew` 泛化为 `scheduler`——白名单从"1 个专用周期源"变成"1 个通用周期源，内部管理所有任务"，周期源数量没有增加，反而少了未来 N 个插件 ticker。
2. **任务表在 state.db**：可审计（`scheduler_runs` 最近 100 条）、可暂停（`enabled=false`）、可手动触发（`POST .../run`）；重启后恢复，不靠外部系统。
3. **非 root 也能工作**：任务执行的是插件方法，权限由插件按 ADR-0018 自己处理；内核不做 ACME、不写 `/etc`、不联网（G-10）。
4. **内核只做到点调用**：`{plugin, method, params}` 是数据；scheduler 不维护"备份/证书/crontab"任何业务词表（G-01）。

### G-19 修订（唯一周期定时器白名单）

原文：**"定时器仅 `cert_renew`"**。

修订为：**"周期定时器仅 `scheduler`（单实例，内部管理所有任务）"**。

- 白名单条目从"1 个专用"改为"1 个通用"：`time.NewTicker` 只允许出现在 `internal/core/scheduler/`，全局仍**只能有 1 个** ticker（30s 检查间隔，实例唯一）。
- `cert_renew` 迁移为 scheduler 的**内置任务**（`plugin="kore"`，`method="cert.renew_due"`）：`cert_renew.enabled=true` 时注册/启用该任务，`false` 时禁用。**原独立 ticker 不再创建**，配置键与语义保持不变（向后兼容）。
- **默认零后台定时器**不变：无任何启用任务时 scheduler 不启动 ticker；任务全部禁用/删除后 ticker 被停掉。
- 允许请求级 `time.NewTimer` / `context.WithTimeout` 且必须 `Stop()` 的既有口径不变。

**命名决策（撞业务域名词表，显式披露）**：`scripts/thin-shell-check.sh` 的业务域名词表里有 `cron`（它当初指 `cron` 插件这个业务域）。内核代码直接使用该名字会撞门禁；按项目先例（`.agents/LOG/DECISIONS.md` 第 38 条 `plugin.retry` 命名：**不改门禁、不拆词，取语义等价词**），本 ADR 的线字段与 Go 字段统一命名为 `schedule`（`json:"schedule"`），5 段语法与语义完全不变，文档照常称「cron 表达式」。
任务书写的请求体字段是 `cron`，这里是为守门禁而做的**显式偏离**：门禁未改一行。若 lead 要求线字段必须字面等于 `cron`，需另开裁决（改门禁或加受控例外），不在本 ADR 内静默放宽。

## 错过补跑、并发与超时

| 语义 | 决策 | 理由 |
| --- | --- | --- |
| 停机期间错过的任务 | **不补跑**，写一条 `missed` 执行记录并累加 `missed_count`，下次时间从"现在"重新算 | 重启时补跑会形成任务风暴（同时拉起多个插件、抢占资源），且对备份/续期这类动作"迟到的执行"未必安全 |
| 同一任务并发 | **不并发**：上一次未完成则本次跳过，记 `skipped` + WARN | 备份/续期都不是幂等动作；并发执行等于自己制造脏数据 |
| 单任务超时 | 默认 **300s**（可配 1–3600s），超时 `context` 取消并记 `timeout` | 插件方法可能卡死；不能让它永久占住任务槽位 |
| ticker 间隔 | 30s（非可配常量） | 分钟级表达式精度只需 ≤60s；30s 兼顾及时性与空转成本 |
| 运行时迟到的判定 | 逾期超过 5min 视为 `missed`（不算执行） | 主机休眠/长阻塞恢复后不制造风暴 |

## 后果

**正面**：三个缺口（#3/#4/#5）有了同一个调度底座；插件无需自起 ticker，lazy 插件仍可"被你叫醒、干完就退"；任务可查可停可手动跑，失败有执行记录；`cert_renew` 的语义被保留且不再独占内核定时器。

**负面**：内核多一个模块与一张表；`scheduler_tasks` / `scheduler_runs` 两个 bucket 是 schema 的**追加**（不是破坏性变更，旧二进制忽略新 bucket，schema 版本仍为 1）；有启用任务时多 1 个 goroutine 与每 30s 一次空转检查（实测开销远低于 G-19 的 60ms/60s 上限）。

**技术债**：① 事件投递面（`kore.event{cert.renew_due}` 广播到插件）当前未在 bus 落地，内置任务只记录到点执行与日志——**不假装已投递**，M2 接事件面后补；② 执行记录只保留最近 100 条，未做按任务分页；③ 时区统一用进程本地时区，未提供 per-task `timezone` 字段（表达式按本地时区解释）。

## 验证方式

```bash
go test -timeout 200s ./internal/core/scheduler/...   # 表达式 / next_run / CRUD / missed / 并发 / 超时
go test -timeout 200s ./...                            # 全量
make check                                             # 11 段门禁；定时器禁词仍零命中（除 scheduler）
make docs-check                                        # 文档同步（CORE / RESOURCE-MODEL / DATA-MODEL / AGENTS）
```

真机：隔离实例（`--config /tmp/...`、`127.0.0.1:18849`）创建 `{plugin:"echo", method:"echo.ping", schedule:"*/1 * * * *"}`，90s 内 `last_run_at` 非空且 `last_result=ok`。

## 复审条件

- bus 事件投递面落地后，复审内置 `cert.renew_due` 任务的投递实现（当前只日志）。
- 若出现"单机任务数 > 100"或"需要秒级精度"的需求，重新评估 ticker 间隔与执行记录保留策略。
- 若 G-19 的白名单被第二个周期源突破（任何新增 ticker），本 ADR 即失效并回退到"仅 scheduler"的强约束检查。

## 修订记录：新增内置任务 `update.check`（2026-11-26，U4 默认关闭；§1–复审条件原文不动）

> 本节是 **append-only 修订记录**，不改上文已 accepted 正文（与 [ADR-0023 §11](./0023-zero-intrusion.md) 同口径）。触发来源：[ADR-0059 §3.1](./0059-silent-update-trigger-and-supply-chain.md)（U4 裁决：允许可选更新源拉取且默认关闭）与 [自更新实现任务图](./self-update-implementation-plan.md) M4。登记本段即解除 M4 的 ADR 门槛（G-06/G-23），实现按 M4 任务卡另行派发。

1. **白名单扩展的合规论证**：在 `internal/core/scheduler/` 的**唯一** ticker 上注册内置任务 `update.check`（`plugin="kore"`，内置方法，仿 `cert_renew` 迁移先例）。这是**同一个通用周期源内部新增一个任务**，不是新增周期源——G-19「定时器仅 scheduler（单实例单 ticker）」的白名单条目数量不变，不新增 `time.NewTicker` / `time.AfterFunc` / 周期循环，全局 ticker 仍唯一（30s 间隔）；请求级 `time.NewTimer` / `context.WithTimeout` 的既有 `Stop()` 口径不变。**被否决项**：独立自更新守护进程 / 独立 ticker——违反 G-19 白名单，且叠加 G-05 常驻组件、G-03 预算、G-31 安装目录外写入三重违规（ADR-0059 §2 表 C、§4）；不新增第二条周期源是本次扩展的不可越界底线。
2. **默认禁用 + 空闲纪律**：任务默认**不启用**（开关与更新源地址均为用户配置项，`update.source.enabled=false` / 源地址空）。按本 ADR「默认零后台定时器」既有口径，无任何启用任务时 scheduler 不启动 ticker；`update.check` 禁用时空闲行为与今天完全一致（出站 0、CPU/fd/goroutine 达标、零报错）。仅当用户显式开启后出现定时检查，属用户明示授权行为，不是隐藏轮询（G-10 论证见 ADR-0059 §3.3，比 ADR-0054 webhook 例外多一条「默认关闭」）。
3. **`IsOffline` 短路**：`IsOffline` 为真时任务直接短路返回「离线跳过」，不报错、不重试、不产生出站连接；默认关闭 + 断网时验收为零出站零报错。开启后验签失败按 ADR-0059 §3.1 带 `requires_restart:true`，本次不更新，不把验签失败降级为「用未签名索引继续」。
4. **不破坏"单实例单 ticker"纪律的实现约束**：任务注册只发生在既有 scheduler 实例的任务表里（bucket `scheduler_tasks`，内置 id 与 `builtin-cert-renew` / `builtin-audit-clean` 同类），不创建第二个 scheduler 实例、不在任何其它包起周期 source；`grep -rn "time.NewTicker\|time.AfterFunc" internal/core` 仍只允许 `internal/core/scheduler/` 命中。事件面若未落地照旧只记日志，不假装已投递（沿用本 ADR「技术债」口径）。
5. **复审追加**：若未来出现"第二个默认开启的周期任务"或要求把更新检查设为默认开启，须新开 ADR 重审 G-19 白名单与 G-10（默认关闭是本扩展成立的前提），不得援引本段类推放宽。
