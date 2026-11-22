> 元信息: 2026-11-23T05:06+08:00 · 执行者 ui-server-version 子 agent · 真机 8787（discover 0.1.0）+ 隔离 18866（discover 0.2.0）· G-28

# 数据库 / Redis 横幅改用服务端版本（兼容旧字段）

## 1. 选择逻辑（`web/db.js` 与 `web/redis.js` 同一口径）
1. `version_source === "server"` 且 id ∈ {mysql, mariadb}：唯一可信的服务端版本，优先选中。MariaDB 不再无条件压过 MySQL——3306 探到 MySQL 9.7.1 时即使本机只装 MariaDB 客户端也选 MySQL。
2. 其次 `found && running`：可能只有客户端版本（连接服务端还需要密码）；db 侧先取 mysql 再取首个，Redis 取首个。
3. 都没有 → 空态；`version_source=unknown` 在 `detect()` 里显式置空，不渲染横幅。

## 2. 两种字段形态的归一
| discover 形态 | 处理 |
| --- | --- |
| 0.2.0：`client_version` / `server_version` / `version_source` | 直接使用；server 横幅只展示 `server_version` |
| 0.1.0：只有 `version` | 归一为 `client_version` + `version_source=client`，**绝不显示成服务端版本** |
| 0.1.0 连 version 都没有（本机 Redis 0.1.0）且 found&&running | 归一为 client 空版本，横幅仍显示「客户端（未连上服务端，需要密码）」，不误判成未检测到 |
三态文案：server「检测到本机 MySQL 9.7.1（127.0.0.1:3306）」；client「检测到本机 MySQL 客户端（未连上服务端，需要密码）」并在说明里写出客户端版本；unknown 无横幅、走空态。
## 3. 真机证据（先 API 后截图）
| 实例 | discover | 关键字段 | 页面横幅 |
| --- | --- | --- | --- |
| 8787 | 0.1.0（旧） | `mysql.version=11.8.6-MariaDB`，无 `server_version` | 检测到本机 MySQL 客户端（未连上服务端，需要密码）✅，说明含 `11.8.6-MariaDB` |
| 18866 | 0.2.0（本地包 + `allow_unsigned`） | `mysql.server_version=9.7.1/source=server`；`redis.server_version=7.4.12/source=server` | 检测到本机 MySQL 9.7.1（127.0.0.1:3306） / Redis 7.4.12（127.0.0.1:6379）✅ |

| 场景 | 截图（`.agents/verify/screenshots/`） | 尺寸 | sha256(12) |
| --- | --- | --- | --- |
| 新字段·DB | sv-desktop-db.png | 1440x893 | dfe81542ac38 |
| 新字段·Redis | sv-desktop-redis.png | 1440x9386 | 0f63ccce5997 |
| 新字段·DB | sv-mobile-db.png | 390x844 | c38a5abc57ab |
| 新字段·Redis | sv-mobile-redis.png | 390x844 | e6b9e81a9ce6 |
| 旧字段·DB | sv-old-desktop-db.png | 1440x912 | dd9f1bd90bc8 |
| 旧字段·Redis | sv-old-desktop-redis.png | 1440x9386 | 243795c8579a |
| 旧字段·DB | sv-old-mobile-db.png | 390x844 | f729cc3687b3 |
| 旧字段·Redis | sv-old-mobile-redis.png | 390x844 | 7910f6519d01 |

- 截图前断言登录态 + 横幅标题/说明原文，截图后核对 PNG 实际宽高；手机 390 宽 `scrollWidth==innerWidth`（无横向溢出）。8 张 sha 两两不同。
- **8787 旧字段截图口径（披露）**：8787 二进制内嵌的是旧 `web/dist`，且验收期间正被并发 agent 重启占用（PID 545729，非本 agent 重启）。为不打断对方，旧字段截图用「8787 真实 `/api` + `web/dist` 新前端」的只读回环代理（18865）取得——API 与插件版本都是 8787 真机，仅静态资源来自本工作区；新字段截图由隔离 18866 直接提供。

## 4. 门禁（命令 + 退出码）
| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/db.js && node --check web/redis.js` | **0** | 无输出 |
| `make frontend` | **0** | 首屏 gzip 42,015 B / 307,200 B（余量 265,185） |
| `make docs-check` | **0** | 5 pass / 1 warn / 0 fail（warn=`docs/RELEASE.md:40` 行数，非本次文件） |
| `make check` | **0** | 10/10 段，末行 `[OK] 门禁全部通过` |
## 5. G-28 产品定位自评
- **数据库页**：打开即知本机有没有 MySQL/MariaDB、版本来自服务端还是仅客户端；有服务端版本时两次点击可连上。与宝塔/1Panel 差距：无建库建用户、无慢查询面板、无多实例向导；当前「可用」。
- **Redis 页**：同样自动识别并区分服务端/客户端版本，可看版本与内存、浏览键。差距：无新建/编辑值、无 TTL/ACL、危险命令不提供；当前「可用」。

## 6. 清理与边界
- 验收后停止 18866 的 kored 与 18865 代理，删除 `/tmp/kore-sv-18866`、`/tmp/sv-*.py` 与 chromium profile；8787 未由本 agent 重启（首尾 `/-/healthz` 均 200），仅读 API；**本轮未改动主实例 8787 的运行态配置/索引**（其 signed-index 快照与重启由并发 agent 操作）。
- 已知边界：旧版 discover 无法提供真实服务端版本，页面只能显示客户端来源；这是数据源限制，不是前端猜测。
