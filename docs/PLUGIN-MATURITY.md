> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5

# PLUGIN-MATURITY — 插件与主壳成熟度分级 · 功能矩阵 · 改造优先级

## 0. 口径

| 项 | 内容 |
| --- | --- |
| 读者 | 产品评审、lead 拆解 Round 3、implementer 领活、red-team 找缺口 |
| 作用 | 回答"每个能力域现在是什么水平、离能用差哪些动作、先补哪个"，作为后续补全的唯一依据 |
| 不作用 | 不替代 [FEATURE-PARITY.md](./FEATURE-PARITY.md)（对标归属）、[PARITY-GAP.md](./PARITY-GAP.md)（差距账）、[PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md)（字段规格） |
| 盘点方法 | 逐仓读 `methods.go` / `internal/*/call.go` / `README.md`，再核对真实副作用（`os/exec`、真实文件读写、网络连接、非 `noopExecutor`）；**不采信 README 自述**，级别只认代码事实 |
| 盘点基线 | 24 个 `kore-plugin-*` 仓、**106 个业务方法**（不含 `config.get/set`）、主壳 **16 视图 / 四组导航**、5 个仓有配置契约（`site` / `logs` / `backup` / `db-mysql` / `redis`）；`echo` 为验证件，不参与 L 分级 |
| 竞品口径 | 宝塔面板 / 1Panel 专业版**公开功能**的常识描述；无法确认的项标"待核实"，不臆造 |
| 盘点范围 | 任务给定的 **24 个** `kore-plugin-*` 仓；Round 2 新增 `discover` 已纳入，不再留在表外 |

**当前结论一句话**：23 个可分级仓里 **L0 9 / L1 1 / L1.5 10 / L2 3 / L3 0**——Round 2 已把 12 个仓从骨架或半成品推到"真实后端 / L2"，"执行器全是 noop"的旧判断不再成立；新的结构性缺口是 **日常动作覆盖不足**（L1.5 占 10 个）与 **探测/版本事实不准**（`discover` 报客户端版本），详见 §3.5。

## 1. 成熟度分级定义（3.1）

| 级别 | 定义 | 判据 | 判定方法 |
| --- | --- | --- | --- |
| **L0 骨架** | 只有参数校验与占位返回 | 无真实副作用 | 执行器是 `noopExecutor` / `placeholderExecutor` / 返回 `applied:false` / 摘要由路径字符串算出 |
| **L1 能干活** | 核心动作有真实副作用 | 至少 1 个方法真操作系统/文件/网络 | 有 `os.WriteFile` / `exec.Command` / PTY / 真实证书落盘 |
| **L1.5 接线完成（L1 子档）** | 真实后端已接通、核心读写可用，但日常动作覆盖 <80% | 有真实 exec/文件/网络；有配置契约更佳 | 方法数 + 竞品日常动作命中率 + 无 noop；单列排期，不计入 L2 |
| **L2 可用** | 覆盖该能力域日常操作 + 错误可理解 | 该域 80% 日常动作可用；错误给人话；有双端页面 | 逐条数日常动作命中率 + 读视图错误文案 + 认 `.agents/verify/` 双端证据 |
| **L3 完整** | 对标竞品同类功能，含进阶与管理能力 | 竞品该域核心能力项 ≥90% 覆盖；有引导/预设/批量 | 按 §2 竞品列逐项打勾 |

**判级纪律**：级别只认代码事实（`file:line`）；"能编译 + 单测绿"不进任何一级的判据；L2 的"双端页面"指 PC 与手机各一张实拍图，接口 200 不算。L1.5 是本轮为"接线完成但未达日常覆盖"新增的子档，不改变 L0–L3 主级定义。

## 2. 功能矩阵（3.2，24 个插件仓）

| 能力域 | 插件 | 现级别 | 现有方法（数量） | 本轮已补（代码事实） | 仍缺（到 L2 / L3） |
| --- | --- | --- | --- | --- | --- |
| 站点（web） | `site` | **L2+** | 16：list / create / delete / status / get / bindSSL / unbindSSL / setRewrite / getRewrite / setProxy / unsetProxy / setRedirect / unsetRedirect / disable / enable / setIndex（另 config.get/set） | SSL 绑定、伪静态、反代、重定向、启停、index；容器 nginx 走 `docker exec`（`nginxdocker.go`） | 缺克隆、密码访问、流量统计、ACME 联动；容器模式 `site_dir_exists` 只看宿主（见 §3.5） |
| 文件 | `file` | **L2** | 12：list / read / write / delete / mkdir / stat / upload / download / extract / compress / chmod / move | 上传下载、解压压缩、改权限、移动；根目录内真实读写（`internal/fileop/`） | 缺 rename/copy、搜索、回收站、批量、断点续传、在线编辑 |
| MySQL | `db-mysql` | **L1.5** | 4：instances / databases / query / status（另 config.get/set） | 真实 `mysql` CLI + 只读 SQL 白名单 + 配置契约（密码 0600、热生效） | 缺建库/删库/改密/用户授权/导入导出/备份（见 §3.5） |
| 计划任务 | `cron` | **L1.5** | 4：list / add / remove / replace | 真实 `crontab` 读写、写前备份、失败回滚 | 缺启停、立即执行、执行日志、任务类型（备份/URL） |
| 终端 | `terminal` | **L2** | 6：create / write / resize / read / close / list | 真实 PTY 全生命周期、增量读写 | 缺多标签、断线重连、命令历史、字号/全屏 |
| 日志 | `logs` | **L1.5** | 4：sources / tail / search / stats（另 config.get/set） | 真实文件与 `journalctl` 读取、since 过滤、搜索、统计、配置契约 | 缺实时跟踪、下载、清理、切割、按站点聚合 |
| 进程 | `process` | **L1.5** | 4：list / detail / kill / tree | 真实 procfs：CPU 差分、详情、信号白名单、进程树 | 缺端口/fd 归属、优先级、守护自启、资源趋势 |
| SSL 证书 | `ssl` | **L1.5** | 6：list / import / selfsign / renew / verify / issue（issue 返 `E_UNSUPPORTED`） | 真实证书落盘、x509 解析、TLS 探测、自签续期 | 缺 ACME 签发/自动续期、绑定站点、到期提醒、强制 HTTPS |
| 备份 | `backup` | **L1.5** | 5：create / list / restore / delete / verify（另 config.get/set） | 标准库 tar.gz 真实打包、原子恢复、sha256 校验、配置契约 | 缺定时、保留策略、下载、进度、站点/数据库维度 |
| 监控 | `monitor` | **L0（插件）** | 2：sample / alert.set | 主壳监控页已读内核指标（G-28 实测 CPU/内存/磁盘）；**插件仍是 `placeholderExecutor`**（`internal/monitor/executor.go:9`） | 插件不读 `/proc`、告警不落盘；缺历史曲线、阈值通知、进程 TOP |
| 防火墙 | `firewall` | **L1.5** | 5：status / rules / allowPort / denyPort / deleteRule | 真实 ufw/iptables 执行、SSH 端口保护、dry-run（`internal/fwop/runner.go`） | 缺 enable/disable、IP 黑白名单、防爆破、变更审计 |
| WAF | `waf` | **L0** | 2：rules / blockLog | 无（`internal/wafop/rules.go:41` 仍 noop） | 缺全部：引擎接入、规则集、观察/拦截模式、IP 封禁 |
| DNS | `dns` | **L0** | 2：zone.list / record.add | 无（`record.add` 只登记提案，`applied:false`） | 缺真实 zone 读写、编辑删除、TXT/SRV、生效检查、reload |
| Redis | `redis` | **L1.5** | 5：instances / info / keys / get / delete（另 config.get/set） | 真实 RESP 连接、键浏览/取值/删除、配置契约（密码 0600） | 缺 set/编辑、TTL 修改、配置调整、慢日志、持久化开关 |
| PostgreSQL | `db-postgres` | **L0** | 2：instances / connections | 无（`internal/pgop/instances.go:45` 仍 noop） | 缺库/表/权限、连接明细、慢查询、备份恢复 |
| Node 运行时 | `runtime-node` | **L0** | 2：versions / allocatePort | 无（`internal/nodeop/noop.go:4`，不探测宿主、不真占端口） | 缺版本探测、切版本、进程守护、扩展、日志 |
| PHP 运行时 | `runtime-php` | **L0** | 2：versions / use | 无（`internal/phpop/versions.go:26`，不真起 FPM） | 缺版本探测、切 FPM、扩展、进程守护、环境变量 |
| Python 运行时 | `runtime-python` | **L0** | 2：versions / venv.create | 无（`internal/pyop/common.go:34` 返 false） | 缺版本探测、真建 venv、依赖管理、进程守护 |
| 容器 | `container` | **L1.5** | 7：list / inspect / logs / start / stop / restart / stats | 真实 docker CLI、生命周期、日志、统计（`internal/containerop/docker.go`） | 缺 exec/shell、镜像管理（G-11 边界需先裁决） |
| 一键部署 | `app-deploy` | **L0** | 2：templates / create | 无（`internal/apop/decode.go:11`，create 不落地） | 缺下载/解压/建库/写 vhost/reload 全链路、进度、卸载升级 |
| 完整性 | `integrity` | **L0** | 2：baseline / verify | 无（摘要取路径字符串，`Scanned:false`） | 缺真实文件 sha256、基线落盘、真实比对、告警、恢复 |
| SSH 加固 | `ssh-guard` | **L1** | 2：status / ban.list | 真实审计规则（5 条）；配置文本由宿主注入，不读真实文件 | 缺读真实 `/etc/ssh/sshd_config`、原子写、`sshd -t`、回滚、封禁执行 |
| 服务发现 | `discover` | **L1.5（新增）** | 3：services / ports / summary | 真实命令探测、`/proc/net` 端口反查、30s 缓存、安装建议 | 缺服务端版本探测（当前报客户端版本，见 §3.5） |
| 验证件 | `echo` | 不参与分级 | 5：ping / echo / slow / timeout / crash | 协议回环、超时、崩溃重启验证 | 非产品能力域，不适用 |

索引仓 `kore-plugins` 仍为 **L2**（24 条索引 / 8 个场景预设 / 3 个校验脚本 / ed25519 签名链）；主壳见 §3.3。

## 3. 主壳（前端）成熟度（3.3）

### 3.3.1 四组导航 · 16 视图

| 导航组 | 视图（id） | 数量 |
| --- | --- | --- |
| 运维 | dashboard / monitor / logs / process / terminal | 5 |
| 业务 | sites / db / redis / tasks | 4 |
| 资源 | files / backup / ssl | 3 |
| 平台 | store / plugins / firewall / settings | 4 |
| **合计** | 16 个视图（`shell.js:49-52` 四组 + `app.js:1077` 基础视图） | **16** |

**本轮新增**：① `web/config-panel.js` 统一配置面板，走 `<id>.config.get/set`，自动字段标「已自动填入」，保存即生效（`docs/PLUGIN-CONFIG.md`）；② 数据库/Redis 页自动检测本机服务 + 一键连接预填（`db.js` / `redis.js`）；③ 建站向导自动填 `/var/www/<域名>`、证书路径自动拼接（`site-edit.js`）；④ Redis 与防火墙视图接入四组导航（`89ba1ea` / `7b85228`）。双端证据：`.agents/verify/round2-full-evidence.md`（34 张，16 PC + 16 手机 + 2 导航）与 `.agents/verify/l2-live.md`（15 张 L2 操作截图）。

### 3.3.2 面板级通用能力

| 能力 | 竞品有 | 我们有 | 现状证据 | 优先级 |
| --- | --- | --- | --- | --- |
| 全局搜索 | 有（站点/文件/功能） | 无 | `shell.js` / `app.js` 无搜索实现；仅商店内局部筛选 | P1 |
| 告警 / 通知中心 | 有（铃铛 + 未读） | 无 | 全仓无 `toast` / `notification` 实现 | P1 |
| 长任务进度 | 有（安装/备份/部署进度条） | 伪 | `store.js:275` 按请求耗时给阶段提示，后端无分阶段事件 | P1 |
| 操作审计入口 | 有（谁在何时做了什么） | 后端有、前端无 | `internal/core/store/audit.go` 有 audit bucket，16 视图无入口 | P1 |
| 首次使用引导 | 有（新手任务/检查清单） | 无 | 无 `onboard` / `guide` 命中 | P2 |
| 快捷键 | 有（搜索/保存/关闭） | 局部有 | 仅 `db.js` Ctrl+Enter、`files.js` Esc，无全局 | P2 |
| 空状态 / 错误边界 / 配置面板 / 自动预填 | 有 | 有 | `app.js` 统一空状态、`shell.js` 三级兜底、`config-panel.js` 自动填入 | 已达标 |
| 主题（深色） | 有 | 无 | `style.css` 无 `prefers-color-scheme` / `data-theme` | P3 |
| 多语言 i18n | 有 | **不做** | G-11 明确不做；当前 `lang="zh-CN"` 硬编码 | 不做 |

## 4. 改造优先级（3.4，Round 3 五批）

排序依据：**用户高频 × 当前真实缺口 × 依赖关系**。批次内可并行，批次间按"前置"执行。

| 批次 | 任务（2–3 项） | 前置依赖 | 为什么排这里 |
| --- | --- | --- | --- |
| **R3-1 主壳通用地板** | ① 全局搜索（视图/插件/站点/文件四源）② 告警中心 + 长任务进度（SSE 分阶段事件）③ 操作审计入口（复用 `store/audit.go`） | 无 | 直接闭合 §3.5-7；后续每个域的进度/告警都复用同一底座 |
| **R3-2 数据库域补到 L2** | ① `db-mysql` 建库/删库/改密/用户授权 ② 导入导出 + 备份恢复入口 ③ `discover` 改探测服务端版本（`SELECT VERSION()` / 端口指纹） | R3-1 的进度与确认组件 | 数据库是最高频管理动作；版本探测不准会让"自动预填"把用户带错 |
| **R3-3 备份 / 计划任务闭环** | ① `backup` 定时 + 保留策略 + 下载 ② `cron` 任务类型（备份/URL）+ 执行日志 + 立即执行 ③ 两者共用"调度 + 日志"模型 | R3-1 的长任务进度 | 备份与任务是一组上下游；不先定调度模型，两个域会各造一套 |
| **R3-4 证书 / 站点收口** | ① `ssl` ACME 签发与自动续期（先出 ADR 定客户端与 DNS 验证）② 证书绑定站点 + 到期倒计时 ③ `site` 容器模式 `site_dir_exists` 改容器内探测 | R3-4② 依赖 `site` vhost 写入点；ACME 依赖 ADR | 建站是对标头号场景；证书不绑站点等于半个功能 |
| **R3-5 剩余 L0 拉 L1** | ① `monitor` 接 `/proc` 真实采样 + 阈值落盘 ② `waf` / `dns` / `db-postgres` 去 noop ③ `runtime-*` / `app-deploy` / `integrity` 打通一条真实链路 | 各自后端选型（先出"执行器设计"ADR） | L0 仍有 9 个，是"半成品"观感的主因；须先定后端，故排最后 |

**不做清单（G-11 复述，避免 Round 3 漂移）**：多用户 RBAC、集群/多机、模板市场、厂商云存储深度集成、拖拽建站、多语言 i18n；另不做容器编排、多租户 SaaS、移动 App、重型主题。

## 5. 本轮新发现的缺口（3.5）

以下 8 条均为 Round 2 收口时**新发现**、且未被 §2 的"仍缺"列完全覆盖的缺口（第 8 条为 Round 3 实测补充）；L0 域的整体 noop 问题见 §2，不在这里重复计数。

| # | 缺口 | 代码事实 / 证据 | 处置建议 |
| --- | --- | --- | --- |
| 1 | `discover` 报的是**客户端版本**，不是服务端版本 | `internal/probe/services.go:74` 对 `bin` 执行 `versionArgs()`；本机 `mysql --version` 回 `11.8.6-MariaDB`（客户端），实际容器为 `mysql:9.7.1` | 改探测服务端：`mysql -e "SELECT VERSION()"`、Redis `INFO server`、或端口指纹；返回体标 `version_source ∈ client/server` |
| 2 | `db-mysql` 仍缺建库/删库/改密/备份/导入导出 | 仅 4 方法；`internal/mysqlop/sqlguard.go` 只放行 SELECT/SHOW/DESCRIBE/EXPLAIN | 补 DDL/DCL 白名单与独立写方法；导入导出走临时文件 + 大小上限；改密需二次确认 |
| 3 | `backup` 缺定时备份/保留策略/异地存储 | 5 方法只做手动 create/list/restore/delete/verify；README 明示 S3 不在插件内 | 补调度（可复用 `cron` 模型）、保留份数、下载；异地存储按 G-11 明确不做，只留外部同步钩子 |
| 4 | `cron` 缺任务类型（备份/URL）、执行日志、立即执行 | 仅 4 个 crontab CRUD 方法 | 补任务类型模板、`run-now`、从 journal/`cron.log` 读执行结果；失败告警接 R3-1 告警中心 |
| 5 | `ssl` 缺 ACME 自动申请与续期 | `methods.go:104` 的 `issue` 返 `E_UNSUPPORTED`；`internal/certs/renew.go:15` 对 ACME 证书同样返 `E_UNSUPPORTED` | v1.1 引入 ACME 客户端 + DNS-01/HTTP-01；未实现前在 UI 明示"需外部签发后导入" |
| 6 | 站点在容器模式下 `site_dir_exists` 只看宿主路径 | `inspect.go:74` 用 `os.Stat(root)`；容器内 root 是容器路径，宿主同路径不存在即误报 false | 只读方法内用 `docker exec <container> test -d <root>`，或返回三态 `unknown（容器模式）`，不伪造 false |
| 7 | 主壳缺全局搜索、告警中心、长任务进度、操作审计入口 | `shell.js` / `app.js` 无搜索；`store.js:275` 仅按时耗伪进度；`internal/core/store/audit.go` 无前端入口 | 合并为 R3-1；进度用 SSE 分阶段事件，审计入口复用现有 audit bucket |
| 8 | 插件凭据无法跨插件传递：`discover` 探测 MySQL / Redis 服务端版本需要 `MYSQL_PWD` / `REDISCLI_AUTH`，密码却在 `db-mysql` / `redis` 的 `config.json` | 两个密码各存各的 0600 `config.json`（`sensitive`），插件间不共享配置；内核无凭据总线，插件进程只继承 kored 环境 → 未注入时 `version_source` 降级为 `client` / `unknown`；当前靠运维手工 `export`，重启即失效 | 按 [PLUGIN-CONFIG.md](./PLUGIN-CONFIG.md) §6.1 候选 A：kored 用 `password` + `password_env` 做机械映射注入（不认业务语义，不违反 G-01）；**v1.0 前必须做** |

| 9 | 槽位被 resident 占满后所有 lazy 插件饿死：`MaxSlots=3` 是 resident + 活跃 lazy 的合并上限，resident 永不驱逐，3 个 resident 并存即无槽可唤醒 lazy | 2026-11-23 实测：`monitor` 声明 `resident` 后与 `site` + `terminal` 占满 3 槽，11 个 lazy 插件（db-mysql / file / backup / redis / logs / firewall / cron / ssl / process / discover / container）调用全部 `429 E_RATELIMIT`；`lazy.go:26` 明写 resident 不可驱逐 | 按 [RESOURCE-MODEL.md](./RESOURCE-MODEL.md) §2.6 候选 A：resident 单独限 2、lazy 至少保留 1 槽；**v1.0 前必须做**（本体已通过 monitor 改 `lazy` 止血） |

## 6. 附录：24 仓方法清单（106 个业务方法）

| 仓库 | 方法数 | 方法名 | 一句话职责 |
| --- | --- | --- | --- |
| `app-deploy` | 2 | templates / create | 列出模板；create 仅骨架，不落地 |
| `backup` | 5 | create / list / restore / delete / verify | 真实 tar.gz 打包、恢复、删除、校验 |
| `container` | 7 | list / inspect / logs / start / stop / restart / stats | 真实 docker CLI 列表、详情、日志、生命周期、统计 |
| `cron` | 4 | list / add / remove / replace | 真实读写系统 crontab |
| `db-mysql` | 4 | instances / databases / query / status | 经 mysql CLI 查实例、库、只读 SQL、状态 |
| `db-postgres` | 2 | instances / connections | 实例与连接（noop，不连库） |
| `discover` | 3 | services / ports / summary | 本机服务、监听端口、安装建议 |
| `dns` | 2 | zone.list / record.add | 列区域；加记录只回提案（`applied:false`） |
| `echo` | 5 | ping / echo / slow / timeout / crash | 验证件：协议回环、超时、崩溃重启计数 |
| `file` | 12 | list / read / write / delete / mkdir / stat / upload / download / extract / compress / chmod / move | 配置根内真实文件读写与 L2 动作 |
| `firewall` | 5 | status / rules / allowPort / denyPort / deleteRule | 真实 ufw/iptables 状态、规则、放行/拒绝/删除 |
| `integrity` | 2 | baseline / verify | 基线/比对（摘要取路径字符串，不读文件） |
| `logs` | 4 | sources / tail / search / stats | 白名单日志源、尾读、搜索、统计 |
| `monitor` | 2 | sample / alert.set | 采样与告警阈值（placeholder，不读 /proc） |
| `process` | 4 | list / detail / kill / tree | 真实 procfs：列表、详情、结束、进程树 |
| `redis` | 5 | instances / info / keys / get / delete | 真实 RESP：实例、信息、键浏览、取值、删除 |
| `runtime-node` | 2 | versions / allocatePort | 版本白名单与端口分配（noop，不真占） |
| `runtime-php` | 2 | versions / use | 版本列表与切换（noop，不真起 FPM） |
| `runtime-python` | 2 | versions / venv.create | 版本列表与建 venv（noop，返 false） |
| `site` | 16 | list / create / delete / status / get / bindSSL / unbindSSL / setRewrite / getRewrite / setProxy / unsetProxy / setRedirect / unsetRedirect / disable / enable / setIndex | 真实写 nginx vhost + test/reload，含容器 nginx |
| `ssh-guard` | 2 | status / ban.list | 读注入文本做 sshd 合规审计；封禁清单恒空 |
| `ssl` | 6 | list / import / selfsign / renew / verify / issue | 真实证书落盘与 x509/TLS 校验；issue 返 `E_UNSUPPORTED` |
| `terminal` | 6 | create / write / resize / read / close / list | 真实 PTY 会话全生命周期 |
| `waf` | 2 | rules / blockLog | 规则与拦截日志（noop，不接 WAF 引擎） |

**证据复现命令**（任何人可重跑核对）：

```bash
# 方法数：按各仓「动词白名单」逐仓计数（site 看 siteverbs.go 的 verbRegistry）
for d in ../kore-plugin-*; do n=${d#../kore-plugin-}; c=$(awk '/^func .*([Vv]erb|normalizeMethod)\(/{f=1} f&&/^\tcase /{print} f&&/^}$/{f=0}' $d/methods.go $d/internal/*/call.go 2>/dev/null | grep -o '"[a-zA-Z][a-zA-Z0-9._]*"' | tr -d '"' | sed "s/^$n\.//" | sort -u | wc -l); printf '%-20s %s\n' "$n" "$c"; done
# 期望：除 site 外 23 仓合计 90（site 走 verbRegistry，上方 awk 得 0 属正常）
grep -cE '^[[:space:]]+"[a-zA-Z]+":' ../kore-plugin-site/siteverbs.go   # 期望 16
# 90 + 16 = 106 个业务方法；config.get/set 不计入，另有 5 仓（下方）
# 配置契约：5 仓（site / logs / backup / db-mysql / redis）
grep -rl '"config.get"' ../kore-plugin-*/ --include='*.go' | grep -v _test | cut -d/ -f2 | sort -u
# noop/placeholder 执行器：7 仓（app-deploy / db-postgres / monitor / runtime-node / runtime-php / runtime-python / waf）
grep -rl "noopExecutor\|placeholderExecutor" ../kore-plugin-*/internal/*/*.go | cut -d/ -f1 | sort -u
# 主壳视图：shell.js 四组 16 项 + app.js 基础视图
grep -n "title: '" web/shell.js; grep -n "id: 'dashboard'" web/app.js
```
