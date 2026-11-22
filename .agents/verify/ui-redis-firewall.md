# Redis / 防火墙两页与 16 项导航验收（真机 · 双端 · G-28）

> 元信息: 2026-11-23T02:48+08:00 · 执行者 ui-redis-firewall 子 agent · 隔离实例 18875 · 真实 chromium · 报告 ≤90 行

## 1. 交付与实现

- `web/redis.js`（318 行）：实例卡（name / host:port / 可达徽章 / 版本 / uptime / 不可达 error）；信息面板（版本、uptime、clients.connected、内存 used/peak/max、`keyspace_hits/(hits+misses)` 命中率、keyspace 各 db 键数）；键浏览（pattern 默认 `*`、limit 默认 200、key/type/ttl 表，点击行 `redis.get`，string 原文 / hash 表 / list/set 列表 / zset 成员+score）；勾选多键 → 页内二次确认列出键名 → `redis.delete`；「设置」复用 `KoreShell.openConfig(root,'redis')`；未配置实例渲染「还没有 Redis 连接」+「添加连接」。
- `web/firewall.js`（290 行）：状态卡（ufw/iptables/none 徽章、启用态、默认入站、规则数）；规则表（编号/动作颜色/方向/协议/端口/来源/备注/删除）；添加规则（allow/deny + 端口 + tcp/udp + 来源 + 备注）先 `dry_run=true` 预览真实 argv，再确认 `dry_run=false`；删除规则同样先 `deleteRule{dry_run:true}` 预览再确认；端口 22 前端即时提示 SSH 保护；`available=false` 时真实写按钮禁用、只读信息保留。
- 接线：`shell.js` 内置路由新增 Redis/防火墙（懒加载 `/assets/redis.js`、`/assets/firewall.js`）；新增堆叠数据块与盾牌图标（20×20、currentColor、stroke-width 1.5）；`index.html` 未加 script；`Makefile` / `web/embed.go` 改为 21 文件；`docs/FRONTEND.md` / `QUICKSTART.md` 同步 14 视图 / 21 文件 / 9–16 项。
- **跨轨披露**：工作树原有 ui-l2 对 `Makefile` / `embed.go` / `FRONTEND.md` / `QUICKSTART.md` 的 19 文件同步（含 files-l2/site-edit）尚未提交；本轨在该基线上追加 redis/firewall，提交会一并纳入这四处既有 diff（否则 embed 缺 L2 子模块、前端无法 21 文件自洽）。

## 2. 导航分组方案与理由（14 → 16 项，手机 ≤2 次点击）

| 组 | 成员 | 理由 |
| --- | --- | --- |
| 运维（5，手机常驻 tab） | 概览、监控、日志、进程、终端 | 日常最高频、故障处置第一入口；手机底栏固定这 5 项，1 次点击直达 |
| 业务（4） | 网站、数据库、Redis、计划任务 | 站点与数据面运维同组，DB/Redis 相邻便于对照 |
| 资源（3） | 文件管理、备份、SSL | 文件、备份、证书同属可占用/需保护的资源 |
| 平台（4） | 软件商店、已装插件、防火墙、设置 | 平台级安装、插件与系统安全/配置 |

- 桌面侧栏显示组标题；手机「更多」抽屉按组显示业务/资源/平台 11 项。组标题不可点击、不增加层级——**5 项 1 次点击 + 其余 11 项「更多」→ 条目 2 次点击**，实测抽屉条目 11、固定 tab 5，点击「更多→Redis / 更多→防火墙」均落到目标视图。

## 3. firewall 不可用时的降级（本机真实：非 root）

- `firewall.status` 实测 `backend=ufw, available=false`，error=`执行 /usr/sbin/ufw status verbose 失败: ERROR: You need to be root...`。
- 页面：状态徽章 ufw + 黄色「只读降级」chip；三个状态值显示「不可读」；**黄底说明**（不是红字）逐字展示「当前环境无法读取防火墙状态：<error>。防火墙管理需要 root 权限（kored 需以 root 运行或配置 systemd 权限）」，原始 error 收进 `<details>` 折叠。
- 规则：`firewall.rules` 返回 `E_UNAUTHORIZED`（ufw status numbered 非 root），页面显示错误原文 + 「非 root 时 ufw 规则不可读…」；删除按钮 disabled。
- 写操作：预览按钮仍可用（`dry_run` 只构造命令、不执行外部命令）；预览面板「确认执行」disabled，并注明「当前环境没有 root 权限，只能预览，无法执行」。真实写路径与 `deleteRule` 因非 root 不可执行，本轮只验证到 dry-run（符合插件 README 的只读+dry-run E2E 边界）。

## 4. 真机证据（18875，redis 0.2.0 + firewall 0.2.0）

| 步骤 | 证据 |
| --- | --- |
| 连接配置 | 默认 6379 不可达（`NOAUTH Authentication required.`）；设置面板改 `127.0.0.1:16380` 保存 → 实例「可达」 |
| 实例/信息 | `redis.info`：版本 7.4.12、uptime 4 分、clients.connected=1、内存 1.37M/峰值 1.39M/最大 0B、命中率 100.0%、keyspace `db0 · 6 keys` |
| 键与取值 | 6 键覆盖 hash/set/string/list/zset；TTL `kore:temp` 4 分；string=`hello from kore`、hash name=alice、list 含 c、set 含 red、zset 成员+分值 |
| 删除 | 勾选 `kore:temp`+`kore:queue` → 确认面板列出两键 → 「已删除 2 个键」；容器 `DBSIZE` 6→4 |
| 防火墙 dry-run | `ufw allow proto tcp from any to any port 18080 comment kore-web`；命令由 `/usr/sbin/ufw` 全路径构造，未执行 |
| SSH 提示 | 端口填 22 → 前端提示「屏蔽 SSH 端口会导致无法连接服务器，后端将拒绝此操作」 |

## 5. 双端截图（`file/identify` 实测；每张截图前后各做 DOM 断言，12 张 sha 两两不同）

| 文件 | 尺寸 | sha256 前12 |
| --- | --- | --- |
| [redis-desktop-01-config.png](screenshots/redis-desktop-01-config.png) | 1440x1800 | 83ad8efa637a |
| [redis-desktop-02-instances-info.png](screenshots/redis-desktop-02-instances-info.png) | 1440x1029 | f8c6501d0cea |
| [redis-desktop-03-keys-value.png](screenshots/redis-desktop-03-keys-value.png) | 1440x1211 | bd398437786b |
| [redis-desktop-04-delete-confirm.png](screenshots/redis-desktop-04-delete-confirm.png) | 1440x1357 | 738e40cecde2 |
| [redis-desktop-05-delete-result.png](screenshots/redis-desktop-05-delete-result.png) | 1440x1170 | d4370b3e359f |
| [redis-mobile-01-keys.png](screenshots/redis-mobile-01-keys.png) | 390x844 | dfa180dd2782 |
| [firewall-desktop-01-status.png](screenshots/firewall-desktop-01-status.png) | 1440x900 | c0bc8450139d |
| [firewall-desktop-02-rules.png](screenshots/firewall-desktop-02-rules.png) | 1440x900 | dcc161a6d5c0 |
| [firewall-desktop-03-dryrun-preview.png](screenshots/firewall-desktop-03-dryrun-preview.png) | 1440x1105 | 7d2a418b79d3 |
| [firewall-mobile-01-status.png](screenshots/firewall-mobile-01-status.png) | 390x844 | 15debdea1d8e |
| [nav-desktop-groups.png](screenshots/nav-desktop-groups.png) | 1440x900 | 715cc5373b4b |
| [nav-mobile-drawer-groups.png](screenshots/nav-mobile-drawer-groups.png) | 390x844 | 0ed003deac63 |

- 断言：nav 16 项（桌面）+ 组标题 4 个；移动固定 tab=5、抽屉=11；Redis 各类型取值与删除文案；防火墙黄底说明 / root 提示 / details / dry-run 命令 / 确认执行 disabled；移动两页 `documentElement.scrollWidth == innerWidth`；`pageerror` 0，未捕获异常 0。

## 6. G-28 产品定位自评

- **Redis 页**：① 不登 SSH 即可确认实例是否可达、看版本/内存/命中率，按类型浏览与取值、批量删键。② 与宝塔/1Panel 差距：无新建/编辑值、无 TTL 编辑、无搜索分页/多实例聚合、无 ACL/慢查询；危险命令刻意不提供。③ **可用**：真实 TCP/RESP、真实 6 种数据、真实删除，不是占位。
- **防火墙页**：① 不登 SSH 看后端/启用态/规则，端口放行/拒绝/删除先看真实 argv 再执行，SSH 端口双层保护。② 差距：非 root 读不到规则（如实降级）、无 iptables 写入、无启用/禁用（安全取舍）、无富规则/区域/限速。③ **只读降级下可用**：状态与降级说明真实，dry-run 真实；真实写路径需 root，本轮未执行。

## 7. 门禁与清理

- `node --check web/redis.js web/firewall.js web/shell.js` → 0
- `make frontend` → 0：21 文件，首屏 gzip **38,887 B / 307,200 B**
- `make docs-check` → 0（6 pass / 0 warn / 0 fail）；`make check` → 0（10/10，`[OK] 门禁全部通过`）；`make build` → 0
- 清理：18875 停止、`docker rm -f kore-redis-ui`、临时脚本与证据只在 `/tmp/kore-rf-18875`；8787 全程未触碰（仅本任务 18875）。
- 提交：`scripts/safe-commit.sh`（精确路径 + CAS）；代码提交 hash 见最终回报。
