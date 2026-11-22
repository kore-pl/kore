> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M2

# PLUGIN-CATALOG — 插件目录与生命周期配额

## 0. 文档定位

| 项 | 内容 |
| --- | --- |
| 读者 | lead 拆任务、插件作者、red-team 审依赖与配额、scribe 对外说明 |
| 作用 | 定义 v1 的 20 个插件：生命周期、预估 RSS、能力、依赖、冲突、pids、对标、里程碑、仓库名 |
| 不作用 | 不写 `info.json` 字段级 schema（见 DATA-MODEL.md）、不写协议（见 PLUGIN-PROTOCOL.md）、不写预设组合（见 [SCENARIOS.md](./SCENARIOS.md)） |
| 硬预算 | **同时常驻 ≤3**、常驻合计 **≤24 MiB**、单常驻 **≤12 MiB**、插件包 **≤15 MiB**、lazy 空闲 300 s 退出、冷启动 p95 ≤300 ms |
| 口径 | 插件 = 独立仓库 `kore-plugin-<id>`；内核内置 `installer` / `market` **不是插件**，不计入 |

生命周期三态：`resident`（常驻，占配额）/ `lazy`（**默认**，按需拉起、空闲 300 s 退出）/ `oneshot`（每次调用拉起、用完即退，空闲 RSS=0）。

## 1. web 族

| id | 名称 | 等级 | lifecycle | 预估 RSS | capabilities | 依赖 | 冲突 | pids | 对标 | 里程碑 | 仓库 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `site` | 站点与反向代理 | 生产级 | resident | 10 MiB | `site:read` `site:write` `net:read` | — | 同端口只属一个站点 | 64 | 网站/域名/伪静态/反代 | M2 | `kore-plugin-site` |
| `ssl` | 证书与自动续期 | 生产级 | oneshot | 峰值 12 MiB | `net:write` `ssl:read` `ssl:write` | `site`(可选) | — | 32 | SSL 签发/续期 | M2 | `kore-plugin-ssl` |
| `runtime-php` | PHP-FPM 管理 | 生产级 | lazy | 8 MiB | `system:read` `system:admin` `net:read` | — | 同端口 FPM 池冲突 | 64 | PHP 运行时 | M2 | `kore-plugin-runtime-php` |
| `runtime-node` | Node 进程守护 | 基础级 | lazy | 8 MiB | `system:read` `net:read` | — | 同端口进程冲突 | 48 | Node 运行时 | M3 | `kore-plugin-runtime-node` |
| `runtime-python` | Python 运行时 | 基础级 | lazy | 8 MiB | `system:read` `net:read` | — | 同端口进程冲突 | 48 | Python 运行时 | M3 | `kore-plugin-runtime-python` |

## 2. data 族

| id | 名称 | 等级 | lifecycle | 预估 RSS | capabilities | 依赖 | 冲突 | pids | 对标 | 里程碑 | 仓库 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `db-mysql` | MySQL/MariaDB 管理 | 生产级 | lazy | 8 MiB | `db-mysql:read` `db-mysql:write` `system:read` | — | 同实例端口冲突 | 32 | MySQL 管理/慢查询 | M3 | `kore-plugin-db-mysql` |
| `db-postgres` | PostgreSQL 管理 | 基础级 | lazy | 8 MiB | `db-postgres:read` `db-postgres:write` `system:read` | — | 同实例端口冲突 | 32 | PostgreSQL 管理 | M3 | `kore-plugin-db-postgres` |
| `redis` | Redis 管理 | 生产级 | lazy | 6 MiB | `redis:read` `redis:write` | — | 同实例端口冲突 | 32 | Redis 管理/键扫描 | M3 | `kore-plugin-redis` |

## 3. ops 族

| id | 名称 | 等级 | lifecycle | 预估 RSS | capabilities | 依赖 | 冲突 | pids | 对标 | 里程碑 | 仓库 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `file` | 文件管理 | 生产级 | oneshot | 峰值 12 MiB | `file:read` `file:write` `system:read` | — | — | 32 | 在线编辑/上传/解压/权限 | M2 | `kore-plugin-file` |
| `cron` | 计划任务（写宿主调度条目） | 生产级 | lazy | 4 MiB（峰值） | `system:admin` `system:read` | — | 只管理 `kore:` 前缀条目；不接管宿主其它任务 | 32 | cron + 执行日志 | M2 | `kore-plugin-cron` |
| `logs` | 日志查看 | 生产级 | lazy | 6 MiB | `system:read` | — | — | 64 | 日志分类/过滤/下载 | M2 | `kore-plugin-logs` |
| `monitor` | 监控与告警 | 生产级 | resident | 6 MiB | `system:read` `net:write`(webhook) | — | — | 64 | CPU/内存/磁盘/告警 | M3 | `kore-plugin-monitor` |
| `backup` | 备份 | 生产级 | oneshot | 峰值 16 MiB | `backup:read` `backup:write` `system:read` `net:write`(S3) | `db-*`(可选) | 同目标目录并发冲突 | 32 | 本地 + S3 备份 | M2 | `kore-plugin-backup` |

## 4. sec 族

| id | 名称 | 等级 | lifecycle | 预估 RSS | capabilities | 依赖 | 冲突 | pids | 对标 | 里程碑 | 仓库 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `firewall` | 防火墙与端口 | 生产级 | lazy | 6 MiB | `system:admin` | — | 只改 `kore:` 注释段 | 32 | 防火墙/端口放行 | M3 | `kore-plugin-firewall` |
| `waf` | WAF | 基础级 | lazy | 8 MiB | `net:read` `net:write` `waf:read` | `site`(可选前置) | 与 `site` 内建反代二选一 | 64 | WAF/拦截日志 | M4 | `kore-plugin-waf` |
| `ssh-guard` | SSH 加固 | 基础级 | oneshot | 峰值 10 MiB | `system:admin` `system:read` | `firewall`(可选) | — | 32 | 失败封禁/配置审计 | M3 | `kore-plugin-ssh-guard` |
| `integrity` | 文件完整性 | 基础级 | oneshot | 峰值 12 MiB | `integrity:read` `system:read` | — | — | 32 | 关键文件哈希基线 | M3 | `kore-plugin-integrity` |

## 5. app 族

| id | 名称 | 等级 | lifecycle | 预估 RSS | capabilities | 依赖 | 冲突 | pids | 对标 | 里程碑 | 仓库 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `app-deploy` | 一键部署应用 | 生产级 | oneshot | 峰值 16 MiB | `app-deploy:read` `app-deploy:write` `system:admin` | `site`；`runtime-*`/`db-*` 可选 | 模板声明端口冲突 | 64 | WordPress/Laravel/Next.js | M4 | `kore-plugin-app-deploy` |
| `dns` | DNS 管理 | 基础级 | lazy | 6 MiB | `net:write` `system:read` | — | 与宿主 `dnsmasq`/`bind` 端口冲突 | 32 | 区域与记录管理 | M4 | `kore-plugin-dns` |
| `container` | 容器管理（可选） | 基础级 | lazy | 10 MiB | `system:admin` `net:read` | — | 默认不装；与 firewall 规则段共存 | 64 | Docker/Podman 面板 | M4 | `kore-plugin-container` |

## 6. 生命周期与配额汇总

| 生命周期 | 数量 | 插件 |
| --- | --- | --- |
| `resident` | **2** | `site`(10) `monitor`(6) → 合计 **16 MiB（目标 ≤19.2，余量 8.0）** |
| `lazy`（默认） | 12 | `cron` `runtime-php` `runtime-node` `runtime-python` `db-mysql` `db-postgres` `redis` `logs` `firewall` `waf` `dns` `container` |
| `oneshot` | 6 | `ssl` `file` `backup` `ssh-guard` `integrity` `app-deploy` |
| 合计 | **20** | 常驻 **2 / 20 = 10%**，其余 lazy/oneshot 按需 |

**每个里程碑的同时常驻数**（硬门禁 ≤3）：

| 里程碑 | 本里程碑新增 resident | 累计 resident | 常驻合计 | 判定 |
| --- | --- | --- | --- | --- |
| M2 | `site`(10) | 1 | 10 MiB | ✅ 推荐 ≤2 / 目标 ≤19.2 |
| M3 | `monitor`(6) | 2 | 16 MiB | ✅ 推荐 ≤2 / 目标 ≤19.2 |
| M4 | 无（全部 lazy/oneshot） | 2 | 16 MiB | ✅ 推荐 ≤2 / 目标 ≤19.2 |

为什么只有这两个常驻：站点要接请求（晚 300 ms 冷启动不可接受）、监控要连续采样（lazy 会让采样断档）。`cron` 看似必须常驻，其实到点唤醒由**宿主调度器**完成（systemd timer / cron.d / launchd / Task Scheduler → `kored invoke`），插件只在被调用时短暂拉起，因此转 lazy。其余能力都可以"用户点开/事件到达时才拉起"，代价是首次点击多 100–300 ms。

### 6.1 深度等级（12 生产级 / 8 基础级）

| 等级 | 数量 | 插件 | 要求 | 用户可见 |
| --- | --- | --- | --- | --- |
| **生产级** | 12 | `site` `ssl` `runtime-php` `db-mysql` `file` `backup` `cron` `logs` `monitor` `firewall` `redis` `app-deploy` | 边界用例 + 故障注入 + 完整错误处理；`tests/fault/` 必须存在 | 商店标「生产级」 |
| **基础级** | 8 | `runtime-node` `runtime-python` `db-postgres` `waf` `ssh-guard` `integrity` `dns` `container` | 核心路径可用；边界用例与高级配置延到 v1.1 | 商店标「基础级 · 边界能力 v1.1」 |

> 口径澄清：索引中 echo 的 depth_level=basic 仅为 schema 两值约束下的占位，验证件不参与 12 生产级 / 8 基础级评级；12/8 统计只数 20 个产品插件。

**升级判据**（基础级 → 生产级，两条都要满足）：① 边界用例覆盖（异常输入、并发、权限不足、资源耗尽各 ≥1 例并进 CI）；② 故障注入通过（`kill -9`、超时、磁盘满、cgroup 超限四类各 1 次，行为符合 `PLUGIN-CATALOG` §8 DoD）。等级不是永久标签，v1.1 目标是把 8 个基础级全部升到生产级。

## 7. 资源预算推导

| 约束 | 值 | 推导 |
| --- | --- | --- |
| 单常驻插件 | ≤12 MiB | 24 MiB / 2 的余量分配，留 1 个 resident 位给运维临时启用 |
| 同时常驻合计 | 目标 **≤19.2 MiB**（预算 24 的 80%），24 MiB 为红线 | **推荐配置 2 个 / 16 MiB**（余量 8）；3 个是硬上限，不是目标 |
| 常驻个数 | ≤3 | 每个常驻占 1 个配额；超过即拒绝启用（见 [ARCHITECTURE.md](./ARCHITECTURE.md) §3.1） |
| 插件包 | ≤15 MiB | 单二进制 + web 资源；超限拒绝收录（G-17） |
| lazy 冷启动 | p95 ≤300 ms | 进程 exec + hello ≤2 s 协议上限内的工程目标；超时即为不达标 |
| lazy 空闲 | 300 s | 空闲计时由 supervisor 维护；到期 drain 后退出，RSS 归 0 |

## 8. 每个插件的最小验收（DoD）

| 检查 | 判据 |
| --- | --- |
| 包结构 | `<id>-<version>.tar.gz` 含 `info.json` + `bin/<id>` + 可选 `web/`，≤15 MiB |
| 声明完整 | `requires_kore`/`capabilities`/`resources`/`lifecycle`/`depends_on`/`conflicts`/`scenario_tags`/`size_bytes` 齐全 |
| hello | 拉起后 2 s 内 `kore.hello` 成功，`protocol=kore.plugin.v1` |
| 能力最小化 | capabilities 合法：6 特权能力或自有 `<id>:<action>`（域=插件 id），非空 ≤16、无重复，且与 `info.json` 一致 |
| 预算达标 | 实测 RSS ≤ 预估值的 110%，常驻插件 ≤12 MiB |
| lazy 冷启动 | 5 次冷启动取 p95 ≤300 ms（oneshot 同样适用） |
| 空闲回收 | lazy 空闲 300 s 后进程消失（`pgrep`=0） |
| 崩溃行为 | `kill -9` 后按退避重启；`failed` 不无限重拉 |
| 日志 | 写 stderr 到 `/var/log/kore/plugins/<id>.log`，不自行建日志文件 |

## 9. 端口与文件占用

| 插件 | 默认端口/路径 | 说明 |
| --- | --- | --- |
| `site` | 80/443、`/etc/kore/sites/` | 站点配置与 vhost 片段 |
| `ssl` | 仅出站 443（ACME） | 证书落 `/var/lib/kore/plugins/ssl/certs/` |
| `runtime-php` | 9000+（FPM 池） | 池配置在插件状态目录 |
| `runtime-node` / `runtime-python` | 3000–3999 / 8000–8999 | 由插件分配并登记，避免撞车 |
| `db-mysql` / `db-postgres` / `redis` | 3306 / 5432 / 6379 | 只管理宿主实例，不新建实例（M3） |
| `firewall` | nftables `kore:` 段 | 不接管其它段 |
| `waf` | 8080（前置） | 与 `site` 80/443 串联 |
| `monitor` | 无监听 | webhook 出站，仅告警时 |
| `cron` | 宿主调度器条目：`/etc/cron.d/kore-*` 或 `kore-<task>.timer`（macOS `LaunchAgent`、Windows Task） | 插件不自建调度器、不轮询 |
| `dns` | 53（管理宿主实例） | 插件不监听 |
| `container` | Docker socket（只读+受限） | 可选；M4 |

## 10. 能力使用统计

六特权能力的使用面（内核固定认识，不可扩展）：

| 特权能力 | 使用插件数 | 插件 |
| --- | --- | --- |
| `system:read` | 10 | cron logs monitor firewall ssh-guard integrity ssl db-mysql db-postgres runtime-php |
| `system:admin` | 6 | cron runtime-php firewall ssh-guard app-deploy container |
| `net:read` | 5 | site runtime-php runtime-node runtime-python waf container |
| `net:write` | 5 | ssl backup monitor waf dns |
| `proc:read` | 0 | 预留给需要读宿主进程表的插件（M2 起按需授予） |
| `proc:write` | 0 | 预留给需要向宿主进程发信号的插件（M2 起按需授予） |

**插件自有能力**：每个插件声明自己的 `<id>:<action>`（如 `db-mysql:read`、`backup:write`），**域必须等于插件 id**，非空 ≤16；内核只校验语法、域匹配与数量，**不维护业务域名词表**。

原则：能用 `system:read` 就不申请 `system:admin`；能读就不写；能用自己的域就不借用别人的域。

## 11. 插件间协作

| 场景 | 协作方式 |
| --- | --- |
| 站点部署后申请证书 | `site` 发 `kore.event{type:"site.created"}` → `ssl`（lazy 唤醒） |
| 备份含数据库 | `backup` 调 `invoke db-mysql db.dump`（HTTP 统一入口，非直连） |
| SSH 封禁落到防火墙 | `ssh-guard` 调 `invoke firewall block`；无 firewall 时降级为日志告警 |
| 站点流量异常触发 WAF | `waf` 独立前置，`site` 通过 upstream 串联 |
| 一键部署串起运行时 | `app-deploy` 依次 `invoke runtime-php`/`db-mysql`/`site` |

禁止：插件间直连 socket、共享内存、绕过内核直接改对方状态目录。

## 12. 反模式

| 反模式 | 为什么不行 |
| --- | --- |
| 让插件"顺手常驻" | 常驻配额只有 3；第 4 个必须等别人让位 |
| 把 UI 数据放进插件常驻内存 | 插件退出即丢；状态应落 `/var/lib/kore/plugins/<id>/` 或 bbolt |
| 为省冷启动把 lazy 改 resident | 直接吃掉 1/3 配额，破坏整机内存预算 |
| 插件包塞进前端依赖树 | 包 >15 MiB 拒收；前端资源应构建期打包并压缩 |
| plugin 内部起后台定时轮询数据库 | 违"零轮询"；用事件或 `cron` 插件触发 |

## 13. 仓库清单速查

| 仓库 | 里程碑 | 首个可发布版本 | 说明 |
| --- | --- | --- | --- |
| `kore-plugin-site` | M2 | v0.2.0 | 首个 resident，配额基线 |
| `kore-plugin-ssl` | M2 | v0.2.0 | oneshot，ACME |
| `kore-plugin-runtime-php` | M2 | v0.2.0 | lazy，管理宿主 FPM |
| `kore-plugin-file` | M2 | v0.2.0 | oneshot |
| `kore-plugin-cron` | M2 | v0.2.0 | resident，触发器 |
| `kore-plugin-logs` | M2 | v0.2.0 | lazy |
| `kore-plugin-backup` | M2 | v0.2.0 | oneshot，S3 兼容 |
| `kore-plugin-runtime-node` | M3 | v0.3.0 | lazy |
| `kore-plugin-runtime-python` | M3 | v0.3.0 | lazy |
| `kore-plugin-db-mysql` | M3 | v0.3.0 | lazy |
| `kore-plugin-db-postgres` | M3 | v0.3.0 | lazy |
| `kore-plugin-redis` | M3 | v0.3.0 | lazy |
| `kore-plugin-monitor` | M3 | v0.3.0 | resident（第 3 个配额） |
| `kore-plugin-firewall` | M3 | v0.3.0 | lazy |
| `kore-plugin-ssh-guard` | M3 | v0.3.0 | oneshot |
| `kore-plugin-integrity` | M3 | v0.3.0 | oneshot |
| `kore-plugin-waf` | M4 | v0.4.0 | lazy，前置串联 |
| `kore-plugin-app-deploy` | M4 | v0.4.0 | oneshot，模板 |
| `kore-plugin-dns` | M4 | v0.4.0 | lazy，管理宿主实例 |
| `kore-plugin-container` | M4 | v0.4.0 | lazy，可选 |

## 14. lazy 的成本账

| 场景 | 代价 | 缓解 |
| --- | --- | --- |
| 首次打开插件页 | 冷启动 100–300 ms（p95 ≤300 ms） | 前端骨架屏 + 服务端预热（仅预热最近使用的 1 个） |
| 空闲 300 s 退出后再次调用 | 重新 exec + hello | 高频插件在预设里标记 warm 提示（不改变生命周期） |
| 冷启动并发 | 多个请求同时唤起同一插件 | supervisor 冷启动互斥 + bus 排队上限（见 CORE） |
| 内存回落 | 退出后 RSS 才归 0 | 用 `pgrep` + `/proc/<pid>/status` 验收，不看缓存 |

## 15. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| [FEATURE-PARITY.md](./FEATURE-PARITY.md) | 能力域 → 插件 id 的对标矩阵；本目录是其明细 |
| [SCENARIOS.md](./SCENARIOS.md) | 8 个预设如何组合本目录插件，并验证 ≤3 常驻 / ≤24 MiB |
| [REPOS.md](./REPOS.md) | 插件仓库形态、发布流程、版本兼容 |
| [CORE.md](./CORE.md) | `installer` / `market` / supervisor 的 lazy 配额仲裁规格 |

> 目录的价值是让"对标"可执行，也让**预算可执行**：20 个插件里只有 3 个允许常驻。谁想让自己的插件常驻，先回答"它凭什么替代 site / monitor / cron 其中之一"。
