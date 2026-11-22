# Round 1 · 14 页双端证据（G-28）
> 2026-11-23T00:22+08:00 · round1-evidence 子 agent · 真 chromium（playwright-core 1.65.1 + 缓存 chromium-1248）· 单 context 单次登录 · 29 张 · 原始采集 `.agents/verify/round1-full-evidence-raw.json`

- 实例：`http://127.0.0.1:8787`（PID 3261414，`./bin/kored serve --config .kore-local.yaml`），healthz 200；**未重启 8787、未改源码、未手改状态库**。
- 登录：页面表单填口令 → `POST /api/v1/auth/login` 200；**1 次登录**后复用同一 context，手机端只 `setViewportSize(390×844)`，不二次登录。
- 采集：每张**截图前**断言 body 无「管理员口令 / 登录失败」，**截图后**立即断言页面关键字（缺一即删图并停止）；29/29 通过，0 张被删。
- 副作用披露：为让 6 个视图有真实数据，走官方 API 安装并启用 `ssl 0.2.0 / backup 0.2.0 / terminal 0.1.0 / process 0.1.0 / logs 0.2.0 / db-mysql 0.1.0`（`POST /api/v1/store/install` download=true + `/plugins/<id>/enable`）；常驻插件峰值 3/3（site+terminal+db-mysql ready，推荐 ≤2 记 WARN）；采集结束复测 db-mysql 已 lazy 退出，**常驻 2/3**（site+terminal）。
- 造数：备份 `r1-docs`（249.6 KiB / 47 条目 / sha256 `1c0dcc65…`，源 `docs/`）；文件根 3 项（复用 `/tmp/kore-file-root`）；站点 2 个（既有，未新建）；日志来源 0（`KORE_LOGS_SOURCES` 未配置）；SSL 自签**失败**（`/etc/kore` 不可写，见异常）。

## 1. 29 张截图：实测尺寸 / sha256 / 前后断言

| # | 文件 | 实测尺寸 | sha256(12) | 前/后断言 | console err | 页面级横向溢出 | 关键元素（行/按钮/面板） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `r1-desktop-01-overview.png` | 1440x900 | `b8f0fbc4928a` | PASS/PASS | 0 | 否 | 0/27/2 |
| 2 | `r1-desktop-02-store.png` | 1440x1610 | `48f8e6967a73` | PASS/PASS | 0 | 否 | 0/67/0 |
| 3 | `r1-desktop-03-plugins.png` | 1440x1001 | `00daf671fb6f` | PASS/PASS | 0 | 否 | 9/44/2 |
| 4 | `r1-desktop-04-files.png` | 1440x900 | `0eb57d178079` | PASS/PASS | 0 | 否 | 3/32/2 |
| 5 | `r1-desktop-05-sites.png` | 1440x900 | `8184c2ddf12a` | PASS/PASS | 0 | 否 | 2/31/2 |
| 6 | `r1-desktop-06-tasks.png` | 1440x900 | `32554fa8e6ea` | PASS/PASS | 1 | 否 | 0/32/2 |
| 7 | `r1-desktop-07-terminal.png` | 1440x901 | `625d18898001` | PASS/PASS | 0 | 否 | 0/28/0 |
| 8 | `r1-desktop-08-db.png` | 1440x900 | `cb3e4e5e5154` | PASS/PASS | 1 | 否 | 0/25/1 |
| 9 | `r1-desktop-09-logs.png` | 1440x900 | `5d50b9c31c5e` | PASS/PASS | 0 | 否 | 0/27/2 |
| 10 | `r1-desktop-10-process.png` | 1440x3973 | `089a318f4ed8` | PASS/PASS | 0 | 否 | 100/31/1 |
| 11 | `r1-desktop-11-ssl.png` | 1440x959 | `3dfa7d1e0740` | PASS/PASS | 0 | 否 | 0/30/3 |
| 12 | `r1-desktop-12-backups.png` | 1440x900 | `b8680d8a50bd` | PASS/PASS | 0 | 否 | 1/29/2 |
| 13 | `r1-desktop-13-monitor.png` | 1440x1267 | `d7b4911c8370` | PASS/PASS | 0 | 否 | 9/25/1 |
| 14 | `r1-desktop-14-settings.png` | 1440x1043 | `62f3d49508c3` | PASS/PASS | 0 | 否 | 4/27/4 |
| 15 | `r1-mobile-01-overview.png` | 390x844 | `d5dc3137c4e8` | PASS/PASS | 0 | 否 | 0/27/2 |
| 16 | `r1-mobile-02-store.png` | 390x844 | `b71240ab8c20` | PASS/PASS | 0 | 否 | 0/67/0 |
| 17 | `r1-mobile-03-plugins.png` | 390x844 | `68b418781c46` | PASS/PASS | 0 | 否 | 9/44/2 |
| 18 | `r1-mobile-04-files.png` | 390x844 | `8f1488c6c0fe` | PASS/PASS | 0 | 否 | 3/32/2 |
| 19 | `r1-mobile-05-sites.png` | 390x844 | `33dabf46411e` | PASS/PASS | 0 | 否 | 2/31/2 |
| 20 | `r1-mobile-06-tasks.png` | 390x844 | `d9a25d7758ef` | PASS/PASS | 1 | 否 | 0/32/2 |
| 21 | `r1-mobile-07-terminal.png` | 390x844 | `7f815635b021` | PASS/PASS | 0 | 否 | 0/28/0 |
| 22 | `r1-mobile-08-db.png` | 390x844 | `4ba5e115df82` | PASS/PASS | 1 | 否 | 0/25/1 |
| 23 | `r1-mobile-09-logs.png` | 390x844 | `79165f70407e` | PASS/PASS | 0 | 否 | 0/27/2 |
| 24 | `r1-mobile-10-process.png` | 390x844 | `e03f9eb046fa` | PASS/PASS | 0 | 否 | 100/31/1 |
| 25 | `r1-mobile-11-ssl.png` | 390x844 | `46a9d55fbc3a` | PASS/PASS | 0 | 否 | 0/30/3 |
| 26 | `r1-mobile-12-backups.png` | 390x844 | `9c465a0fd1ea` | PASS/PASS | 0 | 否 | 1/29/2 |
| 27 | `r1-mobile-13-monitor.png` | 390x844 | `55198a851603` | PASS/PASS | 0 | 否 | 9/25/1 |
| 28 | `r1-mobile-14-settings.png` | 390x844 | `d7a0326faac3` | PASS/PASS | 0 | 否 | 4/27/4 |
| 29 | `r1-mobile-00-nav-drawer.png` | 390x844 | `5e339f83fa53` | PASS/— | 0 | 否 | 抽屉项 9（计划任务…备份） |

- **齐全性**：29/29 落地（14 PC 1440 宽 + 14 手机 390×844 + 1 抽屉）；PC 为 full-page（高度 900–3973），手机为 390×844 视口。
- **唯一性**：29 个 sha256 **两两去重 29 unique / 0 重复**（脚本内置去重，发现重复即报错，未触发）。
- **断言**：28 页 × 3 道（截图前登录态 / 截图前页面特征 / 截图后复查）+ 抽屉「SSL/备份」1 道 = **85 道全 PASS**，0 张因断言缺失被删。
- **console**：仅 tasks(500) 与 db(404) 共 4 条，均为页面自身同源错误（见异常），无脚本异常、无白屏。

## 2. 每页摘录（`document.body.innerText` 归一化前 150 字；手机端仅少侧栏导航，正文一致）

| 页 | 桌面摘录 |
| --- | --- |
| 概览 | 系统信息 版本 0.1.0 常驻插件 2 / 上限 3 插件总数 9 平台 linux · amd64 cgroup v2 降级告警 部分隔离能力不可用（cgroup 委派未开启、SELinux 未启用），资源限额将以观测模式运行 累计重启 8 次 插件概览 已安装 9 已启用 9 运行中 2 异常… |
| 商店 | 软件商店 共 23 个插件 · 已安装 9 个 · 当前显示 23 个 场景预设 预设未装配 当前没有可用的场景预设。 全部 站点与运行时 数据库 运维 安全 🚀 应用一键部署插件 v0.1.0 production · 生产级 运行时 / 站点场景 离线安装 安装 💾 备份插件 v0.2.0 pr… |
| 已装插件 | 插件 刷新列表 插件 版本 深度 生命周期 状态 操作 backup 备份插件 0.2.0 production lazy stopped 停用 调用 ping 状态 stopped cron 计划任务插件 0.2.0 production lazy stopped 停用 调用 ping 状态 st… |
| 文件 | 文件管理 浏览、预览与编辑文件根目录内容；路径始终以根目录相对形式显示。 根目录 新建目录 新建文件 刷新 共 3 项 · / 目录内容 3 项 名称 大小 修改时间 权限 操作 目录docs/ — 2026/11/22 21:44:27 0755 删除 目录www/ — 2026/11/22 21… |
| 网站 | 网站管理 创建站点 vhost，查看 nginx 校验与重载的真实结果。 创建站点 写入后执行 nginx -t 与 reload 域名（小写，至少两个标签） 站点根目录（可选，留空自动生成） 创建站点 站点列表已刷新 站点列表 共 2 个站点 刷新 域名 生效状态 操作 blog.kore.tes… |
| 任务 | 计划任务 管理当前用户的 crontab；每次写入前插件都会备份原内容。 任务表单 5 段表达式 时间表达式（分 时 日 月 周） 每分钟 每小时 每天 3 点 每周一 3 点 命令 备注（可选） 新增任务 5 段 crontab 表达式；命令按原样写入当前用户的 crontab。 计划任务读取失败… |
| 终端 | 终端 已连接 新建会话 关闭会话 pt@U-PT:~/Work/GolandProjects/kore/.kore-local-state/plugins/terminal$ 会话 t-c8752551d0d1de47 · /bin/bash · pid 3286867 · 135×40 |
| 数据库 | 数据库 MySQL / MariaDB 实例、库列表与只读 SQL 控制台。 MySQL 实例 读取实例失败：E_NOTFOUND：未知方法: instances |
| 日志 | 日志 按配置来源查看尾部日志、关键字过滤与全文件搜索；只读，不暴露宿主路径。 日志来源 未配置日志来源 需要在内核环境变量 KORE_LOGS_SOURCES 中登记日志来源（JSON 数组，每项含 name / path / type），修改后重启内核。 日志内容 只读 · 单行上限 8 KiB… |
| 进程 | 进程 来自 /proc 的真实进程：排序、过滤、详情、进程树与信号投递；危险操作二次确认。 刷新 100 / 768 个进程 首次采样无历史基线，CPU 显示为 0 进程列表 点列头排序 · 点行看详情 PID 名称 用户 状态 RSS CPU%↓ 命令 3979401 rygel pt S 56.… |
| SSL | SSL 证书 证书扫描、自签、导入、续期与真实 TLS 握手验证；私钥只提交给本机插件。 验证 刷新 共 0 张证书；验证只做真实 TLS 握手，不改任何文件 申请 Let's Encrypt 证书 ACME 自动申请未实现（v1.1 跟进），当前可用自签或导入 证书列表 还没有证书，可以创建自签证… |
| 备份 | 备份 打包目录、校验完整性、恢复到空目录；恢复与删除都需要页面内二次确认。 共 1 个备份 新建备份 gzip 或无压缩 tar 名称 路径列表（每行一个） 排除 glob（可选） 压缩 gzip 压缩 不压缩（tar） 创建备份 路径必须在插件白名单 KORE_BACKUP_ALLOW_ROOTS… |
| 监控 | 实时采样 · 每 5 秒自动刷新 最后刷新 00:22:31 内核版本 0.1.0 平台 linux · amd64 cgroup v2 重启计数 8 goroutine 14 文件句柄 25 CPU 使用率 实时 0.0 % 内存 VmRSS 超目标 13.3 MiB 13.3 MiB 已用 ·… |
| 设置 | 账户 会话 会话状态 会话有效 认证主体 admin · 单管理员内核 过期时刻 2026/11/23 12:22:21 （剩约 11 小时 59 分） 退出登录 退出后会清除本机会话并回到登录页 安全 CSRF · 会话 CSRF 机制 写操作需要页面内令牌校验，防止跨站伪造请求 kore_csr… |

## 3. 异常统计（如实记录，未掩盖）

- **数据库页不可用**：`db-mysql 0.1.0` 对 `instances / databases / query / status / list / ping` 全部回 `E_NOTFOUND 未知方法`；页面只剩「读取实例失败」黄条，HTTP 404 + console 1 条。
- **计划任务读取失败**：`crontab -l` → `crontabs/pt/: fopen: 权限不够: cron: storage I/O error`（非 root 读不到自身 crontab）；表单可填但任务列表空，HTTP 500 + console 1 条。
- **SSL 空态且自签失败**：`ssl.selfsign` → `E_INTERNAL 创建证书目录 /etc/kore/ssl: mkdir /etc/kore: permission denied`（插件 `KORE_SSL_CERT_DIR` 未配）；页面 0 证书，ACME 明示未实现。
- **日志空态**：`logs/sources` 返回 `{"sources":[],"count":0}`，页面提示需配 `KORE_LOGS_SOURCES` 并重启内核；空态自身渲染完整（符合任务预判）。
- **站点生效状态红**：本机**未安装 nginx**（`nginx` 命令不存在），`site.status` 回 `test_passed:false / test_skipped:true / site_dir_exists:false` → 页面如实标红「nginx -t 失败 / 未加载」。
- **横向溢出**：29/29 页面级 `scrollWidth > innerWidth` 均为 false；进程表在 390px 下靠容器内横向滚动（列被挤出视口，非页面溢出）。

## 4. Round 1 能力现状表

| 页 | 现状 | 本页解决的用户问题 | 与宝塔 / 1Panel 同类功能差距（一句话） |
| --- | --- | --- | --- |
| 概览 | 可用 | 一眼看机器是否健康、插件装了多少 | 有健康总览与降级告警，但缺宝塔首页的快捷入口与一键修复。 |
| 商店 | 可用 | 要加能力时装什么、装哪个 | 23 插件带深度/场景标签，但无预设装配、无搜索排序、无版本选择。 |
| 已装插件 | 可用 | 启停插件、看运行状态 | 能启停与 ping，但无日志查看、无升级/回滚（1Panel 应用管理有）。 |
| 文件 | 可用 | 浏览/新建/预览/删除文件 | 单根目录、无上传下载/解压/权限编辑（宝塔文件管理全套）。 |
| 网站 | 部分可用 | 建站点并确认 nginx 真实生效 | 可建可查，但无 SSL 绑定、反代、伪静态、重写规则编辑（宝塔站点标配）。 |
| 任务 | 部分可用 | 管理 cron 计划任务 | 表单齐全但读不到 crontab，无任务日志/启停（宝塔有计划任务日志）。 |
| 终端 | 可用 | 浏览器里进真实 shell | 真实 pty，但单会话、无多标签与文件传输（1Panel 终端多标签）。 |
| 数据库 | 占位 | 管 MySQL 实例/库/SQL | 页面已渲染但插件方法缺失，建库/改密/备份全无（宝塔数据库管理完整）。 |
| 日志 | 部分可用 | 看/搜日志文件 | 页面完整但需内核环境变量配来源并重启，无站点日志一键接入与切割。 |
| 进程 | 可用 | 查进程、树、发信号 | 真实 769 进程可排序/详情/树，移动端列挤断、无分页与固定表头。 |
| SSL | 占位 | 申请/导入/续期证书 | 仅自签与导入（且本机 /etc/kore 不可写），无 Let's Encrypt 自动申请续期。 |
| 备份 | 可用 | 打包、校验、恢复 | 真实 1 个备份可校验/恢复，但白名单固定、无定时备份与异地存储。 |
| 监控 | 可用 | 看 CPU/内存/磁盘/负载 | 5s 实时采样 + 插件资源表，但无历史曲线（1Panel 有图表历史）。 |
| 设置 | 部分可用 | 看账户/会话/安全与预算 | 只读展示，改口令与运行参数明确「待支持」（宝塔可改密码与面板设置）。 |

## 5. 最直观的 3 个界面问题

1. **数据库页整页不可用**：一进页只有一条 `E_NOTFOUND：未知方法: instances`，实例/库列表/SQL 控制台全不渲染；视图与 `db-mysql 0.1.0` 的方法契约根本没对齐。
2. **计划任务页把系统错误原文怼给用户**：红字 `crontab -l 失败: crontabs/pt/: fopen: 权限不够: cron: storage I/O error`，任务列表空；无「需 root / 如何授权」的产品化指引。
3. **移动端进程表被挤断**：390px 下 PID 显示 `3979…`、名称 `containerd-s…`，RSS/CPU%/命令列被推出视口需横滑；且 100 行全量铺开使桌面 full-page 高达 3973px，无分页/固定表头。
