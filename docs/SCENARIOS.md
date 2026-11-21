> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M2

# SCENARIOS — 场景预设与首次安装

## 0. 文档定位

| 项 | 内容 |
| --- | --- |
| 读者 | lead 拆 M2、implementer（installer）、verifier（预设校验）、运维（首装） |
| 作用 | 定义 preset 机制、schema、8 个预设的插件组合与资源账、首装 7 步、失败回滚、后续商店管理 |
| 不作用 | 不写插件明细（见 [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md)）、不写商店 API 规格（见 [CORE.md](./CORE.md)）、不写兼容矩阵（见 [COMPATIBILITY.md](./COMPATIBILITY.md)） |
| 硬预算 | 每预设**同时常驻 ≤3**；常驻合计**目标 ≤19.2 MiB**（预算 24 MiB 的 80%），24 MiB 只是**绝不越过的红线**、不是设计目标（余量为 0 的预设判 FAIL）；插件包单个 ≤15 MiB；lazy 空闲 300 s 退出 |

## 1. 机制

| 项 | 设计 |
| --- | --- |
| 定义位置 | `kore-plugins` 仓库 `presets/<id>.json`（与索引同仓，一起校验、一起发版） |
| 内置快照 | kore 构建时 `//go:embed presets/` 打包一份快照 → **首次安装完全离线可用**（无需先联网） |
| 刷新 | 只有 `kored store --preset-refresh`（或 `POST /api/v1/store/refresh`）才联网拉新版预设；其余时间零出站 |
| 版本锁定 | 预设内每个插件给 `version_range`；安装器取满足区间的最高已索引版本，并 **pin 到该版本** |
| 配额仲裁 | 安装器按 `lifecycle` 算常驻合计；超 24 MiB 或 >3 个 resident（**推荐 ≤2**）时拒绝该预设并在安装前报错（不是装到一半才失败） |
| 与商店关系 | 预设只是"批量安装清单"；安装后一切管理走商店（更新/卸载/单独启用） |

## 2. preset schema

```json
{
  "schema_version": 1,
  "id": "web-pro",
  "name": "Web 专业版",
  "description": "单机建站主力：站点/反代 + PHP + 证书 + 文件 + 备份 + 定时 + 监控",
  "plugins": [
    {"id": "site", "version_range": ">=0.2.0 <0.3.0", "optional": false},
    {"id": "runtime-php", "version_range": ">=0.2.0 <0.3.0", "optional": false},
    {"id": "ssl", "version_range": ">=0.2.0 <0.3.0", "optional": true},
    {"id": "waf", "version_range": ">=0.2.0 <0.3.0", "optional": true}
  ],
  "config_template": {
    "site": {"default_root": "/var/www", "listen": [80, 443]},
    "resources": {"profile": "standard"}
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `schema_version` | int | 是 | 当前 `1`；不识别即拒绝该预设 |
| `id` | string | 是 | `[a-z0-9-]`，与文件名一致 |
| `name` | string | 是 | 展示名（中文） |
| `description` | string | 是 | 一句话目标用户 |
| `plugins[]` | array | 是 | 元素 `{id, version_range, optional}`；`id` 必须能在索引解析 |
| `config_template` | object | 否 | 按插件 id 分组的初始配置；未知键忽略并 WARN |

## 3. 八个预设

统一口径：**常驻** = `resident` 插件；`lazy`/`oneshot` 不计入常驻但计磁盘。磁盘为安装包估算（20 个全装 ≤200 MiB，单个 ≤15 MiB）。

**80% 余量规则（硬）**：常驻合计**目标 ≤19.2 MiB**（预算 24 MiB 的 80%）；24 MiB 是"绝不越过"的红线，不是设计目标。顶格 = 零余量 = 任何插件增重或用户启用第 4 个 resident 时立刻越线，因此余量为 0 的预设直接判 FAIL。

| 预设 | 常驻数 | 常驻目标 | 预算 | 余量 | 判定 |
| --- | --- | --- | --- | --- | --- |
| `minimal` | 0 | 0 MiB | 24 MiB | 24.0 | ✅ |
| `web-lite` | 1 | `site` 10 MiB | 24 MiB | 14.0 | ✅ |
| `web-pro` | 2 | `site`+`monitor` 16 MiB | 24 MiB | 8.0 | ✅ |
| `db-only` | 0 | 0 MiB | 24 MiB | 24.0 | ✅ |
| `gateway` | 1 | `site` 10 MiB | 24 MiB | 14.0 | ✅ |
| `security` | 0 | 0 MiB | 24 MiB | 24.0 | ✅ |
| `dev` | 1 | `site` 10 MiB | 24 MiB | 14.0 | ✅ |
| `full` | 2 | `site`+`monitor` 16 MiB | 24 MiB | 8.0 | ✅ |

**常驻只留 2 个**：`site`(10) + `monitor`(6) = 16 MiB。3 是硬上限、不是目标；`cron` 转 lazy 后不再占常驻位（见下）。

**`cron` 为什么不常驻、也不自己跑调度器**：`cron` 是 lazy，且只负责把任务**写成宿主调度器的条目**——Linux 用 `systemd timer`（`kore-<task>.timer`）或 `/etc/cron.d/kore-*`，macOS 用 launchd `StartCalendarInterval`，Windows 用 Task Scheduler；到点由**宿主**调用 `kored invoke <plugin> <method>`，再由内核按需拉起目标插件。

理由三条：① kore 自身保持零后台定时器（G-19 红线不破，主壳里没有 ticker）；② 常驻一个插件只为"到点唤醒"不值得占 12 MiB 配额；③ 宿主调度器本来就存在，不引入新守护进程。**它不是"每 60 s 轮询"**——没有循环、没有 sleep 轮询，只有宿主到点触发的一次性调用。

### 3.1 `minimal` — 极简（只要一个入口）

| 项 | 值 |
| --- | --- |
| 目标用户 | 只想有个能看能管入口的小机器（1 GiB 内存 VPS） |
| 插件清单 | **空**（只有内核 UI：登录/商店/系统信息） |
| 运行时依赖 | 无 |
| 常驻 | 0 个 / 0 MiB（余量 24.0） |
| 磁盘 | ≤30 MiB（仅二进制） |
| 配置要点 | 不装任何插件；之后从商店按需装；`resources.profile: compact` |
| 离线 | ✅ 快照内全含 |

### 3.2 `web-lite` — 轻量建站

| 项 | 值 |
| --- | --- |
| 目标用户 | 1–2 个静态/轻动态站点，不碰数据库 |
| 插件清单 | `site` `ssl` `file` `backup` `logs` |
| 运行时依赖 | 无（静态站/反代；如需 node/python 再单独装） |
| 常驻 | `site` 1 个 / 10 MiB（`logs` 为 lazy） |
| 磁盘 | ≤70 MiB |
| 配置要点 | 备份默认本地 `/var/backups/kore`，保留 7 天 |
| 离线 | ✅ |

### 3.3 `web-pro` — 建站主力

| 项 | 值 |
| --- | --- |
| 目标用户 | 单机多站点、PHP 应用、需要证书与定时任务 |
| 插件清单 | `site` `ssl` `runtime-php` `file` `cron` `logs` `backup` `monitor` `firewall`(`optional`) |
| 运行时依赖 | **PHP 8.x + MySQL 8.x（或 MariaDB 10.11+）**；宿主缺则由插件经 apt/dnf/brew 安装 |
| 常驻 | `site`(10) + `monitor`(6) = **16 MiB / 2 个**（余量 8.0）✅（`cron` 为 lazy） |
| 磁盘 | ≤110 MiB |
| 配置要点 | PHP-FPM 池 9000+；站点默认 80/443；`cert_renew.enabled=true`（唯一允许的常驻定时器） |
| 离线 | ✅（ACME 签发需联网，属插件运行时行为，不影响安装） |

### 3.4 `db-only` — 数据库管理机

| 项 | 值 |
| --- | --- |
| 目标用户 | 只有数据库要管，不需要建站 |
| 插件清单 | `db-mysql` `db-postgres` `redis` `backup`（均为 lazy/oneshot） |
| 运行时依赖 | MySQL 8.x / PostgreSQL 16（按引用插件）；宿主缺则经包管理器安装 |
| 常驻 | 0 个 / 0 MiB（余量 24.0） |
| 磁盘 | ≤80 MiB |
| 配置要点 | 只管理宿主已装实例；备份走 `mysqldump`/`pg_dump`，输出落 `tasks/` |
| 离线 | ✅（对象存储需用户自备） |

### 3.5 `gateway` — 反代/网关

| 项 | 值 |
| --- | --- |
| 目标用户 | 前置一台做反代、证书与 WAF，后端另有服务 |
| 插件清单 | `site` `ssl` `waf` `firewall` `logs` |
| 运行时依赖 | 无（前置反代；`waf` 用宿主 nginx/openresty） |
| 常驻 | `site` 1 个 / 10 MiB（`waf` 为 lazy，前置 8080 串联） |
| 磁盘 | ≤90 MiB |
| 配置要点 | `site` 只做 upstream；`waf` 前置；`firewall` 只放行 80/443 |
| 离线 | ✅（证书签发需联网） |

### 3.6 `security` — 安全加固

| 项 | 值 |
| --- | --- |
| 目标用户 | 已经跑着业务，只想要加固与巡检 |
| 插件清单 | `firewall` `ssh-guard` `integrity` `waf` `logs`（全部 lazy/oneshot） |
| 运行时依赖 | 无 |
| 常驻 | 0 个 / 0 MiB（余量 24.0） |
| 磁盘 | ≤95 MiB |
| 配置要点 | `integrity` 每天一次基线比对（由 `cron` 触发）；`ssh-guard` 封禁写 `firewall` 的 `kore:` 段 |
| 离线 | ✅ |

### 3.7 `dev` — 开发机

| 项 | 值 |
| --- | --- |
| 目标用户 | 个人开发/测试机，需要多语言运行时 |
| 插件清单 | `site` `runtime-php` `runtime-node` `runtime-python` `file` `cron` `logs` |
| 运行时依赖 | PHP 8.x + Node 20 LTS + Python 3.12（按需）；宿主缺则经包管理器安装 |
| 常驻 | `site` 1 个 / **10 MiB**（余量 14.0）✅（`cron` 为 lazy） |
| 磁盘 | ≤120 MiB |
| 配置要点 | 每个 runtime 一个默认端口段（3000/8000/9000+）；不装数据库 |
| 离线 | ✅ |

### 3.8 `full` — 全量安装

| 项 | 值 |
| --- | --- |
| 目标用户 | 想一次装齐、之后按需启停的机器（≥2 GiB 内存） |
| 插件清单 | 全部 20 个 |
| 运行时依赖 | 按所选插件：PHP / Node / Python / MySQL / PostgreSQL / Redis 按需；全部由包管理器提供 |
| 常驻 | `site`(10) + `monitor`(6) = **16 MiB / 2 个**（余量 8.0）✅（其余 18 个 lazy/oneshot） |
| 磁盘 | ≤200 MiB |
| 配置要点 | 首装按"resident → lazy → oneshot"三批顺序安装，每批完成即校验；`resources.profile: standard` |
| 离线 | ✅（快照 + 索引缓存） |

**`full` 为什么不超预算**：常驻只由 **2 个** resident 插件占（`site`+`monitor`），`full` 装的是"全部能力"，不是"全部常驻"。20 个插件里 12 个 lazy（含 `cron`；用才起、闲 300 s 退）、6 个 oneshot（用完整进程消失）。若未来新增第 4 个 resident，`full` 必须改为**分批激活**：默认只启用 3 个 resident，其余 resident 在"启用时提示需先停用某个"，这正是 [ARCHITECTURE.md](./ARCHITECTURE.md) §3.1 的配额仲裁。

## 4. 首次安装流程

### 4.1 交互式 9 步

| # | 步骤 | 输出/交互 |
| --- | --- | --- |
| 1 | 环境探测 | 复用 envprobe 的 capability report：Tier、常驻配额、磁盘可用、网络 |
| 2 | 选场景 | 列出 8 个预设 + 每个的插件数与常驻/磁盘估算；默认 `web-lite` |
| 3 | 展示插件与占用 | 逐个插件：lifecycle、预估 RSS、capabilities、pids、磁盘；需 `system:admin` 的高亮 |
| 4 | **运行时预检** | 按预设列出缺失的宿主运行时（PHP/MySQL/Node/Python）：缺什么、装多大、能否走本地镜像；此处可取消 |
| 5 | 确认 | 显示常驻占用（如 2/3）、常驻合计（16/24 MiB）、插件 + 运行时总磁盘；二次确认 |
| 6 | 取插件包 | 优先 `--offline-dir`，其次内置快照 + 索引缓存；都没有才提示联网刷新 |
| 7 | 校验 | 逐包 sha256 比对索引条目；`requires_kore` 区间校验；失败即中止 |
| 8 | 安装插件 + 运行时 | 按依赖序装并 enable；**运行时缺失由插件调用宿主包管理器安装**（apt / dnf / brew），或引导用户执行给出的命令 |
| 9 | 打印访问方式 | 访问地址（UDS/HTTP）、首启口令提示、运行时版本与后续命令 |

**运行时安装边界（写死）**：目录不内置 MySQL/PHP 二进制（单二进制 ≤25 MiB 不许塞运行时）。运行时由**插件调用宿主包管理器**安装（Linux `apt`/`dnf`、macOS `brew`；Windows 给出手动下载指引），**kore 自身不下载运行时**。离线场景用 `--offline-runtime-dir` 指向本地包目录（.deb/.rpm/.pkg），由插件从该目录安装。

失败提示必须具体，不许笼统"安装失败"：

```
[FAIL] web-pro: 缺少运行时 php (>=8.0)，站点未启用
       安装建议：apt install php8.2-fpm  |  或  --offline-runtime-dir /media/usb/pkgs
       已安装插件：site ssl file cron logs backup monitor（6/9）
```

### 4.2 非交互

```bash
kored install --scenario web-pro --yes
kored install --scenario full --offline-dir /media/usb/kore-packages --yes
kored install --scenario web-lite --yes --profile compact
```

`--yes` 时跳过 3–4 步的交互，其余照跑；`--offline-dir` 优先于索引；`--profile compact` 见 [COMPATIBILITY.md](./COMPATIBILITY.md) 降级矩阵。

## 5. 失败与回滚

| 情况 | 处理 | 标注 |
| --- | --- | --- |
| 取包/sha256 失败（尚未安装） | 中止，零改动 | — |
| 第 N 个插件安装失败 | **整预设回滚（事务语义）**：按逆序卸载已装插件、恢复启用状态、清理已写状态目录 | M2 提供，无例外 |
| 安装成功但 enable 失败 | 视为安装失败，按上一行处理 | 同上 |
| 安装成功但健康检查失败（hello 超时） | 该插件置 `failed`，其余保留；提示用户看日志 | 部分成功，不自动回滚 |
| 配额校验失败（resident >3 或 >24 MiB） | 在**安装前**拒绝并给出需停用的插件建议 | 不进入安装 |

**已裁决（M2 事务语义）**：任一插件安装失败即整预设回滚——半装一套 web 栈（有 site 没 PHP）对用户无价值，中间态难诊断。**M2 不提供 `--allow-partial`**；M3 若确有需求再加，届时必须同时输出补偿清单（哪些装了 / 哪些没有 / 如何续装）。

## 6. 后续管理（商店）

安装完成后一切走商店，不再有"预设"概念：

| 操作 | 入口 | API |
| --- | --- | --- |
| 浏览已装/可装 | 插件中心「商店」页 | `GET /api/v1/store/plugins`（读本地索引缓存，零出站） |
| 刷新索引/预设 | 页头「刷新」按钮 | `POST /api/v1/store/refresh`（唯一显式联网入口） |
| 安装插件 | 插件行「安装」 | `POST /api/v1/store/install` → `job_id` → `GET /api/v1/store/jobs/{job_id}` |
| 更新插件 | 有新版时「更新」 | `POST /api/v1/store/update`（同样异步 job） |
| 卸载插件 | 「卸载」（先 disable） | `DELETE /api/v1/store/plugins/{id}` |
| 启用/停用 | 插件行开关 | `POST /api/v1/plugins/{id}/enable|disable`（配额仲裁在此生效） |
| 查看预设 | 首装向导「重新选择场景」 | `GET /api/v1/store/presets` |

联网边界：**运行期零后台出站**；只有 `store/refresh`、安装/更新时的包下载会出站。支持 `--offline-dir` 与自建镜像源（把 `index/plugins.json` 与包放同一 HTTP 目录）。

## 7. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md) | 预设引用的插件明细、lifecycle 与预估 RSS 来源 |
| [FEATURE-PARITY.md](./FEATURE-PARITY.md) | 预设覆盖哪些对标能力 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | lazy 激活与常驻配额仲裁的运行时行为 |
| [CORE.md](./CORE.md) | `installer` / `market` 模块规格与商店 API |

> 预设的价值不是"帮你多点几下"，是**在安装前就把预算账算给你看**：3 个常驻、24 MiB、多少磁盘。装完才发现超预算，那叫事故。
