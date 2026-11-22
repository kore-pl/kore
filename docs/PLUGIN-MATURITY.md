> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5

# PLUGIN-MATURITY — 插件与主壳成熟度分级 · 功能矩阵 · 改造优先级

## 0. 口径

| 项 | 内容 |
| --- | --- |
| 读者 | 产品评审、lead 拆解 Round 2、implementer 领活、red-team 找缺口 |
| 作用 | 回答"每个能力域现在是什么水平、离能用差哪些动作、先补哪个"，作为后续补全的唯一依据 |
| 不作用 | 不替代 [FEATURE-PARITY.md](./FEATURE-PARITY.md)（对标归属）、[PARITY-GAP.md](./PARITY-GAP.md)（差距账）、[PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md)（字段规格） |
| 盘点方法 | 逐仓 `grep` 动词归一化函数与 `internal/*/call.go` dispatch；视图数取 `web/app.js` 8 条 + `web/shell.js` 6 条；**不采信 README 自述** |
| 盘点基线 | 23 个 `kore-plugin-*` 仓、**74 个业务方法**、14 个视图、**插件侧 UI 为空**（仅 `echo/web/` 空目录，其余 22 仓无 `web/`） |
| 竞品口径 | 宝塔面板 / 1Panel 专业版**公开功能**的常识描述；无法确认的项标"待核实"，不臆造 |
| 盘点范围 | 任务给定的 **23 个** `kore-plugin-*` 仓（74 方法）。盘点期间并行任务新增第 24 个仓 `kore-plugin-discover`（services/ports/summary 3 方法，本机服务发现），**不在本表口径内**，避免与在途改动抢数字；纳入前需先补 22 域清单的归属裁决 |

**当前结论一句话**：22 个能力域里 **L0 骨架 10 个 / L1 能干活 10 个 / L2 可用 2 个 / L3 完整 0 个**——"每个插件都是半成品"的判断成立，根因是两个结构性问题：① **10 个插件仓的执行器默认 `noopExecutor`**（`monitor` 为 `placeholderExecutor`），覆盖 8 个能力域，方法通了但没碰宿主；`dns` / `integrity` 用占位返回值达成同一效果，合计 10 个 L0 域。② 插件侧 `web/` 全空，页面都长在主壳里。

## 1. 成熟度分级定义

| 级别 | 定义 | 判据 | 判定方法 |
| --- | --- | --- | --- |
| **L0 骨架** | 只有参数校验与占位返回 | 无真实副作用 | 执行器是 `noopExecutor` / 返回 `applied:false` / 摘要由路径字符串算出 |
| **L1 能干活** | 核心动作有真实副作用 | 至少 1 个方法真操作系统/文件/网络 | 有 `os.WriteFile` / `exec.Command` / PTY / 真实证书落盘 |
| **L2 可用** | 覆盖该能力域日常操作 + 错误可理解 | 该域 80% 日常动作可用；错误给人话；有双端页面 | 逐条数日常动作命中率 + 读视图错误文案 + 认 `.agents/verify/screenshots/` 双端证据 |
| **L3 完整** | 对标竞品同类功能，含进阶与管理能力 | 竞品该域核心能力项 ≥90% 覆盖；有引导/预设/批量 | 按 §2 竞品列逐项打勾 |

**判级纪律**：级别只认代码事实（`file:line`）；"能编译 + 单测绿"不进任何一级的判据；L2 的"双端页面"指 PC 与手机各一张实拍图，接口 200 不算。

## 2. 功能矩阵（22 个能力域）

| 能力域 | 当前插件 | 现级别 | 现有方法 | 竞品同类核心能力（用户能做什么） | 缺什么（对照） | 补到 L2 还要做什么 | 补到 L3 还要做什么 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 站点（web） | `site` | L1 | list / create / delete / status | 一键建站（选运行时/端口/根目录）、绑定多域名、选伪静态模板、配反向代理、一键部署证书、启停站点、看站点目录与日志、设默认站点、克隆站点、密码访问 | 缺：域名绑定、伪静态、反向代理、启停、站点日志入口、SSL 绑定、默认站点、克隆、流量 | 域名与反代落 vhost + 伪静态模板选择 + 启停 + 站点日志页；建站向导合并成一个表单；`sites.js` 补详情页 | ACME 自动绑定、克隆、密码访问、限流、流量统计、批量站点操作 |
| 文件 | `file` | L1 | list / read / write / delete / mkdir / stat | 上传（大文件分片）、下载、在线编辑、解压/压缩、改权限与属主、重命名、复制、移动、批量操作、回收站、搜索、算目录大小、收藏夹 | 缺：上传、下载、重命名、复制、移动、改权限、解压、压缩、回收站、搜索、目录大小、批量 | 补 upload/download/rename/move/copy/chmod + 解压压缩 + 软删回收站；`files.js` 右键菜单与多选 | 断点续传、在线预览、拖拽上传、收藏夹、操作留痕 |
| 数据库（MySQL） | `db-mysql` | L1 | instances / databases / query / status | 建库删库、改密码、用户与授权、导入导出 SQL、备份恢复、慢查询、运行状态、改参数、字符集 | 缺：建库、删库、用户授权、导入、导出、备份恢复、慢查询、参数配置、字符集 | 补建库/删库/用户授权/导入导出；`db.js` 补库管理与结果导出 | 慢查询分析、参数在线调整、备份调度、多实例切换 |
| 计划任务 | `cron` | L1 | list / add / remove / replace | 新建（shell/备份/日志切割/访问 URL）、设周期、启停、立即执行一次、看执行日志、编辑、删除、失败告警 | 缺：启停、立即执行、执行日志、下次执行时间、失败告警 | 补 enable/disable/run-now + 执行日志读取；`tasks.js` 补启停开关与日志抽屉 | 备份/日志切割模板、失败告警、批量导入导出 crontab |
| 终端 | `terminal` | L2 | create / write / resize / read / close / list | 打开 Web 终端、多标签、输入输出、复制粘贴、全屏、调字号、断线重连、命令历史 | 缺：多标签、复制粘贴按钮、字号、全屏、断线重连、历史 | 已达 L2（6/7 日常动作、错误给"会话已失效（可能被空闲回收）"、44px 触摸目标） | 多标签、字号/全屏、断线重连、命令历史 |
| 日志 | `logs` | L1 | sources / tail / search / stats | 按站点/服务看日志、实时跟踪、关键字搜索、时间过滤、下载、清理、日志切割配置、大小统计 | 缺：实时跟踪、时间区间过滤、下载、清理、切割配置、按站点聚合 | 补 since/until 过滤 + 下载 + 清理；`logs.js` 加自动刷新开关 | 切割策略配置、按站点聚合、异常高亮、日志告警 |
| 进程 | `process` | L1 | list / detail / kill / tree | 进程列表（CPU/内存排序）、搜索、详情（命令行/用户/端口/打开文件）、结束进程树、守护自启、资源趋势 | 缺：端口归属、打开文件、按信号结束、优先级、守护自启、趋势 | 补端口与 fd 归属 + 信号选择 + 结束进程树；`process.js` 详情补这两项 | 守护/自启托管、资源趋势图、异常进程识别 |
| SSL 证书 | `ssl` | L1 | list / import / selfsign / renew / verify（issue 返 E_UNSUPPORTED） | 申请证书（ACME 一键）、DNS 验证、上传证书、自签、续期、自动续期、到期提醒、部署到指定站点、证书链校验、强制 HTTPS | 缺：ACME 签发、自动续期联动、部署到站点、到期提醒、强制 HTTPS | 绑站点（选站点→写证书路径→reload）+ 到期倒计时 + `ssl.js` 补绑定表单 | ACME 签发与 DNS 验证、自动续期事件闭环、强制 HTTPS、证书链修复 |
| 备份 | `backup` | L1 | create / list / restore / delete / verify | 手动备份、定时备份、备份列表、恢复、删除、下载、校验、保留份数、备份到本地/对象存储、站点与数据库维度 | 缺：定时策略、保留策略、下载导出、进度、站点维度、对象存储（不做） | 补定时与保留策略 + 下载 + 进度事件；`backups.js` 补进度条与剩余份数 | 站点/数据库分维度备份、一键回滚站点、异地（对象存储明确不做） |
| 监控 | `monitor` | L0 | sample / alert.set | CPU/内存/磁盘/网络实时曲线、历史、负载、告警阈值与通知、进程 TOP、磁盘 IO | 缺：全部——`sample` 走 `placeholderExecutor`，不读 `/proc`；告警不落库不发通知 | 接 `/proc` 真采样（CPU/mem/load/disk/net）+ 阈值落盘；`monitor.js` 接插件采样而非只读内核端点 | 历史曲线与保留、磁盘 IO/温度、告警通知通道、进程 TOP |
| 防火墙 | `firewall` | L0 | rules / allowPort | 开关防火墙、放行端口、IP 黑白名单、规则列表、删规则、看生效状态、防暴力破解 | 缺：全部——`noopExecutor` 不调 `nft`/`iptables`；无黑白名单、无删除、无状态回读 | 接后端真实增删规则 + 回读生效状态 + 端口放行向导；补 `firewall.js` 视图 | IP 黑白名单、防爆破联动、规则导入导出、变更审计 |
| WAF | `waf` | L0 | rules / blockLog | 开关 WAF、规则集（SQL 注入/XSS/CC）、自定义规则、拦截日志、IP 封禁、拦截/观察模式 | 缺：全部——`noopExecutor`；无规则集、无模式切换、无封禁动作 | 定后端引擎（宿主已有 or 插件自带规则匹配）+ rules 真读写 + blockLog 真读；补视图 | 规则集管理与自定义规则、观察/拦截模式、IP 封禁、误报白名单 |
| DNS | `dns` | L0 | zone.list / record.add | 添加解析记录（A/AAAA/CNAME/MX/TXT）、编辑、删除、生效检查、批量、改 TTL | 缺：增删改真落盘（record.add 返 `applied:false` 只给提案）、编辑、删除、TXT/SRV、生效检查、批量 | 接真实 zone 文件读写（或 provider API）+ add/edit/delete + reload；补 `dns.js` 视图 | 生效检查、批量导入、TTL 批量改、provider 多实现 |
| Redis | `redis` | L0 | instances / scan | 实例列表、连接测试、键浏览与搜索、键值查看/编辑/删除、内存使用、命中率、配置、持久化、慢日志 | 缺：全部——`noopExecutor` 不连实例；无连接测试、无键值读写、无内存/命中率 | 接真实客户端（走 `redis-cli` 或 RESP）+ instances/scan 真连；补视图 | 键值编辑、内存与命中率、配置调整、慢日志、持久化开关 |
| PostgreSQL | `db-postgres` | L0 | instances / connections | 实例、库、表、用户权限、连接数、慢查询、备份恢复 | 缺：全部——`noopExecutor`；无库/表/权限、无连接明细、无慢查询 | 接 `psql` 真实执行 + 库/表/连接明细；补视图（可复用 `db.js` 骨架） | 用户权限、慢查询、备份恢复、参数配置 |
| 运行环境 | `runtime-node` / `runtime-php` / `runtime-python` | L0 | versions+allocatePort；versions+use；versions+venv.create | 装多版本、切版本、管扩展、进程守护、分端口、环境变量、看日志、启停 | 缺：全部——三仓均为 `noopExecutor`；`versions` 返白名单不探测宿主，`use`/`venv.create` 返 `false`，端口不真占 | 探测宿主已装版本（`exec` + 版本解析）+ 真建 venv/切 FPM + 端口占用检测；补"运行环境"视图 | 扩展管理、进程守护、环境变量、启停与日志、多版本共存矩阵 |
| 容器 | `container` | L0 | list / inspect | 容器列表、启停/重启/删除、看日志、进 shell、镜像管理、拉取 | 缺：全部——`noopExecutor` 不连 daemon；无生命周期动作、无日志、无 exec | 接 `docker`/`podman` 只读列表与详情（写动作待 G-11 裁决：容器编排明确不做） | 启停/删、日志、进入 shell；镜像管理需先解 G-11 边界 |
| 一键部署 | `app-deploy` | L0 | templates / create | 应用模板（WordPress/Nextcloud 等）、选版本/端口/域名、一键安装、看进度、卸载、升级 | 缺：全部——`create` 返 `applied:false` 只给占位；无真实拉取/解压/建库/写 vhost | 打通一条真实链路（模板→下载→解压→建库→写 vhost→reload）+ 进度事件；补视图 | 模板库扩充、卸载/升级、依赖检查、失败回滚 |
| 完整性 | `integrity` | L0 | baseline / verify | 建完整性基线、扫描比对、变更告警、恢复文件、定时扫描 | 缺：全部——`baseline` 用路径字符串的 sha256 当摘要（`Scanned:false`），`verify` 恒 `unchanged`/`alert:false` | 真读文件算 sha256 + 基线落盘 + 比对真实变更 + 告警；补视图 | 定时扫描、文件恢复、忽略规则、批量校验 |
| SSH 加固 | `ssh-guard` | L1 | status / ban.list | 改端口、禁 root 登录、密钥登录、失败锁定、封禁 IP 列表、审计日志、配置校验 | 缺：写动作全部缺失（`ban.list` 恒空且 `applied:false`）、端口/root/密钥开关、审计日志 | 补 sshd_config 原子写 + 配置校验（`sshd -t`）+ 回滚；`status` 接真实文件；补视图 | 失败锁定联动、IP 封禁执行、审计日志、加固预设（一键加固） |
| 索引本身 | `kore-plugins` | L2 | 索引 23 条（14 production / 9 basic）、8 预设、market 页、3 个校验脚本、签名链 | 商店分类、搜索、看评分/下载量、版本列表、依赖检查、一键安装、更新提示、离线导入 | 缺：依赖检查可视化、更新提示、离线导入 UI、评分/下载量 | 已达 L2（分类+搜索+安装/停用可用，`store.js` 无批量安装时**禁用而非伪造**） | 依赖检查、更新提示、离线导入、评分/下载量（不做运营可标"不做"） |
| 主壳（前端） | `kore` `web/` | L1 | 14 视图：8 条 `app.js` + 6 条 `shell.js` 内置 | 全局搜索、通知中心、长任务进度、操作审计、首次引导、快捷键、批量、空状态、加载骨架、错误边界、主题、多语言 | 见 §3.2：全局搜索/通知中心/审计 UI/引导/快捷键/骨架/主题全缺；i18n 明确不做 | 见 §3.2 与 §4 批次 1 | 见 §3.2 与 §4 批次 5 |

## 3. 主壳（前端）成熟度

### 3.1 14 个视图现状

| # | 视图 id | 文件 | 主要交互 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | dashboard 概览 | `app.js` | 统计卡 + 插件列表 + 空状态引导 | 可用（只读） |
| 2 | store 软件商店 | `store.js` | 卡片网格 + 分类筛选 + 搜索 + 安装/停用 + 按耗时给阶段提示 | 可用（无批量，已禁用） |
| 3 | plugins 已装插件 | `app.js` | 列表 + 状态 + 跳商店 | 可用（只读） |
| 4 | files 文件管理 | `files.js` | 列表 + 进入目录 + 读/写/新建/删除 + 详情 | 可用（缺上传/下载/改名/权限/压缩） |
| 5 | sites 网站 | `sites.js` | 列表 + 建站表单 + 详情 + 删除确认 + 结果区 | 可用（域能力只到 L1） |
| 6 | tasks 计划任务 | `tasks.js` | 列表 + 新建/编辑表单 + 删除 + `backup_path` 回显 | 可用（缺启停/日志） |
| 7 | monitor 监控 | `monitor.js` | 卡片 + 5s 页内轮询 + 可折叠技术说明 | 占位（插件采样未接） |
| 8 | settings 设置 | `settings.js` | 信息行 + 登出 | 骨架（无改密/无主题/无偏好） |
| 9 | terminal 终端 | `terminal.js` | 交互会话 + 尺寸自适应 + 断线提示 | 可用（最强视图） |
| 10 | db 数据库 | `db.js` | 实例下拉 + SQL 输入（Ctrl+Enter）+ 结果表 | 可用（只读查询为主） |
| 11 | logs 日志 | `logs.js` | 来源下拉 + tail/search 参数 + 结果列表 | 可用（无实时跟踪） |
| 12 | process 进程 | `process.js` | 列表（排序/搜索）+ 详情抽屉 + 进程树 | 可用（缺端口/fd） |
| 13 | ssl 证书 | `ssl.js` | 列表 + 自签/导入表单 + 校验结果 | 可用（无 ACME/绑定） |
| 14 | backup 备份 | `backups.js` | 列表 + 创建/校验/恢复/删除 + 结果区 | 可用（无定时/进度） |

### 3.2 面板级通用能力对照

| 能力 | 竞品有 | 我们有 | 现状证据 | 优先级 |
| --- | --- | --- | --- | --- |
| 全局搜索 | 有（搜站点/文件/功能） | 无 | `shell.js`/`app.js` "搜索" 零命中；仅 `store.js:273` 有商店内局部筛选 | P1 |
| 告警 / 通知中心 | 有（铃铛 + 未读） | 无 | 全仓无 `toast`/`notification` 实现 | P1 |
| 长任务进度 | 有（安装/备份/部署进度条） | 伪 | `store.js:205` 按请求耗时给阶段提示，后端无分阶段事件 | P1 |
| 操作审计 | 有（谁在何时做了什么） | 后端有、前端无 | `internal/core/store/audit.go` 有 audit bucket，14 视图无入口 | P1 |
| 首次使用引导 | 有（新手任务/检查清单） | 无 | 无 `onboard`/`guide` 命中 | P2 |
| 快捷键 | 有（搜索、保存、关闭） | 局部有 | 仅 `db.js:200` Ctrl+Enter、`files.js:77` Esc，无全局 | P2 |
| 批量操作 | 有（批量删/批量启停） | 无 | `store.js:110` 明确"暂不支持批量安装"并禁用 | P2 |
| 空状态引导 | 有 | 有 | `app.js:180 emptyState()` 统一带下一步按钮 | 已达标 |
| 加载骨架 | 有（skeleton） | 弱 | 仅 `app.js:1160` "正在连接内核…" 与模块 `loading` 状态 | P2 |
| 错误边界 | 有 | 有 | `shell.js:150/258/263` 三级兜底文案 | 已达标 |
| 主题（深色） | 有 | 无 | `style.css` 无 `prefers-color-scheme`/`data-theme` | P3 |
| 多语言 i18n | 有 | **不做** | G-11 明确不做；当前 `lang="zh-CN"` 硬编码 | 不做 |

## 4. 改造优先级（Round 2 五批）

排序依据：**用户高频 × 竞品核心 × 依赖关系**。批次内可并行，批次间按"前置"执行。

| 批次 | 任务（2–3 项） | 前置依赖 | 为什么排这里 |
| --- | --- | --- | --- |
| **R2-1 主壳通用地板** | ① 统一错误/空状态/加载骨架组件（抽公共函数）② 通知中心 + 长任务进度（SSE 事件 → 前端进度条）③ 全局搜索（视图/插件/站点/文件四源） | 无 | 后续每个视图都要复用；不先做，7 个视图会各写一套 |
| **R2-2 文件域补到 L2** | ① `file` 补 upload/download/rename/move/copy/chmod ② 解压/压缩 + 软删回收站 ③ `files.js` 右键菜单 + 多选 + 上传进度 | R2-1 的组件 | 最高频、动作最标准、无外部系统依赖，是"能干活→可用"的最短路径 |
| **R2-3 站点 + SSL 补到 L2** | ① `site` 补域名绑定/反代/伪静态/启停 ② `ssl` 补绑定站点 + 到期倒计时 ③ `sites.js` 建站向导（合并成一次表单） | R2-1；R2-3② 依赖 R2-3① 的 vhost 写入点 | 建站是对标竞品的头号场景；证书不绑站点等于半个功能 |
| **R2-4 把 10 个 L0 域拉到 L1** | ① `monitor` 接真实 `/proc` 采样 + 阈值落盘 ② `firewall`/`waf` 接真实规则后端 ③ `dns`/`redis`/`db-postgres`/`runtime-*` 去掉 `noopExecutor` 接真实后端 | 各自后端选型（需先出一份"执行器设计"ADR） | L0 占 10/22，是"半成品"观感的主因；但需先定后端，故排在可标准化的域之后 |
| **R2-5 管理与索引补到 L2/L3** | ① `db-mysql` 补建库/用户/导入导出 ② `backup` 补定时与保留 + 下载 ③ `cron` 补启停/立即执行/执行日志；`kore-plugins` 补依赖检查与更新提示 | R2-4（数据库能力）、R2-1（进度） | 管理类能力依赖前四批的数据通路，放最后收口 |

**不做清单（G-11 复述，避免 R2 漂移）**：多用户 RBAC、集群/多机、模板市场、厂商云存储深度集成、拖拽建站、多语言 i18n；另不做容器编排、多租户 SaaS、移动 App、重型主题。

## 5. 附录：23 仓方法清单（74 个方法）

| 仓库 | 方法数 | 方法名 | 一句话职责 |
| --- | --- | --- | --- |
| `app-deploy` | 2 | templates / create | 列出部署模板；`create` 只回显 `applied:false` |
| `backup` | 5 | create / list / restore / delete / verify | tar.gz 真实打包、恢复、删除、校验 |
| `container` | 2 | list / inspect | 容器列表与详情（noop，不连 daemon） |
| `cron` | 4 | list / add / remove / replace | 真实读写系统 crontab |
| `db-mysql` | 4 | instances / databases / query / status | 经 mysql CLI 查实例、库、SQL、状态 |
| `db-postgres` | 2 | instances / connections | 实例与连接（noop，不连库） |
| `dns` | 2 | zone.list / record.add | 列区域；加记录只回提案（`applied:false`） |
| `echo` | 5 | ping / echo / slow / timeout / crash | 验证件：协议回环、超时、崩溃重启计数 |
| `file` | 6 | list / read / write / delete / mkdir / stat | 配置根内真实文件读写 |
| `firewall` | 2 | rules / allowPort | 规则列表与放行端口（noop，不调 nft/iptables） |
| `integrity` | 2 | baseline / verify | 基线/比对（摘要取路径字符串，不读文件） |
| `logs` | 4 | sources / tail / search / stats | 白名单日志源、尾读、搜索、统计 |
| `monitor` | 2 | sample / alert.set | 采样与告警阈值（placeholder，不读 /proc） |
| `process` | 4 | list / detail / kill / tree | 真实 procfs：列表、详情、结束、进程树 |
| `redis` | 2 | instances / scan | 实例与键扫描（noop，不连实例） |
| `runtime-node` | 2 | versions / allocatePort | 版本白名单与端口分配（noop，不真占） |
| `runtime-php` | 2 | versions / use | 版本列表与切换（noop，不真起 FPM） |
| `runtime-python` | 2 | versions / venv.create | 版本列表与建 venv（noop，返 false） |
| `site` | 4 | list / create / delete / status | 真实写 nginx vhost + `nginx -t` + reload |
| `ssh-guard` | 2 | status / ban.list | 读 sshd 配置做合规审计；封禁清单恒空 |
| `ssl` | 6 | list / import / selfsign / renew / verify / issue | 真实证书落盘与 x509 校验；issue 返 `E_UNSUPPORTED` |
| `terminal` | 6 | create / write / resize / read / close / list | 真实 PTY 会话全生命周期 |
| `waf` | 2 | rules / blockLog | 规则与拦截日志（noop，不接 WAF 引擎） |

**证据复现命令**（任何人可重跑核对）：

```bash
# 方法数：按各仓「动词白名单」逐仓计数（去掉 <id>. 前缀再去重）
# 注：直接 grep 'case "' 会把「一行多动词」与子参数 switch 算错，必须走归一化函数
for d in ../kore-plugin-*; do n=${d#../kore-plugin-}; c=$(awk '/^func .*([Vv]erb|normalizeMethod)\(/{f=1} f&&/^\tcase /{print} f&&/^}$/{f=0}' $d/methods.go $d/internal/*/call.go 2>/dev/null | grep -o '"[a-zA-Z][a-zA-Z0-9._]*"' | tr -d '"' | sed "s/^$n\.//" | sort -u | wc -l); printf '%-20s %s\n' "$n" "$c"; done
# 期望：23 仓合计 74；若出现 discover 则为 77（多 3），属并行任务新仓
# 插件自带 UI：输出 1 即只有 echo/web/ 这个空目录（其余 22 仓无 web/）
ls -d ../kore-plugin-*/web 2>/dev/null | wc -l
# noop/placeholder 执行器：19 个文件、10 个插件仓（覆盖 8 个能力域）
grep -rln "noopExecutor\|placeholderExecutor" ../kore-plugin-*/internal/*/*.go | wc -l
```
