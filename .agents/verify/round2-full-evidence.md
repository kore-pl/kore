# Round 2 · 16 页双端证据（G-28）

> 2026-11-23T03:18+08:00 · r2-final-shots 子 agent · chromium 1248 headless（playwright-core 1.65.1）· **单 context 单次登录** · 34 张 · 原始采集（含每页 body 前 400 字）`round2-full-evidence-raw.json`

- 实例：`http://127.0.0.1:8787`（PID **4163078** 未重启，采集前后 healthz 均 200；未改源码、未 git 提交、未写 crontab）。
- 登录：页面表单填口令 → `POST /api/v1/auth/login` 200；**1 次登录**后复用同一 context，手机端只 `setViewportSize(390×844)`，未二次登录。
- 采集：每张截图**前**断言已登录（body 无「管理员口令/登录失败」）+ 页面特征，**后**立即复查；sha256 两两去重，重复即停止。34/34 落地，0 张因断言失败被删。
- 造数（走 API，未重启）：备份 `r2`（1.2 KiB / 10 条目 / sha256 `66ae23274114`）；文件根复用 `/tmp/kore-file-root`（6 项）；站点 3 个（复用，未新建）；SSL 1 张自签（复用）。
- **副作用披露**：为让 Redis/防火墙两页呈现真实状态，经 `POST /api/v1/store/install`（download=true）+ `/plugins/<id>/enable` 安装 **firewall 0.2.0 / redis 0.2.0**（此前未装）；已装 12、启用 11、采集时 ready 3/3（上限 3，推荐 ≤2 记 WARN）。

## 1. 34 张截图：identify 实测尺寸 / sha256(12) / 前后断言

| # | 文件 | 实测 | sha256(12) | 前/后断言 | console err | 横向溢出 | 关键元素(行/钮/面板) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `r2-desktop-01-overview.png` | 1440x900 | `0da164d678e3` | PASS/PASS | 0 | 否 | 0/2/2 |
| 2 | `r2-desktop-02-monitor.png` | 1440x1454 | `14299a7ad270` | PASS/PASS | 0 | 否 | 12/0/1 |
| 3 | `r2-desktop-03-logs.png` | 1440x932 | `97c8c3719dc4` | PASS/PASS | 0 | 否 | 0/5/2 |
| 4 | `r2-desktop-04-process.png` | 1440x3973 | `f9850f77e51e` | PASS/PASS | 0 | 否 | 100/6/1 |
| 5 | `r2-desktop-05-terminal.png` | 1440x901 | `501ef81a773f` | PASS/PASS | 0 | 否 | 0/3/1 |
| 6 | `r2-desktop-06-sites.png` | 1440x900 | `2bd70a5a972a` | PASS/PASS | 0 | 否 | 3/14/2 |
| 7 | `r2-desktop-07-db.png` | 1440x900 | `8a29cf7f0d3d` | PASS/PASS | 0 | 否 | 0/0/1 |
| 8 | `r2-desktop-08-redis.png` | 1440x900 | `71f22ee8a2b0` | PASS/PASS | 2 | 否 | 0/4/5 |
| 9 | `r2-desktop-09-tasks.png` | 1440x900 | `930bbb796aba` | PASS/PASS | 0 | 否 | 0/7/2 |
| 10 | `r2-desktop-10-files.png` | 1440x900 | `a72690917000` | PASS/PASS | 0 | 否 | 6/29/2 |
| 11 | `r2-desktop-11-backup.png` | 1440x900 | `e177c223a7b4` | PASS/PASS | 0 | 否 | 1/5/2 |
| 12 | `r2-desktop-12-ssl.png` | 1440x990 | `d473a8925208` | PASS/PASS | 0 | 否 | 1/7/3 |
| 13 | `r2-desktop-13-store.png` | 1440x1610 | `9bc5885bf3f3` | PASS/PASS | 0 | 否 | 0/53/0 |
| 14 | `r2-desktop-14-plugins.png` | 1440x1232 | `77952edfd9e7` | PASS/PASS | 0 | 否 | 12/25/2 |
| 15 | `r2-desktop-15-firewall.png` | 1440x908 | `83d976b8b38c` | PASS/PASS | 1 | 否 | 0/2/4 |
| 16 | `r2-desktop-16-settings.png` | 1440x1047 | `be17eaf16420` | PASS/PASS | 0 | 否 | 4/2/4 |
| 17 | `r2-desktop-nav-groups.png` | 200x900 | `c05f57ef2fd5` | PASS/— | 0 | 否 | 16/16/4 |
| 18 | `r2-mobile-01-overview.png` | 390x844 | `4afbadf005a7` | PASS/PASS | 0 | 否 | 0/2/2 |
| 19 | `r2-mobile-02-monitor.png` | 390x844 | `1b0497e1c50b` | PASS/PASS | 0 | 否 | 12/0/1 |
| 20 | `r2-mobile-03-logs.png` | 390x844 | `fe0e696a1eff` | PASS/PASS | 0 | 否 | 0/5/2 |
| 21 | `r2-mobile-04-process.png` | 390x844 | `5f5697190440` | PASS/PASS | 0 | 否 | 100/6/1 |
| 22 | `r2-mobile-05-terminal.png` | 390x844 | `749ea9deccea` | PASS/PASS | 0 | 否 | 0/3/1 |
| 23 | `r2-mobile-06-sites.png` | 390x844 | `ac68012a38de` | PASS/PASS | 0 | 否 | 3/14/2 |
| 24 | `r2-mobile-07-db.png` | 390x844 | `c3b0de01fba8` | PASS/PASS | 0 | 否 | 0/0/1 |
| 25 | `r2-mobile-08-redis.png` | 390x844 | `b1c81ecccf42` | PASS/PASS | 2 | 否 | 0/4/5 |
| 26 | `r2-mobile-09-tasks.png` | 390x844 | `5bf6a1a608da` | PASS/PASS | 0 | 否 | 0/7/2 |
| 27 | `r2-mobile-10-files.png` | 390x844 | `74ce716a2960` | PASS/PASS | 0 | 否 | 6/29/2 |
| 28 | `r2-mobile-11-backup.png` | 390x844 | `ba1d6b72ba9c` | PASS/PASS | 0 | 否 | 1/5/2 |
| 29 | `r2-mobile-12-ssl.png` | 390x844 | `e6f3f2b50c86` | PASS/PASS | 0 | 否 | 1/7/3 |
| 30 | `r2-mobile-13-store.png` | 390x844 | `7ae36cb9f410` | PASS/PASS | 0 | 否 | 0/53/0 |
| 31 | `r2-mobile-14-plugins.png` | 390x844 | `f7a653472a76` | PASS/PASS | 0 | 否 | 12/25/2 |
| 32 | `r2-mobile-15-firewall.png` | 390x844 | `3a423a6ec8ca` | PASS/PASS | 1 | 否 | 0/2/4 |
| 33 | `r2-mobile-16-settings.png` | 390x844 | `d517f496a488` | PASS/PASS | 0 | 否 | 4/2/4 |
| 34 | `r2-mobile-nav-drawer.png` | 390x844 | `0ed003deac63` | PASS/— | 0 | 否 | 11/11/3 |

- **齐全性**：34/34 = 16 PC（1440 宽 full-page，高 900–3973）+ 16 手机（390×844 视口）+ 侧栏四组 1 + 抽屉 1；PC 每页命名与导航分组一致。
- **唯一性**：34 个 sha256 **两两去重 34 unique / 0 重复**（脚本内置去重，未触发）。
- **断言**：截图前 68 项（34 张登录态 + 16 桌面 body+#view 特征 + 16 手机 #view 特征 + 侧栏组/项 + 抽屉组/项）+ 截图后 64 项（32 页登录态与特征复查）= **132 项全 PASS**。
- **console 合计 7 条**：登录前 `GET /system/info` 401（未登录探测，预期 1 条）；Redis 页 `redis.info`/`redis.keys` 502 ×2 端 = 4 条；防火墙页 `firewall.rules` 401 ×2 端 = 2 条。无脚本异常、无白屏。
- **横向溢出**：34/34 `scrollWidth ≤ innerWidth`，双端均无页面级横向滚动。

## 2. 16 页判定与依据（产品定位：本页解决什么 / 与宝塔·1Panel 差距）

| # | 页 | 判定 | 依据与差距 |
| --- | --- | --- | --- |
| 1 | 概览 | **可用** | 系统信息/12 插件/常驻 3 上限 3/cgroup 降级告警均为真实值；缺一键体检评分与告警历史（宝塔有） |
| 2 | 监控 | **可用** | CPU 9.2%、VmRSS 13.6 MiB、磁盘 518.6 GiB、load 3.01，5s 采样；缺历史曲线与阈值告警（1Panel 有） |
| 3 | 日志 | **可用** | 2 个来源真实可读，syslog 尾部 154,483 行、64.0 KiB、可按关键字/行数搜索；缺实时 tail 与多来源聚合 |
| 4 | 进程 | **可用** | 759 进程取前 100 行，排序/过滤/详情/树/信号入口齐全；缺按 systemd 服务分组 |
| 5 | 终端 | **可用** | 真实 bash 会话 `t-a79d…` 135×40、已连接、提示符在项目目录；接近 1Panel 终端 |
| 6 | 网站 | **部分可用** | 3 站点 CRUD/vhost 存在，但 nginx 未配置 → 校验与生效均「未检测」；宝塔自带 nginx 安装与一键部署 |
| 7 | 数据库 | **部分可用** | 插件在线但 `KORE_MYSQL_INSTANCES` 未配置 → 仅空态引导，无法列库/执行 SQL；1Panel 支持容器化即开即用 |
| 8 | Redis | **部分可用** | 1 个 default 实例 127.0.0.1:6379 不可达（NOAUTH），实例信息/键浏览 502 并显示原因；空态应为 0 连接 |
| 9 | 计划任务 | **部分可用** | 表单与 5 段校验可用，但环境 crontab 权限错误 → 列表不可读、未写入任何任务（保护真实 crontab） |
| 10 | 文件管理 | **可用** | 根目录 6 项真实文件，上传/压缩/解压/权限/移动/批量删除入口齐全；缺在线代码编辑器（宝塔有） |
| 11 | 备份 | **可用** | 真实 `r2` 备份 1.2 KiB/10 条目/sha 可校验，创建/校验/恢复/删除二次确认齐全；缺异地/对象存储 |
| 12 | SSL | **可用** | 1 张自签证书（365 天、指纹可查），验证/续期/新建/导入齐全；ACME 自动申请明示 v1.1 未实现 |
| 13 | 软件商店 | **可用** | 24 条索引、已装 12、分类过滤与离线安装可用；无评分/评论/版本历史（宝塔有） |
| 14 | 已装插件 | **可用** | 12 行真实版本/深度/生命周期/状态，启停与 ping 可用；缺批量升级 |
| 15 | 防火墙 | **部分可用** | ufw `available=false`、规则 401 → 「只读降级」徽标 + 原因原文 + 写操作禁用，**正是本机真实降级态** |
| 16 | 设置 | **可用** | 账户/会话有效期（剩约 12h）/CSRF cookie 真实状态与退出登录；缺多用户与审计日志（非目标） |

**统计**：可用 11 · 部分可用 5（网站/数据库/Redis/计划任务/防火墙）· 占位 0。

## 3. 异常与最直观 3 个问题

1. **数据库页只有空态**：`db-mysql.instances` 返回 `{instances:[],count:0}`，页面正确提示配置 `KORE_MYSQL_INSTANCES`，但当前无法验证库列表/SQL 控制台（本轮不配连接，避免动内核环境）。
2. **Redis 默认实例不可用**：`redis.instances` 返回 default/127.0.0.1:6379 → `NOAUTH Authentication required.`；`redis.info`、`redis.keys` 均 502 `E_UPSTREAM`，页面已把失败原因原样展示（非白屏）。
3. **网站页无 nginx 可校验**：3 个站点 vhost 文件存在，但「未检测（未配置 nginx）」出现 6 次，站点「生效状态」无法确认；宝塔/1Panel 在此场景会先装 web server。

其余环境性降级：计划任务 `crontab -l` 权限错误（未写任务）；防火墙需 root（available=false）；概览常驻 3/3 触顶（推荐 ≤2）。

## 4. 结论

34 张齐全、sha 全唯一、132 项断言全 PASS；16 页中 11 页可用、5 页部分可用（均为真实环境限制或真实降级态）、0 占位。未重启 8787、未改源码、未提交、未污染 crontab。
