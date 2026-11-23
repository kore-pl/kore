> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5

# PLUGIN-MATURITY — 插件与主壳成熟度分级 · 功能矩阵 · 改造优先级

## 0. 口径

| 项 | 内容 |
| --- | --- |
| 读者 | 产品评审、lead 拆解 Round 5、implementer 领活、red-team 找缺口 |
| 作用 | 回答"每个能力域现在是什么水平、离能用差哪些动作、先补哪个"，作为后续补全的唯一依据 |
| 不作用 | 不替代 [FEATURE-PARITY.md](./FEATURE-PARITY.md)（对标归属）、[PARITY-GAP.md](./PARITY-GAP.md)（差距账）、[PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md)（字段规格） |
| 盘点方法 | 逐仓读 `methods.go` / `internal/*/call.go` / `README.md`，再核对真实副作用（`os/exec`、真实文件读写、网络连接、非 `noopExecutor`）；**不采信 README 自述**，级别只认代码事实 |
| 盘点基线 | 24 个 `kore-plugin-*` 仓、**127 个业务方法**（不含 `config.get/set`；含 `echo` 5 个验证方法，23 个产品仓合计 122）、主壳 **16 视图 / 四组导航**、**6 个仓有配置契约**（`site` / `logs` / `backup` / `db-mysql` / `redis` / `db-postgres`）；`echo` 为验证件，不参与 L 分级 |
| 竞品口径 | 宝塔面板 / 1Panel 专业版**公开功能**的常识描述；无法确认的项标"待核实"，不臆造 |
| 盘点范围 | 任务给定的 **24 个** `kore-plugin-*` 仓；`discover` 自 Round 2 起纳入，不留在表外 |

**当前结论一句话**：23 个可分级仓里 **L0 2 / L1 1 / L1.5 16 / L2 4 / L3 0**——Round 4 把 6 个 L0 仓（`app-deploy` / `integrity` / `runtime-node` / `runtime-php` / `runtime-python` / `db-postgres`）拉到 L1.5，`monitor` 换成真实 `/proc` 采集；Round 3 把 `db-mysql` 推到 11 方法 + 双端页面（L2）。剩下的结构性缺口不再是"执行器全是 noop"，而是 **提权只证了拒绝路径**（R5-1）、**插件级 capability 让只读方法也进审计**（R5-2）与 **`runtime-php` / `runtime-python` 0.2.0 未入索引**（§3.5 第 10 条）。

## 1. 成熟度分级定义（3.1）

| 级别 | 定义 | 判据 | 判定方法 |
| --- | --- | --- | --- |
| **L0 骨架** | 只有参数校验与占位返回 | 无真实副作用 | 执行器是 `noopExecutor` / `placeholderExecutor` / 返回 `applied:false` / 摘要由路径字符串算出 |
| **L1 能干活** | 核心动作有真实副作用 | 至少 1 个方法真操作系统/文件/网络 | 有 `os.WriteFile` / `exec.Command` / PTY / 真实证书落盘 |
| **L1.5 接线完成（L1 子档）** | 真实后端已接通、核心读写可用，但日常动作覆盖 <80% | 有真实 exec/文件/网络；有配置契约更佳 | 方法数 + 竞品日常动作命中率 + 无 noop；单列排期，不计入 L2 |
| **L2 可用** | 覆盖该能力域日常操作 + 错误可理解 | 该域 80% 日常动作可用；错误给人话；有双端页面 | 逐条数日常动作命中率 + 读视图错误文案 + 认 `.agents/verify/` 双端证据 |
| **L3 完整** | 对标竞品同类功能，含进阶与管理能力 | 竞品该域核心能力项 ≥90% 覆盖；有引导/预设/批量 | 按 §2 竞品列逐项打勾 |

**判级纪律**：级别只认代码事实（`file:line`）；"能编译 + 单测绿"不进任何一级的判据；L2 的"双端页面"指 PC 与手机各一张实拍图，接口 200 不算。L1.5 是 Round 2 为"接线完成但未达日常覆盖"新增的子档，不改变 L0–L3 主级定义。

## 2. 功能矩阵（3.2，24 个插件仓）

| 能力域 | 插件 | 现级别 | 现有方法（数量） | 已补（代码事实） | 仍缺（到 L2 / L3） |
| --- | --- | --- | --- | --- | --- |
| 站点（web） | `site` | **L2+** | 16：list / create / delete / status / get / bindSSL / unbindSSL / setRewrite / getRewrite / setProxy / unsetProxy / setRedirect / unsetRedirect / disable / enable / setIndex（另 config.get/set） | SSL 绑定、伪静态、反代、重定向、启停、index；容器 nginx 走 `docker exec`（`nginxdocker.go`） | 缺克隆、密码访问、流量统计、ACME 联动；容器模式 `site_dir_exists` 只看宿主（见 §3.5） |
| 文件 | `file` | **L2** | 12：list / read / write / delete / mkdir / stat / upload / download / extract / compress / chmod / move | 上传下载、解压压缩、改权限、移动；根目录内真实读写（`internal/fileop/`） | 缺 rename/copy、搜索、回收站、批量、断点续传、在线编辑 |
| MySQL | `db-mysql` | **L2** | 11：instances / databases / query / status / createDatabase / dropDatabase / createUser / dropUser / grant / export / import（另 config.get/set） | Round 3 补建库/删库/建用户/删用户/授权/导入导出（`internal/mysqlop/call.go:22-48`）+ 双端页面（`web/db-l2.js`）；写方法要求 `system:admin`、删库/删用户强制 `confirm`、系统库与 root 保护 | 缺改密（ALTER USER）、慢查询分析、多实例切换 UI；备份归 `backup` 插件 |
| 计划任务 | `cron` | **L1.5** | 4：list / add / remove / replace | 真实 `crontab` 读写、写前备份、失败回滚 | 缺启停、立即执行、执行日志、任务类型（备份/URL） |
| 终端 | `terminal` | **L2** | 6：create / write / resize / read / close / list | 真实 PTY 全生命周期、增量读写 | 缺多标签、断线重连、命令历史、字号/全屏 |
| 日志 | `logs` | **L1.5** | 4：sources / tail / search / stats（另 config.get/set） | 真实文件与 `journalctl` 读取、since 过滤、搜索、统计、配置契约 | 缺实时跟踪、下载、清理、切割、按站点聚合 |
| 进程 | `process` | **L1.5** | 4：list / detail / kill / tree | 真实 procfs：CPU 差分、详情、信号白名单、进程树 | 缺端口/fd 归属、优先级、守护自启、资源趋势 |
| SSL 证书 | `ssl` | **L1.5** | 6：list / import / selfsign / renew / verify / issue（issue 返 `E_UNSUPPORTED`） | 真实证书落盘、x509 解析、TLS 探测、自签续期 | 缺 ACME 签发/自动续期、绑定站点、到期提醒、强制 HTTPS |
| 备份 | `backup` | **L1.5** | 5：create / list / restore / delete / verify（另 config.get/set） | 标准库 tar.gz 真实打包、原子恢复、sha256 校验、配置契约 | 缺定时、保留策略、下载、进度、站点/数据库维度 |
| 监控 | `monitor` | **L1.5** | 4：system / processes / disks / temperature | 真实 `/proc` 采集（`internal/monitor/collector_*.go`，零 ticker、非 Linux `E_UNSUPPORTED`）；主壳监控页读插件数据（`web/monitor-cards.js`）；`alert.set` 已移除 | 缺历史曲线、阈值告警（无通知中心）、进程 TOP 排序、跨平台真实实现 |
| 防火墙 | `firewall` | **L1.5** | 5：status / rules / allowPort / denyPort / deleteRule | 真实 ufw/iptables 执行、SSH 端口保护、dry-run（`internal/fwop/runner.go`）；`requires_root` + 5 个 `root_actions` 走内核通道（ADR-0018），非 root 返 `E_NEED_ROOT`（不是 401） | 缺**提权成功路径**（真 root 未证，R5-1）、enable/disable、IP 黑白名单、防爆破、变更审计 |
| WAF | `waf` | **L0** | 2：rules / blockLog | 无（`internal/wafop/rules.go:41` 仍 noop） | 缺全部：引擎接入、规则集、观察/拦截模式、IP 封禁 |
| DNS | `dns` | **L0** | 2：zone.list / record.add | 无（`record.add` 只登记提案，`applied:false`） | 缺真实 zone 读写、编辑删除、TXT/SRV、生效检查、reload |
| Redis | `redis` | **L1.5** | 5：instances / info / keys / get / delete（另 config.get/set） | 真实 RESP 连接、键浏览/取值/删除、配置契约（密码 0600） | 缺 set/编辑、TTL 修改、配置调整、慢日志、持久化开关 |
| PostgreSQL | `db-postgres` | **L1.5** | 5 个入口：config.get/set + instances / databases / query / status（业务方法 4） | 0.2.0 去 noop：`psql` 子进程 / `docker exec` 两级回退、真实库大小与状态、只读 SQL 白名单（拒多语句/`SELECT INTO`/加锁读/副作用函数）、配置契约（密码 `PGPASSWORD`/stdin，不进 argv） | 缺建库/删库/用户权限、慢查询、备份恢复、**前端页面**（`web/` 无 `db-postgres.*` 调用，见 R5-3） |
| Node 运行时 | `runtime-node` | **L1.5** | 4：versions / info / projects / doctor | 0.2.0 真实探测宿主 Node（PATH / 多路径 / 真实路径去重）、`node -v` / `npm -v`、项目扫描（package.json）、健康检查 | 缺切版本、进程守护、扩展管理、前端页面 |
| PHP 运行时 | `runtime-php` | **L1.5** | 4：versions / info / projects / doctor | 0.2.0 真实检测 PHP CLI（phpenv / 多路径 / 软链去重）、`php -v` / `-m` / `-i`、项目扫描（composer.json）、健康检查 | 缺切 FPM 版本、扩展安装、进程守护、前端页面 |
| Python 运行时 | `runtime-python` | **L1.5** | 4：versions / info / projects / doctor | 0.2.0 真实检测 Python（pyenv / conda / 多路径）、`--version` / pip / site-packages / 包数、项目扫描（pyproject / requirements）、健康检查；移除骨架方法 `venv.create` | 缺建 venv、依赖安装、进程守护、前端页面 |
| 容器 | `container` | **L1.5** | 7：list / inspect / logs / start / stop / restart / stats | 真实 docker CLI、生命周期、日志、统计（`internal/containerop/docker.go`） | 缺 exec/shell、镜像管理（G-11 边界需先裁决） |
| 一键部署 | `app-deploy` | **L1.5** | 4：templates / deploy / list / remove | 0.2.0 内置 4 模板（nginx-static / wordpress / redis / postgres）经 docker CLI 真部署；端口冲突检测与顺延、内存限额、记录 0600、失败回滚、外部容器护栏；骨架方法 `create` 移除 | 缺下载/解压到宿主、建库、写 vhost/reload 联动、升级与进度、前端页面 |
| 完整性 | `integrity` | **L1.5** | 4：baseline / check / status / verify_file | 0.2.0 真实 sha256 基线（递归 ≤10 层 / 10000 条、单文件 8 GiB 上限）、added/removed/modified 对比、单文件校验；基线 0600 原子写、符号链接二次归属 | 缺定时扫描、告警、恢复/回滚、基线多版本、前端页面 |
| SSH 加固 | `ssh-guard` | **L1** | 2：status / ban.list | 真实审计规则（5 条）；配置文本由宿主注入，不读真实文件 | 缺读真实 `/etc/ssh/sshd_config`、原子写、`sshd -t`、回滚、封禁执行 |
| 服务发现 | `discover` | **L1.5** | 3：services / ports / summary | 真实命令探测、`/proc/net` 端口反查、30s 缓存、安装建议；服务端版本可直连探测（`version_source=server`，探不到降级 client/unknown） | 缺其他服务指纹、安装动作；凭据跨插件传递受阻（§3.5 #8） |
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
| **合计** | 16 个视图（`shell.js:49-52` 四组 + `app.js:1321-1330` 基础视图） | **16** |

**Round 4 新增**：① **全局搜索**（`web/search.js`，四源：页面 / 已装插件 / 商店 / 操作；`shell.js:316-363` 入口，Ctrl/Cmd+K、手机 44px；懒加载不进首屏）；② **操作审计入口**（设置页「操作审计」tab，`web/audit.js` + `GET /api/v1/audit`；登录成功/失败 + 写类调用审计 + 1s 内 >10 次合并、只读调用不落库，证据 `.agents/verify/round4-audit.md`）；③ 监控页接 monitor 插件 `/proc` 数据（`f39e1fd`）。**审计是设置页 tab，不新增第 17 个视图**——视图数仍 16。

**更早轮次**：统一配置面板（`web/config-panel.js`，走 `<id>.config.get/set`）、数据库/Redis 自动检测与预填、建站向导自动填路径、Redis/防火墙接入四组导航（`89ba1ea` / `7b85228`）；双端证据：`.agents/verify/round2-full-evidence.md`（34 张）与 `l2-live.md`（15 张 L2 操作截图）。

### 3.3.2 面板级通用能力

| 能力 | 竞品有 | 我们有 | 现状证据 | 优先级 |
| --- | --- | --- | --- | --- |
| 全局搜索 | 有（站点/文件/功能） | **有**（四源：页面 / 已装插件 / 商店 / 操作） | `search.js` 四组结果 + `shell.js:316-363` 入口（Ctrl/Cmd+K）；商店/插件数据懒加载 | 已达标 |
| 告警 / 通知中心 | 有（铃铛 + 未读） | 无 | 全仓无 `toast` / `notification` 实现 | P1 |
| 长任务进度 | 有（安装/备份/部署进度条） | 伪 | `store.js:275` 按请求耗时给阶段提示，后端无分阶段事件 | P1 |
| 操作审计入口 | 有（谁在何时做了什么） | **有**（设置页「操作审计」tab） | `web/audit.js` + `GET /api/v1/audit`：登录成功/失败 + 写类调用（含失败）+ 突发合并；只读调用不落库（`round4-audit.md`） | 已达标 |
| 首次使用引导 | 有（新手任务/检查清单） | 无 | 无 `onboard` / `guide` 命中 | P2 |
| 快捷键 | 有（搜索/保存/关闭） | 局部有 | 全局 Ctrl/Cmd+K 搜索已落地；其余仅 `db.js` Ctrl+Enter、`files.js` Esc | P2 |
| 空状态 / 错误边界 / 配置面板 / 自动预填 | 有 | 有 | `app.js` 统一空状态、`shell.js` 三级兜底、`config-panel.js` 自动填入 | 已达标 |
| 主题（深色） | 有 | 无 | `style.css` 无 `prefers-color-scheme` / `data-theme` | P3 |
| 多语言 i18n | 有 | **不做** | G-11 明确不做；当前 `lang="zh-CN"` 硬编码 | 不做 |

## 4. 改造优先级（3.4，Round 5 五批）

排序依据：**安全链路上游 × 承重能力 × 依赖关系**。批次内可并行，批次间按"前置"执行；R5-1 是唯一没有前置的批次（其余都要复用它的提权通道与授权口径）。

| 批次 | 任务（2–3 项） | 前置依赖 | 为什么排这里 |
| --- | --- | --- | --- |
| **R5-1 提权成功路径** | ① 真 root 下跑通 firewall `root-action` 成功路径（`ufw-status` 读状态、`ufw-allow` 改规则、审计留痕、幂等/回滚）② `waf` / `dns` 接真实后端并声明 `requires_root` + `root_actions`（WAF 规则落地、zone 写入 + reload）③ 非 root 仍 `available=false` + 可操作 hint（不回 401） | 无（复用 ADR-0018 通道） | 现在只证了**拒绝**路径（round3-closeout：status 200 + `E_NEED_ROOT`、rules 403），成功路径没在真 root 下跑过；waf/dns 的真实后端必然要 root，先证通道再写后端，避免每个插件各造一套 sudo |
| **R5-2 方法级 capability 声明** | ① `info.json` 增加**方法级** capability（只读 `system:read` / 写 `system:admin`）② 内核授权与审计按方法粒度取用（守住 G-01：只认 6 个 `system:`/`net:`/`proc:` 能力与 `<id>:<action>`，不维护业务词表）③ `db-mysql` 只读方法不再被审计 + 回归测试 | R5-1（提权通道的授权口径先稳定） | 当前是**插件级** `system:admin`：`db-mysql.instances` 这类只读调用也按 admin 类进审计（round4-audit §6），噪声会盖住真实写操作——审计可信度依赖方法级声明 |
| **R5-3 数据库前端** | ① `db-postgres` 前端（实例 / 库 / 查询 / 状态 + 配置面板，复用 `db.js` 组件）② `db-mysql` / `db-postgres` 统一数据库视图（引擎切换，不复制两套页面）③ 改密方法与二次确认 | R5-2（写方法按方法级 capability 授权） | `db-postgres` 有后端无前端（`web/` 零 `db-postgres.*` 调用），装了也用不上；统一视图防止两套页面漂移 |
| **R5-4 备份 / 任务 / 证书闭环** | ① `backup` 定时 + 保留策略 + 下载 ② `cron` 任务类型（备份/URL）+ 执行日志 + 立即执行 ③ `ssl` ACME 签发与自动续期（先出 ADR 定客户端与 DNS-01/HTTP-01） | R5-1（调度与证书续期都走 root 动作）；② 依赖 ① 的调度模型 | 三件事共用"调度 + 失败通知"模型，一次定模型省两套；ACME 不定客户端就会各写各的 |
| **R5-5 槽位保护** | ① `MaxSlots` 内 resident 单独限 2、lazy 独占至少 1 槽（[RESOURCE-MODEL.md](./RESOURCE-MODEL.md) §2.6 候选 A）② 第 3 个 resident `enable` 返回明确错误 + 可操作提示 ③ `resident_slots_test.go` 增「2 resident + 1 lazy 仍可唤醒」 | 无 | ✅ **已落地**（见 §3.5 #9）：设计债已造成 11 个 lazy 插件全 429 的 P1 事故（`CS-20261123-01`）；结构性保证不依赖插件作者自觉声明 lifecycle |

**不做清单（G-11 复述，避免 Round 5 漂移）**：多用户 RBAC、集群/多机、模板市场、厂商云存储深度集成、拖拽建站、多语言 i18n；另不做容器编排、多租户 SaaS、移动 App、重型主题。

## 5. 缺口清单（3.5）

口径：**Round 2/3 记录的 9 条 + Round 4 盘点新增 3 条 = 12 条**；§2 的"仍缺"列不重复计数。状态只有三种：`已补` / `部分补` / `仍在`。

| # | 缺口 | 状态 | 代码事实 / 证据 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | `discover` 报的是**客户端版本** | **已补** | `internal/probe/server_version.go` 按 `ServerProbe` 直连探测（MySQL `SELECT VERSION()` / Redis `INFO server`），`VersionSource=server`；探不到才降级 `client` / `unknown`，字段始终出现 | 结案；凭据缺失时的降级仍见 #8 |
| 2 | `db-mysql` 缺建库/删库/改密/备份/导入导出 | **部分补** | 0.3.0 已有 11 方法（含 createDatabase / dropDatabase / createUser / dropUser / grant / export / import）+ `web/db-l2.js` 双端页面；仍缺改密与备份 | 改密进 R5-3；备份归 R5-4 |
| 3 | `backup` 缺定时备份/保留策略/异地存储 | 仍在 | 5 方法只做手动 create/list/restore/delete/verify；README 明示 S3 不在插件内 | R5-4（异地按 G-11 明确不做，只留外部同步钩子） |
| 4 | `cron` 缺任务类型（备份/URL）/执行日志/立即执行 | 仍在 | 4 个 crontab CRUD 方法 | R5-4 |
| 5 | `ssl` 缺 ACME 自动申请与续期 | 仍在 | `methods.go:104` 的 `issue` 返 `E_UNSUPPORTED`；`internal/certs/renew.go:15` 对 ACME 证书同样返回 | R5-4（先出 ADR：客户端与 DNS-01/HTTP-01） |
| 6 | 站点容器模式 `site_dir_exists` 只看宿主路径 | 仍在 | `inspect.go:74` 仍 `os.Stat(root)`；容器内 root 在宿主不存在会误报 false | 单列任务（`docker exec test -d` 或返回三态 `unknown`），不塞进 R5 任一批 |
| 7 | 主壳缺全局搜索/审计入口/告警中心/长任务进度 | **部分补** | 搜索（`web/search.js` 四源 + Ctrl/Cmd+K）与审计入口（`web/audit.js` + `GET /api/v1/audit`，`round4-audit.md`）已交付；告警中心与长任务进度仍无（`store.js:275` 仍是伪进度） | 告警/进度不单独造底座，随 R5-4 的备份/任务失败通知先落最小模型 |
| 8 | 插件凭据无法跨插件传递 | 仍在 | kored 无 `password_env` 注入（`grep -rn password_env internal cmd` 零命中）；`discover` 探服务端版本仍需 `MYSQL_PWD` / `REDISCLI_AUTH`；按 [PLUGIN-CONFIG.md](./PLUGIN-CONFIG.md) §6.1 候选 A | v1.0 前必须做，与 R5-2 的最小权限模型同批评审 |
| 9 | `resident` 占满槽位后 lazy 饿死 | **已补** | R5-5 落地候选 A：`resident_max=2` + lazy 保底 1 槽（`internal/core/supervisor/{manager,lazy}.go` 的 `startResident`/`admitResident`）；第 3 个 resident 的 enable/invoke 返 `E_RATELIMIT` + 当前 resident 列表；`resources.resident_max` 可配 1–3；`resident_slots_test.go` 覆盖 2+1 事故回归与 2+3 交替；隔离实例 18851 实测 2 resident + monitor lazy → `monitor.system` 200。**诚实披露：显式 `resident_max=3` 会放弃保护、事故仍可复现** | 结案；候选 B/C 未采用（见 §2.6） |
| 10 | **`runtime-php` / `runtime-python` 0.2.0 未入索引** | 仍在 | 逐仓比对：24 条里 22 条 `info.json.version == index.version`；两仓 `info.json` / `manifest.json` 均 0.2.0、tag `v0.2.0` 已在远端，索引仍是 0.1.1（未重签） | 第二十七次重签并入 `CS-R4-01` 后续提交；重签前商店装到的是 0.1.1（旧方法面） |
| 11 | **提权只验证了拒绝路径** | 仍在 | round3-closeout：非 root 下 `firewall.status` 200 + `error_code=E_NEED_ROOT`、`firewall.rules` 403；`root-action` 成功路径（真 root）未跑过；`waf` / `dns` 真实后端同样要 root | R5-1 |
| 12 | **插件级 capability 让只读方法也进审计** | 仍在 | `round4-audit.md` §6：`db-mysql` 只声明 `system:admin`，`db-mysql.instances` 也按 admin 类落审计；协议当前不支持方法级声明，内核不得维护业务词表（G-01） | R5-2（方法级 capability 声明） |

汇总：**12 条 = 已补 2（#1 #9）/ 部分补 2（#2 #7）/ 仍在 8（#3 #4 #5 #6 #8 #10 #11 #12）**；其中 v1.0 前必须 2 条（#8 #10），#10 是发布链阻断项。

## 6. 附录：24 仓方法清单（127 个业务方法）

| 仓库 | 方法数 | 方法名 | 一句话职责 |
| --- | --- | --- | --- |
| `app-deploy` | 4 | templates / deploy / list / remove | 内置 4 模板经 docker 真部署、记录、回滚 |
| `backup` | 5 | create / list / restore / delete / verify | 真实 tar.gz 打包、恢复、删除、校验 |
| `container` | 7 | list / inspect / logs / start / stop / restart / stats | 真实 docker CLI 列表、详情、日志、生命周期、统计 |
| `cron` | 4 | list / add / remove / replace | 真实读写系统 crontab |
| `db-mysql` | 11 | instances / databases / query / status / createDatabase / dropDatabase / createUser / dropUser / grant / export / import | 真实 mysql CLI：只读查询 + 建库/删库/用户/授权/导入导出 |
| `db-postgres` | 4（另 config.get/set） | instances / databases / query / status | psql 或 docker exec 真连接、只读 SQL 白名单 |
| `discover` | 3 | services / ports / summary | 本机服务、监听端口、安装建议；服务端版本可探 |
| `dns` | 2 | zone.list / record.add | 列区域；加记录只回提案（`applied:false`） |
| `echo` | 5 | ping / echo / slow / timeout / crash | 验证件：协议回环、超时、崩溃重启计数 |
| `file` | 12 | list / read / write / delete / mkdir / stat / upload / download / extract / compress / chmod / move | 配置根内真实文件读写与 L2 动作 |
| `firewall` | 5 | status / rules / allowPort / denyPort / deleteRule | 真实 ufw/iptables 状态、规则、放行/拒绝/删除；root 走内核通道 |
| `integrity` | 4 | baseline / check / status / verify_file | 真实 sha256 基线、比对、单文件校验；基线 0600 原子写 |
| `logs` | 4 | sources / tail / search / stats | 白名单日志源、尾读、搜索、统计 |
| `monitor` | 4 | system / processes / disks / temperature | 真实 `/proc` 采集系统/进程/磁盘/温度，零 ticker |
| `process` | 4 | list / detail / kill / tree | 真实 procfs：列表、详情、结束、进程树 |
| `redis` | 5 | instances / info / keys / get / delete | 真实 RESP：实例、信息、键浏览、取值、删除 |
| `runtime-node` | 4 | versions / info / projects / doctor | 真实探测 Node 版本、详情、项目扫描、健康检查 |
| `runtime-php` | 4 | versions / info / projects / doctor | 真实检测 PHP CLI、ini/扩展、项目、健康检查 |
| `runtime-python` | 4 | versions / info / projects / doctor | 真实检测 Python、pip/site-packages、项目、健康检查 |
| `site` | 16 | list / create / delete / status / get / bindSSL / unbindSSL / setRewrite / getRewrite / setProxy / unsetProxy / setRedirect / unsetRedirect / disable / enable / setIndex | 真实写 nginx vhost + test/reload，含容器 nginx |
| `ssh-guard` | 2 | status / ban.list | 读注入文本做 sshd 合规审计；封禁清单恒空 |
| `ssl` | 6 | list / import / selfsign / renew / verify / issue | 真实证书落盘与 x509/TLS 校验；issue 返 `E_UNSUPPORTED` |
| `terminal` | 6 | create / write / resize / read / close / list | 真实 PTY 会话全生命周期 |
| `waf` | 2 | rules / blockLog | 规则与拦截日志（noop，不接 WAF 引擎） |

**证据复现命令**（任何人可重跑核对）：

```bash
# 方法数：按各仓分发 switch 的 case 字面量计数（site 走 verbRegistry；config.* / kore.* 不计）
for d in ../kore-plugin-*; do n=${d#../kore-plugin-}; c=$(grep -hE '^[[:space:]]*case ' $d/methods.go $d/internal/*/call.go $d/internal/*/runtime.go 2>/dev/null | grep -oE '"[a-zA-Z][a-zA-Z0-9._]*"' | tr -d '"' | sed "s/^$n\.//" | grep -vE '^(kore\.|config\.)' | sort -u | wc -l); printf '%-20s %s\n' "$n" "$c"; done
# 期望：site = 0（走 verbRegistry），其余 23 仓合计 111；site 另计 16 → 127
grep -cE '^[[:space:]]+"[a-zA-Z]+":' ../kore-plugin-site/siteverbs.go   # 期望 16
# 配置契约：6 仓（site / logs / backup / db-mysql / redis / db-postgres）
grep -rl '"config.get"' ../kore-plugin-*/ --include='*.go' | grep -v _test | cut -d/ -f2 | sort -u
# 版本 vs 索引（24 行；本轮盘点时 runtime-php / runtime-python 期望 MISMATCH）
python3 - <<'PY'
import json, os
idx = {p['id']: p['version'] for p in json.load(open('../kore-plugins/index/plugins.json'))['plugins']}
for d in sorted(x for x in os.listdir('..') if x.startswith('kore-plugin-')):
    info = json.load(open(os.path.join('..', d, 'info.json')))
    i = idx.get(info['id'])
    print("%-16s info=%-6s index=%-6s %s" % (info['id'], info['version'], i, 'OK' if i == info['version'] else 'MISMATCH'))
PY
# 主壳视图：shell.js 四组 16 项 + app.js 基础视图
grep -n "title: '" web/shell.js; grep -n "id: 'dashboard'" web/app.js
# 全局搜索 / 操作审计入口
grep -n "KoreSearch\|search.js" web/shell.js; grep -n "/api/v1/audit" web/audit.js internal/core/httpapi/handlers_audit.go
```
