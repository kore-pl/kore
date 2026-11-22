# kore 成品验收截图报告（G-28）

- 实例：127.0.0.1:18893（隔离 /tmp/final-shots）；8787 未重启、未触碰
- 构建：`make build` → [OK]；bin/kored 8,458,402 B；`strings bin/kored | grep -c "files.js\|sites.js\|tasks.js"` = **11**
- 插件：file 0.1.0 / cron 0.2.0 / site 0.1.0；`POST /api/v1/store/install`（download=true）三个均 HTTP 200，enable 均 HTTP 200
- 数据：文件根 docs/、www/、readme.md；站点 demo.kore.test、blog.kore.test（vhost 存在 / nginx -t 通过 / 已加载）；cron 2 条（0 3 * * *、*/5 * * * *）
- 登录：单次登录后复用同一 browser context；每页截图前、截图后各断言一次：无登录页标记 + 页内关键文案 + 导航 8 项

## 尺寸与断言（identify 实测）
| # | 文件 | 实际尺寸 | sha256 前12 | 断言 |
| --- | --- | --- | --- | --- |
| 1 | final-desktop-01-overview.png | 1440x900 | e048ca8f60a6 | 前/后均 OK |
| 2 | final-desktop-02-store.png | 1440x1610 | fb81f3ec85fe | 前/后均 OK |
| 3 | final-desktop-03-plugins.png | 1440x900 | 8a972fc5ff1b | 前/后均 OK |
| 4 | final-desktop-04-files.png | 1440x900 | 989dc9fec809 | 前/后均 OK |
| 5 | final-desktop-05-sites.png | 1440x900 | 9f57ca4d1ac7 | 前/后均 OK |
| 6 | final-desktop-06-tasks.png | 1440x900 | d94b9d5ca726 | 前/后均 OK |
| 7 | final-desktop-07-monitor.png | 1440x900 | a505475991a9 | 前/后均 OK |
| 8 | final-desktop-08-settings.png | 1440x1043 | 85c4062efe99 | 前/后均 OK |
| 9 | final-mobile-00-nav-drawer.png | 390x844 | d402edf4c381 | 前/后均 OK |
| 10 | final-mobile-01-overview.png | 390x844 | 653d042f67ae | 前/后均 OK |
| 11 | final-mobile-02-store.png | 390x844 | 3bf48ac5625b | 前/后均 OK |
| 12 | final-mobile-03-plugins.png | 390x844 | 1d20290d6b96 | 前/后均 OK |
| 13 | final-mobile-04-files.png | 390x844 | 8798e5e60425 | 前/后均 OK |
| 14 | final-mobile-05-sites.png | 390x844 | 2310eaed317c | 前/后均 OK |
| 15 | final-mobile-06-tasks.png | 390x844 | 68b586fc6bc6 | 前/后均 OK |
| 16 | final-mobile-07-monitor.png | 390x844 | 768bd3cb6607 | 前/后均 OK |
| 17 | final-mobile-08-settings.png | 390x844 | 1a54e80aae93 | 前/后均 OK |

- 17 张 sha256 两两去重：**0 重复**（17 unique）；宽度全部达标（PC 1440 / 手机 390）

## 每页采集（document.body.innerText 前 600 字）

### PC 1440×900（full-page）
- dashboard | final-desktop-01-overview.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 系统信息 / 版本	0.1.0 / 常驻插件	1 / 重启计数	0 / 插件总数	3 / 平台	linux · amd64 / cgroup	v2 / 降级告警	cgroup 委派不可写，限额不生效；SELinux 未强制（disabled），策略拦截不可依赖 / 插件概览 / 已安装	3 / 已启用	3 / 运行中	1 / 异常	0 / 查看全部插件 / 重新检测
- store | final-desktop-02-store.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 软件商店 /  / 共 21 个插件 · 已安装 3 个 · 当前显示 21 个 /  / 场景预设 / 预设未装配 /  / 当前没有可用的场景预设。 /  / 全部 / 站点与运行时 / 数据库 / 运维 / 安全 / 🚀 / 应用一键部署插件 / v0.1.0 / production · 生产级 /  / 运行时 / 站点场景 /  / 离线安装 / 安装 / 💾 / 备份插件 / v0.1.0 / production · 生产级 /  / 运维 / 数据库场景 /  / 离线安装 / 安装 / 📦 / 容器管理插件 / v0.1.0 / basic · 基础级 /  / 运维场景 /  / 离线安装 / 安装 / ⏰ / 计划任务插件 / v0.2.0 / production · 生产级 / 已安装 ✅ /  / 运维场景 /  / 待支持 / 停用 / 🗄️ / MySQL/MariaDB 管理插件 / v0.1.0 / production · 生产级 /  / 数据库场景 /  / 离线安装 / 安装 / 🐘 / PostgreSQL 管理插件 / v0.1.0 / basic · 基础级 /  / 数据库场景 /  / 离线安装 / 安装 / 🧭 / DNS 区域 / 记录管理插件 / v0.1.0 / basic · 基础级 /  / 运维 / 站点场景 /  / 离线安装 / 安装 / 🔁 / Echo 验证插件 / v0.1.1 / basic · 基础级 /  / 运维场景 /  / 离线安装 / 安装 / 📁 / 文件管理插件 / v0.1.0 / production
- plugins | final-desktop-03-plugins.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 插件 / 刷新列表 / 插件	版本	深度	生命周期	状态	操作 /  / cron / 计划任务插件 / 	0.2.0	production	lazy	 / stopped / 	 / 停用 / 调用 ping / 状态 stopped /  /  / file / 文件管理插件 / 	0.1.0	production	lazy	 / stopped / 	 / 停用 / 调用 ping / 状态 stopped /  /  / site / Nginx 站点管理插件 / 	0.1.0	production	resident	 / ready / 	 / 停用 / 调用 ping / 插件 UI（独立沙箱） / 暂无可展示的插件界面；插件界面会在需要时加载，不影响首屏速度。
- files | final-desktop-04-files.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 文件管理 /  / 浏览、预览与编辑文件根目录内容；路径始终以根目录相对形式显示。 /  / 根目录 / 新建目录 / 新建文件 / 刷新 / 共 3 项 · / / 目录内容 / 3 项 / 名称	大小	修改时间	权限	操作 / 目录docs/	—	2026/11/22 21:15:10	0775	删除 / 目录www/	—	2026/11/22 21:15:10	0775	删除 / 文件readme.md	73 B	2026/11/22 21:15:10	0664	删除 / 文件预览 / 点击左侧文件预览内容；目录请点击进入。
- sites | final-desktop-05-sites.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 网站管理 /  / 创建站点 vhost，查看 nginx 校验与重载的真实结果。 /  / 创建站点 / 写入后执行 nginx -t 与 reload / 域名（小写，至少两个标签） / 站点根目录（可选，留空自动生成） / 创建站点 / 站点列表已刷新 / 站点列表 / 共 2 个站点 / 刷新 / 域名	生效状态	操作 / blog.kore.test	 / vhost 存在 / nginx -t 通过 / 已加载 / 	查看状态删除 / demo.kore.test	 / vhost 存在 / nginx -t 通过 / 已加载 / 	查看状态删除
- tasks | final-desktop-06-tasks.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 计划任务 /  / 管理当前用户的 crontab；每次写入前插件都会备份原内容。 /  / 任务表单 / 5 段表达式 / 时间表达式（分 时 日 月 周） / 每分钟 / 每小时 / 每天 3 点 / 每周一 3 点 / 命令 / 备注（可选） / 新增任务 /  / 5 段 crontab 表达式；命令按原样写入当前用户的 crontab。 /  / 计划任务已刷新 / 任务列表 / 共 2 条 / 刷新 / 索引	时间表达式	命令	备注	操作 / 0	0 3 * * *	/usr/local/bin/kore-backup --all	夜间备份	编辑删除 / 1	*/5 * * * *	/usr/local/bin/kore-healthcheck	健康检查	编辑删除
- monitor | final-desktop-07-monitor.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 实时采样 · 每 5 秒自动刷新 / 最后刷新 21:31:45 / 内核版本 0.1.0 / 平台 linux · amd64 / cgroup v2 / 重启计数 0 / goroutine 16 / 文件句柄 94 / CPU 使用率 / 实时 / 9.0 / % / 内存 VmRSS / 超目标 / 12.9 / MiB / 12.9 MiB 已用 · 目标 8 / 红线 16 MiB / 磁盘占用 / 实时 / 517.6 / GiB /  / 共 1875.7 GiB /  / 负载 load1 / 偏高 / 2.34 / 常驻插件数 / 已用满 / 3 / /3 /  / 内核报告的常驻进程数 · 上限 3（推荐 ≤2） /  / 插件总数 / 已采样 / 3 / 个 /  / 已安装插件数 /  / cgroup 委派不可写，限额不生效 / SELinux 未强制（disabled），策略拦截不可依赖 / 插件资源表 / 插件 id	生命周期	状态	授权能力 /  / cron / 0.2.0 · pid 2539746 · 重启 0 / 	lazy	 / ready / 	system:adminsystem:read /  / file / 0.1.0 · pid 2539728 · 重启 0 / 	lazy	 / ready / 	system:readsystem:admin /  / site / 0.1.0 · pid 2492516 · 重启 0 / 	resident
- settings | final-desktop-08-settings.png | text: kore / 控制台 / 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 计划任务 / 监控 / 设置 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 账户 / 会话 / 会话状态	会话有效 / 认证主体	admin · 单管理员内核 / 过期时刻	2026/11/23 09:31:38 （剩约 11 小时 59 分） / 退出登录 / 退出后会清除本机会话并回到登录页 / 安全 / CSRF · 会话 / CSRF 机制	写操作需要页面内令牌校验，防止跨站伪造请求 / kore_csrf cookie	存在（只读展示，前端不可改写） / 会话 cookie	登录凭证保存在浏览器 Cookie 中，页面脚本不可读取 / 会话有效期	随使用自动续期，默认 12 小时（以配置文件为准） / 修改口令 / 待支持 / 当前版本暂不支持在线修改口令；如需更换，请编辑配置文件后重启内核。 / 运行参数 / 只读 · 修改需改配置文件后重启 / 当前版本未暴露运行参数（GOGC、内存上限、数据目录等）；如需调整，请编辑配置文件后重启内核。 / 资源预算（硬红线 / 目标）： / 资源项	硬红线（判未完成）	目标（争取） / 主壳空载 VmRSS	≤ 16 MiB	8 MiB / 单常驻插件	≤ 24 MiB	12 MiB / 常驻合计	≤ 48 MiB	24 MiB / 同时常驻插件数	≤ 3 个	1–2 个 / 当前主壳 0.1.0 · 常驻插件 3 · 重启计数 0 / 关于 / 版本与许可 / kore 版本	0.1.0 / 协议版

### 手机 390×844（viewport）
- dashboard | final-mobile-00-nav-drawer.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 系统信息 / 版本 / 0.1.0 /  /  / 常驻插件 / 3 /  /  / 重启计数 / 0 /  /  / 插件总数 / 3 /  /  / 平台 / linux · amd64 /  /  / cgroup / v2 /  /  / 降级告警 / cgroup 委派不可写，限额不生效；SELinux 未强制（disabled），策略拦截不可依赖 / 插件概览 / 已安装 / 3 /  /  / 已启用 / 3 /  /  / 运行中 / 3 /  /  / 异常 / 0 / 查看全部插件 / 重新检测 / 计划任务 / 监控 / 设置
- dashboard | final-mobile-01-overview.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 系统信息 / 版本 / 0.1.0 /  /  / 常驻插件 / 3 /  /  / 重启计数 / 0 /  /  / 插件总数 / 3 /  /  / 平台 / linux · amd64 /  /  / cgroup / v2 /  /  / 降级告警 / cgroup 委派不可写，限额不生效；SELinux 未强制（disabled），策略拦截不可依赖 / 插件概览 / 已安装 / 3 /  /  / 已启用 / 3 /  /  / 运行中 / 3 /  /  / 异常 / 0 / 查看全部插件 / 重新检测
- store | final-mobile-02-store.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 软件商店 /  / 共 21 个插件 · 已安装 3 个 · 当前显示 21 个 /  / 场景预设 / 预设未装配 /  / 当前没有可用的场景预设。 /  / 全部 / 站点与运行时 / 数据库 / 运维 / 安全 / 🚀 / 应用一键部署插件 / v0.1.0 / production · 生产级 /  / 运行时 / 站点场景 /  / 离线安装 / 安装 / 💾 / 备份插件 / v0.1.0 / production · 生产级 /  / 运维 / 数据库场景 /  / 离线安装 / 安装 / 📦 / 容器管理插件 / v0.1.0 / basic · 基础级 /  / 运维场景 /  / 离线安装 / 安装 / ⏰ / 计划任务插件 / v0.2.0 / production · 生产级 / 已安装 ✅ /  / 运维场景 /  / 待支持 / 停用 / 🗄️ / MySQL/MariaDB 管理插件 / v0.1.0 / production · 生产级 /  / 数据库场景 /  / 离线安装 / 安装 / 🐘 / PostgreSQL 管理插件 / v0.1.0 / basic · 基础级 /  / 数据库场景 /  / 离线安装 / 安装 / 🧭 / DNS 区域 / 记录管理插件 / v0.1.0 / basic · 基础级 /  / 运维 / 站点场景 /  / 离线安装 / 安装 / 🔁 / Echo 验证插件 / v0.1.1 / basic · 基础级 /  / 运维场景 /  / 离线安装 / 安装 / 📁 / 文件管理插件 / v0.1.0 / production · 生产级 / 已安装 ✅ /  / 运维 
- plugins | final-mobile-03-plugins.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 插件 / 刷新列表 / 插件	版本	深度	生命周期	状态	操作 / cron / 计划任务插件 / 0.2.0 / production / lazy / ready / 停用 / 调用 ping / file / 文件管理插件 / 0.1.0 / production / lazy / ready / 停用 / 调用 ping / site / Nginx 站点管理插件 / 0.1.0 / production / resident / ready / 停用 / 调用 ping / 插件 UI（独立沙箱） / 暂无可展示的插件界面；插件界面会在需要时加载，不影响首屏速度。
- files | final-mobile-04-files.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 文件管理 /  / 浏览、预览与编辑文件根目录内容；路径始终以根目录相对形式显示。 /  / 根目录 / 新建目录 / 新建文件 / 刷新 / 共 3 项 · / / 目录内容 / 3 项 / 名称	大小	修改时间	权限	操作 / 目录 / docs/ / — / 2026/11/22 21:15:10 / 0775 / 删除 / 目录 / www/ / — / 2026/11/22 21:15:10 / 0775 / 删除 / 文件 / readme.md / 73 B / 2026/11/22 21:15:10 / 0664 / 删除 / 文件预览 / 点击左侧文件预览内容；目录请点击进入。
- sites | final-mobile-05-sites.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 网站管理 /  / 创建站点 vhost，查看 nginx 校验与重载的真实结果。 /  / 创建站点 / 写入后执行 nginx -t 与 reload / 域名（小写，至少两个标签） / 站点根目录（可选，留空自动生成） / 创建站点 / 站点列表已刷新 / 站点列表 / 共 2 个站点 / 刷新 / 域名	生效状态	操作 / blog.kore.test / vhost 存在 / nginx -t 通过 / 已加载 / 查看状态 / 删除 / demo.kore.test / vhost 存在 / nginx -t 通过 / 已加载 / 查看状态 / 删除
- tasks | final-mobile-06-tasks.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 计划任务 /  / 管理当前用户的 crontab；每次写入前插件都会备份原内容。 /  / 任务表单 / 5 段表达式 / 时间表达式（分 时 日 月 周） / 每分钟 / 每小时 / 每天 3 点 / 每周一 3 点 / 命令 / 备注（可选） / 新增任务 /  / 5 段 crontab 表达式；命令按原样写入当前用户的 crontab。 /  / 计划任务已刷新 / 任务列表 / 共 2 条 / 刷新 / 索引	时间表达式	命令	备注	操作 / 0 / 0 3 * * * / /usr/local/bin/kore-backup --all / 夜间备份 / 编辑 / 删除 / 1 / */5 * * * * / /usr/local/bin/kore-healthcheck / 健康检查 / 编辑 / 删除
- monitor | final-mobile-07-monitor.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 实时采样 · 每 5 秒自动刷新 / 最后刷新 21:31:57 / 内核版本 0.1.0 / 平台 linux · amd64 / cgroup v2 / 重启计数 0 / goroutine 15 / 文件句柄 94 / CPU 使用率 / 实时 / 9.0 / % / 内存 VmRSS / 超目标 / 13.0 / MiB / 13.0 MiB 已用 · 目标 8 / 红线 16 MiB / 磁盘占用 / 实时 / 517.6 / GiB /  / 共 1875.7 GiB /  / 负载 load1 / 偏高 / 2.18 / 常驻插件数 / 已用满 / 3 / /3 /  / 内核报告的常驻进程数 · 上限 3（推荐 ≤2） /  / 插件总数 / 已采样 / 3 / 个 /  / 已安装插件数 /  / cgroup 委派不可写，限额不生效 / SELinux 未强制（disabled），策略拦截不可依赖 / 插件资源表 / 插件 id	生命周期	状态	授权能力 / cron / 0.2.0 · pid 2539746 · 重启 0 / lazy / ready / system:admin / system:read / file / 0.1.0 · pid 2539728 · 重启 0 / lazy / ready / system:read / system:admin / site / 0.1.0 · pid 2492516 · 重启 0 / resident / ready / system:admin / 技术说明
- settings | final-mobile-08-settings.png | text: 概览 / 软件商店 / 已装插件 / 文件管理 / 网站 / 更多 / 正常 / 健康检查 / 正常 / 系统信息 / 退出 / 账户 / 会话 / 会话状态 / 会话有效 /  /  / 认证主体 / admin · 单管理员内核 /  /  / 过期时刻 / 2026/11/23 09:31:38 （剩约 11 小时 59 分） / 退出登录 / 退出后会清除本机会话并回到登录页 / 安全 / CSRF · 会话 / CSRF 机制 / 写操作需要页面内令牌校验，防止跨站伪造请求 /  /  / kore_csrf cookie / 存在（只读展示，前端不可改写） /  /  / 会话 cookie / 登录凭证保存在浏览器 Cookie 中，页面脚本不可读取 /  /  / 会话有效期 / 随使用自动续期，默认 12 小时（以配置文件为准） / 修改口令 / 待支持 / 当前版本暂不支持在线修改口令；如需更换，请编辑配置文件后重启内核。 / 运行参数 / 只读 · 修改需改配置文件后重启 / 当前版本未暴露运行参数（GOGC、内存上限、数据目录等）；如需调整，请编辑配置文件后重启内核。 / 资源预算（硬红线 / 目标）： / 资源项	硬红线（判未完成）	目标（争取） / 主壳空载 VmRSS / ≤ 16 MiB / 8 MiB / 单常驻插件 / ≤ 24 MiB / 12 MiB / 常驻合计 / ≤ 48 MiB / 24 MiB / 同时常驻插件数 / ≤ 3 个 / 1–2 个 / 当前主壳 0.1.0 · 常驻插件 3 · 重启计数 0 / 关于 / 版本与许可 / kore 版本 / 0.1.0 /  /  / 协议版本 / kor

## 异常与溢出
- 17/17 页：console error = 0、未捕获异常 = 0、Log error = 0；scrollWidth == innerWidth（无横向溢出）
- 关键元素计数：store 卡 21、files 行 3、sites 行 2、tasks 行 2、monitor 卡 6、settings 行 19、drawer 项 3、导航 8

## 最直观的 3 个界面问题
1. 顶栏状态「正常 健康检查 正常 系统信息」语序倒置：状态点在前、标签在后，读起来像两个「正常」并排。
2. 「已装插件」把 lazy 插件的 idle 退出显示成黄点 + stopped（PC 截图如此，手机时因刚被调用显示 ready），容易被误读为故障。
3. 商店已安装卡片操作区在「停用」旁显示灰色「待支持」（file/site/cron 都是），用户不知道缺的是更新还是卸载入口。

补充观察：监控页文件句柄 94（G-19 红线 fd ≤ 64）、VmRSS 13.0 MiB（超 8 MiB 目标、未超 16 MiB 红线）；概览「运行中 1」与监控「常驻插件数 3/3」口径不一致。
