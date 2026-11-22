# 数据库 / Redis 自动预填与一键连接验收（真机 · 双端 · G-28）

> 元信息: 2026-11-23T03:42+08:00 · 执行者 r3-autofill-db-redis 子 agent · 隔离实例 18871 · chromium 1248 headless（手写 CDP，无 Playwright 依赖）· 真机 API + 双端截图 · 报告 ≤80 行

## 1. 交付
- **db-mysql 配置契约**：`db-mysql.config.get/set`，`<KORE_STATE_DIR>/config.json`（0600 原子写），字段 `host/port/user/password/password_env/databases_include_system`；优先级 **config.json > 环境变量 > 默认值**。旧 `KORE_MYSQL_INSTANCES` 多实例路径保留，文件只覆盖实例名 `default`。
- **redis 配置增强**：新增敏感字段 `password`（只存本机 0600 文件，`config.get` 只回 `***`，`config.set` 收到 `***` 保留原值）；`password` 优先于 `password_env`，旧路径兼容。
- **db-mysql.config 生效**：`config.set` 顺序为校验 → 原子写 → 更新内存 `Instances/IncludeSystem` → applied；同一插件进程下一次 `instances/databases/query/status` 立即使用新配置。
- **前端自动预填**：`web/db.js` / `web/redis.js` 打开页面先调 `discover.discover.services`；命中运行中的 MySQL/MariaDB、Redis 时显示自动检测横幅 + 一键连接，host/port（数据库另加 user）预填并标「已自动填入」，密码框自动聚焦。保存后自动调 `instances` 验证：成功显示实例卡/版本/库列表，失败显示后端原文 + 「怎么办」。
- **通用面板**：`web/config-panel.js` 新增 `prefill` / `autoKeys` / `autoNote` / `focusKey`，不改既有调用方默认行为。
- **文档同步**：`docs/PLUGIN-CONFIG.md` 增 §7.3/§7.4；`docs/USABILITY.md` 删除数据库页欠账并记录已改造；`docs/FRONTEND.md` 更新两页描述；两插件 README/CHANGELOG 同步。

## 2. 真机环境与隔离
| 项 | 事实 |
| --- | --- |
| kored | `127.0.0.1:18871`，state/run/log/临时索引全在 `/tmp/kore-autofill-18871`；`curl /-/healthz` → 200 |
| 插件 | 本地包安装并启用 `db-mysql 0.1.0` / `redis 0.2.0` / `discover 0.1.0`，三插件 `restarts=0` |
| 数据库 | 3306 实测服务端 **MySQL 9.7.1**（`mysql:9.7.1` 容器），本机客户端 `mariadb 11.8.6-MariaDB`；discover 因此报 MariaDB 11.8.6、横幅照此显示，实例版本以服务端 9.7.1 为准 |
| Redis | 6379 真实 `redis:7.4.12`（`--requirepass`），采集时 79 个客户端连接；本次只读 keys/info，未执行删除 |
| 共享 8787 | 全程未触碰，首尾 `/-/healthz` 均 200 |
| 索引披露 | 本地包 sha 与已签名索引不同，隔离实例用临时索引 + `store.allow_unsigned=true`；生产索引/签名未改 |

## 3. 点击次数实测（打开 → 连上）
| 页面 | 步骤 | 点击数 |
| --- | --- | --- |
| 数据库 | 打开 `/ #/db`（0）→ 一键连接（1）→ 键盘填密码（不计点击）→ 保存（2）→ 自动验证并选中实例（0） | **2** |
| Redis | 打开 `/ #/redis`（0）→ 一键连接（1）→ 键盘填密码（不计点击）→ 保存（2）→ 自动选中并加载 keys（0） | **2** |

- 浏览器脚本注入捕获阶段 click 监听，读回 `window.__koreClicks`：DB **2**、Redis **2**（低于 ≤3 判据）。
- 数据库一键连接预填 3 项（host/port/user）并显示 3 个「已自动填入」；Redis 预填 2 项（host/port）并显示 2 个标记；两次实测值分别为 `127.0.0.1:3306 root`、`127.0.0.1:6379`。

## 4. 真机证据（API 层，先于截图）
| 步骤 | 实测结果 |
| --- | --- |
| db 初始 | `config.get` → `source=default`，`values.host=127.0.0.1/port=3306/user=root` |
| db 保存 | `config.set` → `{"saved":true,"applied":true,"restart_required":false,"warnings":[]}` |
| db 热生效 | 同一进程 PID **79789 → 79789**；`instances` → `default 127.0.0.1:3306 reachable=true version=9.7.1` |
| db 真实数据 | `databases` → `fees_china / fees_china_docker / iouf_lives / live_games / live_token`（5 个）；`query` → `version=9.7.1, user=root@%` |
| db 落盘 | `state/plugins/db-mysql/config.json` 权限 **600**、137 B；重启 kored 后 `config.get` 仍 `source=file`、密码 `"***"`，实例仍可达 |
| redis 保存 | `config.set` → `{"saved":true,"applied":true,"restart_required":false}`；PID **79798 → 79798** |
| redis 真实数据 | `instances` → `default 127.0.0.1:6379 reachable=true version=7.4.12`；`info` → clients.connected=79、used_memory=61.75M；`keys` → 扫描 200 条、类型覆盖 hash/string/set/zset |
| redis 落盘/掩码 | `config.json` 权限 **600**、130 B；`config.get` 密码 `"***"`；再次 `config.set {"port":6379}` 后密码保留、`applied=true` |
| 静态资源 | 服务端 `/assets/db.js|redis.js|config-panel.js|style.css` 的 sha256 与 `web/` 源文件**逐字节一致** |

## 5. 双端截图（`file/identify` 实测；8 张 sha 两两不同）
| 文件 | 尺寸 | bytes | sha256(12) | 截图前/后断言 |
| --- | --- | --- | --- | --- |
| [autofill-db-desktop.png](screenshots/autofill-db-desktop.png) | 1440x1782 | 131131 | `217b8470d70f` | 横幅含「MariaDB 11.8.6」+「已连接」/实例「可达」/5 库/结果含 9.7.1；前后均 PASS |
| [autofill-db-desktop-config.png](screenshots/autofill-db-desktop-config.png) | 1440x1335 | 163235 | `90ac67adbdd8` | 3 个「已自动填入」+ host/port/user 值 + 密码空；前后均 PASS |
| [autofill-db-mobile.png](screenshots/autofill-db-mobile.png) | 390x844 | 60882 | `fe4917fd78a5` | 横幅 + 默认连接「可达」+ 390 宽无横向溢出；前后均 PASS |
| [autofill-db-mobile-full.png](screenshots/autofill-db-mobile-full.png) | 390x2364 | 138152 | `65af85463865` | 同上 + 实例详情/库列表完整；前后均 PASS |
| [autofill-redis-desktop.png](screenshots/autofill-redis-desktop.png) | 1440x3132 | 303908 | `0bcbe7407c8a` | 横幅 +「默认连接」可达 + info + 30 个真实键；前后均 PASS |
| [autofill-redis-desktop-config.png](screenshots/autofill-redis-desktop-config.png) | 1440x1755 | 201125 | `37da9180e16c` | 2 个「已自动填入」+ `127.0.0.1:6379` + 密码空；前后均 PASS |
| [autofill-redis-mobile.png](screenshots/autofill-redis-mobile.png) | 390x844 | 65368 | `da485a7d1b1d` | 横幅「已连接」+默认连接可达+info，无横向溢出；前后均 PASS |
| [autofill-redis-mobile-full.png](screenshots/autofill-redis-mobile-full.png) | 390x2821 | 217263 | `47dffacdaf90` | 同上 + 键表完整；前后均 PASS |

- 断言实现：每张图**截图前**校验登录态 + 页面特征（横幅文本/「可达」/库名/SQL 版本/键行数/`scrollWidth≤innerWidth`），`Page.captureScreenshot` 后**立即复查**；失败即删图并中止。8/8 落地、0 回滚、sha 8 unique。

## 6. G-28 产品定位自评
- **数据库页**：① 不配环境变量、不登 SSH，打开即知道本机有没有数据库；有则两次点击连上，能列真实库、跑只读 SQL。② 与宝塔/1Panel 差距：无建库/建用户、无慢查询面板、无多实例向导式添加；当前只覆盖「连接 + 浏览 + 只读查询」。③ **可用**（真实 MySQL 9.7.1、5 个真实库、真实 SQL 结果）。
- **Redis 页**：① 打开即检测本机 Redis，两次点击连上后可看版本/内存/命中率/keyspace、列真实键并按类型取值。② 差距：无新建/编辑值、无 TTL 编辑、无 ACL/慢查询；危险命令刻意不提供。③ **可用**（真实 Redis 7.4.12、79 客户端、真实键与 TTL）。

## 7. 门禁（命令 + 退出码）
| 仓库 | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| db-mysql | `make check` | **0** | gofmt clean / vet / 5 包 test ok；`make build && make dist` 两次 sha 均为 `7e02be455a74…` |
| redis | `make check` | **0** | gofmt clean / vet / 5 包 test ok；两次 dist sha 均为 `a068a67d38ef…` |
| kore | `make build` | **0** | `bin/kored` sha256 `c1c2ca00…` |
| kore | `make frontend` | **0** | 21 文件；首屏 gzip **39,210 B / 307,200 B** |
| kore | `make docs-check` | **0** | 6 pass / 0 warn / 0 fail |
| kore | `make check` | **0** | 10/10 段，末行 `[OK] 门禁全部通过` |

## 8. 清理与已知边界
- 验收后已停止 18871 的 kored；删除 `/tmp/kore-autofill-18871`、chromium profile 与一次性 CDP 脚本；工作区只保留本报告与截图。8787 全程未触碰。
- 已知边界：`password` 字段改变了「密码只从环境变量读取」的旧口径（现为本机 0600 文件优先、env 兜底），已在 README/PLUGIN-CONFIG 明示；插件包版本未 bump，商店索引/Release 未重签，安装仍走本地包 + 临时索引。
- 本机 3306 是 MySQL 容器而非 MariaDB 服务端；横幅的「MariaDB 11.8.6」来自 discover 探测到的本机 `mariadb` 客户端版本，实例卡显示服务端真实版本 9.7.1，未把客户端版本冒充服务端版本。
