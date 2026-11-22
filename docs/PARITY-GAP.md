> 状态: draft · 归属: lead · 更新: 2026-11-22 · 里程碑: M4

# PARITY-GAP — 现状 vs 目标：对标宝塔 / 1Panel 专业版的可执行差距账

## 0. 口径

- **22 能力域 / 12 生产级 / 8 基础级 / 6 不做**：20 个产品插件（12 生产级 + 8 基础级）覆盖 22 域（`site` 一插件覆盖站点/域名/反代 3 域），另 6 项明确不做；`echo` 为验证件、不评级。来源 `V1-GOALS.md:23`、`ROADMAP.md:316`。
- **v1.0 = Linux GA**；macOS 12+ / Windows 10 1809+ 为 preview（仅交叉编译 + 基础链路，不计入 gate）。来源 `ROADMAP.md:14`、`ROADMAP.md:346`。
- 口径差异留痕：`.agents/BOARD.md:163` 已记 `FEATURE-PARITY.md:12` 的"14 生产级域"与 `V1-GOALS.md:23` 的"12 生产级插件"是域数 vs 插件数两种说法，本账按 V1-GOALS 计。
- 状态口径：**已实现**只认代码事实（`file:line` / commit），不认文档宣称；**骨架** = 代码在但核心动作未落地；**未开始** = 无仓库/无代码；**不做** = G-11 非目标。不确定项标"未验证"。
- 里程碑口径：`.agents/BOARD.md:49-52` 记 M0–M3 均 completed；`make check` 10/10（BOARD:51-52）。本账更新于 HEAD `e2043da`。

## 1. 现状盘点

### 1.1 覆盖域盘点（22 行）

"未开始"的统一证据：2026-11-22 磁盘核查 `for id in <20 id>; do ls -d ../kore-plugin-$id; done` 仅 `site` / `echo` 存在；`../kore-plugins/index/plugins.json:3-37` 仅 echo、site 两条。下表每行证据列不再重复此句。

| 能力域 | 对标功能（宝塔/1Panel 专业版） | kore 现状 | 证据（file:line / commit） | 归属仓库 |
| --- | --- | --- | --- | --- |
| 站点管理 | 站点生命周期 + 目录/端口/日志隔离 | 骨架 | `../kore-plugin-site/main.go:3-5`（自述只做参数校验、不写 nginx conf）；`info.json:7` | kore-plugin-site |
| 域名与伪静态 | 域名绑定 + 伪静态模板库 | 骨架 | 同上（`site` 一插件覆盖此域，无 vhost 写入） | kore-plugin-site |
| 反向代理 | 可视化 upstream + 路径规则 | 骨架 | 同上（`site` 覆盖此域） | kore-plugin-site |
| SSL 证书与自动续期 | ACME 签发 / 自动续期 | 未开始 | 索引 `plugins.json:3-37` 无 `ssl`；仓不存在 | kore-plugin-ssl |
| PHP 运行时 | 多版本 FPM 管理 | 未开始 | 索引无 `runtime-php`；仓不存在 | kore-plugin-runtime-php |
| Node 运行时 | 进程守护 + 端口分配 | 未开始 | 索引无 `runtime-node`；仓不存在 | kore-plugin-runtime-node |
| Python 运行时 | venv + gunicorn 模板 | 未开始 | 索引无 `runtime-python`；仓不存在 | kore-plugin-runtime-python |
| MySQL/MariaDB 管理 | 实例管理 + 慢查询 + 备份钩子 | 未开始 | 索引无 `db-mysql`；仓不存在 | kore-plugin-db-mysql |
| PostgreSQL 管理 | 实例 + 连接 + 备份钩子 | 未开始 | 索引无 `db-postgres`；仓不存在 | kore-plugin-db-postgres |
| Redis | 实例 + 内存策略 + 键扫描 | 未开始 | 索引无 `redis`；仓不存在 | kore-plugin-redis |
| 文件管理 | 在线编辑 / 上传 / 解压 / 权限 | 未开始 | 索引无 `file`；仓不存在 | kore-plugin-file |
| 计划任务 cron | 任务定义 + 执行记录 + 日志 | 未开始 | 索引无 `cron`；仓不存在 | kore-plugin-cron |
| 系统监控与告警 | 采样 + 阈值告警 | 未开始 | 索引无 `monitor`；仓不存在 | kore-plugin-monitor |
| 防火墙/端口 | 规则管理 + 端口放行 | 未开始 | 索引无 `firewall`；仓不存在 | kore-plugin-firewall |
| WAF | 规则集 + 拦截日志 | 未开始 | 索引无 `waf`；仓不存在 | kore-plugin-waf |
| SSH 加固 | 失败封禁 + 配置审计 | 未开始 | 索引无 `ssh-guard`；仓不存在 | kore-plugin-ssh-guard |
| 木马/文件完整性 | 关键文件哈希基线 + 变更告警 | 未开始 | 索引无 `integrity`；仓不存在 | kore-plugin-integrity |
| 备份（本地 + S3） | 本地 + S3 兼容对象存储 | 未开始 | 索引无 `backup`；仓不存在（BOARD:132 归 M2 但未落地） | kore-plugin-backup |
| 日志查看分析 | 按来源分流 + 关键字过滤 | 未开始 | 索引无 `logs`；仓不存在 | kore-plugin-logs |
| 一键部署应用 | WordPress/Laravel/Next.js 模板 | 未开始 | 索引无 `app-deploy`；仓不存在 | kore-plugin-app-deploy |
| DNS | 区域/记录管理 | 未开始 | 索引无 `dns`；仓不存在 | kore-plugin-dns |
| 容器管理 | Docker/Podman 面板（可选） | 未开始 | 索引无 `container`；仓不存在 | kore-plugin-container |

### 1.2 明确不做（6 项）

来源 `V1-GOALS.md:73`、`FEATURE-PARITY.md:89-98`；G-11 拦截，不进任何里程碑。

| 不做项 | 判定证据 | 归属仓库 |
| --- | --- | --- |
| 多用户 RBAC | `V1-GOALS.md:73`（单管理员 + audit 审计） | — |
| 集群 / 多机 | `V1-GOALS.md:73` | — |
| 模板市场 | `V1-GOALS.md:73` | — |
| 厂商云存储深度集成 | `V1-GOALS.md:73`（只做 S3 兼容协议） | — |
| 拖拽建站 | `V1-GOALS.md:73` | — |
| 多语言 i18n | `V1-GOALS.md:73` | — |

### 1.3 内核与平台机制（非 22 能力域，单列以免与"已实现能力域"混淆）

| 机制 | 现状 | 证据（file:line / 产物） |
| --- | --- | --- |
| 单管理员鉴权（PBKDF2 + 会话） | 已实现 | `internal/core/auth/password.go:30`、`session.go:44`、`httpapi/handlers_auth.go` |
| 商店后端 + store 三端点（未装配回 501） | 已实现 | `internal/core/market/market.go:52`、`httpapi/handlers_store.go:46`、`market/store_endpoints_test.go` |
| lazy 生命周期 + 冷启 p95 实测 | 已实现 | `internal/core/supervisor/lazy.go`、`coldstart_p95_test.go`、`idle.go`（BOARD:52 两轮 p95 2.87/3.68 ms） |
| audit 写入 + 四类生命周期事件 | 已实现 | `internal/core/store/audit.go:54`、`supervisor/audit.go:55`、`store/audit_events_test.go:14` |
| 主壳前端 | 已实现 | `web/dist/index.html`（372 B）、`app.js`、`style.css`（BOARD:51 首屏 4151 B） |
| 其余内核模块 store/bus/installer/registry/httpapi/config/envprobe | 已实现 | `internal/core/store/store.go:47`、`bus/bus.go:59`、`installer/installer.go:64`、`registry/catalog.go:52`、`httpapi/server.go:55`、`config/config.go:75`、`envprobe/probe.go` |
| 验证件 echo（hello/invoke/dist 通） | 已实现 | `../kore-plugin-echo/info.json:2-16`、`dist/echo-0.1.1.tar.gz`、`../kore-plugins/index/plugins.json:5-18` |
| site 插件（协议握手 + site.list/create/delete 参数校验） | 骨架 | `../kore-plugin-site/main.go:3-5`（源码明示"不实际改动 nginx 配置，真实 conf.d 写入留待 M2-A 第二批"） |

## 2. 缺口清单

### 2.1 v1 GA 必须补（M4 收口，`v1.0 gate` 取证项）

| # | 缺口 | 一句话验收判据 |
| --- | --- | --- |
| G1 | 19 个产品插件仓未建（20 产品仅 site 在） | 19 仓各自 `make dist` 退出码 0 + 经商店安装/卸载/回滚五步记录齐全。 |
| G2 | site 生产化（当前骨架，不写 nginx conf） | 建静态站点 → 真实 vhost 落 conf.d → `curl` 200 → 删除后端口释放。 |
| G3 | 12 个生产级插件故障注入 | 每仓 `tests/fault/` 四类用例（kill -9/超时/磁盘满/cgroup）+ CI 12/12 绿。 |
| G4 | v1.0 gate 九类取证（`V1-GOALS.md:79-89`） | 功能/质量/资源/性能/兼容/安全/运维闭环/开放/不做九类证据齐备、无 P0。 |
| G5 | 商店装/卸全量（21 仓） | 20 产品 + echo 均可经商店安装与卸载，索引 sha256 与发布物一致。 |
| G6 | 资源与性能实测 | 空载进程 ≤1、同时常驻 ≤3、合计 ≤24 MiB、API p95 ≤50 ms、启动 ≤1 s 三件输出在阈值内。 |
| G7 | 安全能力缺口（2FA / IP 白名单 / API token / 审计 CSV） | 登录二次验证生效、token 可生成/吊销、审计可按动作过滤并导出 CSV（`FEATURE-PARITY.md:80-83`）。 |
| G8 | 运维五步链端到端 | 装插件→装运行时→建站→签证书→配备份一次跑通，运行时预检失败给可读错误。 |
| G9 | M1/M3 遗留未闭环项（`.agents/BOARD.md:160,52`） | bus 多路复用、capability 方法级校验、退避重启/心跳、真实宿主 `env_kind=real`、echo audit CLI 各有通过用例。 |
| G10 | 对象存储备份 + cgroup 硬上限 + 三处文案一致 | S3 备份恢复 sha256 一致、cgroup 超限只杀插件、README/商店首屏/安装器口径逐字相同。 |

### 2.2 v1.1+ 可延（M5，`ROADMAP.md:170-176`）

| 缺口 | 一句话验收判据 |
| --- | --- |
| 8 个基础级插件升生产级 | 每仓补边界用例 + `tests/fault/` 四类，G-20 复验通过。 |
| macOS / Windows 转 GA | 两平台全链路（下载→校验→安装→启动）跑通，不只交叉编译。 |
| ed25519 签名 / 静态市场页 / SDK / 文档站 | 篡改包拒装、市场页断网可开、第三方按 SDK 30 分钟跑通 hello。 |
| 迁移导入器（宝塔/1Panel 站点与库） | 导入样例站点与库后可 `curl` 访问（当前明确 v1.1 提供，`FEATURE-PARITY.md:79`）。 |
| 监控历史报表 | 24h 环形之外提供历史落盘查询（`FEATURE-PARITY.md:84`）。 |
| 6 项不做 | 永久不排期；G-11 命中即退回提案。 |

## 3. 建议排期（裁决 35：本机功能与验证 > 多平台）

| 里程碑 | 优先顺序（先本机后多平台） | 落点 |
| --- | --- | --- |
| M4 = v1.0 | ① site 生产化（G2）→ ② 本机 19 插件仓 + 商店装/卸（G1/G5）→ ③ 12 故障注入（G3）→ ④ 本机资源/性能/安全/端到端取证（G6/G7/G8/G9/G10）→ ⑤ 多平台仅 preview（交叉编译 + 基础链路） | `ROADMAP.md:53`、`.agents/BOARD.md:166` |
| M5 = v1.1 | ① 8 基础级升生产 → ② ed25519 签名 / SDK / 市场页 → ③ macOS / Windows GA（多平台放最后）→ ④ 迁移导入器 / 历史报表 | `ROADMAP.md:54,170-176` |

## 4. 诚实声明（计数，不用形容词）

- **22 能力域达标数：0**。分解：骨架 3（站点/域名/反代，均由 `site` 覆盖但源码不写 nginx）、未开始 19（3+19=22）。另有 6 项非目标明确不做（§1.2，独立于 22 域、不计入分解）。
- **20 产品插件仓落地数：1**（`site`，且为骨架）；19 个不存在于磁盘、不在索引。验证件 `echo` 1 个已落地但不对应能力域。
- **内核与平台机制已实现：8 类**（auth / market / lazy / audit / web / 其余内核模块 / echo），均属调度与机制层，**不构成任何运维能力域的端到端结果**。
- **v1.0 gate 九类取证：完整 0 类**（M0–M3 的 `make check` 10/10 是门禁绿，不是九类证据齐备）。
- 结论：按"对标宝塔 / 1Panel 专业版"的能力覆盖面口径，当前处于 **M0–M3 的骨架期**，差距是 19 个未开始域 + 3 个骨架域 + 九类 gate 证据待补；本账不含任何"基本完成"表述。
