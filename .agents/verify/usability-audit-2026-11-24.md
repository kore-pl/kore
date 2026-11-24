# 可用性全景审计：24 插件 + 全站 24 个页面（2026-11-24）

> 审计人：`usability-audit-24`（子 agent）｜任务卡：只审计不改代码｜写域：`.agents/verify/`
> 输入：用户 2026-11-24 连续 8 条反馈 + 追加 2 条（导航菜单重复、逐页排查）
> 判据：AGENTS.md §7 产品易用性四原则（预设优先 / 自动发现 / 步骤少 / 小白能懂）
> 证据形式：`file:line` 或 命令输出。**没有起隔离实例跑真实调用**，凡"零参数返回什么"均为**读码判定**，未实测的显式标「未确认」。

---

## 0. 结论先行

**不是 24 个插件「都简陋」，是 3 个结构性设计问题。**

| # | 结构问题 | 证据 | 影响面 |
| --- | --- | --- | --- |
| S1 | **把「插件」当一级菜单**：左侧 24 个菜单项，其中 16 个是按插件逐个铺的页面；「软件商店」与「已装插件」并列 | `web/app.js:2054-2063`（8 项）+ `web/shell.js:595-610`（注入 16 项） | 全站导航，直接对应用户第 9 条反馈 |
| S2 | **预设两极分化**：备份 / 计划任务 / 完整性有真预设（零参数可成功），SSL / DNS / 容器 / 日志 / WAF / 运行环境没有 | `kore-plugin-backup/internal/backupop/preset.go:14-32`、`web/tasks.js:14-27`、`web/integrity.js`（16 处预设）vs `web/ssl.js`（0 处） | 8 条反馈里 5 条是「全是自定义输入」 |
| S3 | **能力面与页面面错位**：插件方法面普遍有只读兜底（`list`/`status` 零参数能跑），但「创建类」主流程仍要高级参数；主壳又给每个插件铺了一个菜单，等于把「能力清单」当「产品界面」 | 见 §2 表 | 用户感知为「简陋」：每页都只有一张表 + 一个裸表单 |

**计数**：24 个插件中 **合格 10 / 勉强 9 / 不合格 5**（判据见 §2 表末列，不为了凑数把合格写成不合格）。

**最严重的单点**：`SSL` 无「给站点一键申请证书」路径（要域名 + 邮箱 + 勾选 ACME 三步）；`日志` 的切割是**手动按钮**不是默认策略（用户第 4 条原话「默认就该切割和按时间/大小清理」）。

---

## 1. 左侧导航审计（用户反馈：「怎么还有个已装插件的菜单啊」）

### 1.1 现在的菜单清单（24 项）

| 来源 | 菜单项 | 证据 |
| --- | --- | --- |
| 主壳硬编码 8 项 | 概览、软件商店、已装插件、文件管理、网站、计划任务、监控、设置 | `web/app.js:2054-2063` |
| `mount()` 注入 16 项 | 终端、数据库、日志、进程、SSL、备份、Redis、防火墙、Web 防火墙、DNS 解析、服务发现、SSH 防护、运行环境、完整性、容器、应用部署 | `web/shell.js:595-610` |

按组分四组（`web/shell.js:67-72`）：运维 5 / 业务 5 / 资源 4 / 平台 10 = **24**。

### 1.2 重复与可合并项（客观判定）

| 判定 | 菜单 | 理由 | 建议 |
| --- | --- | --- | --- |
| **确认重复** | 软件商店 + 已装插件 | 商店已有「已安装 / 可升级 / 索引未收录」四态卡片（`web/store.js:161-180`）和升级汇总（`:341`），但没有「已安装」筛选 tab（`CATS` 只有分类，`web/store.js:59`）→ 才被迫拆出第二个一级菜单 | 商店加标签页 `[全部 \| 已安装 \| 可更新]`，删除「已装插件」一级菜单 |
| **确认重复（隐性）** | 已装插件 页里的「插件 UI（独立沙箱）」面板 | 该面板对每个插件建 iframe，条件是 `plugin.web.entry` 为字符串（`web/app.js:1409`）。实测 24 个 `info.json` **无一声明 `web` 字段**（`grep -l '"web"' */info.json` 命中的 5 个是 `web_server` 等子串，`json.get('web')` 全为 `None`）→ 这块面板**永远是空的** | 删面板，或补 `web.entry` 契约后并入插件详情 |
| **建议合并** | 网站 / 数据库 / Redis / 运行环境 / 备份 / SSL / 日志 / 进程 / 终端 / 容器 | 这些是「域能力」，宝塔/1Panel 都是域内 tab（站点页里带 SSL/备份/日志），不是 10 个平级菜单 | 一级菜单收敛到 8–10 项：概览 / 网站 / 数据库 / 文件 / 监控 / 计划任务 / 安全 / 商店 / 设置 |
| **建议下沉** | 防火墙 / Web 防火墙 / DNS 解析 / SSH 防护 / 完整性 / 服务发现 | 低频，且都是「安全 / 平台」子域 | 收进「安全」页 tab 或「设置 → 平台」 |

**对照**：宝塔一级菜单约 10 项、1Panel 约 12 项；kore 现在 24 项，且其中 16 项是按插件铺的 —— 这就是「怎么还有个已装插件的菜单」的根因：**导航是插件清单的投影，不是用户任务的投影**。

### 1.3 移动端影响（硬约束相关）

`NAV_GROUPS` 注释写「运维是日常入口，常驻手机底部 5 个 tab；其余项进更多抽屉」（`web/shell.js:65-66`）。24 项时「更多」抽屉要装 19 项，虽然点开仍 ≤2 次点击，但**认知负担**（找「备份」要滚 19 项）与四原则③「步骤尽量少」冲突。

---

## 2. 24 插件逐项审计（8 项 × 24 行）

> 列说明：**零参数** = 不传任何参数调「主流程方法」的结果（读码判定）；**字段** = 完成主流程最少必填；**点击** = 从进页面到完成（含确认）；**预设** = 有无「一键 XX」。

| # | 插件 | 主流程 | 零参数 | 最少字段 | 点击 | 有预设 | 错误提示给「怎么办」 | 内部术语 | 空状态引导 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | app-deploy | 部署一个应用 | ❌ `E_INVALID`（template+name 必填，`call.go` 的 `callDeploy`） | 2（模板 + 名称）+ 上传制品 | 4–5（上传→选模板→部署→确认） | ✅ 模板列表 `templates` | ✅ 三态降级（未装/无权限/版本低），`web/appdeploy.js:5-7` | 无 | ✅ 4 处 | **勉强**：有模板但「上传制品」仍是高级动作 |
| 2 | backup | 打一份备份 | ✅ `{}` 走默认预设 `site-full`（`preset.go:32,87`） | **0** | 1–2 | ✅ 4 个预设（网站全量/配置/数据库/整机） | ✅ `预设「X」需要指定…`，且给可选值列表（`preset.go:203`） | 无 | ✅ 6 处 | **合格**：全站唯一做到「零参数真成功」的写操作 |
| 3 | container | 看/停容器 | ⚠️ `list` 可零参数，但依赖 docker；无 docker 时 `E_UNSUPPORTED|docker_missing` | 2（容器名 + confirm） | 3 | ❌ | ✅ docker 缺失给安装命令（`web/app.js:123-126`） | 无 | ⚠️ 1 处 | **勉强**：basic 级、无常用镜像/一键跑容器 |
| 4 | cron | 加一个定时任务 | ❌ `add` 需 schedule+command | **0**（选快捷预设即填满） | 2 | ✅ 4 快捷预设 + 4 频率预设（`web/tasks.js:14-27`） | ✅ `cron 需要 5 段…例：0 3 * * *`（`web/backups.js:247`） | 无 | ✅ 4 处 | **合格**：预设→保存两步 |
| 5 | db-mysql | 连库/看库/建库 | ✅ `instances` 读配置零参数（`instances.go:10-30`） | 0（读）/ 1（库名） | 2–3 | ✅ 13 处（SQL 模板等） | ✅ 分类映射 + 「怎么办」（`web/db-l2.js:5`） | ⚠️ 用户可见文案用「实例」（`web/db.js:320,328`） | ✅ 5 处 | **合格**：L2 写能力齐 |
| 6 | db-postgres | 同上 | ✅ `instances` 零参数 | 0（只读） | 2 | ⚠️ 少量 | ✅ 同上 | ⚠️ 同 | ✅ | **不合格**：**只读**，无建库/建用户 L2（`web/db.js:7`「PostgreSQL 只读，无 L2」）——用户要管库时无路可走 |
| 7 | discover | 看本机装了什么服务 | ✅ `services` 零参数 | 0 | 1 | ⚠️ 无（本身是发现结果） | ✅ 三种降级 | ⚠️ 1 处 | ✅ 2 处 | **合格**：只读定位正确，自动发现 |
| 8 | dns | 管 DNS 记录 | ⚠️ `status/zones` 零参数可读 | 写需 TSIG 密钥 | — | ❌ | ✅ `E_NO_ENGINE` 给装 BIND9 | 无 | ⚠️ 1 处 | **不合格**：页面**只读，无编辑入口**（`web/dns.js:5`），「DNS 管理」名不符实 |
| 9 | echo | 协议自测 | ✅ `ping` 零参数 | 0 | 1 | 不适用 | 不适用 | 无 | 不适用 | **合格（非产品页）**：基准插件，不计入易用性 KPI |
| 10 | file | 传/删/改文件 | ✅ `list` 零参数（`path:""` → 根，`list.go:16`） | 0（浏览） | 2（上传 2 步） | ⚠️ 2 处 | ✅ 失败原样展示 code+message+detail（`web/files-l2.js:4`） | 无 | ❌ **0 处空状态** | **勉强**：功能很全（upload/extract/chmod/回收站），但**空目录无引导、无拖拽上传、批量入口在二级注入** → 用户原话「什么垃圾玩意」 |
| 11 | firewall | 开/关端口 | ✅ `status` 零参数 | 2（端口 + 协议） | 2（dry-run → 执行） | ⚠️ 2 处（常用端口） | ✅ 非 root 给黄底说明 + 禁用按钮 | 无 | ❌ 0 处 | **合格**：dry-run 预览是亮点 |
| 12 | integrity | 建基线/查篡改 | ✅ `status` 零参数 | 0 | 1 | ✅ 16 处（监控路径预设） | ✅ 0 条目基线**不报成功**（`web/integrity.js:5`） | 无 | ✅ 4 处 | **合格**：诚实降级做得好 |
| 13 | logs | 看/搜/切日志 | ✅ `sources` 零参数（`registry.Sources`） | 0（看） | 1 | ❌ **0 处** | ⚠️ 有 message 但无「怎么办」层 | 无 | ⚠️ 1 处 | **不合格**：**切割是手动按钮**（`web/logs.js:507-521`，保留 5 份），无「按时间/大小自动清理」默认策略 → 用户第 4 条原话 |
| 14 | monitor | 看系统负载 | ✅ `monitor.system` 零参数 | 0 | 1 | ❌ | ✅ 插件失败降级到内核指标且不白屏（`web/monitor.js:3-5`） | ⚠️ 8 处（注释里「实例」，1 处用户可见） | ⚠️ 1 处 | **合格**：已有 hover/tap 读数面板（`web/monitor.js:87-88`，commit `00575ac`） |
| 15 | process | 找进程/结束 | ✅ `list` 零参数 | 0（看）/ 2（kill: pid+confirm） | 2 | ✅ 6 处 | ✅ 契约对齐 + 详情抽屉 | 无 | ❌ 0 处 | **合格** |
| 16 | redis | 看键/改值/运维 | ✅ `instances` 零参数 | 0 | 1–2 | ✅ 14 处 + 18 处自动探测 | ✅ 具体到「Docker 的 --requirepass」「主机名无法解析」（`web/redis.js:150,157`） | ⚠️ 18 处（注释为主） | ✅ 2 处 | **合格**：错误提示是全站最好的之一 |
| 17 | runtime-node | 看 Node 版本/项目 | ✅ `versions` 零参数 | 0 | 1 | ❌ | ⚠️ doctor detail 原样展示 | 无 | ❌ 0 处 | **不合格**：**只能探测不能装/切版本**（`web/runtimes.js:5`「全部只读探测」），「运行环境」名不符实 |
| 18 | runtime-php | 同上 | ✅ | 0 | 1 | ❌ | ⚠️ | 无 | ❌ | **勉强**：production 级但仍只读 |
| 19 | runtime-python | 同上 + venv/pip | ✅ | 0 | 1 | ❌ | ⚠️ | 无 | ❌ | **不合格**：基础管理（装包/建 venv）在方法面有，页面未暴露 |
| 20 | site | 建站/改配置 | ✅ `list` 零参数 | **1（域名，根目录自动填 `/var/www/<域名>`）** | 3（向导一次提交，内部串行 create→SSL→伪静态） | ⚠️ 1 处 | ✅ 失败不把「配置写过」说成「已生效」（`web/sites.js:6`） | 无 | ✅ 3 处 | **勉强**：向导合格，但缺站点级**备份 / 日志 / 数据库 / 一键部署**四件套（对标宝塔差距最大处） |
| 21 | ssh-guard | 看爆破/封 IP | ✅ `status` 零参数 | 1（IP）+ 一次性 confirm 令牌 | 3 | ⚠️ 3 处 | ✅ 明确「ban.add 没有时长参数」（`web/sshguard.js:5`） | 无 | ⚠️ 1 处 | **勉强**：封禁需先换 confirm-token，小白会卡在「为什么要两次」 |
| 22 | ssl | 申请/续期证书 | ✅ `list` 零参数 | 2（域名 + 邮箱）+ 勾选 ACME | 4 | ❌ **0 处** | ✅ ACME 联网需勾选确认 | 无 | ⚠️ 1 处 | **不合格**：**没有「给站点一键申请」**；用户要 HTTPS 必须懂 ACME 三步 → 最典型的「全是自定义输入」 |
| 23 | terminal | 网页终端 | ✅ `create` 只需 client_id（前端自动生成），cols/rows 默认 80×24，shell 取配置（`methods.go:28-35`） | **0** | 1 | 不适用 | ⚠️ | 无 | ✅ 2 处 | **勉强**：ANSI/vim/htop 可用（1024 行），但**无分屏、无会话恢复、无文件上传**（用户「太简陋」的具体内容） |
| 24 | waf | 看拦截/封 IP | ✅ `status` 零参数 | 1（IP）/ 开关 confirm | 2–3 | ⚠️ 3 处 | ✅ 引擎平面/规则平面分开呈现 | 无 | ✅ 2 处 | **勉强**：basic 级，规则只能看不能编辑 |

**判定口径**：合格 = 主流程 ≤3 点击且零/单字段可完成，错误可执行、空状态有引导；勉强 = 主流程能走完但需 2+ 高级字段或关键能力缺失；不合格 = 主流程走不通（只读/名不符实）或直接命中用户点名缺陷。

---

## 3. 全站 24 个页面逐页排查（用户追加：「每个页面都排查吧」）

> 每页三问：解决什么用户问题 / 对标宝塔·1Panel 差什么 / 结论。

| # | 页面（文件） | 解决什么 | 对标差距 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 概览 `web/app.js` | 一屏看健康 | 无自定义仪表盘、无快捷入口（新建站点/备份） | **勉强** |
| 2 | 软件商店 `web/store.js` | 装/升级插件 | **缺「已安装」筛选 tab**，才被拆出独立菜单 | **合格** |
| 3 | 已装插件 `web/app.js` | 启停/卸载/看状态 | **与商店重复**；「插件 UI」面板永远空（见 §1.2） | **不合格**（重复菜单） |
| 4 | 文件管理 `web/files.js` | 传/改/删文件 | 无空状态、无拖拽、批量在二级、无在线解压进度详情 | **勉强** |
| 5 | 网站 `web/sites.js` + `site-edit.js` | 建站/SSL/伪静态 | 缺站点级备份/日志/DB/一键建站（WordPress 等） | **勉强** |
| 6 | 计划任务 `web/tasks.js` | 定时任务 | 无执行历史趋势图、无失败重试 | **合格** |
| 7 | 监控 `web/monitor.js` | 负载/磁盘/网络 | 无历史曲线存储（只有当前采样）、无告警阈值可视化 | **勉强** |
| 8 | 设置 `web/settings.js` | 会话/系统信息/退出 | 无备份恢复、无更新检查、无面板主题 | **勉强** |
| 9 | 终端 `web/terminal.js` | 网页 shell | 无分屏/会话恢复/文件上传 | **勉强** |
| 10 | 数据库 `web/db.js` + `db-l2.js` | 连库/查/管 | PG 只读（#6）；MySQL 无「一键建站配套库」 | **勉强** |
| 11 | 日志 `web/logs.js` | 看/搜/切 | **无默认切割与保留策略**（用户点名） | **不合格** |
| 12 | 进程 `web/process.js` | 找/杀进程 | 无进程资源历史、无自启动管理 | **合格** |
| 13 | SSL `web/ssl.js` | 证书 | **无一键申请、无站点绑定联动** | **不合格** |
| 14 | 备份 `web/backups.js` | 备份/恢复 | 无恢复演练、无异地(S3)一键配置向导（有方法面） | **合格** |
| 15 | Redis `web/redis.js` | 键浏览/运维 | 无慢查询趋势图（有表格） | **合格** |
| 16 | 防火墙 `web/firewall.js` | 端口 | 无规则导入导出 | **合格** |
| 17 | Web 防火墙 `web/waf.js` | 拦截 | 规则只读 | **勉强** |
| 18 | DNS 解析 `web/dns.js` | 解析查询 | **只读，无编辑** | **不合格** |
| 19 | 服务发现 `web/discover.js` | 本机装了什么 | 无「一键接入为插件」动作 | **合格** |
| 20 | SSH 防护 `web/sshguard.js` | 爆破防护 | 封禁两步令牌、无白名单 UI | **勉强** |
| 21 | 运行环境 `web/runtimes.js` | 版本/项目探测 | **只读，不能装/切版本** | **不合格** |
| 22 | 完整性 `web/integrity.js` | 篡改检测 | 无定时巡检可视化 | **合格** |
| 23 | 容器 `web/container.js` | 容器列表/日志 | 无镜像/编排/一键跑常用容器 | **勉强** |
| 24 | 应用部署 `web/appdeploy.js` | 部署应用 | 模板少、上传制品门槛高 | **勉强** |

**页面计数**：合格 9 / 勉强 10 / 不合格 5。

---

## 4. 共性模式归纳（四类问题清单）

### 4.1 「零参数」路径坏掉的插件（最严重）

| 类型 | 插件 | 证据 |
| --- | --- | --- |
| **写操作零参数必失败** | app-deploy、cron、site、ssh-guard、firewall、ssl、container | 例：`site/methods.go:104` 空 domain → `E_INVALID`；`app-deploy` deploy 需 template+name |
| **零参数能成功（写）** | **仅 backup**（`preset.go:87` + `defaultPresetID`） | 全站唯一 |
| **零参数能成功（读）** | 其余 22 个的 `list/status/instances/sources/versions` | 只读兜底是普遍做对的 |
| **根本没写能力** | db-postgres、dns、runtime-node、runtime-python | 页面只读 |

**结论**：只读零参数 22/24 合格，**写操作零参数 1/24 合格**——这正是「全是自定义输入」的量化根因。

### 4.2 错误提示是「纯错误码」的插件

**实际结论：没有插件返回纯 `E_INVALID` 裸码。** 全部错误 message 都是中文（`invalid("...")` 全量 900+ 处，抽样均有具体字段名），且主壳有统一 `ERROR_VIEW` 映射表把 code → 「怎么办」文案（`web/app.js:110-175`，14 条映射，含 `E_NEED_ROOT` 的 systemd 操作步骤、`docker_missing` 的安装命令）。

**真正的缺口是第二层**：
- 插件 message 说「什么错了」（如 `domain 非法：仅允许小写字母数字…`，`site/methods.go:114`），但**不说「怎么办」**（应给 `example.com` 示例）；
- 未收录的错误码 `mapped=false` 时只剩通用文案（`web/app.js:197-201`）；
- `web/logs.js`、`web/files.js` 没有把后端 `hint` 渲染出来（`failureOf` 支持 `err.hint`，但视图未接）。

### 4.3 暴露内部术语的页面

| 术语 | 位置 | 严重度 |
| --- | --- | --- |
| 「实例」 | `web/db.js:320,328`、`web/redis.js:137,174` 用户可见文案；`db.js` 共 25 处、`redis.js` 18 处（多数在注释） | 中（AGENTS.md §7④ 明令禁用） |
| 「插件 UI（独立沙箱）」 | `web/app.js:1392` 面板标题 | 中（内部机制当标题） |
| 「存量/契约/方法面」 | 各视图头注释（不进 UI，不计） | — |
| 「capability / revision / 生命周期」 | **未在 UI 字符串中发现**（`grep -c` 全为 0） | 合格 |

### 4.4 有预设 vs 没预设（差异对比）

| 有真预设（零参数或一键） | 预设数 | 没预设（全靠自定义） |
| --- | --- | --- |
| backup | 4（含零参数默认） | ssl（0） |
| cron | 8（4 快捷 + 4 频率） | logs（0） |
| integrity | 16（监控路径） | container（0） |
| db-mysql | 13（SQL 模板） | runtime-node/php/python（0） |
| redis | 14 + 18 自动探测 | monitor（0，但本身无需输入） |
| process / ssh-guard / waf / firewall | 2–6 | dns / db-postgres（只读，不需要） |

**规律**：**预设密度与「用户是否抱怨」强负相关**——被点名的 6 个（图表/终端/监控/日志/网站/数据库/文件/备份）里，唯一有零参数预设的 backup 恰恰是用户最后一条「小白也要能用」的**正面参照**，说明用户要的不是更多表单，是**「点一下就有合理默认」**。

---

## 5. G-33 产品可用性门禁（设计）

### 5.1 门禁定位

G-33 = **产品可用性门禁**，与 G-28（UI 双端证据）互补：G-28 管「有没有交付界面」，G-33 管「界面能不能用」。分两层：**自动可查（阻断）** + **人工评审（记 WARN，里程碑收口核对）**。

### 5.2 自动检查项（可脚本化，阻断级）

| 编号 | 判据（可执行） | 检查方式 | 失败示例 |
| --- | --- | --- | --- |
| G-33-A1 | **写操作零参数可用**：每个有 create/add/deploy/issue 类方法的插件，必须存在一个「零参数或单字段」预设路径，且 `{}` 调用返回**非 `E_INVALID`**（允许 `E_NEED_ROOT`/`E_UNAVAILABLE`/`E_CONFIRM_REQUIRED`） | 插件仓内 `tests/usability/zero_param_test.go`，用 `pluginapitest` 假执行面 in-process 跑 | `site.create {}` → `E_INVALID 缺少必填字段 domain` |
| G-33-A2 | **预设声明**：`info.json` 新增必填 `presets: [{id,label,description}]`，create 类插件至少 1 条；或方法面暴露 `*.templates`/`*.presets` 且非空 | `python3 -c` 读 info.json + grep 方法表 | ssl/dns/container 无预设 → FAIL |
| G-33-A3 | **错误提示可执行**：每条 `invalid("…")` 的 message 长度 ≥8 且含「请/应/需/例/格式/如」之一；禁止裸 `E_XXX` 作为 message | `grep -rhoE 'invalid\("[^"]*"' */**/*.go | python3` 逐条判 | `invalid("E_INVALID")` |
| G-33-A4 | **内部术语零命中**：`web/*.js` 的**字符串字面量**（非注释）不得含 `实例|生命周期|capability|revision|沙箱` | `node -e` 或 python 去注释后 grep | `web/app.js:1392`「独立沙箱」→ FAIL |
| G-33-A5 | **空状态可引导**：每个视图 `web/<view>.js` 必须调用 `emptyState(...)` 或含「暂无/还没有」+ 一个跳转按钮 | grep + 弱断言（要求同时有文案与 route） | `web/files.js` 0 处 → FAIL |
| G-33-A6 | **导航唯一性**：一级菜单 id 集合 = 白名单（≤10 项）；`store` 与 `plugins` 不得同时存在；每个插件 id 最多映射 1 个一级菜单 | 解析 `web/app.js` 的 `SHELL_ROUTES` 与 `web/shell.js` 的 `items.push` | 当前 24 项 → FAIL |
| G-33-A7 | **主流程 ≤3 点击**：视图内从渲染到「主流程方法 invoke」之间，`on(...)` 事件链深度 ≤3（静态近似：统计主流程按钮到 invoke 的中间确认层） | 人工标注 + 门禁脚本读标注文件 `usability.yaml` | — |

### 5.3 人工评审项（不可脚本化，WARN + 里程碑核对）

| 编号 | 判据 | 评审方式 |
| --- | --- | --- |
| G-33-M1 | 抽 3 个真实错误码，message 是否给「怎么办」 | 截图 + 逐条引用 |
| G-33-M2 | 小白 60 秒能否完成主任务（不查文档） | 录屏/点击计数表 |
| G-33-M3 | 空状态是否给「下一步按钮」且点了能到正确页 | 手工点一遍 |
| G-33-M4 | 对标宝塔/1Panel 同类页，缺的能力是否已记入 `PLUGIN-MATURITY §3.5` | 对照表 |

### 5.4 脚本思路：`scripts/usability-check.sh`

**能不能直接跑「零参数调用」？** 不能直接对生产 UDS 跑——需要主壳 + 插件进程 + root（`E_NEED_ROOT` 会掩盖真实校验），且 `G-29` 禁止动主实例。**替代方案（可行且已在仓库有基础）**：

```bash
# scripts/usability-check.sh —— 只读静态检查 + 调插件仓自带 in-process 测试
#!/usr/bin/env bash
set -u
FAIL=0
for d in ../kore-plugin-*; do
  id=${d#../kore-plugin-}
  # A2 预设声明
  python3 - "$d/info.json" "$id" <<'PY' || FAIL=1
import json,sys
info=json.load(open(sys.argv[1]))
if info.get('presets'): sys.exit(0)
print(f"[G-33-A2] {sys.argv[2]}: 未声明 presets"); sys.exit(1)
PY
  # A3 错误提示可执行（去注释后逐条判）
  grep -rhoE 'invalid\("[^"]*"' "$d" --include='*.go' | grep -v _test \
    | grep -vE '请|应|需|例|格式|如|不能|必须|只支持' \
    | sed "s/^/[G-33-A3] $id: /" && FAIL=1
  # A1 零参数：插件仓若有 usability 测试就跑（in-process，不碰主实例）
  ( cd "$d" && [ -d tests/usability ] && go test ./tests/usability/ -run TestZeroParam -count=1 ) || true
done
# A4/A5/A6 在主壳仓库查
python3 scripts/usability_static.py || FAIL=1
exit $FAIL
```

**A1 的落地方式**（关键）：不新增运行依赖，复用各插件已有的 `internal/*/call.go` + `NewRuntime(..., fakeExecutor)`。每个插件加一个 `tests/usability/zero_param_test.go`：

```go
func TestZeroParam(t *testing.T) {
    rt := NewRuntime(Options{...}, fakeExec)   // 假执行面，不碰真系统
    _, perr := rt.Call("site.create", json.RawMessage(`{}`))
    if perr != nil && perr.Code == pluginapi.E_INVALID {
        t.Fatalf("零参数主流程返回 E_INVALID: %s", perr.Message)
    }
}
```

成本：每插件 ~20 行 + 一条 `make usability` 入口；不满足时**先记 WARN**，M4 转阻断（与 G-17/G-18 的分层推进一致）。

---

## 6. 优先级排序（用户痛感 × 修复成本）

| 优先级 | 项 | 痛感 | 成本 | 依据 |
| --- | --- | --- | --- | --- |
| **P0-1** | 导航收敛：商店加 `[全部\|已安装\|可更新]` tab，删「已装插件」一级菜单；24 → ≤10 项 | 高（用户主动质疑 2 次） | 低（改 `SHELL_ROUTES` + store 筛选 + 路由迁移） | §1.2 |
| **P0-2** | 日志默认切割 + 保留策略（默认 7 天 / 100 MB，生成 systemd timer 或 scheduler 任务），页面只保留「高级」入口 | 高（第 4 条原话） | 中（插件 + scheduler 联动） | §2 #13 |
| **P0-3** | SSL 一键：站点页勾 HTTPS → 自动 `ssl.acme.issue`（域名取站点域名、邮箱取全局设置） | 高 | 中（site-edit 向导 + ssl 方法复用） | §2 #22 |
| **P0-4** | 文件管理空状态 + 拖拽上传 + 批量操作条 | 高（「什么垃圾玩意」） | 低（前端） | §2 #10 |
| **P1-1** | 备份的「零参数预设」模式复制到 ssl/container/dns/运行环境（G-33-A2 强制） | 中高 | 中 | §4.4 |
| **P1-2** | 站点级四件套：备份 / 日志 / 数据库 / 一键部署 | 中高 | 中高 | §3 #5 |
| **P1-3** | db-postgres 补 L2（建库/建用户/授权） | 中 | 中 | §2 #6 |
| **P1-4** | DNS 补写入口（record.add/update/delete 已有，页面只读） | 中 | 低 | §2 #8 |
| **P1-5** | 删「插件 UI（独立沙箱）」空面板 | 低中 | 极低 | §1.2 |
| **P2-1** | 内部术语清理（实例 → 数据库/Redis 服务；沙箱 → 无） | 中 | 低 | §4.3 |
| **P2-2** | 运行环境补「安装/切换版本」 | 中 | 高 | §2 #17/19 |
| **P2-3** | WAF 规则编辑、容器常用镜像预设、终端分屏/上传 | 中 | 中高 | §3 #17/#23/#9 |
| **P2-4** | 错误 message 第二层「怎么办」补齐 + `hint` 渲染 | 低中 | 低 | §4.2 |

---

## 7. 未确认清单（诚实标注）

1. **零参数真实返回**：全部为读码判定；未起隔离实例（`G-29` + 无 root）。`container`/`ssl`/`firewall` 在非 root 下真实返回可能是 `E_NEED_ROOT`，本表按「校验层是否先于权限层」判。
2. **点击次数**：按视图代码的「按钮 → 确认 → invoke」链路静态估算，未录屏计数（G-33-M2 需人工补）。
3. **`db.js`/`redis.js`「实例」是否全部用户可见**：只抽查了 6 处，其余为注释；精确清单需逐行去注释后统计。
4. **`web/logs.js` 是否已有默认 retention 配置**：`retention.get/set` 方法存在，但页面未渲染默认值；插件默认值未确认。
5. **图表 tooltip 覆盖**：`monitor` 已确认有（`web/monitor.js:87-88`）；`db`/`redis`/`process` 的图表是否有读数面板未逐个确认（仅 monitor 有 `monitor-cards` 图表基建）。

---

## 8. 证据命令（可复跑）

```bash
# 导航项数量（8 + 16 = 24）
grep -n "SHELL_ROUTES" -A10 web/app.js | head -12
grep -cE "items.push\(\{ id:" web/shell.js

# 插件 info.json 是否声明 web 入口（0 = 面板恒空）
for f in ../kore-plugin-*/info.json; do python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('web'))" "$f"; done | sort | uniq -c

# 预设密度
for f in appdeploy backups container tasks db discover dns files firewall integrity logs monitor process redis runtimes sites sshguard ssl terminal waf; do
  printf "%s %s\n" "$f" "$(grep -cE '预设|一键|PRESETS|模板' web/$f.js)"; done

# 内部术语（字符串层）
grep -rnE "实例|生命周期|capability|revision" web/*.js | head

# 备份零参数预设
grep -n "defaultPresetID\|isZeroCreateParams" ../kore-plugin-backup/internal/backupop/create.go
```
