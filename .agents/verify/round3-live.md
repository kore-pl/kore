# Round 3 · 真实 8787：网站 / 数据库 / Redis 转「可用」+ 34 张双端证据

> 2026-11-23T04:02+08:00 · r3-live-finalize · 实例 PID **165724 未重启**（采集前后 `/-/healthz` 均 200）· 未改源码 / 未提交 / 未写真实 crontab

## 1. 插件升级（按 package sha256 比对，不按版本号）

| 插件 | 版本 | 装前 sha8 | 索引 sha8 | 动作 / HTTP |
| --- | --- | --- | --- | --- |
| backup | 0.2.0 | `779fbdb5` | `53885cbb` | disable→备份→install(force,download)→enable · 200/200 |
| cron | 0.2.0 | `550b892d` | `4d957c1c` | 同上 · 200/200 |
| db-mysql | 0.1.0 | `94b40647` | `7e02be45` | 同上 · 200/200 |
| file | 0.2.0 | `cdd2bfe9` | `a4f340f0` | 同上 · 200/200 |
| logs | 0.2.0 | `7f655b9b` | `b503ad9e` | 同上 · 200/200 |
| process | 0.1.0 | `bb793eb9` | `d5e0865b` | 同上 · 200/200 |
| redis | 0.2.0 | `5fc590d0` | `a068a67d` | 同上 · 200/200 |
| runtime-php | 0.1.0 | `1eb2d390` | `8d8a51ba` | install 后保持停用 · 200 |
| site | 0.1.0 | `991652bd` | `1273b55b` | 同上 · 200/200 |
| ssl | 0.2.0 | `714db347` | `af6bb539` | 同上 · 200/200 |
| terminal | 0.1.0 | `38efffbb` | `65025fd1` | 同上 · 200/200 |

- 复核：从 `state.db` 读回安装记录，当前 14 个已装插件的 `package_sha256` **全部 = 索引**。`firewall` 0.2.0（`959f357a`）本就一致，未重装。
- 新增：`container` 0.1.0（去 noop）、`discover` 0.1.0（数据库/Redis 页自动检测前置，页面报错原文即要求安装）；均 install+enable HTTP 200。
- 备份目录：`.kore-local-state/plugins/<id>/<ver>.bak-r3-20261123T035215`。

## 2. site 容器 nginx 模式

1. `mkdir -p .kore-local-state/nginx-conf.d` → ok。
2. `docker run -d --name kore-nginx -p 18084:80 -v $PWD/.kore-local-state/nginx-conf.d:/etc/nginx/conf.d:ro nginx:alpine` → 容器 Up，18084->80。
3. `site.config.set` values=`{nginx_mode:docker, docker_container:kore-nginx, host_conf_dir:$PWD/.kore-local-state/nginx-conf.d}` → `{"saved":true,"applied":true,"restart_required":false}` HTTP 200；`config.get` 回显 source=file。
4. `site.create live2.kore.test` → `{"nginx_mode":"docker","test_passed":true,"reloaded":true,"applied":true,"created":true}` HTTP 200。
5. `curl -H 'Host: live2.kore.test' http://127.0.0.1:18084/` → **404**（vhost 已加载、docroot 未建）；容器内建 index.html 后 **200**（返回「live2.kore.test OK」）。
6. `ssl.selfsign live2.kore.test`（365 天）→ 200；`site.bindSSL`（force_https=false）→ `test_passed/reloaded=true、ssl_bound=true`；`site.setRewrite` template=wordpress → 200。
7. `site.get` 摘要：managed=true、ssl.bound=true、rewrite.template=wordpress、vhost=`…/nginx-conf.d/kore-site-live2.kore.test.conf`；`site.list`：**3 站点（live/live2/demo）test_ok=reloaded=true、applied=true**。

## 3. 数据库 / Redis 真机连接

- MySQL 密码：`docker inspect common-mysql` → `MYSQL_ROOT_PASSWORD=root123`；`db-mysql.config.set` HTTP 200，`config.get` 密码回显 `***`，配置文件 0600。
- `db-mysql.instances` → reachable=true、**server 9.7.1**；`databases` → 5 个真实库：`fees_china`、`fees_china_docker`、`iouf_lives`、`live_games`、`live_token`。
- `db-mysql.query "SELECT VERSION()"` → **9.7.1 @ b222b5d80edb**（服务端版本，非 mysql 客户端）；`status` → max_connections=151、threads=5、uptime=149758s、slow=0。
- Redis 密码：`docker inspect common-redis` → `REDIS_PASSWORD=87d6…0e55`（直连原为 NOAUTH）；`redis.config.set` HTTP 200，`config.get` 密码 `***`，0600。
- `redis.instances` → reachable=true、**server 7.4.12**、uptime 149760s；`redis.keys` → 10 条真实键（hash/string/set，TTL 461875…-1），全库 DBSIZE=6574。

## 4. 34 张截图（`.agents/verify/screenshots/`，sha256 前 12 位）

| # | 页 | desktop 文件 / 实测 / sha | mobile 文件 / 实测 / sha |
| --- | --- | --- | --- |
| 1 | 概览 | `r3-desktop-01-dashboard.png` 1440x900 `7430dcb35b34` | `r3-mobile-01-dashboard.png` 390x844 `9f165710f945` |
| 2 | 监控 | `r3-desktop-02-monitor.png` 1440x1579 `33e0bb03cc19` | `r3-mobile-02-monitor.png` 390x844 `452503cab2d6` |
| 3 | 日志 | `r3-desktop-03-logs.png` 1440x932 `c75a5992970a` | `r3-mobile-03-logs.png` 390x844 `ff6d6909a210` |
| 4 | 进程 | `r3-desktop-04-process.png` 1440x3973 `08ed75725abb` | `r3-mobile-04-process.png` 390x844 `27c7de7ac6c3` |
| 5 | 终端 | `r3-desktop-05-terminal.png` 1440x901 `3ee2a371f433` | `r3-mobile-05-terminal.png` 390x844 `8218c5dce895` |
| 6 | 网站 | `r3-desktop-06-sites.png` 1440x900 `7ab9e132fab6` | `r3-mobile-06-sites.png` 390x844 `caaa6098e4d9` |
| 7 | 数据库 | `r3-desktop-07-db.png` 1440x900 `e89f75186418` | `r3-mobile-07-db.png` 390x844 `dcee9695cfc3` |
| 8 | Redis | `r3-desktop-08-redis.png` 1440x9386 `8f46e500c721` | `r3-mobile-08-redis.png` 390x844 `994c2fd0c76e` |
| 9 | 计划任务 | `r3-desktop-09-tasks.png` 1440x900 `1b9a08604527` | `r3-mobile-09-tasks.png` 390x844 `b72c5e7e9c19` |
| 10 | 文件 | `r3-desktop-10-files.png` 1440x900 `a72690917000` | `r3-mobile-10-files.png` 390x844 `74ce716a2960` |
| 11 | 备份 | `r3-desktop-11-backup.png` 1440x900 `a7f030784336` | `r3-mobile-11-backup.png` 390x844 `09a1570f93f0` |
| 12 | SSL | `r3-desktop-12-ssl.png` 1440x1039 `89d6d6f9f643` | `r3-mobile-12-ssl.png` 390x844 `81de5c278089` |
| 13 | 商店 | `r3-desktop-13-store.png` 1440x1610 `c384c2dd5b1f` | `r3-mobile-13-store.png` 390x844 `daa98beda834` |
| 14 | 已装插件 | `r3-desktop-14-plugins.png` 1440x1398 `e61643d722ae` | `r3-mobile-14-plugins.png` 390x844 `b6ea45472655` |
| 15 | 防火墙 | `r3-desktop-15-firewall.png` 1440x908 `32ba38b5b498` | `r3-mobile-15-firewall.png` 390x844 `15debdea1d8e` |
| 16 | 设置 | `r3-desktop-16-settings.png` 1440x1043 `71e94ff798a5` | `r3-mobile-16-settings.png` 390x844 `48e97553b1f1` |
| — | 侧栏四组 / 抽屉 | `r3-desktop-nav-groups.png` 1440x900 `d1eb817e398f` | `r3-mobile-nav-drawer.png` 390x844 `0ed003deac63` |

- 齐全性 34/34：16 页 PC 1440 宽 full-page（高 900–9386）+ 16 页手机 390×844 视口 + 侧栏四组 + 手机抽屉；每张截图前 2 道断言（已登录：无登录表单且顶栏含「退出」；页面特征：`#view[data-view]` 命中 + 特征文本命中），34 张共 68 项全 PASS。
- 唯一性：34 个 sha256 **两两去重 34 unique / 0 重复**（脚本内比对，重复即中止）。

## 5. 16 页状态判定（对比 Round 2）

| # | 页 | R2 | R3 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | 概览 | 可用 | **可用** | 14 插件 / 常驻 2、cgroup 降级告警为真实值 |
| 2 | 监控 | 可用 | **可用** | CPU/RSS/磁盘/load 5s 实时采样 |
| 3 | 日志 | 可用 | **可用** | 2 来源真实可读，syslog 29.2MB 尾部可搜 |
| 4 | 进程 | 可用 | **可用** | 100 行真实进程；此前 E_CONFLICT 已随插件启用消失 |
| 5 | 终端 | 可用 | **可用** | 真实 bash 会话已连接、可新建/关闭 |
| 6 | 网站 | 部分可用 | **可用** | docker 模式 3 站点 test_ok=reloaded=true；vhost 真被 nginx 加载（Host 200） |
| 7 | 数据库 | 部分可用 | **可用** | 真实 9.7.1、5 库、实例详情 + 只读 SQL 控制台 |
| 8 | Redis | 部分可用 | **可用** | 真实 7.4.12、内存 61.87M、命中率 72.7%、keyspace 与键浏览 |
| 9 | 计划任务 | 部分可用 | 部分可用 | 本机 `crontab -l` 报 `crontabs/pt: 权限不够`（非 root），列表只读不可写；未污染真实 crontab |
| 10 | 文件 | 可用 | **可用** | 根目录 6 项真实文件与全部操作入口 |
| 11 | 备份 | 可用 | **可用** | 1 个真实备份、sha 可校验、创建/恢复/删除齐全 |
| 12 | SSL | 可用 | **可用** | 2 张证书（含 live2 自签 365 天），验证/续签/导入齐全 |
| 13 | 商店 | 可用 | **可用** | 24 条索引、已装 14、分类筛选与在线安装可用 |
| 14 | 已装插件 | 可用 | **可用** | 14 行真实版本/深度/状态，启停与 ping 可用 |
| 15 | 防火墙 | 部分可用 | 部分可用 | ufw 需 root（`You need to be root`），只读降级 + 原因原文，写操作禁用 |
| 16 | 设置 | 可用 | **可用** | 会话剩余时长、CSRF 状态、退出登录真实 |

**统计**：可用 **14** · 部分可用 **2** · 占位 0（Round 2：11 / 5 / 0）。转化为可用的三页正是本轮目标：网站、数据库、Redis。
**G-28 三问自评（变化页）**：① 网站——解决"建站后不知道配置是否真生效"，现给出 nginx -t/reload 与 Host 真实响应；差距：无 nginx 安装/重载状态可视化、无站点根目录选择器；**可用**（容器模式真实加载，非占位）。② 数据库——解决"打开即知道本机有没有库并直接连"，现自动检测 + 一键连接 + 只读 SQL；差距：无建库/建用户/慢查询/多实例向导；**可用**。③ Redis——解决"连上即可看版本/内存/命中率并浏览键"，现真实实例与键值；差距：无 TTL/值编辑、无 ACL/慢查询；**可用**。

## 6. 保留、清理与最直观的 3 个问题

- **保留（演示数据）**：`kore-nginx` 容器、`live2.kore.test` 站点（连同恢复的 `demo/live.kore.test`，共 3 站点）与自签证书；`live2` docroot 与证书副本在容器内，容器**重建即失效**（未改任务指定的 `docker run` 参数）。
- **清理**：`/tmp/r3` 全部脚本与 cookie、下载的 release 包已删除；Playwright 使用临时 profile 并已关闭，无残留 chromium 进程。
- **问题 1**：11 个插件版本号未变但包 sha 全变（重建未 bump 版本）——只按版本号判断"已最新"会全部漏掉，必须按 `package_sha256`。
- **问题 2**：数据库页自动检测横幅写「MariaDB 11.8.6」（`/usr/bin/mysql` 客户端版本），实例卡片才是真实服务端 9.7.1，同页两个版本易误导。
- **问题 3**：容器模式下 `site.get` 的 `site_dir_exists=false` 与 nginx 实际 200 矛盾（它查宿主路径，站点根在容器内）；证书也需手工 `docker cp`，无自动挂载/同步。
