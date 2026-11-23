[agent:kore-rel-redis] G-28 证据：discover 探测核对（**无独立 discover 视图**，双端未达成）

# discover —— 探测准确性核对 + G-28 截图（部分）

> 元信息: 2026-11-23T21:2x+08:00 · 执行者 kore-rel-redis（task-181）· 隔离实例 `127.0.0.1:18899`（`--config /tmp/kore-discover/config.yaml`，state/run/log 全在 `/tmp/kore-discover`，portable，index=`kore-plugins/index`）· 装入本地 `dist/discover-0.3.0.tar.gz` · chromium-1248 headless（Playwright 1.65.1 缓存，零新依赖）
> **结论先说**：① 主壳**没有 discover 视图**——`web/` 无 `discover.js`、`web/shell.js` 无「发现/探测」导航项、`kore-plugin-discover` 仓**无 `web/` 目录**；任务书设想的「探测首页 / 结果详情 / 安装接管跳转」在 UI 上不存在，无法截图。② 探测结果目前只以「自动检测横幅」形式出现在**数据库**与 **Redis** 视图内。③ 手机端两次实测均停在「概览」（导航在手机上折叠为「更多」抽屉，未成功进入目标视图），**G-28 双端证据未达成**，只交了 PC 端。

## 1. 视图与入口（实测）

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 主壳视图模块 | `ls web/ \| grep discover` | **无**（无 `discover.js`） |
| 导航项 | `grep -n "discover" web/shell.js` | **零命中**（无发现/探测导航） |
| 插件自带 UI | `ls kore-plugin-discover/web` | 目录不存在（无 `web/`） |
| 探测结果落点 | `grep -rln "discover" web/*.js` | `web/app.js`、`web/db.js`、`web/redis.js` —— 仅消费 `discover.discover.services` 渲染自动检测横幅 |

> 因此「安装/接管跳转」也**不存在**：DB/Redis 横幅上只有「一键连接 / 手动配置 / 重新检测」，没有从探测结果到商店安装或接管的跳转按钮。任务书 c) 项无对应 UI 可点。

## 2. 探测准确性逐项对照（**本轮重点**）

插件 `discover.services`（0.3.0）返回 **22 项**；本机实际用 `command -v` / `dpkg -l` / `pgrep` / `ss -ltnp` / `docker ps` 独立核对。

| 服务 | 插件报 | 本机实际 | 判定 |
| --- | --- | --- | --- |
| nginx | `found=true running=true version=1.31.9 port=80 source=process` | **宿主无 nginx**（`/usr/sbin/nginx` 不存在、`dpkg -l nginx` 无包）；实际是容器 `kore-nginx`（`nginx:alpine`），发布 **18084→80**；宿主 **80 端口无监听**（`ss -ltnp '( sport = :80 )'` 空） | **误导性误报**：把容器内进程/内部端口当成宿主服务；`port=80` 不可连（应 18084），版本 `1.31.9` 无宿主来源可证 |
| mysql | `found=true running=true version=∅ source=which` | 宿主只有 MariaDB **客户端 11.8.6**；服务端是容器 `common-mysql`（`mysql:9.7.1`，3306→3306） | 半命中：连通性对（3306 有服务），但**版本/实现全丢**，用户会以为连的是本地 MySQL |
| mariadb | `found=true running=true version=∅ source=which` | 宿主仅 **客户端** 11.8.6；无 mariadbd 进程 | **半误报**：把客户端二进制当「运行中服务」，与 mysql 重复计数 |
| redis | `found=true running=true source=process` | 宿主 `redis-server *:6379` 真实运行 | **命中**（版本为空） |
| python3 | `found=true running=true version=∅` | `/usr/bin/python3`，Python 3.14.4；无常驻服务进程 | 命中安装，`running` 语义可疑（把 CLI 当服务），版本未给 |
| node | `found=true running=false version=∅` | nvm 下 v24.21.0 | 命中安装；版本未给 |
| docker | `found=true running=true` | `Docker 29.7.2`，daemon 在跑 | 命中 |
| ufw / iptables | `found=true running=false` | 二进制存在，规则未确认 | 命中安装（running 未证实） |
| postgres / caddy / apache2 / httpd / mongodb / memcached / rabbitmq / elasticsearch / php / podman / firewall-cmd | 全部 `found=false` | 均未安装（`command -v` 空） | **全部正确** |

**漏检**：容器里的 MySQL 服务端真实版本（9.7.1）与 nginx 容器的宿主发布端口（18084）都没有被正确表达；`php` 未装是对的，但若装在非 PATH 的位置也无从得知（未验证）。
**误检**：`mariadb running=true`（只有客户端）、`nginx port=80`（宿主不可达）是两处会直接误导用户的项；nginx 版本号在宿主侧无法复核。
**结论**：`found` 布尔在「二进制存在」层面基本可靠（22 项里 0 个假阴性可证实、2 个假阳性可证实）；但 **running/port/version 三个字段在容器场景下不可信**，而这三个字段正是用户决定「连哪里」的依据。建议（不在本任务写码）：容器内服务应标注 `source=container` + 宿主发布端口，或直接降级为 `unknown` 而不是编一个宿主端口。

## 3. 截图证据（`file`/`identify` 实测宽高）

| 文件 | 实测宽高 | 场景 |
| --- | --- | --- |
| `discover-db-autodetect-desktop-01.png` | **1440 x 900** | 数据库视图自动检测横幅：「检测到本机 MySQL 客户端（未连上服务端，需要密码）…客户端版本 11.8.6-MariaDB…已自动填入主机、端口、用户名」+「一键连接」 |
| `discover-redis-autodetect-desktop-01.png` | **1440 x 900** | Redis 视图横幅：「未检测到本机 Redis…`sudo apt install redis-server`」——**与第 2 节实测矛盾**（本机 6379 有 redis-server 在跑）；原因未证实（疑为注入 cookie 的会话/CSRF 导致页面 `discover.services` 调用失败后回落空态，或 redis.js 过滤逻辑差异），**如实记录为未解决疑点，不作为「探测正确」证据** |

> **未交付**：手机 390×844 的两张目标视图截图（两次实测均停在「概览」，`更多` 抽屉未进入 DB/Redis）；「探测首页/详情/安装接管」四类场景因无 UI 不存在；「空态/未探测态」只能以 Redis 横幅那种「未检测到服务」分支代表，已含在上表第二张里。
> 浏览器 `pageerror` = 0。登录走手工 PBKDF2（600000 轮，口令只存 `/tmp/kore-discover/pw` 0600，随目录删除）。

## 4. 产品自评三问（G-28 原文）

**① 本页解决什么用户问题**：新用户装完 kore 后不该被要求手填 host/port——discover 探测本机已有服务，DB/Redis 视图据此预填连接参数并给「一键连接」。探测存在的价值是「少填三个字段」。
**② 与宝塔 / 1Panel 同类功能差距**：宝塔/1Panel 有独立的「软件商店 + 已安装环境」页，能列出服务名、版本、状态、端口并提供安装/启动/卸载动作；本仓**没有 discover 视图**，结果只散落在 DB/Redis 横幅里，无版本、无安装/接管入口、容器内服务会被误报成宿主服务。差距是「能力面」而非「像素」。
**③ 当前是「可用」还是「占位」**：**部分可用**。能探测到 22 类二进制/进程并用它预填 DB/Redis 连接（真实可用）；但 running/port/version 在容器场景会误导，且没有可浏览的探测结果页——作为 L2 明显不足，维持 L1.5 是准确的。

## 5. 运行态与清理（G-29）

- 隔离实例：`127.0.0.1:18899`，config/state/run/log 全在 `/tmp/kore-discover`；装入 `discover-0.3.0`（`package_path` 本地包，`POST /api/v1/store/install` → `state=succeeded`、`reload=reloaded`），随后 `POST /api/v1/plugins/discover/enable`。
- 主实例 8787：**零写入、零请求**（本轮全部请求只发往 18899；未读写 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`，未重启）。
- 收尾：TERM 18899 实例、删除 `/tmp/kore-discover`；未改任何代码文件（本轮只新增本 md 与 2 张截图）。
