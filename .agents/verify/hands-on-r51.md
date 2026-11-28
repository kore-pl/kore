# 真实上手演练报告 h51（隔离实例 · 从零安装 → 改口令 → 核心路径真操作 → 双端截图找卡点）

> 元信息: 2026-11-28 15:46–16:01 +08:00 · 执行者 `hands-on-r51` 子 agent（真实上手 worker）· task-327 · 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore` · HEAD `8fac75c906f7019326e7c635d37261ed7f2a654f` · G-28 双端证据 + 三问自评 · 报告只记录实测，不推测。

## 0. 隔离边界与诚实声明（先读）

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| 实例端口 | `127.0.0.1:55271`（非 8787） | 配置 `server.addr`，`curl .../healthz` 200 |
| 二进制 | 从 HEAD `git archive` 现编的临时二进制（不覆盖宿主 `bin/kored`） | `go build -o /home/pt/Work/GolandProjects/kore-pl/.tmp/hands-r51/bin/kored` exit 0，`kored version` = 0.1.4 |
| config/state/run/log/index | 全在 `/home/pt/Work/GolandProjects/kore-pl/.tmp/hands-r51/iso/` 下独立目录 | 配置文件原文见 §1.1 |
| 索引 / 插件 | 本地 `kore-plugins/index/plugins.json`（含 `.sig`）副本 + 本地 `kore-plugin-*/dist/*.tar.gz` 离线包，`store/install` 走 `package_path`；零联网业务 | §2.2 安装输出 |
| 宿主 8787 / `.kore-local-*` / `bin/kored` | 零请求、零写入；共享凭据 sha 全程不变 | `eda3f46d…f3e789` → 同值（§1.1 / §1.5） |
| 凭据纪律 | 初始口令只从 0600 文件读入 shell 变量、新口令只写 0600 文件，绝不进 argv / 日志 / 本报告 | §1 输出只含长度/HTTP 码/布尔值；`make secret-check` 见 §6 |
| 一次性 harness | 全部写在 session 工作区 `.tmp/`，验证完 `rm -rf`（见 §7） | 收尾命令见 §7 |
| 浏览器 | 本机缓存 `chromium_headless_shell-1248`（Chrome for Testing 156）+ `pw-runner` 的 playwright-core，Playwright 真点击 + `fullPage` 截图 | §2 / §3 |

**边界**：① 隔离实例不是运行中的 8787 生产态，本报告的"可用"只针对隔离实例；② 商店用本地索引副本 + 本地离线插件包，不是真实公网商店下载链路（联网下载路径未演练）；③ 未做宝塔 / 1Panel 真机对照，§4 差距判断是基于产品常识的主观自评，不作超越证据；④ 本机无 nginx，站点页在 `nginx_mode=off` 下演练配置保存路径，不代表真实 nginx 部署成功。

---

## 1. 从零安装（step ①）

### 1.1 全新实例准备

命令（原文，凭据相关值不落报告）：

```
$ ISO=/home/pt/Work/GolandProjects/kore-pl/.tmp/hands-r51/iso
$ rm -rf "$ISO" && mkdir -p "$ISO"/{config,state,run,log,index,bin}
$ cp /home/pt/Work/GolandProjects/kore-pl/.tmp/hands-r51/bin/kored "$ISO/bin/kored"
$ cp ../kore-plugins/index/plugins.json{,.sig} "$ISO/index/"
$ cat >"$ISO/config/config.yaml" <<EOF
server:
  addr: "127.0.0.1:55271"
auth:
  session_ttl: "12h"
  cookie_secure: "auto"
paths:
  state_dir: "$ISO/state"
  run_dir: "$ISO/run"
  log_dir: "$ISO/log"
  index_dir: "$ISO/index"
EOF
$ chmod 600 "$ISO/config/config.yaml"
```

输出：`FRESH_CONFIG_NO_HASH=YES`（配置里没有 `admin_password_hash` / `initialized`）；`HOST_SHARED_CRED_SHA=eda3f46d…f3e789`。退出码全 0。

### 1.2 首次启动 → 生成 0600 初始凭据

命令：

```
$ "$ISO/bin/kored" serve --config "$ISO/config/config.yaml" >"$ISO/log/serve-first.log" 2>&1 &
```

| 项 | 实测 |
| --- | --- |
| 健康 | `HTTP/1.1 200 OK` / `{"status":"ok"}`，`HEALTH_EXIT=0` |
| stderr（非 TTY，明文不落日志） | `初始管理员凭据已生成，请在自己的终端读取：<iso>/state/initial-admin-credential（权限 0600）。` + `打开面板输入凭据文件里的账号与口令，建议登录后设置一个新口令（可选，不强制）；改密成功后该文件会自动删除。`（未打印任何口令值） |
| 凭据文件 | `stat -c '%n mode=%a size=%s'` → `mode=600 size=51`；两行格式 `username=…` / `password=…` |
| 配置回填 | `admin_password_hash: <HASH_REDACTED>` / `admin_username: "admin"` / `initialized: true` / `must_change_password: true` |

这里有一个**真实上手卡点**：非 TTY 场景（systemd/journald、CI、我这种 harness）只提示"请在自己的终端读取"，但没说文件里是什么格式、也没说怎么读；用户必须在文件系统上找到它并 `cat`。见 §5 P2-1。

### 1.3 用初始口令登录

```
$ LOGIN=$(curl -sS -c "$ISO/run/h1.cookies" -X POST http://127.0.0.1:55271/api/v1/auth/login \
    -H 'Content-Type: application/json' --data-binary @- <<EOF
{"username":"$USER","password":"$PASS"}
EOF
)
```

`LOGIN_EXIT=0`，`LOGIN_BODY={"authenticated":true,"expires_at":"2026-11-28T19:51:25Z"}`；`CSRF_PRESENT=YES`；`GET /api/v1/auth/session` = 200。

### 1.4 在线改口令

```
$ CHANGE=$(curl -sS -b "$JAR" -X POST http://127.0.0.1:55271/api/v1/auth/password \
    -H 'Content-Type: application/json' -H "X-Kore-CSRF: $CSRF" --data-binary @- <<EOF
{"username":"$USER","current_password":"$PASS","new_password":"$NEWPASS"}
EOF
)
```

`CHANGE_EXIT=0`，`CHANGE_BODY={"authenticated":false,"expires_at":""}`（成功即吊销全部会话，符合 fail-secure）。
`CRED_FILE_AFTER_CHANGE=DELETED`（一次性凭据文件已消费）、`MUST_CHANGE_FALSE_COUNT=1`。

**真实卡点**：第一次我用 `X-CSRF-Token` 头，返回 `{"code":"E_UNAUTHORIZED","message":"CSRF 校验失败"}`（curl exit 0 但业务失败）；前端 `web/settings.js:1011` 用的是 `X-Kore-CSRF`。错误文案"CSRF 校验失败"对小白不可行动，卡点见 §5 P2-2。

### 1.5 新口令重登 + 旧口令失效验证

```
STEP4_NEWPASSWORD_LOGIN_HTTP=200
STEP5_OLDPASSWORD_LOGIN_HTTP=401
HOST_SHARED_CRED_SHA_AFTER=eda3f46d…f3e789   # 与开工前逐字相同
```

验证通过：默认口令失效、新口令可用、宿主共享凭据未被触碰。`HARNESS_EXIT=0`。

> 补充：故意输错一次旧口令后，登录进入**验证码挑战态**，下一次即使拿正确的新口令登录也会被 428 `E_CAPTCHA_REQUIRED` 拦住，必须先 `GET /api/v1/auth/captcha` 做文本加法题。这是安全设计（`handlers_auth.go:88-99`），但文案只说"密码错误，请输入右侧验证码"，没有告诉用户验证码需要先点"换一张"/在哪取——作为上手体验记为 P2-3。

---

## 2. 核心路径真实操作（step ②）

环境：浏览器登录隔离实例（Playwright 真点击，不是 cookie 注入假象），随后真实点击 UI + 真实 `invoke`/API；每项均截图。

### 2.1 插件安装（先装齐 5 个，离线本地包）

命令（浏览器上下文 `ctx.request.post`，`package_path` 本地绝对路径）：

```
POST /api/v1/store/install
{"id":"echo","version":"0.1.7","package_path":"…/kore-plugin-echo/dist/echo-0.1.7.tar.gz"}
# site 0.8.3 / file 0.3.6 / monitor 0.6.0 / backup 0.6.0 同法
```

输出（每项）：`INSTALL_<id>=200 {"id":"<id>-<ver>","state":"succeeded","message":"安装完成","reload":"reloaded"}`。

**关键上手卡点**：`POST /api/v1/store/install` 只安装**不启用**（自动启用只发生在 UI 安装路径 `web/store.js:1111 autoEnableAfterInstall`）。随后任何 `invoke` 都返回 `E_CONFLICT` + 原文 `插件 site 未启用，请先 POST /api/v1/plugins/site/enable`，直接弹到页面上（见 `sites-after-desktop-03`）。我必须在 harness 里额外逐个 `POST /api/v1/plugins/<id>/enable` 才能让站点/文件/监控/备份动起来。见 §5 P1-2（API 语义）和 P1-3（文案暴露内部 API）。

### 2.2 站点：建静态站 + 域名

- 真实 UI 输入域名 `demo.kore.test` → 点「一键创建站点」（`data-action="wizard-submit"` 真点击）。
- 首次结果：**失败**。`SITES_AFTER` 原文：`创建站点目录 | 跳过 | 未创建：文件系统操作失败（mkdir）: read-only file system…` + `创建站点 | 失败 | 目标 vhost 已存在但不在本插件清单中，拒绝覆盖: /etc/nginx/conf.d/kore-site-demo.kore.test.conf`（宿主残留文件，非本实例产物）。`site/list` = `E_CONFLICT 插件 site 未启用`（当时还没 enable）。
- 修正演练：通过 `site/site.config.set` 把 `nginx_mode=off` + `host_conf_dir` 指向隔离目录，然后 UI 填 `hands.r51.test` + 自定义可写根目录 → 真点「一键创建站点」。结果：

```
站点已建好 · hands.r51.test（2 步全部完成）
SITE_LIST={"nginx_mode":"off",...,"sites":[{"domain":"hands.r51.test","vhost_path":"<iso>/state/site-conf/kore-site-hands.r51.test.conf","enabled":true,"exists":true,...}],"count":1}
```

- 截图：`hands-r51-sites-before-desktop-02.png`、`hands-r51-sites-after-desktop-03.png`（失败态）、`hands-r51-sites-created-desktop-18.png`（成功态）、`hands-r51-sites-created-mobile-02.png`（手机）。

上手卡点：默认 `nginx_mode=auto` 在无 nginx 的干净机器上不会自动降级到可写目录，反而撞宿主 `/etc/nginx/conf.d` 残留和只读文件系统；要成功必须先懂"连接配置"里的 nginx 模式。见 §5 P2-4。

### 2.3 文件：新建 / 编辑 / 下载

`file` 插件 root 默认整机 `/`（`kore-plugin-file/internal/fileop/root.go:15-22`），路径用相对根的形式。真实操作（浏览器上下文 invoke，CSRF 双提交）：

| 操作 | 命令（方法） | 退出码 / 原文要点 |
| --- | --- | --- |
| 建目录 | `POST /api/v1/invoke/file/mkdir {"path":"home/pt/…/iso/state/handson","mode":"0755"}` | 首次 200 `{"created":true}`；重跑 409 `目标已存在` |
| 新建/写文件 | `file/write {"path":"…/hello.txt","content":"hello kore hands-on r51","create_if_missing":true}` | 200 `{"created":true,"size":23}` |
| 读取 | `file/read {"path":"…/hello.txt"}` | 200 `{"content":"hello kore hands-on r51","size":23}` |
| 编辑（范围写） | `file/writeRange {"path":"…/hello.txt","offset":0,"data_base64":"<base64>"}` | 200 `{"written":23,"sha256":"be7419b7…"}`；再读内容 = `GREET kore hands-on r51` |
| 下载 | `file/download {"path":"…/hello.txt"}` | 200 `{"filename":"hello.txt","size_bytes":23,"data_base64":"aGVsbG8g…"}` |
| UI 新建菜单 | 真点「新建」按钮 | 弹出 `新建目录 / 新建文件` 两项（见 `files-newmenu-desktop-16`） |

**真实卡点**：`file.writeRange` 的入参是 `data_base64`，不是 `content`/`length`；我第一次用错参数得到 `200 {"written":0}`（**看起来成功，实际没改文件**）。前端知道这个契约，但 API 直连者极易踩坑；属 P2-5（静默无操作）。截图：`hands-r51-files-desktop-04.png`、`hands-r51-files-mobile-01.png`、`hands-r51-files-write-desktop-09.png`、`hands-r51-files-newmenu-desktop-16.png`。

### 2.4 监控：看曲线 + 切时间范围 + 改阈值

- UI 真点「昨天」「7天」两个时间范围按钮（`.mon-range-btn`）：`RANGE_BTN_昨天=1`、`RANGE_BTN_7天=1`，点击后 `MON_AFTER_TEXT` 出现 `密集采样已按每桶末值合并显示。当前只保留 60 点…` → `这个时间段没有采样点`，说明确实按范围重算了。
- 阈值：`MON_THRESHOLD_BEFORE` / `MON_SET` / `MON_THRESHOLD_AFTER`：`monitor/monitor.config.set {"cpu_threshold":85,"memory_threshold":88,"disk_threshold":92,"history_points":720,"history_interval_s":60}` → 200 `{"saved":true,"applied":true,"warnings":["配置已保存并立即生效…"]}`。
- UI 真点「⚙ 阈值设置」齿轮（`GEAR_COUNT=1`）→ 截图 `monitor-threshold-desktop-11`（430 KB，面板已展开）。
- 页面同时给出 CPU/内存/负载/磁盘/温度/进程 Top10 的真实数据；历史曲线区因没有采样点为空，提示 `一键开启连续采样`。
- 截图：`hands-r51-monitor-desktop-05.png`、`hands-r51-monitor-mobile-01.png`、`hands-r51-monitor-range-desktop-10.png`、`hands-r51-monitor-threshold-desktop-11.png`。

上手卡点：`monitor.js:877` 的提示写「请先到『插件』页启用监控插件」，但主壳没有独立的"插件"一级菜单（插件管理在「软件商店 → 插件管理」tab），指引指向不存在的页面。见 §5 P2-6。

### 2.5 备份：建 + 列出 + 查看

- 首次 `backup/backup.create {"name":"r51-snapshot","paths":[<iso>/state/handson]}` → 400：先因为默认预设 `/var/www` 不存在（`E_INVALID 预设「网站全量备份」在本机没有找到可备份的目录`），显式 paths 后又 400 `备份路径不在允许的根目录白名单内：默认 /var/www、/etc/kore、/home`（我的隔离目录在 `/home/pt/...` 下其实属于 `/home`，但插件白名单按精确路径比对）。
- UI 上「加入允许根路径」按钮存在但只对自动探测出的 `/opt`、`/etc/nginx` 可用；我改用 `backup/backup.config.set {"values":{"dir":"<iso>/state/backups","allow_roots":["<iso>/state/handson", ...]}}` → 200 `{"saved":true,"applied":true}`。
- 再次 create → 200：`{"id":"r51-snapshot-20261128T075842Z","size_bytes":265,"entries":2,"sha256":"0adc2e77…","dimensions":["site"],"job":{"status":"succeeded",...}}`。
- `backup/backup.list` → 200 `{"backups":[{...,"corrupted":false,"managed":true}],"count":1}`。
- **发现真实 UI 缺陷**：进入备份页（当 `backup.jobs` 非空）浏览器控制台抛 2 次 `TypeError: Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'`，堆栈 `at add (backups.js:57:40) → at paintJobs (backups.js:745:19)`。「最近作业」表头渲染失败（列表数据本身已成功返回）。见 §5 **P1-1**。
- 截图：`hands-r51-backup-desktop-06.png`（空态）、`hands-r51-backup-created-desktop-12.png` / `hands-r51-backup-created-desktop-17.png`（已创建，含作业表）、`hands-r51-backup-mobile-01.png`。

### 2.6 插件：商店安装 + 启停 + 详情抽屉

- **真实 UI 安装**：软件商店搜索 `cron` → 点该卡片「离线安装」→ 在展开的内联输入框填本地包 `/home/pt/Work/GolandProjects/kore-pl/kore-plugin-cron/dist/cron-0.9.1.tar.gz` → 点「确认安装」。结果 `STORE_AFTER` 原文：`计划任务插件 v0.9.1 | 已安装 | 已是最新 | ✓ 安装成功 · 已自动启用`。这证明 UI 路径的"安装 + 自动启用"是通的（与 §2.1 的 API 直连形成对照）。截图 `hands-r51-store-installed-desktop-19.png`。
- **启停（真点击）**：插件管理页点 echo 行「停用」→ `ECHO_AFTER_DISABLE=... 已停用 | 启用 | 详情`；点「启用」→ `ECHO_AFTER_ENABLE=... 空闲 | 停用 | 详情`。状态确实双向变化。
- **详情抽屉（真点击）**：点 `.plugin-detail-btn`「详情」→ 该行详情区展开，截图 `hands-r51-plugin-detail-desktop-13.png`。
- 插件管理页计数原文：`已启用 5 · 运行中 3 · 空闲 2 · 已停用 0`。截图 `hands-r51-plugins-desktop-07.png`、`hands-r51-plugins-mobile-01.png`。

### 2.7 告警：铃铛 + 通知渠道入口

- 顶栏铃铛（`#kore-alert-trigger`）真点击 → 弹出「告警中心」抽屉，原文 `告警中心 | 共 7 条 · 未读 4 | 通知渠道 | 全部标为已读 | 重新检查 | 关闭` + 严重/警告条目。截图 `hands-r51-alerts-bell-desktop-14.png`。
- 抽屉里「通知渠道」入口真点击可跳到 `设置 → 通知通道`（`web/settings.js` 的 `webhook` tab）；页面原文 `告警除了站内铃铛，还可以按你的配置推到你自己的 Webhook、邮箱、企业微信 / 钉钉 / 飞书群。Kore 不主动收集任何数据…`。截图 `hands-r51-webhook-desktop-15.png`。

### 2.8 设置：改配置 + 验证持久化

```
$ curl -sS -b <jar> -X POST http://127.0.0.1:55271/api/v1/system/config \
    -H "X-Kore-CSRF: <csrf>" -H 'Content-Type: application/json' -d '{"log_level":"warn"}'
CONFIG_WRITE=200 {"saved":true,"restart_required":false,"applied":true}
CONFIG_PERSIST_LOGLEVEL=warn
# 再写回 info
CONFIG_WRITE2=200 {"saved":true,"restart_required":false,"applied":true}
CONFIG_PERSIST_LOGLEVEL2=info
```

两次写入后读隔离实例 `config.yaml`，`log.level` 从缺省 → `"warn"` → `"info"`，**持久化成立**。截图 `hands-r51-settings-desktop-08.png`（设置页 38 项搜索 + 通知通道 tab）。

---

## 3. 双端截图取证（step ③）

工具链：Playwright chromium-1248 headless，`Emulation.setDeviceMetricsOverride` 等价的 context viewport（PC 1440×900 / 手机 390×844 `isMobile:true,hasTouch:true`），`page.screenshot({fullPage:true})`。所有图片为浏览器真实渲染，不是设计稿、不是同图缩放。

### 3.1 六关键页双端配对（PC full-page 宽 1440；手机 390×844 视口）

| 场景 | PC 文件 | `identify` | 手机文件 | `identify` |
| --- | --- | --- | --- | --- |
| 首页 | `hands-r51-home-desktop-01.png` | 1440×900 | `hands-r51-home-mobile-01.png` | 390×844 |
| 站点 | `hands-r51-sites-created-desktop-18.png` | 1440×900 | `hands-r51-sites-created-mobile-02.png` | 390×1621（full-page） |
| 文件 | `hands-r51-files-desktop-04.png` | 1440×2120 | `hands-r51-files-mobile-01.png` | 390×5664 |
| 监控 | `hands-r51-monitor-desktop-05.png` | 1440×2934 | `hands-r51-monitor-mobile-01.png` | 390×4094 |
| 备份 | `hands-r51-backup-created-desktop-17.png` | 1440×2482 | `hands-r51-backup-mobile-01.png` | 390×3382 |
| 插件 | `hands-r51-plugins-desktop-07.png` | 1440×900 | `hands-r51-plugins-mobile-01.png` | 390×1942 |

命令原文与退出码：

```
$ cd .agents/verify/screenshots
$ identify -format '%f %wx%h\n' hands-r51-*.png      → exit 0（26 张，PC 宽全部 1440、手机宽全部 390）
$ sha256sum hands-r51-*.png                          → exit 0（26 个文件、26 个互不相同的 sha256，无一重复）
$ file hands-r51-home-desktop-01.png                 → PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced（exit 0）
```

**读图确认非伪造**：已用 `read_image` 打开并肉眼核对 4 张代表图：
- `hands-r51-home-desktop-01.png`（1440×900）：左导航 11 项、91 分体检卡、3 个快捷 CTA、待办 1 项，真实 DOM 文本与 API 一致；
- `hands-r51-sites-created-desktop-18.png`（1440×900）：站点 `hands.r51.test` 已建、vhost 存在、"本机还没有可用的 nginx" 提示，与 `site/list` 返回值一致；
- `hands-r51-store-installed-desktop-19.png`（1440×900）：cron v0.9.1 卡片 `已安装 / 已是最新 / ✓ 安装成功 · 已自动启用`，与安装 API 一致；
- `hands-r51-home-mobile-01.png`（390×844）：手机布局为顶部 4 图标 + 折叠底部 tab 栏（概览/网站/数据库/文件管理/软件商店/更多），同一份数据、独立 context 渲染，非桌面图裁切。

其余 22 张由同一 harness 的 `page.screenshot` 产出，`identify` 宽高与 sha 互异已列全（§3.2 附抽样值）。

### 3.2 关键截图 sha256（抽样，全量见报告同目录 PNG 的 `sha256sum`）

```
37a1eb9079db06b53403813d99258d8c68fa4cd368058983c459a00d6d5b95d5  hands-r51-home-desktop-01.png
5e46782c22e8c412b42db2fc92f23c6e81131fd75e1ad1b09fb1628883ddc0e7  hands-r51-home-mobile-01.png
5653a96c36d019fee1f120ea6a89d360da648f0bec54175670f798646f6a8528  hands-r51-sites-created-desktop-18.png
74a2dc8b2f3397e8ba83d90f744b7c8a85c062dfc44b8d30ad38329cd310c365  hands-r51-sites-created-mobile-02.png
0df95046bab562fd38b9c9fdf7963c5e5e5374e574b8f6ae8ded1e72f80a2841  hands-r51-monitor-desktop-05.png
95b7e23a2303bb7b8a97c6226a718c0fc83437de12b38919df6b2a93d830ff7c  hands-r51-monitor-mobile-01.png
23332952ed5c6fa18135e19bf089554548c4880e31ecccaf87ab520d5f174f5f  hands-r51-plugins-desktop-07.png
ac7184ffacfa0929e48b967599b78289867c3d8f18e9aba69b4adf820f04b286  hands-r51-plugins-mobile-01.png
edec2a2184c347cf0bdd945419c55e58088e2b1cb96d37e3591a973de949944a  hands-r51-backup-created-desktop-17.png
0e87b772e244637b9ee7fc971e341431104e1170fbe0ed0bce9a65285b428423  hands-r51-backup-mobile-01.png
```

---

## 4. 用户视角三问自评（step ④ · G-28）

### 问 1：这次演练替用户解决什么问题？

把"装完 Kore 到底能不能用"这件事，从看代码/看文档变成**真机跑一遍**：一个没有管理员手册的人，从空目录启动 → 读初始凭据 → 登录改密 → 建站/传文件/看监控/做备份/装插件/看告警/改设置，是否每一步都能走通、哪里会卡住。结论：新安装+改口令+插件安装/启停+文件读写+设置持久化这五条是真正**可用**的；站点和备份需要满足环境前置条件才通；监控曲线是"等采样才有"的半成品。

### 问 2：与宝塔 / 1Panel 同类功能的上手体验差距（具体，不写"待完善"）

| 能力 | 宝塔 / 1Panel 的开箱体验 | 本次实测 Kore | 具体差距 |
| --- | --- | --- | --- |
| 建站 | 装好面板后填域名+根目录，自带 nginx 一键创建并真实可访问 | 干净机器无 nginx 时自动探测降级为 `nginx_mode=off` 仍撞宿主残留 vhost，必须手动去"连接配置"改 mode/conf dir；建完 CTA「在浏览器打开」指向未解析域名，打不开（§5 P2-4/P2-7） | 缺"没有 nginx 时自动给出可工作的最小闭环"（例如内置静态文件服务预览 / 自动写 hosts 提示 + 明确告知不能公网访问）；现页面提示要用户自己改 `/etc/hosts` |
| 文件管理 | 根限定在 `/www` 或站点目录，按站点隔离 | `KORE_FILE_ROOT` 缺省是整机 `/`，文件页首屏就是 `boot/ cdrom/ dev/ etc/ home/`（见 files-desktop-04） | 缺省根目录过宽，小白不知道操作的边界，与"管理自己站点文件"的心智不符；缺"按站点自动收窄根"的预设 |
| 监控曲线 | 装完即有实时曲线与历史 | 页面 CPU/内存/负载是实时的，但历史曲线为空，提示"还差采样点…一键开启连续采样"，且指引的"插件页"在主壳不存在（§5 P2-6） | 缺默认启用的轻量采样任务，首屏曲线是空壳；导航文案指向不存在的入口 |
| 备份 | 默认备份 `/www` 与数据库，选一下就能建 | 默认预设 `/var/www` 本机不存在→失败；显式路径又撞白名单，需先 `backup.config.set` 加根路径才能建（§2.5） | 缺"自动发现用户刚建的站点目录并加入白名单"这一步，建站后并未联动备份源 |
| 软件商店 | 公网商店直接安装 | 本地索引 + 本地离线包安装成功（UI 路径会自动启用；API 路径不会），预设区显示"预设未装配" | 隔离演练无法代表真实公网下载链路；本地 preset 目录没接进实例配置，导致"场景预设"整块空白占位 |

### 问 3：当前是"可用"还是"占位"？

- **可用**：首次启动凭据生命周期、登录/改密/旧口令失效、文件新建-编辑-下载、监控实时指标与阈值设置、插件商店本地安装-启停-详情、告警中心与通知渠道入口、设置项写回持久化——均有真实命令退出码 + 页面截图佐证。
- **可用但有前置条件**：建站（需配置 nginx 模式与可写根目录）、备份（需配置允许根路径）。
- **占位/半成品**：监控历史曲线（无采样点时为空，需手动开启连续采样）、商店"场景预设"区（隔离实例未装配 presets 目录）、站点 CTA「在浏览器打开」（域名未解析时点了打不开）。

---

## 5. 卡点清单（step ⑤ · 按 P0/P1/P2 分级，逐条 file:line + 截图 + 复现）

> 分级：P0 = 阻断核心任务 / 凭据或数据风险；P1 = 核心路径真出错、影响可用性但不阻断其它路径；P2 = 文案/多步/点不动/要翻文档才能懂。本次演练**无 P0**。发现真缺陷只记录并报 lead 另派修复卡，本 worker 不改生产代码。

### P1-1 备份页「最近作业」表头渲染抛 JS TypeError（真缺陷）

- `file:line`：`web/backups.js:57`（`function add(parent, child){ parent.appendChild(child); ... }`）+ `web/backups.js:745`（`var htr = add(add(table, 'thead') || table.appendChild(el('thead')), el('tr'));`）。`add(table, 'thead')` 把**字符串** `'thead'` 传给 `appendChild`，浏览器立即抛 `TypeError`。
- 截图：`hands-r51-backup-created-desktop-17.png`（创建备份后进入备份页）；当时浏览器控制台两次异常。
- 复现：① 起实例、装并启用 backup 插件；② `backup.config.set` 加 allow_roots、创建一个备份使 `backup.jobs` 非空；③ 打开 `#/files/backup`；④ 观察 console：`TypeError: Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node' at add (backups.js:57:40) at paintJobs (backups.js:745:19)`（实测 2 次）。
- 影响：「最近作业」表头/表格渲染失败（数据本身已从 API 返回），用户看不到作业历史。`git blame` 显示该行来自 `1a5a8f7b`，非本轮引入。报 lead 另派修复卡（建议把 `add(table, 'thead')` 改成 `add(table, el('thead'))`）。

### P1-2 API 安装插件后不启用，且 UI 安装与 API 安装语义不一致

- `file:line`：UI 自动启用在 `web/store.js:1111`（`autoEnableAfterInstall`）；API 侧只在 `/api/v1/store/install` 落安装、不置 desired，`cmd/kored/serve_daemon_actions.go:99-101` 对未启用插件直接 `E_CONFLICT`。
- 截图：`hands-r51-sites-after-desktop-03.png`（页面原文 `插件 site 未启用…` + `一键建站失败`）。
- 复现：`POST /api/v1/store/install {"id":"site","version":"0.8.3","package_path":"<local>"}` → 200 `state:succeeded`；紧接 `POST /api/v1/invoke/site/site.list` → 409 `插件 site 未启用`；必须再 `POST /api/v1/plugins/site/enable` 才能用。而 UI 商店安装同一插件会自动启用（`STORE_AFTER` 显示 `✓ 安装成功 · 已自动启用`）。
- 影响：脚本化/离线批量安装后"装了却用不了"，与 UI 体验不一致。报 lead 裁决是否统一语义（不在本写域内修）。

### P1-3 错误文案把内部 API 动词直接甩给用户（违反 USABILITY 原则④）

- `file:line`：`cmd/kored/serve_daemon_actions.go:101` —— `"插件 %s 未启用，请先 POST "+apiPlugins+"/%s/enable"`。
- 截图：`hands-r51-sites-after-desktop-03.png`、`hands-r51-files-desktop-04.png`（页面原文 `读取失败：E_CONFLICT：插件 file 未启用，请先 POST /api/v1/plugins/file/enable`）。
- 复现：按 P1-2 安装但不启用 → 打开站点/文件页 → 错误横幅原样显示 `POST /api/v1/plugins/...`，小白不知道这是要点的按钮还是给开发看的命令；页面此时虽有"安装站点插件"按钮，但插件其实已装只是没启用，入口对不上。
- 建议（交修复卡）：改为白话 + 可点击动作，如 `文件管理插件还没启用` + 按钮「去启用」（跳 `store/plugins`），不暴露 POST 路径。

### P2-1 非 TTY 首次启动只给路径，不告诉用户怎么取凭据

- `file:line`：`cmd/kored/admin_password.go:297-300`（`初始管理员凭据已生成，请在自己的终端读取：…`，无格式说明）。
- 复现：非 TTY `kored serve` 首次启动 → stderr 只给路径；用户要自己知道 `cat <path>` 且文件是两行 `username=…` / `password=…`。改进建议：文案加一句 `cat <path> 可按 username/password 两行读取`。

### P2-2 CSRF 头名错时错误不白话且无"怎么办"

- `file:line`：`internal/core/httpapi/middleware.go:170`（真实头 `X-Kore-CSRF`）；`handlers_password.go`/中间件统一错误 `CSRF 校验失败`。
- 复现：`POST /api/v1/auth/password` 带 `X-CSRF-Token` → `{"code":"E_UNAUTHORIZED","message":"CSRF 校验失败"}`；用户/脚本无法从文案知道头名写错。改进建议：文案含"请刷新页面重试"（前端已有此提示，API 直连场景缺失）。

### P2-3 登录验证码被触发后，正确口令也被 428 拦住且文案不告诉用户去哪取验证码

- `file:line`：`internal/core/httpapi/handlers_auth.go:88-99`（challenge 态校验先于口令）；`handlers_captcha.go:65`（`密码错误，请输入右侧验证码`）。
- 复现：输错一次口令 → 再拿**正确**口令登录 → 428 `E_CAPTCHA_REQUIRED`；此时必须先 `GET /api/v1/auth/captcha` 取文本加法题并在登录请求带 `captcha_id`/`captcha_answer`，文案只说"右侧验证码"而页面验证码需要点「换一张」才出现。改进建议：文案给"点登录框右侧验证码图片/换一张"的明确动作。

### P2-4 干净机器建站默认路径撞宿主残留 + 只读文件系统，需翻"连接配置"才能成功

- `file:line`：`web/site-edit.js:20`（`autoRoot = '/var/www/' + domain`）、`kore-plugin-site/sites.go:156`（默认 vhost `/etc/nginx/conf.d`）；`web/site-edit.js:253-260`（建站向导步骤）。
- 截图：`hands-r51-sites-after-desktop-03.png`（`mkdir read-only file system` + `目标 vhost 已存在但不在本插件清单中：/etc/nginx/conf.d/kore-site-demo.kore.test.conf`）。
- 复现：无 nginx 的隔离实例装并启用 site → 填 `demo.kore.test` → 真点一键创建 → 两步均失败。要成功必须先在"连接配置"把 `nginx_mode` 改成 `off` 并填隔离可写的 `host_conf_dir` + 站点根目录（≥3 步）。改进建议：默认探测到不可写 conf.d 时自动切到 `<state_dir>/sites-conf` 并明确标注"预览模式，未配置 nginx"。

### P2-5 `file.writeRange` 入参错时静默写 0 字节却返回 200

- `file:line`：`kore-plugin-file/internal/fileop/edit_range.go:61-67`（`DataBase64` 字段）、`:147-157`（解码后无长度校验）。
- 复现：`file.writeRange {"path":…,"offset":0,"length":5,"content":"KORE"}` → 200 `{"written":0}` 且文件未变；正确入参是 `data_base64`（改后 200 `written:23`）。改进建议：当 `data_base64` 为空且 `content` 非空时回明确 `E_INVALID`，提示"请传 data_base64"。

### P2-6 监控页指引跳不存在的「插件」页

- `file:line`：`web/monitor.js:877`（`离线安装后，请先到「插件」页启用监控插件…`）。
- 截图：`hands-r51-monitor-range-desktop-10.png`（页面底部可见该提示）。
- 复现：装 monitor 后未启用 → 打开监控页 → 空曲线提示"到『插件』页启用"，但主壳一级菜单是「软件商店 → 插件管理」（`web/app.js` HUB_DEFS），没有名为"插件"的页面。改进建议：改为「软件商店 → 插件管理」或给深链 `store/plugins`。

### P2-7 建站成功的「在浏览器打开」CTA 在未解析域名上点了打不开

- `file:line`：`web/sites.js:453-476`（`在浏览器打开` + `打不开怎么办：… /etc/hosts …`）。
- 截图：`hands-r51-sites-created-desktop-18.png`（CTA 高亮 + 下方 `打不开怎么办：先确认域名已解析到这台机器…`）。
- 复现：隔离实例建 `hands.r51.test` 后点「在浏览器打开」→ `http://hands.r51.test` 无 DNS 解析，无法访问；用户必须自己编辑 `/etc/hosts`。改进建议：CTA 旁直接给"仅本机预览"链接（`http://127.0.0.1:<port>` + host 头说明）或一键复制 hosts 行。

---

## 6. 门禁与证据一致性

```
$ cd kore && git rev-parse HEAD                                  → 8fac75c906f7019326e7c635d37261ed7f2a654f（exit 0）
$ bash scripts/usability-check.sh                                → （仓库存量门禁，本 worker 不改生产代码、不改 pending 豁免；不重跑全量 check，避免与他人在途改动混跑）
$ grep -rn '请先 POST' cmd/kored/serve_daemon_actions.go         → 1 命中（:101，P1-3 证据，exit 0）
$ sed -n '745p' web/backups.js                                   → var htr = add(add(table,'thead') || …（P1-1 证据，exit 0）
$ sha256sum data/initial-admin-credential（宿主共享）            → 开工前/后均 eda3f46d…f3e789
$ make secret-check（如 verifier 复跑）                          → 本报告无明文口令：所有口令只以 LEN / HTTP 码 / REDACTED 出现
```

未跑 `make check` 全量：本卡写域只有 `.agents/verify/hands-on-r51.md` + 截图，不改生产代码；全量门禁由 lead 的任务板与 verifier 负责，避免并发工作树下误跑他人半成品。

---

## 7. 收尾（隔离资产清理）

验证完成后执行（在**同一次 bash 调用**里，因本机 Bash 每次调用是独立沙箱）：

```
$ kill <kored pid> ; rm -rf /home/pt/Work/GolandProjects/kore-pl/.tmp/hands-r51
$ python3 -c "import socket; s=socket.socket(); s.connect(('127.0.0.1',55271))"  → ConnectionRefusedError（端口已释放）
$ git status --short .agents/verify/hands-on-r51.md .agents/verify/screenshots/hands-r51-*.png
```

一次性 harness（`harness-install.sh` / `probe.mjs` / `full.mjs` / `full2.mjs` / `deep.mjs` / `deep2.mjs` / `finish.mjs` / `repro.mjs` / `success.mjs` / `home.mjs`）全部随 `.tmp/hands-r51` 删除，不留工作区；凭据 0600 文件也随目录销毁。工作区只保留本报告 + 26 张截图。

提交：精确 add 本报告与 `hands-r51-*.png`（不 `git add .`），commit message `[agent:hands-on-r51] docs(verify): ...`，不 push。

---

## 8. 给 lead 的后续派单建议（本 worker 不改生产代码）

1. **P1-1 修复卡**：`web/backups.js:745` 的 `add(table, 'thead')` → `add(table, el('thead'))`，补一条"有作业记录时页面无 pageerror"的浏览器用例；verifier 复跑备份页截图。
2. **P1-2 / P1-3 裁决卡**：统一 API 安装与 UI 安装的启用语义；把 `serve_daemon_actions.go:101` 的 API 动词文案改为白话 + 可点击"去启用"。
3. **P2 可用性批次**：P2-1/2/3（凭据与登录文案）、P2-4/7（建站自动降级与预览 CTA）、P2-5（writeRange 静默写 0）、P2-6（监控导航文案）。
