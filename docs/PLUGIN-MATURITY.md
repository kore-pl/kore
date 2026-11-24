> 状态: draft · 归属: architect · 更新: 2026-11-24 · 里程碑: M5

# PLUGIN-MATURITY — 插件与主壳成熟度分级 · 功能矩阵 · 改造优先级

## 0. 口径

| 项 | 内容 |
| --- | --- |
| 读者 | 产品评审、lead 拆解 Round 5、implementer 领活、red-team 找缺口 |
| 作用 | 回答"每个能力域现在是什么水平、离能用差哪些动作、先补哪个"，作为后续补全的唯一依据 |
| 不作用 | 不替代 [FEATURE-PARITY.md](./FEATURE-PARITY.md)（对标归属）、[PARITY-GAP.md](./PARITY-GAP.md)（差距账）、[PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md)（字段规格） |
| 盘点方法 | 逐仓读 `info.json` / `CHANGELOG.md` / `methods.go` / `internal/*/call.go`，再核对真实副作用（`os/exec`、真实文件读写、网络连接、非 `noopExecutor`）；**不采信 README / tag message / CHANGELOG 的级别自述**，以 **git HEAD** 为准、未提交工作树不计入 |
| 盘点基线 | 24 个 `kore-plugin-*` 仓、**完整方法面 253**（`§6` 实测：各仓 dispatch 白名单 / `businessVerb` / `verbRegistry` / `methodTable` 逐仓计数；不含 `config.get/set`，`waf.blockLog` 为别名不另计）、主壳 **22 导航项 / 20 懒加载视图模块**（两个指标，别混用）、**9 个仓有配置契约**、**23 个仓有方法级 `method_capabilities`**（`grep -l` 实测；`echo` 验证件不计）；`echo` 不参与 L 分级 |
| 竞品口径 | 宝塔面板 / 1Panel 专业版**公开功能**的常识描述；无法确认的项标"待核实"，不臆造 |
| 盘点范围 | 任务给定的 **24 个** `kore-plugin-*` 仓；`discover` 自 Round 2 起纳入，不留在表外 |
| 盘点时刻 | **2026-11-23 21:00 +08:00**。HEAD 实测版本（2026-11-24 复核）：`site` 0.4.3 / `file` 0.3.2 / `db-mysql` 0.4.1 / `db-postgres` 0.3.3 / `dns` 0.4.0 / `ssl` 0.6.0 / `redis` 0.6.0 / `container` 0.5.5 / `integrity` 0.4.0 / `logs` 0.5.1 / `cron` 0.7.0 / `firewall` 0.2.6 / `process` 0.3.0 / `ssh-guard` 0.3.1 / `waf` 0.4.4 / `runtime-node` 0.2.4 / `runtime-python` 0.3.1 / `runtime-php` 0.2.2 / `app-deploy` 0.3.1 / `backup` 0.5.1 / `monitor` 0.3.0 / `terminal` 0.2.1 / `discover` 0.3.1 / `echo` 0.1.4（HEAD 实测 `depth_level`：**23 个 `production` / 1 个 `basic`**；产品分级以 [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md) §6.1 的 **12 生产级 / 8 基础级** 为准，8 个仓待各自自然发版时回退 `basic`，见 [ADR-0045](./DECISIONS/0045-depth-level-convergence.md) 与 [`scripts/depth-level-pending.txt`](../scripts/depth-level-pending.txt)），按 **HEAD** 计；索引对齐与方法数都是滚动量，以 §6 命令实测为准 |
| 分级口径 | **唯一分级真源是 [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md) §6.1 的 12 生产级 / 8 基础级**；本文出现的 `depth_level` 指仓库 `info.json` 的**当前字面值**（盘点观测），不等于产品分级；两者偏差按 [ADR-0045](./DECISIONS/0045-depth-level-convergence.md) 随各仓自然发版收敛 |

**当前结论一句话**：23 个可分级仓里 **L0 0 / L1 0 / L1.5 2 / L2 21 / L3 0**（改前 L1.5 18 / L2 5）。本轮升级依据 = **代码事实 + G-28 双端截图**（`.agents/verify/screenshots/` 同名 desktop+mobile 成对）；**`app-deploy` 与 `discover` 因无截图压住不升**（后端已具备：`app-deploy` 0.3.0 upload/upgrade/jobs；`discover` 0.3.0 探测增强）。L2 = `site`/`file`/`db-mysql`/`cron`/`terminal`/`logs`/`process`/`ssl`/`backup`/`monitor`/`firewall`/`waf`/`dns`/`redis`/`db-postgres`/`runtime-node`/`runtime-php`/`runtime-python`/`container`/`integrity`/`ssh-guard`。**插件降权已落地**（#13）；**方法级 capability 23/24**（`echo` 验证件不计）；`depth_level` 仓库 `info.json` 当前 **23 `production` / 1 `basic`**（`ssh-guard` 已是 `basic`）；产品分级为 **12 生产级 / 8 基础级**（[PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md) §6.1），其余 8 个仓（7 个基础级产品仓 + `echo` 验证件）待各自自然发版时回退 `basic`，登记于 [`scripts/depth-level-pending.txt`](../scripts/depth-level-pending.txt)（[ADR-0045](./DECISIONS/0045-depth-level-convergence.md)）。索引对齐：22/24 已收录（待入索引 2 仓按发版滚动）。

### 0.1 文档声明 vs 代码事实（本轮重判）

| # | 文档原写 | 实际（HEAD 代码事实） | 证据（file:line / 命令） | 本次处置 |
| --- | --- | --- | --- | --- |
| 1 | `dns` **L0**「缺全部：引擎接入、规则集…」 | **L1.5（只读）**：status / zones / records / query 四方法，四引擎探测 + bind/dnsmasq 解析 + 查询三级回退 | `../kore-plugin-dns/internal/dnsop/call.go:35-68`、`query.go:23` | 重判 L1.5（只读，写路径为 0） |
| 2 | `waf` **L0**「缺全部」 | **L1.5（0.3.0 起为 L2 方向）**：10 业务方法（0.3.0 当时为 7 实方法 + `blockLog` 别名；0.4.2–0.4.4 补 `rule.add`/`rule.remove`/`rule.toggle`），nft 自有数据面 + ban/unban/bans + 12 条 root_actions | `../kore-plugin-waf/internal/wafop/call.go:53,69`、`CHANGELOG.md` 0.3.0、`info.json` | 重判 L1.5（缺前端页面，未到 L2） |
| 3 | `cron` L1.5「缺启停、立即执行、执行日志、任务类型」 | **L2**：0.4.0 共 **8 方法**，三类型 + 日志 + 立即执行 + **启停**全部落地，8 条方法级 capability | `croncore/tasktype.go:11`、`methods.go:131,142`、`info.json`、`81e84d8` | 重判 L2 |
| 4 | `backup` L1.5「缺定时、保留策略、下载、进度、维度」 | **L1.5，后端缺口全补**：0.4.0 共 **11 方法**，retention/stats + download（分块 base64）+ jobs（状态机 + stages 耗时）+ schedule.set/get（交内核 scheduler，零 ticker）+ `dimensions=["site","db"]` | `../kore-plugin-backup/CHANGELOG.md` 0.4.0、`internal/backupop/{call.go:37-39,retention,download,jobs,schedule}.go` | 后端改已补；**前端未接**（`web/backups.js` 无新方法调用） |
| 5 | §3.5 #12 写「只读方法也按 **admin 类**进审计」、声明「**3/24** 仓」 | **审计记录根本没有 capability 字段**：修复前只读也写一条 `invoke.*`（判定来源是插件级 admin），修复后 `needAdmin=false` 时**连记录都不写**（= 完全不落库）；已声明仓为 **17/24** | `internal/core/store/audit.go:36-44`（无 capability 字段）、`httpapi/audit_http.go:137`（审计门）、`httpapi/invoke_capability.go:165-177`（判定/回退）、`.agents/verify/r5-12-method-capability.md` §3/§4（18875 vs 18876 A/B） | #12 改部分补 + **措辞纠正为"只读完全不落库 vs 写调用落库"** |
| 6 | `ssl` L1.5（10 方法已列） | 与代码一致；expiring / renew.set / acme.status / acme.issue 均在 | `../kore-plugin-ssl/methods.go:139,150,161,171` | 维持 L1.5（ACME 仍骨架） |
| 7 | `process`「缺优先级」 | HEAD 0.2.1：protect + renice 已提交、tag 已推，**并补了 5 条方法级 capability**（list/detail/tree=`proc:read`，kill/renice=`proc:write`） | `../kore-plugin-process/CHANGELOG.md` 0.2.1、`methods.go:46` | 计入（索引待重签） |
| 8 | 主壳 **16 视图**（旧口径） | **21 导航项 / 19 懒加载视图模块**：导航项 = `NAV_GROUPS` 四组 ids（运维 5 + 业务 5 + 资源 4 + 平台 7，`dns` 已入平台组）；懒加载视图模块 = `make frontend` 的 19 个视图模块（`render: lazyView` 注册）。**两个指标不要混用** | `web/shell.js` NAV_GROUPS + `Makefile` 前端打包计数 | §3.3.1 重写为 21 导航项 |
| 9 | §3.5 #10「`runtime-php` / `runtime-python` 0.2.0 未入索引」 | 两仓已入索引（#10 结案）；索引对齐是滚动量，盘点时刻 14/24 | §6 版本比对命令（读 HEAD） | #10 改"已补" |
| 10 | §3.3.2「告警/通知中心 无」「长任务进度 伪」 | **均已落地**：铃铛 + 抽屉 + 3 端点 + 服务端埋点；SSE 真实阶段进度 | `httpapi/handlers_alerts.go:19`、`httpapi/sse.go`、`web/shell.js:395-449`、`ui-alerts-progress.md`（双端截图） | 两行改"已达标" |
| 11 | 配置契约 **6 个仓** | **9 个仓**：另含 `dns` / `ssh-guard` / `waf` | §6 `grep -rl '"config.get"'` | 口径更新 |
| 12 | R5-3 前提「`db-postgres` 有后端无前端」 | `web/db.js` 已做 MySQL / PostgreSQL 引擎切换（统一实例卡 / 库列表 / 查询台） | `web/db.js:73-79`、提交 `83adbbe`、`fix-emptystate.md` | R5-3 ①② 改"已落地" |
| 13 | 方法总数 **127** | **164**（命令口径；`site` 另计 16、`redis` 注册表另计 16 → 完整 196） | §6 复现命令 | §6 附录重算 |
| 14 | §3.5 #6「站点容器模式 `site_dir_exists` 只看宿主」 | **已补**：`site.status` / `site.get` 增 `site_dir_state`（present/absent/unknown）+ `site_dir_reason`；容器模式走 `docker exec <c> test -d`（固定 argv、20s 超时），"查不到"不再误报"不存在" | `../kore-plugin-site/sitedir.go:60`、`get.go:48`、`CHANGELOG.md` 0.3.0 | #6 改"已补" |
| 15 | §3.5 #11「提权只验证了拒绝路径」 | **已补**：真 root 成功路径跑通（`systemd-run --uid=0` transient unit → ufw，输出/退出码完整回传），修掉 `--pipe` 与 file: 冲突导致的输出恒空缺陷；幂等/回滚/两阶段审计均有原文证据 | `.agents/verify/r5-1-privilege-success.md` §0/§2/§5 | #11 改"已补"；未证项见 #13 与 §5 注 |
| 16 | （无）回退样本选型 | `logs` 虽无方法级声明，但插件级只声明 `system:read`，**回退后同样不审计**；拿它当"回退仍审计"的反例会得出错误结论 | `r5-12-method-capability.md` §3.3 | 写成 §5 教训注 |
| 17 | 主壳「**20 视图**」（上一版盘点） | **21 导航项 / 19 懒加载视图模块**：导航项按 `NAV_GROUPS` 四组 ids 计（平台组已含 `dns`），懒加载模块按 `make frontend` 计；两个指标不可混用 | `web/shell.js` NAV_GROUPS；`Makefile` 打包计数 | §3.3.1 与矩阵行 8 重写 |
| 18 | §3.5 #8「插件凭据无法跨插件传递 = 仍在」 | **已补（一期）**：ADR-0026 方案 A 落地（credential 包 + 5 端点 + env 注入 + 审计 fail-closed），db-mysql 0.4.1 / db-postgres 0.3.3 已采用 | `internal/core/credential/`、`internal/core/httpapi/handlers_credentials.go` | #8 改「已补（一期）」并写剩余挂账 |
| 19 | §3.5 #12「方法级 capability 17/24」 | **23/24**（firewall 0.2.6 补全量 7 条；echo 验证件不计） | `grep -l method_capabilities ../kore-plugin-*/info.json` 实测 23 | #12 收口 |
| 20 | 主壳「21 导航项 / 19 懒加载模块」 | **22 导航项 / 20 懒加载模块**：`ssh-guard` 视图入导航（`a35097c`）后两组各 +1 | `web/shell.js` NAV_GROUPS / `Makefile` 打包计数 | §3.3.1 与矩阵行 8 改 22/20 |
| 21 | 方法总数「220」（旧口径 184+20+16） | **253 业务方法**（白名单口径：dispatch `case` / `businessVerb` / `verbRegistry` / `methodTable`；不含 `config.get/set`，`waf.blockLog` 为别名不另计）；旧「252 = 213+20+19」少计 `integrity.schedule.set/get` 2 条、把 `blockLog` 当独立方法 1 条 | §6 命令实测（§6 表逐行重建） | 基线/§6 标题同步为 253 |
| 22 | L 分布「L1.5 18 / L2 5」 | **L1.5 2 / L2 21**（app-deploy / discover 因无 G-28 双端截图压住不升） | `.agents/verify/screenshots/` 同名 desktop+mobile 成对 + file:line | §2 矩阵 23 仓重定级 |
| 23 | `waf`「8 方法 / 缺规则增删」（§2 行） | **10 业务方法**（另 `blockLog` 是 `logs` 别名 = 11 受理名）：0.4.2–0.4.4 加 `rule.add` / `rule.remove` / `rule.toggle`；12 条 capability；前端 `web/waf.js` 已接 | `../kore-plugin-waf/internal/wafop/call.go:70-74`、`fe813a6`、`info.json` | §2 行改 10（+别名） |
| 24 | `app-deploy`「4 方法 / 缺升级」 | **8 业务方法**：0.3.0 `upload` / `deployFromArtifact` / `upgrade` / `jobs`；建库与写 vhost/reload 按 G-13 **刻意不做**（只回 `site_hint`/`databases` 提示） | `../kore-plugin-app-deploy/internal/apop/call.go:49-63`、`CHANGELOG.md` 0.3.0 | §2 行改 8 |
| 25 | `container`「缺 exec/shell」 | **13 业务方法；`exec` 已实现**（0.5.0 一次性命令：固定 argv + 拒绝清单 + 非 root 默认）；**刻意不做 = `shell` / `attach`**（`deniedMethods`），不是「未实现」 | `../kore-plugin-container/internal/containerop/methodset.go:12-30`、`exec.go:110`、`call.go:43-56` | §2 行改「exec 已实现 / shell·attach 刻意不做」 |
| 26 | `file`「0.3.1 进行中」 | **23 业务方法；v0.3.1 与 v0.3.2 tag 均已发**（0.3.1 断点续传 `uploadChunk`/`uploadStatus`，0.3.2 按字节在线编辑 `readRange`/`writeRange`） | `../kore-plugin-file/CHANGELOG.md`、`internal/fileop/call.go:21-65` | §2 行版本改 0.3.2 / 方法面改 23 |

## 1. 成熟度分级定义（3.1）

| 级别 | 定义 | 判据 | 判定方法 |
| --- | --- | --- | --- |
| **L0 骨架** | 只有参数校验与占位返回 | 无真实副作用 | 执行器是 `noopExecutor` / `placeholderExecutor` / 返回 `applied:false` / 摘要由路径字符串算出 |
| **L1 能干活** | 核心动作有真实副作用 | 至少 1 个方法真操作系统/文件/网络 | 有 `os.WriteFile` / `exec.Command` / PTY / 真实证书落盘 |
| **L1.5 接线完成（L1 子档）** | 真实后端已接通、核心读写可用，但日常动作覆盖 <80% | 有真实 exec/文件/网络；有配置契约更佳 | 方法数 + 竞品日常动作命中率 + 无 noop；单列排期，不计入 L2 |
| **L2 可用** | 覆盖该能力域日常操作 + 错误可理解 | 该域 80% 日常动作可用；错误给人话；有双端页面 | 逐条数日常动作命中率 + 读视图错误文案 + 认 `.agents/verify/` 双端证据 |
| **L3 完整** | 对标竞品同类功能，含进阶与管理能力 | 竞品该域核心能力项 ≥90% 覆盖；有引导/预设/批量 | 按 §2 竞品列逐项打勾 |

**判级纪律**：级别只认代码事实（`file:line`）；"能编译 + 单测绿"不进任何一级的判据；L2 的"双端页面"指 PC 与手机各一张实拍图，接口 200 不算。只读域（`monitor` / `logs` / `dns`）读侧接线完成即记 L1.5，但须在级别列注明"只读"。未提交的工作树改动**不计入**任何一级。

## 2. 功能矩阵（3.2，24 个插件仓）

**depth_level（本轮升 8 仓）**：`container` 0.4.1 / `db-postgres` 0.3.1 / `dns` 0.3.1 / `integrity` 0.3.2 / `runtime-node` 0.2.3 / `runtime-python` 0.2.3 / `ssh-guard` 0.2.3 / `waf` 0.3.1 从 `basic` 升 **`production`**；`echo` 0.1.4 为**最后一个**升 production 的仓（`basic` 已清零），`file` 0.3.1 同批。G-20 判据：`tests/fault/` + dist 可复现——本盘点只实测 `info.json` 版本与方法面，**fault 测试未复跑**（各仓证据以仓库内 `tests/fault/` 与 CHANGELOG 为准，不在此文冒充已证）。方法总数见 §6 实测（**253** 业务方法，口径见 §6 标题）。（**2026-11-24 口径更正**：以上是当时盘点动作的记录；按 [ADR-0045](./DECISIONS/0045-depth-level-convergence.md) 用户裁决，分级以 [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md) §6.1 的 12/8 为准。HEAD 实测 `ssh-guard` 已为 `basic`，其余 7 个基础级产品仓与 `echo` 验证件仍为 `production`，待各自自然发版时回退——「`basic` 已清零」不再成立；清单见 [`scripts/depth-level-pending.txt`](../scripts/depth-level-pending.txt)。）

| 能力域 | 插件（版本） | 现级别 | 现有方法（数量） | 已补（代码事实） | 仍缺（到 L2 / L3） |
| --- | --- | --- | --- | --- | --- |
| 站点（web） | `site` 0.4.3 | **L2+** | 20：list / create / delete / status / get / bindSSL / unbindSSL / setRewrite / getRewrite / setProxy / unsetProxy / setRedirect / unsetRedirect / disable / enable / setIndex / clone / setPassword / clearPassword / traffic（另 config.get/set） | 20 verb 注册 `siteverbs.go`（含 `traffic`）；vhost 原子写/test/reload；容器 nginx `docker exec`；**目录三态** `site_dir_state`（`sitedir.go:60`）；0.4.1 补 clone 与访问密码；方法级 capability 22 条（20 业务 + config 2） | ACME 与站点证书联动未做（`ssl` 侧有 `acme.*`，`site` 无联动方法）；**流量统计已补**（`traffic.go` 只读解析 nginx access_log） |
| 文件 | `file` 0.3.2 | **L2** | 23：list / read / write / delete / mkdir / stat / upload / uploadChunk / uploadStatus / readRange / writeRange / download / extract / compress / chmod / move / rename / copy / search / batch / trash.list / trash.restore / trash.purge | 0.3.0 rename/copy/search/批量/回收站；**0.3.1 断点续传**（`uploadChunk`/`uploadStatus`）、**0.3.2 在线编辑**（`readRange`/`writeRange`，按字节 + `expected_sha256` 乐观锁）；v0.3.1 / v0.3.2 tag 均已发 | 前端未接 search/trash/rename/copy/uploadChunk（`web/files.js` 仅见 `readRange`） |
| MySQL | `db-mysql` 0.4.1 | **L2** | 13：instances / databases / query / status / createDatabase / dropDatabase / createUser / changePassword / dropUser / grant / export / import / slowlog（另 config.get/set） | 建库/删库/用户/授权/导入导出 `internal/mysqlop/call.go`；0.3.2 补慢查询分析 `slowlog`；方法级 capability 同步；双端页面 `web/db-l2.js` | **改密已补**（`changePassword`，`call.go:41`；`client_admin.go:146` 说的「需单独方法」即指它）；多实例切换已有（`web/db.js` 的 selected 实例）；L3 项本轮未逐项复核 |
| 计划任务 | `cron` 0.7.0 | **L2** | 10：list / add / remove / replace / logs / run / enable / disable / templates / batch | 三类型 `croncore/tasktype.go:11`；日志 `methods.go:131`；立即执行 `:142`；启停 `81e84d8`（`#KORE-DISABLED#` 幂等标记、run 拒停用）；`templates`/`batch` 0.5.0 落地；10 条 capability | **启停前端已接**（`web/tasks.js` 有 `cron.enable`/`cron.disable`）；方法面 10/10，原「缺批量/模板」已不成立（`batch`/`templates` 均在） |
| 终端 | `terminal` 0.2.1 | **L2** | 9：create / write / resize / read / close / list / attach / history / history.clear | PTY `pty_linux.go:41`；0.2.0 补历史落盘（0600 原子写）、**重连游标**（`attach` + `read.cursor` + replay 窗口）、会话绑定 `client_id`、9 条 capability | 前端已接 history/attach（`web/terminal.js`）；缺多标签、字号/全屏（纯前端范围） |
| 日志 | `logs` 0.5.1 | **L2** | 13：sources / tail / search / stats / download / follow / rotate / aggregate / retention.get / retention.set / usage / clean / clean.restore（另 config.get/set） | 真实文件与 `journalctl` 读取；`download` 导出 0600 原子落盘；0.4.0 补 `follow` 实时跟踪与 `rotate` 切割 | **清理与聚合已补**（`clean`/`clean.restore`、`aggregate`、`retention.*`、`usage`，`methods.go:151-196`）；L3 项本轮未逐项复核 |
| 进程 | `process` 0.3.0 | **L2** | 9：list / detail / kill / tree / renice / ports / history / trend / watchdog.suggest | procfs 真实读；保护名单 + `renice`（`internal/procfs/protect.go`）；0.3.0 补 `ports`/`history`/`trend`/`watchdog.suggest`（`runtime.go:105-111`）；9 条 capability（kill/renice=`proc:write`） | **端口/fd 归属（`ports`）、资源趋势（`history`/`trend`）、守护自启建议（`watchdog.suggest`）均已补**（0.3.0）；方法面 9/9 |
| SSL 证书 | `ssl` 0.6.0 | **L2** | 20：list / import / selfsign / renew / verify / issue / expiring / renew.set / acme.status / acme.issue / acme.builtin.issue / acme.builtin.renew / acme.builtin.status / acme.auto / bind.set / bind.remove / bind.list / https.status / https.enforce / https.unenforce | 证书落盘/x509/TLS；`expiring`、`renew.set`、ACME 探测（ADR-0020）；0.4.0 补站点归属登记 `bind.*` 与 `https.status`；0.6.0 补 `acme.builtin.*` / `acme.auto` / `https.enforce` / `https.unenforce`；20 条 capability | **强制 HTTPS 下发已补**（`https.enforce`/`https.unenforce`）；ACME 仍骨架（本机无客户端，真机签发未验证）；`https.enforce`/`https.unenforce` 前端已接（`web/ssl.js:360`）；自动续期靠 `renew.set` + 内核调度 |
| 备份 | `backup` 0.5.1 | **L2** | 11：create / list / restore / delete / verify / retention / stats / download / jobs / schedule.set / schedule.get（另 config.get/set） | tar.gz 真实打包/原子恢复；retention+stats（`backupop/call.go:37-39`）；0.4.0 补 download/jobs/schedule/dimensions | **前端已接** download/jobs/维度（`web/backups.js:327,348,379`）；异地存储按 G-11 不做 |
| 监控 | `monitor` 0.3.0 | **L2** | 4：system / processes / disks / temperature | 真实 `/proc` 采集（`internal/monitor/collector.go:80-114`，零 ticker）；0.3.0 结果体新增 `history`（60 点环形缓冲、0600 落盘）与 `alerts[]` 阈值；4 条 capability | **前端已接 history/alerts**（`web/monitor.js:19,434`）；**进程 TOP 排序已补**（`collector_process.go:156` 按 cpu/mem 降序）；跨平台真实实现仍缺（非 Linux 回 E_UNSUPPORTED） |
| 防火墙 | `firewall` 0.2.6 | **L2** | 7：status / rules / allowPort / denyPort / deleteRule / enable / disable | 真实 ufw/iptables `fwop/call.go:19-27`；root 通道 `runtime.go:72`；非 root `E_NEED_ROOT`(403)+hint；真 root 成功路径已实测（r5-1） | **enable/disable 已补**（`call.go:29-31`）；仍缺 IP 黑白名单、防爆破、变更审计（方法面无对应入口） |
| WAF | `waf` 0.4.4 | **L2** | 10 业务方法（另 `blockLog` 是 `logs` 兼容别名，合计 11 个受理名）：status / rules / logs / toggle / ban / bans / unban / rule.add / rule.remove / rule.toggle | nft 自有 `table inet kore_waf`（banned4/6 + 4 条基础防护）；ban/unban/bans 幂等并回读；12 条 nft root_actions（删除危险 sed 入口，ADR-0022）；12 条 capability（10 业务 + config 2） | **规则增删已补**（`rule.add`/`rule.remove`/`rule.toggle`，`call.go:70-74`，0.4.2–0.4.4）；前端已接（`web/waf.js` 被 `shell.js` 引用）；引擎安装/部署仍缺（无方法） |
| DNS | `dns` 0.4.0 | **L2** | 11：status / zones / records / query / record.add / record.update / record.delete / addRecord / updateRecord / deleteRecord / reload（另 config.get/set） | 四引擎探测、区域/记录、真实查询；0.4.0 补 **写路径** `addRecord` / `updateRecord` / `deleteRecord` / `reload`（root-action 通道，`dnsop/call.go`） | 写路径 6 入口 + `reload` 已齐（`call.go:79-121`）；L3 项本轮未逐项复核（原「仍需 ssh 无关」不是缺口描述） |
| Redis | `redis` 0.6.0 | **L2** | 19：instances / info / keys / get / delete / keyInfo / memory / persistence / slowlog / set / ttl / expire / persist / bgsave / rename / move / copy / serverConfig.get / serverConfig.set（另 config.get/set） | 真实 RESP；0.5.0 起方法面改为**注册表** `methodTable`（14 动词）+ `dottedMethods`（2），并拒 `flushall`/`eval`/`shutdown` 等危险命令；`tests` 对 info.json 做双向断言 | **键重命名/迁移/复制已补**（`rename`/`move`/`copy`，0.6.0）；仍缺集群模式 |
| PostgreSQL | `db-postgres` 0.3.3 | **L2** | 11：instances / databases / query / status / slowlog / createDatabase / dropDatabase / createUser / dropUser / grant / changePassword（另 config.get/set） | `psql` / `docker exec` 两级回退；0.3.0 补建库/删库/用户/授权/改密；只读 SQL 白名单；空态 hint | **慢查询（`slowlog`）与方法级 capability（13 条 = 11 业务 + config 2）均已补**；仍缺备份恢复（无对应方法） |
| Node 运行时 | `runtime-node` 0.2.4 | **L2** | 5：versions / info / projects / doctor / paths | 真实 `exec` 探测 `nodeop/runtime.go:63`；0.2.1 补 `paths` 与 versions 元信息、5 条方法级 capability；前端 `web/runtimes.js` | 缺切版本、进程守护、扩展管理 |
| PHP 运行时 | `runtime-php` 0.2.2 | **L2** | 5：versions / info / projects / doctor / paths | 真实 `exec` 探测 `phpop/runtime.go:83`；0.2.1 补 `paths`；`php -i` / ini / 扩展；前端 `web/runtimes.js` | 缺切 FPM 版本、扩展安装、进程守护 |
| Python 运行时 | `runtime-python` 0.3.1 | **L2** | 9：versions / info / projects / doctor / paths / venv.create / venv.list / pip.install / pip.list | 真实 `exec` 探测 `pyop/runtime.go:90`；pip/site-packages/包数；前端 `web/runtimes.js` | **建 venv 与依赖安装已补**（`venv.create`/`venv.list`/`pip.install`/`pip.list`）；仍缺进程守护 |
| 容器 | `container` 0.5.5 | **L2** | 13：list / inspect / logs / start / stop / restart / stats / images / pull / rmi / update / health / exec | 真实 docker CLI（`containerop/call.go:48-52`）；0.4.0 补镜像面与 update/health；**0.5.0 补 `exec`**（一次性命令：固定 argv、拒绝清单、非 root 默认、root 需 confirm）；13 条 capability | **`exec` 已实现**（一次性命令，不是缺口）；**刻意不做**：`shell`/`attach`（`methodset.go:26` 的 `deniedMethods`，交互式通道归 terminal 插件）；容器编排按 G-11 不做；前端 `web/container.js` 已提交（`c901e28`），不再「untracked 待验收」；**前端已接 8 方法**（list / logs / stats / inspect / start / stop / restart / exec，后三个经 `act()` 动态拼接）；`images`/`pull`/`rmi`/`update`/`health` **后端有实现、前端未接**（R15 已派镜像管理接线卡，落地后同步） |
| 一键部署 | `app-deploy` 0.3.1 | **L1.5** | 8：templates / deploy / deployFromArtifact / list / remove / upload / upgrade / jobs | 4 模板经 docker 真部署 `apop/call.go:49-51`；端口冲突顺延、内存限额、失败回滚 | **上传/升级/作业已补**（0.3.0 `upload`/`deployFromArtifact`/`upgrade`/`jobs`）；**按 G-13 刻意不做**：建库、写 vhost/reload（`deployFromArtifact` 只回 `site_hint`/`databases` 提示）；前端已接（`web/appdeploy.js`） |
| 完整性 | `integrity` 0.4.0 | **L2** | 8：baseline / baseline.list / check / restore / status / verify_file / schedule.set / schedule.get | 真实 sha256 基线（`integrity/methods.go:114-116`、`scan.go:218`）；0.3.0 补 `baseline.list` 多版本留存与方法级 capability；基线 0600 原子写；前端 `web/integrity.js` | **定时扫描/变更告警/恢复已补**（0.4.0 `schedule.set`/`schedule.get` + `restore`）；`verify_file` 无法声明方法级 capability（下划线命名约束，`methods.go:57`）；L3 项本轮未逐项复核 |
| SSH 加固 | `ssh-guard` 0.3.1 | **L2** | 7：status / attempts / bans / ban.list / ban.add / ban.remove / suggest（另 config.get/set） | 日志解析 + 防护源检测 `methods.go:50-60`；0.2.1 `status` 经 root-action 通道读防护源（`rootaction_client.go`）；3 个 root_actions | `suggest` 已补（0.3.0）；`sshd_config` 写路径依赖 ADR-0028（未实施，挂 v1.1）；`ban.add`/`ban.remove` 仍走 root-action |
| 服务发现 | `discover` 0.3.1 | **L1.5** | 3：services / ports / summary | 真实命令探测 + `/proc/net` 端口反查；服务端版本 `probe/server_version.go:29`（探不到降级 client/unknown） | 缺其他服务指纹、安装动作；凭据跨插件受阻（§5 #8） |
| 验证件 | `echo` 0.1.4 | 不参与分级 | 5：ping / echo / slow / timeout / crash | 协议回环、超时、崩溃重启验证 | 非产品能力域，不适用 |

索引仓 `kore-plugins` 仍为 **L2**（24 条索引 / 8 个场景预设 / 3 个校验脚本 / ed25519 签名链）；主壳见 §3.3。

## 3. 主壳（前端）成熟度（3.3）

### 3.3.1 四组导航 · 22 导航项（20 懒加载视图模块）

| 导航组 | 视图（id） | 数量 |
| --- | --- | --- |
| 运维 | dashboard / monitor / logs / process / terminal | 5 |
| 业务 | sites / db / redis / tasks / runtimes | 5 |
| 资源 | files / backup / ssl / container | 4 |
| 平台 | store / plugins / integrity / firewall / settings | 5 |
| **合计** | **19**（`shell.js:58-61` 四组 ids；`SHELL_ROUTES` 8 个 + `lazyView` 11 个） | **19** |

**容器视图**：`web/container.js`（KoreContainer，25 KB）当前实际消费 `container.list/logs/stats/inspect/start/stop/restart/exec` 共 8 方法（后三个经 `act()` 动态拼接）；`images/pull/rmi/update/health` 后端有实现、**前端未接**（R15 镜像管理接线中，落地后同步）；`web/shell.js` 已有 `container` 图标 + 资源组 id + `lazyView` 注册（三处齐备，计入第 19 个视图）。`web/container.js` 已在 `c901e28` 提交（本权衡卡仍以「**已落地待验收**」计：`web/shell.js` 尚有工作树在途改动，构建 + 双端截图验收另见验收报告）。

**上一版的 16 是漏计**：`runtimes`（业务组）与 `integrity`（平台组）自 `d6f517c` 起已在导航与 `lazyView` 注册，旧表未列入——真实基线是 **18**（不是 16），加上容器视图为 **19**（不是 17）。

**Round 4/5 已落地**：① **全局搜索**（`web/search.js` 四源：页面 / 已装插件 / 商店 / 操作；`shell.js:316-363` 入口，Ctrl/Cmd+K、手机 44px；懒加载不进首屏）；② **操作审计入口**（设置页 tab，`web/audit.js` + `GET /api/v1/audit`）；③ **告警中心**（顶栏铃铛 + 抽屉，`web/alerts.js` + `handlers_alerts.go:19` 的 3 个 `/api/v1/alerts` 端点 + 5 类服务端埋点；双端截图 `alerts-*.png`）；④ **长任务真实进度**（`httpapi/sse.go` 的 `task.progress` 流 + `store.js` 按 task_id 过滤）；⑤ 监控页接 monitor 插件 `/proc` 数据。审计与告警都是**设置页 tab / 顶栏抽屉，不新增视图**。

**更早轮次**：统一配置面板（`web/config-panel.js`，走 `<id>.config.get/set`）、数据库/Redis 自动检测与预填、建站向导自动填路径；双端证据：`.agents/verify/round2-full-evidence.md`（34 张）与 `l2-live.md`（15 张 L2 操作截图）。

### 3.3.2 面板级通用能力

| 能力 | 竞品有 | 我们有 | 现状证据 | 优先级 |
| --- | --- | --- | --- | --- |
| 全局搜索 | 有（站点/文件/功能） | **有**（四源） | `search.js` 四组结果 + `shell.js:316-363` 入口；商店/插件数据懒加载 | 已达标 |
| 告警 / 通知中心 | 有（铃铛 + 未读） | **有**（铃铛 + 红点 + 抽屉 + 服务端历史） | `web/alerts.js` + `handlers_alerts.go:19`（3 端点）+ `ui-alerts-progress.md` 双端截图；无 `setInterval` | 已达标 |
| 长任务进度 | 有（安装/备份/部署进度条） | **有**（SSE 真实阶段） | `httpapi/sse.go` + `store.js` 按 `task_id` 显示 download/verify/extract/register/reload | 已达标 |
| 操作审计入口 | 有（谁在何时做了什么） | **有**（设置页「操作审计」tab，按**最终生效能力**决定是否落库） | `web/audit.js` + `GET /api/v1/audit`；`audit_http.go:137`：`!auditInvokeAll && !needAdmin` 直接不写；审计记录无 capability 字段（`store/audit.go:36-44`） | 已达标 |
| 首次使用引导 | 有（新手任务/检查清单） | 无 | `grep -rn "onboard\|guide" web/*.js` 仅命中 firewall 提权指引 | P2 |
| 快捷键 | 有（搜索/保存/关闭） | 局部有 | 全局 Ctrl/Cmd+K；其余仅 `db.js` Ctrl+Enter、`files.js` Esc | P2 |
| 空状态 / 错误边界 / 配置面板 / 自动预填 | 有 | 有 | `app.js` 统一空状态、`shell.js` 三级兜底、`config-panel.js` 自动填入 | 已达标 |
| 主题（深色） | 有 | 无 | `web/*.css` 无 `prefers-color-scheme` / `data-theme` | P3 |
| 多语言 i18n | 有 | **仅中文 + 英文可选骨架** | G-11 收窄为不做全量框架（ADR-0021）；导航/通用/设置已迁移，页面内部文案待迁移 | 仅骨架 |

## 4. 改造优先级（3.4，Round 5 五批）

排序依据：**安全链路上游 × 承重能力 × 依赖关系**。批次内可并行，批次间按"前置"执行。

| 批次 | 任务（2–3 项） | 前置依赖 | 现状（代码事实） |
| --- | --- | --- | --- |
| **R5-1 提权成功路径** | ① 真 root 下跑通 firewall `root-action` 成功路径（读状态、改规则、审计留痕、幂等/回滚）② `waf` / `dns` 接真实后端并声明 `requires_root` + `root_actions` ③ 非 root 仍 `available=false` + 可操作 hint（不回 401） | 无 | **①②③ 已落地**：真 root 通道跑通并修掉 `--pipe` 输出丢失缺陷（`r5-1-privilege-success.md`）；`waf` 0.3.0 用 12 条 nft root_actions、`dns` 0.2.0 真实后端；非 root 403+hint 回归 PASS |
| **R5-2 方法级 capability 声明** | ① `info.json` 增加**方法级** capability ② 内核授权与审计按方法粒度取用（守 G-01）③ 只读方法不再进审计 + 回归测试 | R5-1（授权口径先稳定） | ①②③ **已落地并经 A/B 验证**（`r5-12-method-capability.md`：只读 0 条、写 +1、回退按插件级）；**23/24 已声明**（`echo` 验证件不计），无待补仓 |
| **R5-3 数据库前端** | ① `db-postgres` 前端 ② `db-mysql` / `db-postgres` 统一视图（引擎切换）③ 改密方法与二次确认 | R5-2（部分） | ①② **已落地**（`web/db.js:73-79`，提交 `83adbbe`）；③ **仍在**（`client_admin.go:146`） |
| **R5-4 备份 / 任务 / 证书闭环** | ① `backup` 定时 + 保留策略 + 下载 ② `cron` 任务类型 + 执行日志 + 立即执行 ③ `ssl` ACME 签发与自动续期（先出 ADR） | R5-1（调度与证书续期走 root 动作） | ① 后端 **已落地**（0.4.0，含下载/进度/维度），**前端未接**；② 后端 **全落地**（0.4.0 含启停），**前端未接**；③ 仍骨架（ADR-0020） |
| **R5-5 槽位保护** | ① `MaxSlots` 内 resident 单独限 2、lazy 独占至少 1 槽 ② 第 3 个 resident `enable` 明确错误 ③ `resident_slots_test.go` 增 2+1 用例 | 无 | ✅ **已落地**（§5 #9）；设计债曾造成 11 个 lazy 插件全 429 的 P1 事故（`CS-20261123-01`） |

**不做清单（G-11 复述，避免 Round 5 漂移）**：多用户 RBAC、集群/多机、模板市场、厂商云存储深度集成、拖拽建站、多语言全量框架（中文为主 + 英文可选骨架已落地，见 ADR-0021）；另不做容器编排、多租户 SaaS、移动 App、重型主题。

## 5. 缺口清单（3.5）

口径：Round 2/3 的 9 条 + Round 4 的 3 条 = **12 条**，本轮新增 **2 条**（#13 插件降权、#14 SDK 发布链）= **14 条**；§2 的"仍缺"列不重复计数。状态只有三种：`已补` / `部分补` / `仍在`。

| # | 缺口 | 状态 | 代码事实 / 证据 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | `discover` 报的是**客户端版本** | **已补** | `probe/server_version.go:29` 直连探测（MySQL `SELECT VERSION()` / PG `SHOW server_version` / Redis `INFO server` / nginx `-v`），`version_source=server`；探不到降级 client/unknown | 结案；凭据降级见 #8 |
| 2 | `db-mysql` 缺建库/删库/改密/备份/导入导出 | **已补（结案）** | 0.3.0 起建库/删库/用户/授权/导入导出；**0.4.0 补 `changePassword`**（改密）；0.4.1 起优先读内核凭据 env 并回 `credential_source`；`web/db-l2.js` 双端页面 | 0.4.1 方法面 13（含 changePassword + slowlog） |
| 3 | `backup` 缺定时备份/保留策略/异地存储 | **已补** | 0.4.0 11 方法：retention/stats + schedule.set/get（交内核 scheduler，零 ticker）+ download + jobs 进度 + dimensions；异地按 G-11 不做 | 结案；**前端接线另列** |
| 4 | `cron` 缺任务类型/执行日志/立即执行 | **已补** | 三类型 `croncore/tasktype.go:11`；日志 `methods.go:131`；立即执行 `:142`（`cron-l3.md` 隔离实例实测）；启停随后补于 0.4.0（`81e84d8`） | 结案 |
| 5 | `ssl` 缺 ACME 自动申请与续期 | **部分补（骨架）** | 0.4.0 共 14 方法：ACME 探测/显式调用（ADR-0020，本机无客户端故真机签发未验证）+ 新建 `bind.*` 站点归属与 `https.status`；续期前备份 | 结案骨架部分；强制 HTTPS 下发与真机签发待补验 |
| 6 | 站点容器模式 `site_dir_exists` 只看宿主路径 | **已补** | `sitedir.go:60` 容器内 `docker exec <c> test -d`（固定 argv、20s）；`get.go:48` 三态 `site_dir_state` + `site_dir_reason`，unknown 不误报 absent；保留旧布尔字段兼容 | 结案（site 0.3.0） |
| 7 | 主壳缺全局搜索/审计入口/告警中心/长任务进度 | **已补** | `web/search.js`；`web/audit.js` + `GET /api/v1/audit`；`web/alerts.js` + 3 端点 + 服务端埋点；`sse.go` + `store.js` 真实进度；证据 `round4-audit.md`、`ui-alerts-progress.md` | 结案 |
| 8 | 插件凭据无法跨插件传递 | **已补（一期，ADR-0026 方案 A）** | credential 包（0600/0700、`E_NEED_GRANT`、授权/删除审计 fail-closed）+ 5 端点 + supervisor env 注入；**`db-mysql` 0.4.1 / `db-postgres` 0.3.3 / `redis` 0.6.0 均已采用**（`credential_source`）；剩余挂账：凭据 UI 未截图、无轮换（方案 D 留 v1.1） | v1.0 硬缺口已关闭 |
| 9 | `resident` 占满槽位后 lazy 饿死 | **已补** | `resident_max=2` + lazy 保底 1 槽（`supervisor/{manager,lazy}.go`）；第 3 个 resident 返 `E_RATELIMIT`；`resident_slots_test.go` 覆盖 2+1 与 2+3；隔离实例 18851 实测。**诚实披露：显式 `resident_max=3` 会放弃保护** | 结案；候选 B/C 未采用（§2.6） |
| 10 | `runtime-php` / `runtime-python` 0.2.0 未入索引 | **已补** | 两仓 0.2.0 已入索引（本条结案）；索引对齐是滚动量（§6 实测：盘点时刻 14/24，10 个刚发版仓待重签） | 结案；余项归重签收口 |
| 11 | 提权只验证了拒绝路径 | **已补** | `r5-1-privilege-success.md`：真 root `systemd-run --uid=0` → ufw 全动作跑通、stdout/exit code 完整、幂等、回滚后 `ufw show added` 为空且 `iptables -S` 与基线 diff=0、两阶段 `root.action` 审计、非 root 403+hint 回归；并修掉 `--pipe`+file: 导致的输出恒空阻断缺陷 | 结案；**未证项**：ufw 活动状态下的数据面效果、插件降权组合（→#13） |
| 12 | 插件级 capability 让只读方法也进审计 | **已补（23/24）** | 只读调用不落库；方法级 `method_capabilities` 覆盖 **23/24**（`echo` 验证件不计）；`firewall` 0.2.6 全量、`dns` 0.4.0 写路径同步声明 | `grep -l method_capabilities ../kore-plugin-*/info.json` 实测 23 |
| 13 | **root 内核下插件未降权**（本轮新增） | **已补（阶段 C 数据根契约）** | `6ceeba8` 降权（`kore-<id>` + `SysProcAttr.Credential`）；**阶段 C** 新事实：插件数据根契约 `KORE_PLUGIN_DATA` / `KORE_INSTALL_DIR` 已注入（0700、属主 `kore-<id>`），ADR-0023 阶段 C 落地 `site` 0.4.3 / `ssl` 0.5.1 / `app-deploy` 0.2.2 三仓；`ssl` 证书仍留系统路径（web server 读取，属 ADR-0023 §3.5 豁免 #3） | 写域审计：插件只写 `KORE_PLUGIN_DATA` 下 |
| 14 | **SDK 发布链缺 root_actions schema**（本轮新增） | **已补** | `pkg/pluginapi/v0.1.2` tag 已发（`git show pkg/pluginapi/v0.1.2:pkg/pluginapi/rootaction.go` 存在），`root_actions` schema + 白名单随 tag 固化；插件侧 `ssh-guard` 已 bump 到 v0.1.2 并加 schema 自检 | 结案 |

**回退样本选型的教训**：验证「无方法级声明时按插件级判定」**不能拿 `logs` 当反例**——它插件级只声明 `system:read`，回退后同样不审计；必须选**插件级含 write/admin** 的仓（本轮 A/B 用的是 `process` 0.2.0 的 `proc:write`；HEAD 下同类样本可用 `db-postgres` / `runtime-php` 的 `system:admin`）。

**命名约束（写方法时的硬限制）**：内核 `methodActionPattern` = `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`（`internal/core/registry/validate.go:55`）——**不支持下划线**。所以 `integrity.verify_file` 无法写进 `method_capabilities`（integrity 0.3.0 的声明里只有 baseline / baseline.list / check / status / schedule.*），这类方法只能回退插件级能力。**新方法名一律用 camelCase**（如 `verifyFile`），否则永远拿不到方法级审计收益。

汇总：**14 条 = 已补 13（#1 #2 #3 #4 #6 #7 #8 #9 #10 #11 #12 #13 #14）/ 部分补 1（#5：下划线命名约束，已文档化）/ 仍在 0**；v1.0 前**无硬缺口**（#8 一期已补，剩余挂账：`redis` 未采用 / 凭据 UI 未截图 / 无轮换=方案 D 留 v1.1）；索引对齐 22/24，待入索引 2 仓。

## 6. 附录：24 仓方法清单（**253 业务方法**；口径 = 各仓 dispatch 白名单 / `businessVerb` / `verbRegistry` / `methodTable`，**不采信 README / CHANGELOG 的自述方法表**；`config.get/set` 另计 9 仓，`waf.blockLog` 是别名不另计）

| 仓库 | 方法数 | 方法名 | 一句话职责 |
| --- | --- | --- | --- |
| `app-deploy` | 8 | deploy / deployFromArtifact / jobs / list / remove / templates / upgrade / upload | 内置 4 模板经 docker 真部署、记录、回滚；0.3.0 起用户应用包 `upload` / `upgrade` + `jobs` 作业 |
| `backup` | 11 | create / delete / download / jobs / list / restore / retention / schedule.get / schedule.set / stats / verify | 真实 tar.gz 打包/恢复/校验；保留策略、下载、作业进度、定时任务描述、站点/库维度 |
| `container` | 13 | exec / health / images / inspect / list / logs / pull / restart / rmi / start / stats / stop / update | 真实 docker CLI 列表、详情、日志、生命周期、统计；镜像拉取/删除、更新与健康检查；**`exec` 0.5.0 已实现**（一次性命令），`shell` / `attach` 属**刻意不做**（`deniedMethods`，交互式归 terminal） |
| `cron` | 10 | add / batch / disable / enable / list / logs / remove / replace / run / templates | crontab 读写 + 三类任务 + 执行日志 + 立即执行 + 启停 |
| `db-mysql` | 13 | changePassword / createDatabase / createUser / databases / dropDatabase / dropUser / export / grant / import / instances / query / slowlog / status | 真实 mysql CLI：只读查询 + 建库/删库/用户/授权/导入导出 + 改密（`changePassword`）与慢查询（`slowlog`） |
| `db-postgres` | 11（另 config.get/set） | changePassword / createDatabase / createUser / databases / dropDatabase / dropUser / grant / instances / query / slowlog / status | psql/docker exec 真连接；建库/删库/用户/授权/改密；只读 SQL 白名单 |
| `discover` | 3 | ports / services / summary | 本机服务、监听端口、安装建议；服务端版本可探 |
| `dns` | 11（另 config.get/set） | addRecord / deleteRecord / query / record.add / record.delete / records / record.update / reload / status / updateRecord / zones | 四引擎探测、区域与记录解析、真实查询；0.4.0 起含记录写路径（`record.*` / `reload`） |
| `echo` | 5 | crash / echo / ping / slow / timeout | 验证件：协议回环、超时、崩溃重启计数 |
| `file` | 23 | batch / chmod / compress / copy / delete / download / extract / list / mkdir / move / read / readRange / rename / search / stat / trash.list / trash.purge / trash.restore / upload / uploadChunk / uploadStatus / write / writeRange | 配置根内真实文件操作；回收站、批量、搜索；19 条方法级 capability |
| `firewall` | 7 | allowPort / deleteRule / denyPort / disable / enable / rules / status | 真实 ufw/iptables 状态、规则、放行/拒绝/删除；root 走内核通道 |
| `integrity` | 8 | baseline / baseline.list / check / restore / status / verify_file / schedule.set / schedule.get | 真实 sha256 基线、比对、单文件校验；基线多版本列表；基线 0600 原子写 |
| `logs` | 13（另 config.get/set） | aggregate / clean / clean.restore / download / follow / retention.get / retention.set / rotate / search / sources / stats / tail / usage | 白名单日志源、尾读、搜索、统计、导出、实时跟踪、切割、清理、聚合、保留策略 |
| `monitor` | 4 | disks / processes / system / temperature | 真实 `/proc` 采集；结果体含 history 环形缓冲与 alerts 阈值，零 ticker |
| `process` | 9 | detail / history / kill / list / ports / renice / tree / trend / watchdog.suggest | 真实 procfs + 保护名单；kill/renice 为 `proc:write` |
| `redis` | 19（另 config.get/set） | bgsave / copy / delete / expire / get / info / instances / keyInfo / keys / memory / move / persist / persistence / rename / serverConfig.get / serverConfig.set / set / slowlog / ttl | 注册表 `methodTable`（17 动词）+ 点分方法（2）；真实 RESP；危险命令拒绝表 |
| `runtime-node` | 5 | doctor / info / paths / projects / versions | 真实探测 Node 版本、详情、项目扫描、健康检查、路径元信息 |
| `runtime-php` | 5 | doctor / info / paths / projects / versions | 真实检测 PHP CLI、ini/扩展、项目、健康检查、路径元信息 |
| `runtime-python` | 9 | doctor / info / paths / pip.install / pip.list / projects / venv.create / venv.list / versions | 真实检测 Python、pip/site-packages、项目、健康检查；0.3.0 起建 venv 与 pip 安装 |
| `site` | 20（另 config.get/set） | bindSSL / clearPassword / clone / create / delete / disable / enable / get / getRewrite / list / setIndex / setPassword / setProxy / setRedirect / setRewrite / status / traffic / unbindSSL / unsetProxy / unsetRedirect | 真实写 nginx vhost + test/reload，含容器 nginx；目录三态 |
| `ssh-guard` | 7（另 config.get/set） | attempts / ban.add / ban.list / ban.remove / bans / status / suggest | 日志解析 + 防护源检测 + 封禁清单；`ban.add`/`ban.remove` 经 root-action 通道执行（`methods.go:63`），`suggest` 只出建议态 |
| `ssl` | 20 | acme.auto / acme.builtin.issue / acme.builtin.renew / acme.builtin.status / acme.issue / acme.status / bind.list / bind.remove / bind.set / expiring / https.enforce / https.status / https.unenforce / import / issue / list / renew / renew.set / selfsign / verify | 证书落盘与 x509/TLS；到期聚合、续期任务、ACME 探测/显式调用；站点归属登记与 HTTPS 状态 |
| `terminal` | 9 | attach / close / create / history / history.clear / list / read / resize / write | 真实 PTY；历史落盘、重连游标（attach + read.cursor） |
| `waf` | 10（+`blockLog` 别名） | ban / bans / blockLog / logs / rule.add / rule.remove / rules / rule.toggle / status / toggle / unban | nft 数据面 + 封禁集合 + 模式切换 + 规则增删；12 条 capability（10 业务 + config 2） |

**证据复现命令**（任何人可重跑核对；一律读 HEAD，避免并发工作树干扰）：

```bash
cd /home/pt/Work/GolandProjects/kore
# 方法数口径：业务方法 = 各仓 dispatch 白名单（businessVerb / verbRegistry / methodTable / case）− config.* − kore.*
# 交叉校验（caps 口径）：业务方法 = method_capabilities 条数 − config.* 条数
#   两处例外：integrity.verify_file 因下划线命名不可声明（+1）；echo 为验证件、无任何声明（+5）
for d in ../kore-plugin-*; do git -C $d show HEAD:info.json | python3 -c '
import json,sys
d=json.load(sys.stdin)
caps=[c for c in d.get("method_capabilities",{}) if not c.endswith((".config.get",".config.set"))]
print("%-16s caps_business=%d" % (d["id"], len(caps)))'; done
# 期望：247（= 253 − echo 5 − integrity.verify_file 1）；逐仓与 §2/§6 表核对
git -C ../kore-plugin-site show HEAD:siteverbs.go | grep -cE '^[[:space:]]+"[a-zA-Z]+":'   # 期望 20
git -C ../kore-plugin-redis show HEAD:internal/redisop/call.go | sed -n '/var methodTable/,/^}/p' | grep -cE '^[[:space:]]+"[a-zA-Z]+":'   # 期望 17（另有 dottedMethods 2 → 19）
# 配置契约：9 仓
grep -rl '"config.get"' ../kore-plugin-*/ --include='*.go' | grep -v _test | cut -d/ -f2 | sort -u | wc -l
# 方法级 capability：23 仓（`echo` 验证件无声明，不计）
for d in ../kore-plugin-*; do git -C $d show HEAD:info.json 2>/dev/null | grep -q method_capabilities && echo "${d#../kore-plugin-}"; done | wc -l   # 期望 23
# 版本 vs 索引（24 行；HEAD 快照随发版滚动，盘点时刻 22/24 OK、2 仓待重签）
python3 - <<'PY'
import json, os, subprocess
idx = {p['id']: p['version'] for p in json.load(open('../kore-plugins/index/plugins.json'))['plugins']}
for d in sorted(x for x in os.listdir('..') if x.startswith('kore-plugin-')):
    raw = subprocess.run(['git', '-C', os.path.join('..', d), 'show', 'HEAD:info.json'], capture_output=True, text=True).stdout
    info = json.loads(raw); i = idx.get(info['id'])
    print("%-16s info=%-6s index=%-6s %s" % (info['id'], info['version'], i, 'OK' if i == info['version'] else 'MISMATCH'))
PY
# 主壳视图：四组 19 项 + 懒加载 11 个
grep -n "title: '" web/shell.js; grep -c "render: lazyView(" web/shell.js   # 期望 11（第 346 行是定义，不算）
# #12 审计语义复核（判定/回退 + 审计门 + 记录结构）
grep -n "effectiveInvokeRequirement" internal/core/httpapi/invoke_capability.go; sed -n '135,140p' internal/core/httpapi/audit_http.go; sed -n '36,44p' internal/core/store/audit.go
```
