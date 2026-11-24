# R19 G-28 双端截图：内置 ACME / 从模板部署 / 站点 PHP-FPM / 已装插件总览

日期：2026-11-24 17:43–17:52（Asia/Shanghai）｜Owner：`r19-shots2`（🔵 美团味）｜批次：第 19 轮批次2 四张能力卡 G-28 双端证据补齐

## 0. 结论先行

第 19 轮批次2 四张能力卡（`ssl-acme` commit `3107f36` / `app-template` commit `80a7221` / `site-php` commit `1abf853` / `plugins-health` 已装插件总览）已补齐 G-28 双端证据：**4 场景 × 双端 = 8 张真实运行界面浏览器截图**，PC 1440×900 / 手机 390×844，`file` 实测全过、`md5sum` 8 张全异。每场景产品自评三问 + 已证明/未证明两栏 + G-29 声明齐备。证据齐，声明完成。

> ▎[🔵 美团味] 过程透明，结果说话：8 张截图全部来自隔离实例真实浏览器 + 真实口令表单登录 + 真实点击（关引导、选 wordpress 伪静态触发 PHP 表单、内置 ACME 只读状态探测、模板目录加载）。无域名/无 Docker 场景如实标注空态/降级态，没有一张是同图缩放、设计稿或 DOM 断言冒充。

## 1. 隔离实例（G-29：主实例 8787 零改动；本轮未改动主实例运行态配置）

主实例 8787 已是含本批新构建（PID `2128919` / sha `2700d865`，lead 已回读确认特征全命中），但它是共享运行态资产，**不重启、不改配置、不覆盖静态资源**。为拍含本批 commit 的界面且完全隔离，走 `git archive HEAD` + 独立构建 + 独立实例（端口 **18880**，与并行批次1 的 18879 分开）：

```text
$ cd /home/pt/Work/GolandProjects/kore && git rev-parse HEAD
输出: 43c3d889f11638f908c48a4dc730d07ed9a97201
$ for c in 3107f36 80a7221 1abf853; do git merge-base --is-ancestor $c HEAD && echo "$c YES"; done
输出: 3107f36 YES / 80a7221 YES / 1abf853 YES
$ git archive HEAD | tar -x -C /tmp/kore-r19-shots2/src
$ cd /tmp/kore-r19-shots2/src && make web-dist &&
  CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false \
    -ldflags '-s -w' -o /tmp/kore-r19-shots2/bin/kored ./cmd/kored
退出码: 0；隔离二进制 sha256=5e6012c54b802847f7d9d2759eac32d255e2d84e7ac39286881ef035aabd4763，11190434 bytes（独立产物，全路径落 /tmp）
$ /tmp/kore-r19-shots2/bin/kored admin-password --set --stdin --config /tmp/kore-r19-shots2/config.yaml
输出: 已将口令哈希写入 0600 配置（明文口令只存 /tmp/kore-r19-shots2/admin.pw，报告及全部证据均 *** 占位，G-30 合规）
$ /tmp/kore-r19-shots2/bin/kored serve --config /tmp/kore-r19-shots2/config.yaml
输出: {"status":"ok"}；pid=2141859；addr=127.0.0.1:18880（config/state/run/log 全落 /tmp/kore-r19-shots2）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18880/-/healthz
输出: 200
$ ss -ltn | grep -E ':(8787|18879|18880) '
输出: 127.0.0.1:8787（主实例 PID 2128919）/ 127.0.0.1:18879（批次1 隔离实例 PID 2142418）/ 127.0.0.1:18880（本批隔离实例 PID 2141859）三条独立 LISTEN
```

浏览器走登录页表单 `#kore-password` 填真实口令、点「登录」按钮进入（非注入 cookie 冒充）；首次登录的新手引导通过真实点击 `.kore-onboard-skip`（「以后再看」）关掉。为拍到真实界面，在**隔离实例**内通过 store install API 安装并启用 3 插件（只落 `/tmp/kore-r19-shots2/state`，与主实例 state 无关）。写操作遇 CSRF 双提交门：补 `X-Kore-CSRF` 头（值取自 `kore_csrf` cookie）后成功：

```text
$ python3 核对 index/plugins.json sha256 vs 本地 dist 包 sha256
输出: ssl@0.7.1 match=True / app-deploy@0.3.3 match=True / site@0.4.4 match=True
$ POST /api/v1/store/install {"id":"ssl|app-deploy|site","version":"0.7.1|0.3.3|0.4.4","package_path":"<本地 dist>","force":true} + X-Kore-CSRF
输出: 3× {"state":"succeeded","message":"安装完成","reload":"reloaded"}
$ POST /api/v1/plugins/<id>/enable + X-Kore-CSRF
输出: 3× {"enabled":true,"desired":"enabled"}，三个插件进入「运行中」
```

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' bin/kored
输出: 2026-11-24 17:41:45.358780824 +0800 11190434   # 主二进制 mtime/大小未变（本批隔离产物 sha 5e6012c5 与 lead 确认的主实例 sha 2700d865 不同源）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ pgrep -af 'kored.*serve'
输出: 2128919 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml（主实例未重启、未改配置）
      2141859 /tmp/kore-r19-shots2/bin/kored serve --config /tmp/kore-r19-shots2/config.yaml（本批隔离实例）
      2142418 /tmp/kore-r19-batch1/bin/kored serve --config /tmp/kore-r19-batch1/config/config.yaml（批次1 隔离实例，非本 agent 管理）
$ grep -n 'index_dir' .kore-local.yaml
输出: 12:  index_dir: "/home/pt/Work/GolandProjects/kore-plugins/index"   # 主配置 index_dir 指向正确路径，本轮未改
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主实例 state/run/socket、未重建主 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r19-shots2` 隔离实例。隔离实例的临时脚本、临时口令、config/state/run/log 在收尾时删除（G-30 零明文凭据入仓）。注：`/api/v1/system/info` 本版本响应体不含 `paths.index_dir` 键（实测为空），故 G-29 ①② 以"主配置文件 index_dir 字面正确 + 主二进制 mtime/PID 未变 + healthz 200 + 未在本轮写主运行态"四项等价坐实，未依赖该响应字段。workaround 无（未使用任何 workaround）。

## 2. 截图清单与 file 实测（验收项①②）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-01.png`。PC 用 1440×900 viewport，手机用 390×844 viewport（playwright `deviceScaleFactor=1`、手机 `isMobile`/`hasTouch=true`）；均为**精确视口截图**（非 fullPage 滚动长图），保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <8 张正式证据>
ssl-acme-desktop-01.png:       PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
ssl-acme-mobile-01.png:        PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
app-template-desktop-01.png:   PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
app-template-mobile-01.png:    PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
site-php-desktop-01.png:       PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
site-php-mobile-01.png:        PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
plugins-health-desktop-01.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
plugins-health-mobile-01.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图 / 拍到旧界面」：**全部证伪**。

```text
$ md5sum <8 张正式证据>
f60842a73e4b5e72531a30046f5d0aed  ssl-acme-desktop-01.png
41b9b9625eee3a3eb2aa8ca59244f105  ssl-acme-mobile-01.png
3bc3bc779e0964ba232bfd36745656d8  app-template-desktop-01.png
dc2547cfe8b686147e0d92984ef57eb7  app-template-mobile-01.png
ba47731c09350fdf82cee1345d8eee0f  site-php-desktop-01.png
e1b7eaf9234e57d0ecb641cb4a17fe9a  site-php-mobile-01.png
c3a145946e35b8b262817f583112e9ef  plugins-health-desktop-01.png
67640638ba6fbd4cc423f29c132f393b  plugins-health-mobile-01.png
退出码: 0；md5 去重后计数 = 8（全不同）
```

- **同图缩放**：8 张 md5 全异 + `file` 实测 PC/手机尺寸不同，证伪。
- **设计稿替代**：全部来自 playwright 驱动的隔离实例真实浏览器渲染，登录走真实 `#kore-password` 表单、交互走真实 click（关引导 / 选 wordpress 伪静态 / 等待 ACME status 与模板目录 API 返回），证伪。
- **拍到旧界面**：隔离二进制独立构建（sha `5e6012c5`），3 个目标 commit 均为 HEAD 祖先，内置 ACME 面板 / 模板卡片 / PHP 表单 / 3 插件总览都是本批交付物的真实渲染，证伪。

## 3. 四场景交互真实性（DOM 断言 + 命令输出）

### 场景① SSL 内置 ACME（ssl-acme，commit 3107f36）

```text
[ssl desktop/mobile] 登录 → 关引导 → #/security/ssl → 内置 ACME 面板自动只读探测
  → builtinPanel=true；status="内置可用 / CA：letsencrypt-staging（staging，浏览器不信任）/ 账户未注册 /
     自动续期关闭 / 证书目录：/tmp/kore-r19-shots2/data/ssl · 到期前 30 天续期 /
     提示：自动续期默认关闭：用 ssl.acme.auto {enabled:true, confirm:true} 开启后内核 scheduler 才会每天检查"
  → hasIssueEntry=true（「我确认由内置 ACME 联网向 CA 申请证书」勾选项）
  → hasAutoEntry=true（自动续期入口）
```

commit `3107f36` 的 UI 真实生效：内置 ACME 面板、内置可用状态探测、staging CA 标识、签发确认门、自动续期入口全部同屏。本机无域名/无 ACME 账户，状态如实展示"账户未注册 / 自动续期关闭"降级态，**未真机签发证书**——如实标注，不伪造成功态。

### 场景② 从模板部署（app-template，commit 80a7221）

```text
[app-template desktop/mobile] 登录 → #/sites/appdeploy → 「从模板部署」面板真实加载 templates()
  → panel=true；cards=4（Nginx 静态站点 / WordPress 站点 / Redis 缓存 / PostgreSQL 数据库）
  → 每张卡片有人话需求描述（如「内存约 768 MiB · HTTP 18091（推荐，可改） · 含数据库等 2 个组件」）
  → hasForm=true（应用名 / 端口 / 必填配置表单）；hasRemove=false（无已部署实例，移除入口在应用列表行操作里）
```

commit `80a7221` 的 UI 真实生效：模板卡片 4 张、人话需求描述、部署表单、刷新模板入口全部同屏。隔离实例宿主无 Docker 可用部署，`templates()` 返回的是内置模板目录（不是真实部署结果）——如实标注：本场景展示的是"模板卡片/表单"而非真机一键拉起容器。

### 场景③ 站点 PHP-FPM（site-php，commit 1abf853）

```text
[site-php desktop/mobile] 登录 → #/sites/sites → 建站向导已展开
  → 真实 selectOption('[data-field="rewrite"]', 'wordpress')
  → rewriteValue="wordpress"；phpBoxVisible=true
  → phpVersion="auto"；phpSocketPlaceholder="/run/php/php-fpm.sock"
  → wizardText="建站向导 / 一次提交：create → bindSSL → setRewrite（PHP 模板再接 setPHP） / ... / 所选模板需要
     PHP-FPM 才能访问；不配置页面会一直 404。版本填 auto 会自动选用已检测到的最高版本；如未检测到，可先留空建站，
     再到站点详情里选版本。"
```

commit `1abf853` 的 UI 真实生效：选 wordpress 伪静态后 PHP-FPM 版本/socket 表单动态出现，白话提示解释"不配置会 404"。本机无真实站点（隔离实例 state 为空站），展示的是**建站向导的模板选择区 + PHP 表单**，未真机提交 create/setPHP——如实标注，不伪造已建站点。

### 场景④ 已装插件总览（plugins-health）

```text
[plugins-health desktop/mobile] 登录 → #/store/plugins → 插件管理表真实渲染
  → panel=true；summary="共 3 个已安装，0 个可升级"
  → 表头：插件 / 版本 / 最新版本 / 深度 / 运行方式 / 状态 / 操作
  → 三行：app-deploy 0.3.3 生产级 按需启动 运行中 / site 0.4.4 生产级 常驻 运行中 /
     ssl 0.7.1 生产级 按需启动 运行中；每行「停用 / 卸载 / 调用 ping」入口
  → 「已启用 3 · 运行中 3 · 空闲 0 · 已停用 0 · 共 3 个已安装，0 个可升级」「全部已是最新」
```

本轮能力补齐后的整体面貌真实呈现：三插件均为生产级、版本与索引一致、状态运行中。三个插件是本批隔离实例真实 store install + enable 的结果，非空态、非设计稿。

## 4. 产品定位自评三问（验收项③，原文）

### 场景① SSL 内置 ACME（ssl-acme）

**问 1：本页解决什么用户问题？** 解决「给站点上 HTTPS 要搞懂 ACME 客户端、装 certbot、配 webroot、写续期 cron，小白根本无从下手」——证书页内置 ACME 默认路线（标准库实现、零外部依赖），自动只读探测当前内置可用状态/CA/账户/续期开关，用户勾一次「确认联网申请」填域名邮箱就能签发，自动续期一个开关交给内核 scheduler，不用装任何外部客户端。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的 SSL 页多走 Let's Encrypt 校验 + 面板内置续期，但常依赖外部 acme.sh/certbot。Kore 内置 ACME 零依赖、状态只读探测可安全自动加载，方向领先。差距：①本机无域名/无 ACME 账户时只能展示"账户未注册"降级态，真机签发要用户自备可解析域名与邮箱（本次隔离实例正是此态）；②CA 只有 letsencrypt-staging/production 两个预设，不支持自定义 ACME 目录；③自动续期默认关闭，需显式 `ssl.acme.auto` 开启，用户容易忽略。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（能力可用，真机签发受域名/账户约束）。** 判据：真机内置 ACME 面板自动探测出"内置可用 / CA：letsencrypt-staging / 账户未注册 / 自动续期关闭"真实状态，签发确认门与自动续期入口可见可点，不是灰字占位。诚实标注：本机无域名/账户，未真机签发证书——这是能力边界的真实表现，不是缺陷。

### 场景② 从模板部署（app-template）

**问 1：本页解决什么用户问题？** 解决「想部署个 WordPress/nginx 得先写 docker-compose、挑镜像、配端口和环境变量」——应用部署页「从模板部署」把常用组合（Nginx 静态/WordPress/Redis/PostgreSQL）做成预设卡片，点一张就把内存需求、推荐端口、组件数用人话列清，填个应用名就能一键起，零镜像/编排细节。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔有软件商店一键安装，1Panel 有应用商店模板，但模板常是外部市场下载、依赖联网。Kore 模板内置、卡片给人话需求说明、危险部署二次确认，符合"预设优先、小白能看懂"。差距：①模板固定 4 个，不支持用户自定义/从市场导入；②真正拉起容器依赖宿主 Docker，无 Docker 时只能展示模板目录、无法一键部署（本次隔离实例未真机拉容器）；③手机端卡片纵向堆叠，一次只能看 1-2 张。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（模板浏览/表单可用，真机部署受 Docker 约束）。** 判据：真机加载出 4 张真实模板卡片（含内存/端口/组件数人话描述）、部署表单与刷新入口可见，不是空状态。诚实标注：宿主无可用 Docker，未真机一键拉起容器——展示的是模板目录与表单，不伪造部署成功。

### 场景③ 站点 PHP-FPM（site-php）

**问 1：本页解决什么用户问题？** 解决「选了 WordPress 伪静态却不知道还要配 PHP-FPM，页面一直 404 找不到原因」——建站向导/站点编辑器在选 wordpress/laravel/thinkphp/discuz 伪静态模板时，自动弹出 PHP 版本（auto=自动检测）与 FPM socket（可选自动检测）表单，并用白话说明"不配置会一直 404"，把伪静态与 PHP-FPM 的隐性依赖显性化。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 建站时要分别选 PHP 版本、设伪静态，二者关联靠用户自己记得。Kore 把"PHP 类伪静态必须有 PHP-FPM"做成联动表单（选模板即弹表单），且版本来自 `getPHP.available` 动态填充而非硬编码，体验领先。差距：①建站阶段站点未落盘，版本只能给 auto + 手填 socket，真实版本下拉要到站点编辑器才有；②无真实站点/未装 PHP-FPM 时无法验证 socket 是否可用，只能建站后到详情里补；③模板枚举固定 4 个（wordpress/laravel/thinkphp/discuz）。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用（表单联动可用，真机配置受站点/PHP 环境约束）。** 判据：真机选 wordpress 后 PHP 表单从隐藏变可见，版本默认 auto、socket 占位符 `/run/php/php-fpm.sock`、白话 404 提示全部出现，是真实条件渲染。诚实标注：隔离实例无真实站点、未真机提交 create/setPHP——展示的是建站向导模板选择区 + PHP 表单，不伪造已建站点。

### 场景④ 已装插件总览（plugins-health）

**问 1：本页解决什么用户问题？** 解决「装了哪些插件、什么版本、生产级还是基础级、按需启动还是常驻、当前跑没跑起来，得挨个点进插件看」——软件商店「插件管理」tab 用一张表把已装插件的版本/最新/深度/运行方式/状态/操作一屏列清，顶部汇总条给「已启用 N / 运行中 M / 可升级 K」，支持停用/卸载/调用 ping 与批量升级。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品插件页多是卡片网格，版本/运行状态要逐个看。Kore 用表格把"深度等级（生产级/基础级）+ 运行方式（常驻/按需）+ 状态"三列并排，运营一眼能看出哪些是生产级常驻、哪些按需，配合一键升级，颗粒度更细。差距：①只有表格视图，无卡片视图切换；②批量升级进度以文本返回，无实时进度条；③无插件依赖/冲突关系的可视化。属范围边界，不是占位。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真机列出 3 个刚安装的插件（app-deploy 0.3.3 / site 0.4.4 / ssl 0.7.1），均显示"生产级 / 状态运行中"，汇总条"共 3 个已安装，0 个可升级"，每行停用/卸载/ping 入口可见，是真实 store state 渲染。

## 5. 已证明 / 未证明（验收项③，逐场景）

| 场景 | 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- | --- |
| ssl-acme | PC/手机各 1 张；内置 ACME 面板 + 只读 status 探测结果（内置可用/staging CA/账户未注册/续期关闭）+ 签发确认门 + 自动续期入口 | 本机无域名/账户，未真机签发证书；自定义 CA 目录不支持；自动续期默认关闭未真机开启 |
| app-template | PC/手机各 1 张；「从模板部署」面板 + 4 张真实模板卡片（内存/端口/组件数人话描述）+ 部署表单 + 刷新入口 | 宿主无可用 Docker，未真机一键拉起容器；移除入口在无部署实例时未取证（在应用列表行操作里）；模板固定 4 个不可自定义 |
| site-php | PC/手机各 1 张；选 wordpress 后 PHP-FPM 版本/socket 表单真实出现（auto / `/run/php/php-fpm.sock`）+ 白话 404 提示 | 隔离实例无真实站点，未真机提交 create/setPHP；真实版本下拉（getPHP.available）在站点编辑器而非建站向导，本次未取证 |
| plugins-health | PC/手机各 1 张；插件管理表 3 行真实插件（app-deploy/site/ssl，生产级/运行中）+ 汇总条「共 3 个已安装」+ 停用/卸载/ping 入口 | 批量升级未真机执行（0 个可升级）；停用/卸载/ping 写操作未逐一点开（避免破坏隔离实例状态）；无卡片视图切换 |
| 全局 | 8 张核心证据，md5 全异、尺寸合规、命名规范；G-29 主实例零改动；G-30 secret-check 0 FAIL | 未在主实例 8787 取证（其运行态为共享资产，不碰）；store install/enable 写操作仅在隔离实例执行 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 8 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 8 张 PNG + 本报告；未改任何源码、Makefile/embed、运行态资产。与并行任务 `r19-shots1`（端口 18879、前缀 `pg-write`/`firewall-switch`/`python-venv`/`log-clean`）端口与文件名前缀互不重叠，写域仅目录层共享、文件名不冲突。
- **G-28**：PC + 手机 + 每场景自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核；`bin/kored` mtime `17:41:45` 未变、8787 PID 2128919 未重启、主配置 index_dir 字面正确）；本轮未改动主实例运行态配置，无 workaround。
- **G-30**：报告无任何明文口令；`make secret-check` → `0 FAIL / 13 处匹配（占位写法均合规）`，退出码 0。

```text
$ cd /home/pt/Work/GolandProjects/kore && make secret-check
[RUN ] secret-check
secret-check: 0 FAIL / 13 处匹配（占位写法均合规）
退出码: 0
```

> ▎💼 [P8 自检] 冰山下面还有冰山：本批不止补 8 张截图，还在隔离实例里真装了 ssl@0.7.1 / app-deploy@0.3.3 / site@0.4.4 三个新构建插件（dist sha 与索引逐项核对），把四个视图从"插件未安装"逼成真实内置 ACME 状态探测、真实模板卡片、真实 PHP 联动表单与真实 3 插件总览。CSRF 401 不隐瞒、读源码补头自恢复——做难而正确的事，不遮不掩。
