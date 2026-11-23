# cron 唤醒路径裁定：`kored invoke` 该补还是该撤（2026-11-24）

> 结论先行：**推荐 B2 —— 撤回「宿主条目唤醒插件」的承诺，收敛到内核 scheduler；不新增 `kored invoke` 免登录通道。**
> 但任务卡的前提需要纠正：**没有任何一条 `cron` 写的 crontab 条目试图唤醒插件**。shell/http 写的是自包含命令、由系统 cron 在插件用户下直接执行；`type=plugin` 根本不写 crontab，第二跳由浏览器 POST 内核 scheduler 完成。断链在**承诺面**（3 份文档 + 1 条已采纳决策记录），不在运行期。
> 取证锚点：`HEAD=ca4f45e`；`kore-plugin-cron HEAD=ecec619`。引用行号按这两个提交解析。
> 本轮：只读代码 / 文档，未起服务、未改代码、未 sudo、未改动主实例运行态配置。产出 ADR 草案 [ADR-0046](../../docs/DECISIONS/0046-cron-wake-path.md)（`状态: proposed`）。

## 1. 断链复核（问题 1）

### 1.1 `kored invoke` 存在吗？——不存在

| 证据 | 位置 |
| --- | --- |
| 子命令 switch 只有 9 个分支：serve / version / install / audit / uninstall / status / upgrade / admin-password / help | `cmd/kored/main.go:37-62` |
| 未知子命令 → 打印用法 + 退出码 **2** | `cmd/kored/main.go:58-61`；码表 `:18-25` |
| 文档自认「没有对外 CLI 唤醒入口」 | `docs/DATA-MODEL.md:30`、`docs/CORE.md:342`、`docs/ARCHITECTURE.md:118`、`docs/RESOURCE-MODEL.md:245` |

复核命令：`grep -n 'case "' cmd/kored/main.go` → 9 条命中，无 `invoke`；`grep -rn "kored invoke"` 全 workspace → 只命中 docs / 决策记录，**代码零命中**。

### 1.2 cron 到底往宿主写了什么？——不是"唤醒命令"

`cron.add` 按 `type` 三分（`kore-plugin-cron/internal/croncore/methods.go:33-60`）：

| type | 写什么 | 到点谁执行 | 需要 `kored invoke` 吗 |
| --- | --- | --- | --- |
| shell | 插件用户 crontab 一行：`'<plugin-bin>' __task-run '<runlog>' '<name>' '<cmd>'`（`wrapper.go:31-38`，隐藏子命令 `:15-16`；写盘 `crontab.go:79-105`） | 系统 cron，以插件用户身份 | **否**（直接 exec 插件二进制写日志，`main.go:20-24` 在 `loadConfig` 前分流） |
| http | 同 crontab，行内容为固定 argv curl（`tasktype.go:112-124`） | 系统 cron | **否** |
| plugin | **不写 crontab**（`methods.go:47-60`）；返回 `scheduler_task` 建议 + `endpoint`（`types.go:76`、`tasktype.go:27-28`、`:190-215`） | 内核 scheduler | **否** |

plugin 类型的第二跳确实存在，且已闭合：`web/tasks.js:84-93` 读 `kore_csrf` 后 `POST /api/v1/scheduler/tasks`，触发分支 `web/tasks.js:373-378`；端点鉴权 = 登录会话 + `system:admin`（`handlers.go:99-102`，POST 创建在 `:100`；`handlers_scheduler.go:42-67`、`:75-91`）。到点执行 `s.invoker.Invoke`（`internal/core/scheduler/run.go:39-54`，调用点 `:53`）。

**结论**：任务卡说的「cron 写条目成功、到点无人执行」在代码里不成立——crontab 里根本没有需要内核唤醒的行；需要唤醒的 plugin 型任务走的是 scheduler，也已实现。**断链在别处**（下节）。

### 1.3 真正的断链：文档与决策记录承诺了一条不存在的路径

| 位置 | 承诺 | 与代码的关系 |
| --- | --- | --- |
| `.agents/LOG/DECISIONS.md:15`（2026-11-21 **已采纳**） | cron 只写宿主条目，「到点由宿主调 `kored invoke`，主壳零定时器」 | 命令从未实现；记录未随 ADR-0019 修订 |
| `docs/SCENARIOS.md:74`、`:76` | cron 写 systemd timer / `/etc/cron.d/kore-*`；`kored invoke` 未实现 | 后半句属实；**前半句也错**——代码写的是**用户 crontab**（`crontab.go:79-105`），而 `/etc/cron.d` 需 root、已被 ADR-0019:26 否决为主路径 |
| `docs/RESOURCE-MODEL.md:245` | 「CLI / 宿主调度器（未实现）」与 HTTP、scheduler 并列为触发源 | 属实，但并列写法让人误以为只是待补 |
| `docs/PLUGIN-CATALOG.md:79`、`docs/ARCHITECTURE.md:118` | 同上 | 同上，重复了 SCENARIOS:74 的第二处错误 |

这是 G-06（文档同步）+ G-23（判断留痕）缺陷，**不是运行期 bug**。

### 1.4 真实能力缺口：外部无人值守调用无路可走

两个调用入口都要求交互式会话：

1. `POST /api/v1/invoke/{plugin}/{method}` → `authorizeInvoke` 先验会话（`invoke_capability.go:107-116`）；
2. 内核 scheduler 创建任务 → 需会话 + `system:admin`（`handlers_scheduler.go:42-67`）。

ADR-0019 把「外部触发器（用户 cron 调 HTTP）」列为**可选增强**（`0019-scheduler.md:42-44`），但没回答「无人值守凭据从哪来」。这才是「要不要 `kored invoke`」的真问题。

## 2. A / B 对比（问题 2、3）

| 维度 | **A1** `kored invoke` + UDS 文件权限即身份 | **A2** `kored invoke` + 会话签发的作用域凭据 | **B1** 全部并入 `scheduler_tasks`（内核执行 shell） | **B2** 收敛口径、撤回承诺（**推荐**） |
| --- | --- | --- | --- | --- |
| 能否真正闭环 | 能，但只闭合「外部触发」这一窄需求 | 能，可撤销 / 可审计 | 能，但把任意命令执行搬进内核 | 能——scheduler 已闭合到点唤醒；撤回承诺消除文档谎言 |
| 安全影响 / 新攻击面 | **大**：本机任意能连 socket 的进程获得调用权；目标方法可能带 admin 副作用 | 中：多一套签发 / 撤销 / 作用域；漏配即长期有效 bearer | **大**：内核 = 任意代码执行入口 + 业务进薄壳 | **无新增** |
| 与 ADR-0043 | **违反**（§1 要求 UDS 一律会话；§2-C 否决「本机 UDS 免登录」） | 不违反字面，需补「派生凭据」条款 | 不涉及 | **一致** |
| 与既有设计一致性 | 中性 | 中性 | **违反 G-01**（`run.go:44-51` 只允许内置/插件方法） | **一致**（ADR-0019 单 ticker、ADR-0042 root 服务、G-01 薄壳） |
| 实现代价 | 2–3 人日（子命令 + 鉴权 + 审计 + 退出码 + 测试 + 安全评审） | 5–8 人日（+ 凭据存储 / 撤销 / UI） | 3–5 人日 + 重开 ADR-0019 | **0.5 人日**（6 处文档 + 1 条记录） |
| 对用户影响 | 新增能力；用户须理解「本机进程 = 可调用」 | 新增能力；多一步签发 | 失去 crontab 可见性；执行 uid / cwd / env 全变 | shell/http 用户**照旧**在宿主 crontab 可见可编辑；plugin 型本就在任务页；失去「外部无人值守触发」这一未实现能力 |

补充否决理由：
- **B1 按字面执行是危险的**：内核 scheduler 只认 `{plugin, method, params}`（`run.go:39-52`），塞进 shell 执行等于在内核开一个任意代码执行面，直接撞 G-01 与 ADR-0018。所以 B 只能是「B2 收敛」，不能是「B1 全搬家」。
- **A3（CLI 用 admin 口令登录）** 未单列：无人值守必须在磁盘留明文管理员口令，且拿到的是全权 admin，比 A1 更差，直接否决。

## 3. 推荐与牺牲（问题 4）

**推荐 B2。** 四条理由：

1. 闭环已有替代：ADR-0019 的 scheduler 是唯一周期源，plugin 型任务 UI 一步到位（`web/tasks.js:373-378`）。
2. A 的收益窄：缺的只是「kore 之外的程序触发插件方法」，v1 非目标清单里没有这条需求，也没有用户故事。
3. A1 与 ADR-0043 正面冲突；A2 成本是 B2 的 10 倍以上，且引入「长期凭据」这一新资产类别。
4. B1 违反薄壳红线（`run.go:44-51` 的分流结构就是为拒绝这类扩张写的）。

**牺牲了什么（逐条）**：

- **放弃「kore 之外无人值守触发插件方法」**：host timer、外部守护进程、CI 都调不到插件；只能走 kore scheduler 或带会话的 HTTP。
- **放弃「宿主条目 100% 由 kore 管理」**：shell/http 行仍在用户 crontab，kore 只增删改、不接管执行环境；用户手改 `crontab -e` kore 读得到但不管。
- **不解决 crontab 行钉死旧版本**（见 §5 风险 1）。
- **不补 ADR-0023 的变更清单**（另开卡）。

## 4. 本机免登录 vs ADR-0043（问题 5，关键）

**A1 违反 ADR-0043，且是决策表层面的正面冲突，不是实现细节。**

- `0043:18` 鉴权行：`withAuth` 对全部 `/api/v1/*` 一律会话校验，「UDS / loopback **不再跳过**」；
- `0043:29-31`：选项 C「本机 UDS 保留免登录、只给浏览器加登录页」被**否决**，理由「留下第二套身份来源，能力解析与审计都会分叉」；
- 代码现状同口径：`internal/core/httpapi/middleware.go:18-19`、`:33-61`；UDS 只剩「免 CSRF」豁免（`middleware.go:150-155`），且注释明写「只免 CSRF，不免认证」。

所以 A1 真要落地，**必须改 ADR-0043 本身**（新 ADR 取代 / amendment），不能宣称兼容。

「cron 无人值守不能要会话」属实，因此唯一合规方向是 **A2：凭据是登录的派生物**，不是把本机通道升格为身份。落地硬约束（ADR §5 全文）：

1. **只允许已声明方法**——目标方法必须在 `info.json.method_capabilities` 显式声明（`kore-plugin-cron/info.json:11`），并**拒绝** `system:admin` 级方法（`cron.add` / `cron.run` 这类）；委派上限低于会话。
2. **无 admin 能力继承**——不解析成 `subject=admin`，能力走独立白名单（G-01：不维护业务词表，只认 read 动作与显式 `(plugin, method)`）。
3. **审计 fail-closed**——写不进审计就拒绝执行。
4. **通道防伪只做防伪**——socket `0600` + `SO_PEERCRED` uid ∈ {kored 属主, root}（`local_access.go:80-92` 已有）只用于拒绝陌生对端，**不构成身份**；`channel.go:46-60` 是这种多因子通道的先例。
5. **参数只从文件 / stdin，≤64 KiB**（对齐 `handlers_scheduler.go:17`），不做 shell 解析。
6. **退出码语义**——复用 `cmd/kored/main.go:18-25` 码表；插件业务失败需新码（建议 7）。

## 5. 顺带发现（owner 视角，均未修复）

1. **crontab 行钉死绝对路径**：`wrapper.go:31-38` 写 `<state>/plugins/cron/<version>/...`；本地实存 0.2.0–0.4.1 多版本目录，升级后旧条目继续跑**旧版本**（静默）。`internal/core/installer/layout.go:66-105` 只处理同版本强制重装的暂存 / 删除，无旧版本清理。→ 建议单开卡（B2 不覆盖）。
2. **执行环境不透明**：shell/http 以**插件用户**（nologin 系统账户，`supervisor/demote.go:51`、`platform/linux_identity.go:22-23`）身份执行，不是提交者；UI 未提示。
3. **crontab 写入缺 ADR-0023 §3.5 类别 3 的 `changes.jsonl` 清单**（`0023:110`，缺口登记 `:158`）——G-31 合规缺口，与本裁定独立。
4. **未确认**：nologin 系统账户执行 `crontab -` 是否被宿主 PAM / `cron.allow` 拒绝。需真机（隔离实例 + 插件用户）验证；若被拒，shell/http 返回 `E_NO_PERMISSION`（`croncore/errors.go:8-9`），不静默。

## 6. 交付物与验证

| 项 | 路径 |
| --- | --- |
| ADR 草案（`状态: proposed`） | `docs/DECISIONS/0046-cron-wake-path.md` |
| 本报告 | `.agents/verify/cron-wake-decision.md` |

验证命令与结果见最终回复（`bash scripts/docs-check.sh` / `bash scripts/secret-check.sh` 的退出码原文）。
