> 状态: proposed · 归属: architect · 更新: 2026-11-24 · 里程碑: M5 · 关联: [0019-scheduler](./0019-scheduler.md)、[0023-zero-intrusion](./0023-zero-intrusion.md)、[0043-login-gate-vs-passwordless-ops](./0043-login-gate-vs-passwordless-ops.md)、[RESOURCE-MODEL](../RESOURCE-MODEL.md) §5.2、[SCENARIOS](../SCENARIOS.md) §3、[ARCHITECTURE](../ARCHITECTURE.md) §3.6、[PLUGIN-CATALOG](../PLUGIN-CATALOG.md) §6.2

# ADR-0046: 「宿主调度条目唤醒插件」——撤回承诺，收敛到内核 scheduler（不新增 `kored invoke` 免登录通道）

## 0. 问题与本 ADR 裁什么

任务卡的前提是：「`cron` 插件写的宿主 crontab 条目，到点后没有任何办法唤醒插件，因为 `kored invoke` 不存在」。复核后确认：`kored invoke` **确实不存在**（§1.1），但**今天没有任何一条 crontab 条目试图唤醒插件**——`cron` 写的是自包含命令，由系统 cron 在插件用户下直接执行；`type=plugin` 则根本不写 crontab，而是交给内核 scheduler（§1.2）。

所以断链不在运行期，**在承诺面**：三份文档 + 一条已被采纳的决策记录仍在描述「宿主条目 → `kored invoke` → 唤醒插件」这条从未实现的路径（§1.3）；同时内核确实**没有**对外非交互调用入口（§1.4）。

本 ADR 只裁一件事：**这条路径补上（A），还是撤回（B）**。本卡不实现。

## 1. 事实核查（每条带 file:line）

### 1.1 `kored invoke` 不存在

- 子命令分发 switch 只有 9 个分支（`cmd/kored/main.go:37-62`：serve / version / install / audit / uninstall / status / upgrade / admin-password / help）。未知子命令打印用法并返回 **2**（`cmd/kored/main.go:58-61`，码表见 `:18-25`）。
- 文档自认：`docs/DATA-MODEL.md:30`、`docs/CORE.md:342`、`docs/ARCHITECTURE.md:118`、`docs/RESOURCE-MODEL.md:245` 均写明「未实现 / 没有对外 CLI 唤醒入口」。
- `kore` 与 24 个插件仓的代码里**没有任何地方**调用 `kored invoke`（`grep -rn "kored invoke"` 仅命中本 ADR 与被引文档）。

### 1.2 cron 到底写什么（三类任务）

| type | 落盘位置 | 到点由谁执行 | 需要 `kored invoke` 吗 |
| --- | --- | --- | --- |
| shell | **插件用户自己的 crontab**：`crontab -` 从 stdin 整份写回（`kore-plugin-cron/internal/croncore/crontab.go:79-105`，二进制名 `:16-17`） | 系统 cron，以插件用户身份 | 否 |
| http | 同上，行内容是固定 argv 的 curl（`kore-plugin-cron/internal/croncore/tasktype.go:112-124`，前缀常量 `:13`） | 系统 cron | 否 |
| plugin | **不写 crontab**（`kore-plugin-cron/internal/croncore/methods.go:47-60`）；只返回 `scheduler_task` 建议 + `endpoint`（`types.go:76`、`tasktype.go:27-28`、`:190-215`） | 内核 scheduler | 否 |

- shell / http 的行长这样：`'<plugin-bin>' __task-run '<runlog>' '<name>' '<cmd>'`（`kore-plugin-cron/internal/croncore/wrapper.go:31-38`；隐藏子命令 `:15-16`，在 `kore-plugin-cron/main.go:20-24` 于 `loadConfig` **之前**分流，所以 cron 环境没有 `KORE_PLUGIN_SOCK` 也能跑）。它是**自包含**的：直接 exec 插件二进制写执行日志，全程不经内核。
- plugin 类型的第二跳由**浏览器**完成：`web/tasks.js:84-93` 读 CSRF 令牌后 `POST /api/v1/scheduler/tasks`，触发分支在 `web/tasks.js:373-378`；该端点要求登录会话 + `system:admin`（`internal/core/httpapi/handlers.go:99-102`，POST 创建在 `:100`；`handlers_scheduler.go:42-67`、`:75-91`）。
- 因此：**不存在「cron 写了一条要唤醒插件、到点却没人执行」的运行期断链**。任务卡描述的机制与代码不符，必须纠正后才能谈方案。

### 1.3 真正的断链：承诺面

| 位置 | 承诺的内容 | 与实现的关系 |
| --- | --- | --- |
| `.agents/LOG/DECISIONS.md:15`（2026-11-21 采纳） | cron 只写宿主条目，「到点由宿主调 `kored invoke`，主壳零定时器」 | 该命令从未实现；记录未随 ADR-0019 修订 |
| `docs/SCENARIOS.md:74`、`:76` | cron 写 systemd timer / `/etc/cron.d/kore-*`，宿主到点唤醒插件；`kored invoke` **未实现** | 后半句属实；**前半句也错**——代码写的是用户 crontab（`crontab.go:79-105`），`/etc/cron.d` 需 root 且已被 ADR-0019:26 否决为主路径 |
| `docs/RESOURCE-MODEL.md:245` | 「CLI / 宿主调度器（未实现）」列在「三种触发源」里 | 属实，但并列写法让人以为只是待补 |
| `docs/PLUGIN-CATALOG.md:79`、`docs/ARCHITECTURE.md:118` | cron 只写宿主条目，宿主到点唤醒所需的 CLI 未实现 | 同 SCENARIOS:74 的第二处错误 |

这是 **G-06（文档同步）/ G-23（判断留痕）** 层面的缺陷，不是运行期 bug。

### 1.4 真实的能力缺口（要补的话补的是什么）

内核目前只有两个插件调用入口，**都要求交互式会话**：

1. HTTP：`POST /api/v1/invoke/{plugin}/{method}`，`authorizeInvoke` 先验会话再按 `method_capabilities` 校验（`internal/core/httpapi/invoke_capability.go:107-116`）；
2. 内核 scheduler：到点 `s.invoker.Invoke`（`internal/core/scheduler/run.go:39-54`，调用点 `:53`），创建任务需会话 + `system:admin`（见 §1.2 引用）。

于是**外部无人值守调用（host timer / 其它守护进程 / CI）无路可走**。ADR-0019 把「外部触发器（用户 cron 调 HTTP）」列为**可选增强**而非主路径（`0019-scheduler.md:42-44`），但没有回答「无人值守时凭据从哪来」——这才是本 ADR 要裁的真问题。

## 2. 备选方案

| 编号 | 方案 | 关键设计点 |
| --- | --- | --- |
| **A1** | `kored invoke` 走 UDS，**文件权限即身份**（socket 0600 + `SO_PEERCRED` uid 判定） | 复用 `local_access.go:80-92` 的对端凭据，但把它当**认证**用 |
| **A2** | `kored invoke` 携带**会话签发的作用域凭据**（登录后签发 `invoke:<plugin>.<method>`，0600 落盘） | 凭据是登录的派生物，不是新身份源 |
| **B1** | 全部并入：cron 连 shell/http 也写 `scheduler_tasks`，由内核执行命令 | 需要内核新增「执行 shell」内置处理 |
| **B2** | 收敛口径：plugin 归 scheduler（已实现）；shell/http 保留宿主 crontab；**撤回**「宿主条目唤醒插件」承诺，显式声明无外部非交互入口 | 纯文档 + 记录修订 |

## 3. 六维打分

| 维度 | A1 | A2 | B1 | B2 |
| --- | --- | --- | --- | --- |
| 能否真正闭环 | 能（只闭合「外部触发」这一窄需求） | 能，且可撤销、可审计 | 能，但把任意命令执行搬进内核 | **能**——现有 scheduler 已闭合到点唤醒；撤回承诺消除文档谎言 |
| 安全影响 / 新增攻击面 | **大**：本机任意能连该 socket 的进程获得调用权；目标方法可能带 admin 副作用 | 中：多一套签发 / 撤销 / 作用域，漏配即长期有效 bearer | **大**：内核执行 shell = 任意代码执行入口 + 业务进薄壳 | 无新增 |
| 与 ADR-0043 一致 | **违反**（§1 鉴权行要求 UDS 一律会话；§2-C 明确否决「本机 UDS 免登录」） | 不违反字面，但需补「派生凭据」条款（见 §5） | 不涉及 | 一致 |
| 与既有设计一致（G-01 / ADR-0019 / ADR-0042） | 中性 | 中性 | **违反 G-01**（`run.go:44-51` 只允许内置方法与插件方法，塞 shell 就是业务） | **一致**：ADR-0019 已定 scheduler 为唯一周期源（`0019:48-53`、`:61`） |
| 实现代价 | 2–3 人日（子命令 + 服务端鉴权 + 审计 + 退出码 + 测试 + 安全评审） | 5–8 人日（+ 凭据存储 / 撤销 / UI / 文档） | 3–5 人日，且要重开 ADR-0019 | **0.5 人日**（6 处文档 + 1 条记录修订） |
| 对用户的影响 | 新增能力，但用户要理解「本机进程 = 可调用」 | 新增能力，多一步签发 | 用户失去 crontab 可见性；命令改由内核代跑，uid / cwd / env 全变 | shell/http 用户在宿主 crontab 里**照旧可见可编辑**；plugin 型任务本来就在 kore 任务页；失去的只是「外部无人值守触发」这一未实现能力 |

## 4. 决策：B2

理由：

1. **闭环已有替代**：ADR-0019 的内核 scheduler 是唯一周期源，plugin 型任务从 UI 一步到位（`web/tasks.js:373-378`）——功能上不缺。
2. **A 的收益窄**：真正缺的只是「kore 之外的程序想触发插件方法」；v1 非目标清单没有这条需求，也没有用户故事。
3. **A1 与 ADR-0043 正面冲突**，A2 的成本是 B2 的 10 倍以上，且引入长期凭据这一新资产类别。
4. **B1 违反薄壳红线**：内核执行 shell 会让 `internal/core` 拥有业务执行面；`run.go:44-51` 的分流结构就是为拒绝这类扩张而写的。

**B2 的具体动作（后续卡，本 ADR 不执行）**：

1. 改 `docs/SCENARIOS.md:74`、`:76`：删「systemd timer / `/etc/cron.d`」与「`kored invoke` 未实现」的表述，改为「cron 写**本插件用户** crontab；插件方法的定时唤醒一律走内核 scheduler；**没有**外部命令行唤醒入口，这是设计选择不是缺口」。
2. 改 `docs/RESOURCE-MODEL.md:245`：把「三种触发源，第三种未实现」改为「两种触发源」，删掉 CLI 条目。
3. 同口径修 `docs/PLUGIN-CATALOG.md:79`、`docs/ARCHITECTURE.md:118`、`docs/DATA-MODEL.md:30`、`docs/CORE.md:342`（后两处已写「未实现」，需补「且不再计划」）。
4. 在 `.agents/LOG/DECISIONS.md` **追加**一条（不改历史行）：注明 2026-11-21 那条「到点由宿主调 `kored invoke`」已被 ADR-0019 + 本 ADR 取代，被否决原因指向本 ADR §3。
5. `kore-plugin-cron/README.md` 补一句：plugin 型任务的第二跳由前端完成（`web/tasks.js:84-93`），非 UI 调用方需自行 POST。
6. 顺带（独立卡）：crontab 写入缺 ADR-0023 §3.5 类别 3 的 `changes.jsonl` 清单（`0023:110`，缺口登记 `:158`）。

**牺牲了什么（必须写清）**：

- **放弃「kore 之外无人值守触发插件方法」**。host timer、外部守护进程、CI 都不能调插件；只能用 kore 自己的 scheduler（可停 / 可查 / 可审计）或带会话的 HTTP。
- **放弃「宿主条目 100% 由 kore 管理」的叙事**：shell/http 条目仍在用户 crontab 里，kore 只管增删改，不接管执行环境；用户自己 `crontab -e` 的改动 kore 读得到但不管。
- **不解决 crontab 行钉死旧版本的问题**（见 §6 风险 1）。
- **不补 ADR-0023 的变更清单**（另开卡）。

## 5. 如果将来仍要选 A：本机免登录与 ADR-0043 的关系（明确回答）

**结论：A1 违反 ADR-0043，而且不是实现细节上的违反，是决策表里的正面冲突。**

- `0043:18` 鉴权行：`withAuth` 对全部 `/api/v1/*` 一律会话校验，「UDS / loopback **不再跳过**」；
- `0043:29-31`：选项 C「本机 UDS 保留免登录、只给浏览器加登录页」被**否决**，理由写着「留下第二套身份来源，能力解析与审计都会分叉」。

因此 A1 若落地，必须改 ADR-0043 本身（新 ADR 取代或 amendment），不能声称「兼容」。

「cron 无人值守不能要求会话」属实。合规解法只有 A2 一类：**把凭据做成登录的派生物**，而不是把本机通道升格成身份。落地时至少 6 条硬约束：

1. **只允许已声明方法**：目标方法必须在插件 `info.json.method_capabilities` 里显式声明（`kore-plugin-cron/info.json:11`），并**拒绝** `system:admin` 级方法（如 `cron.add` / `cron.run`）——委派凭据的能力上限**低于**会话，不等于会话。
2. **无 admin 能力继承**：凭据不解析成 `subject=admin`；能力解析走独立白名单（G-01：内核不维护业务词表，白名单只认 read 动作与显式 `(plugin, method)` 二元组）。
3. **审计 fail-closed**：写不进审计就**拒绝执行**（对齐 ADR-0018 提权审计口径），不是「记不上也放行」。
4. **通道防伪只做防伪**：socket `0600` + `SO_PEERCRED` uid 必须等于 kored 属主或 root（`internal/core/httpapi/local_access.go:80-92` 已有实现），但只用于**拒绝陌生对端**，不构成身份——身份来自凭据本身（`internal/core/httpapi/channel.go:46-60` 是这种多因子通道的先例）。
5. **参数与体积**：`--params` 只从文件或 stdin 读，≤64 KiB（对齐 `handlers_scheduler.go:17`），不引入 shell 解析。
6. **退出码语义**：复用 `cmd/kored/main.go:18-25` 码表；插件业务失败需要新码（建议 7 = 远端方法失败），不得把业务失败压成 0 或 2。

CSRF：CLI 走 UDS 时无浏览器可达性，`internal/core/httpapi/middleware.go:150-155` 已有 UDS 免 CSRF 的先例；但**认证不能跟着一起免**（同一段注释写明「只免 CSRF，不免认证」）。所以 A2 需要的是 `withAuth` 认 bearer（`channel.go` 的 root-action 分支是模板），不是 CSRF 豁免。

## 6. 风险与已知缺口

1. **crontab 行钉死绝对路径**：`wrapper.go:31-38` 写的是 `<state>/plugins/cron/<version>/...`（本地实存 0.2.0–0.4.1 多个版本目录）。升级后旧条目继续跑**旧版本**（静默）；旧版本目录当前无清理逻辑（`internal/core/installer/layout.go:66-105` 只处理同版本强制重装的暂存 / 删除）。属 B2 未覆盖的独立缺陷，建议单开卡。
2. **执行环境不透明**：shell / http 任务以**插件用户**身份执行（插件用户是 nologin 系统账户，`internal/core/supervisor/demote.go:51`、`internal/platform/linux_identity.go:22-23`），不是提交任务的用户；UI 未提示。
3. **`cron` 写 crontab 但不落 `changes.jsonl`**：ADR-0023 §3.5 类别 3 要求有清单（`0023:110`），`:158` 已把它登记为缺口 #3。
4. 未确认（只读复核无法判定）：以 nologin 系统账户执行 `crontab -` 是否会被宿主 PAM / `cron.allow` 拒绝——需真机（隔离实例 + 插件用户）验证。若被拒，shell / http 类型会返回 `E_NO_PERMISSION`（`kore-plugin-cron/internal/croncore/errors.go:8-9`），不会静默。

## 7. 复审条件

- 出现**真实需求**：外部守护进程 / systemd `OnFailure=` / CI 必须触发插件方法，且 kore scheduler 表达力不够（例如需要事件驱动而非时间驱动）。
- ADR-0043 被修订（本机通道重新定义为认证来源）→ §5 的前提变化，需重评。
- 内核 scheduler 被移除或降级（ADR-0019 失效）→ B2 的「已有替代」不成立。
