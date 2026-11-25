> 元信息: 2026-11-25T11:52+08:00 · 执行者 feat-golden-journey · 黄金旅程（刚装好 Kore → 第一个站点在浏览器打开）· 隔离实例真机点击 + 双端截图 · 报告 ≤100 行

# 黄金旅程：新用户 ≤5 步看到自己的第一个站点

## 0. 结论先行

装完 Kore 的新用户此前在「网站」页会**卡死在第一个页面**：没装站点插件时页面只给 `站点列表读取失败：E_NOTFOUND：插件 site 未安装`，同时照样渲染一个注定失败的建站表单；建好之后也没有「打开网站」的出口。本轮把这条路做成一条连续的可点路径，并在隔离实例里**真机点击走通到 curl 200**：

- 未装插件 → 页面直接给「一键安装站点插件」（含文件管理插件，一次装完）
- 建好站点 → 成功卡给「在浏览器打开 / 复制访问地址 / 管理这个站点」，真开新页拿到站点默认首页
- 打不开 / 本机没 nginx → 一行「怎么办」+ 「打开连接配置」
- 概览「服务」卡 站点/证书/数据库 变成可点入口；商店装完给「去创建第一个站点」

**实测：登录后 5 步（含一键装插件）到「站点在浏览器打开」，curl 返回 200。** 写域仅 `web/{app,sites,site-edit,store}.js`，未改后端、未改 shell/onboarding、未碰主实例运行态。

## 1. 改前断点清单（HEAD `5049d95`，path:line）

| # | 断点（path:line） | 实测现象 | 违反 |
| --- | --- | --- | --- |
| B1 | `web/sites.js:810-816` | 未装站点插件时只把 `E_NOTFOUND` 拼进状态条：「站点列表读取失败：E_NOTFOUND：插件 site 未安装」；无安装入口、无下一步 | 原则 4（错误无「怎么办」） |
| B2 | `web/sites.js:244-256` + `web/site-edit.js:259-264` | 插件缺失仍渲染「一键建站」表单；点提交必失败，步骤条写 `E_NOTFOUND：插件 site 未安装`，`hintFor`（`web/sites.js:72-86`）对该错误无提示 → **死胡同** | 原则 3/4 |
| B3 | `web/sites.js:67-71` | `errText` 把内部错误码拼进正文（用户读到 E_NOTFOUND 这类码） | A4 术语 |
| B4 | `web/site-edit.js:303-317` | 建站成功只改状态条一句话，成功后**没有下一个动作**（没有打开/复制地址） | 原则 4「成功后给下一个动作」 |
| B5 | `web/store.js:797-800` | 装完只写「安装成功 · 已自动启用」；站点插件在商店第 2 页，用户不知道回哪去用 | 原则 4 |
| B6 | `web/app.js:2034-2043` | 首屏黄条把 `monitor 插件不可用（HTTP 404）` 原样给用户，且没有安装入口 | 原则 4 |
| B7 | `web/app.js:2043-2051` | 概览「服务」卡 站点/证书/数据库 是静态文本；看到「未启用」点不进去 | 原则 4 / A7 |

复现证据（改前截图，HEAD 构建的隔离实例）：`screenshots/golden-journey-before-sites-desktop-01.png`、`golden-journey-before-sites-submit-desktop-01.png`（表单提交后两步全失败、无下一步）。

## 2. 改后（path:line）

- `web/sites.js:338-413` 未装插件的落点换成「还差一步」卡：说明 + 「同时安装文件管理插件」（默认勾选）+ **一键安装站点插件** + 「去软件商店自己挑」；安装走既有 `GET /api/v1/store/plugins` → `POST /api/v1/store/install` → `POST /api/v1/plugins/<id>/enable`，装完自动回到建站表单。
- `web/sites.js:1046-1058` 识别 `E_NOTFOUND` 走上面这条引导（不再把表单留在页面上等人踩坑）。
- `web/sites.js:415-430` nginx 不可用时给提示条：「配置能存、浏览器打不开；装 nginx 后刷新，已有容器就改「连接配置」」，并带同一个配置入口。
- `web/sites.js:432-490` 建站成功卡：`http://<域名>` + 在浏览器打开 / 复制访问地址 / 管理这个站点 / 再建一个站点 + 打不开的 hosts / nginx「怎么办」；目录步骤被跳过时额外给失败原因与「去文件管理建目录」。
- `web/sites.js:907-928` 站点详情新增「访问地址」行（打开 / 复制），回访也有出口。
- `web/sites.js:98-121` `errText` 不再拼错误码；`hintFor` 补 `E_NOTFOUND`（装插件）与 nginx 缺失（装 nginx / 改连接配置）两条白话提示。
- `web/site-edit.js:308,316` 把步骤明细传给页面，成功/失败都能用上（`ctx.after(domain, steps)`）。
- `web/store.js:11-18,808-809` 安装成功后给直达入口：site → 「去创建第一个站点」，file/db-mysql/redis/backup 同理。
- `web/app.js:1788-1792,2061-2088` 概览「服务」三行可点（角色 button + Enter/Space + 44px 触摸高 + `›`），点「站点 未启用」直达网站页。
- `web/app.js:2039-2060` 首屏监控提示改为「监控插件还没装：指标暂用内核采样…装好后完整显示」+「去商店装监控插件」按钮；原始检测原因进 `title`。

## 3. 改后实测旅程（隔离实例，真实点击）

隔离实例：`kored`（HEAD 归档 + 仅叠加本轮 4 个 web 文件）`127.0.0.1:18883`，state/run/log/conf 全在 `kore/.tmp/gj/run1`（工作区内、gitignore），全新 state（零插件）。

| 步 | 用户动作 | 实测 |
| --- | --- | --- |
| 1 | 输入口令登录 | `{"authenticated":true}` |
| 2 | 概览点「站点 未启用 ›」 | 跳到网站页（`OV_LINK_ROWS=["站点 2 ›","证书 未启用 ›","数据库 未检测到 ›"]`） |
| 3 | 点「一键安装站点插件」 | 3336 ms 装好 site 0.4.4 + file 0.3.5 并自动启用，页面换成建站表单 |
| 4 | 填 `demo.kore.test` → 点「一键创建站点」 | 成功卡出现；目录与默认首页由文件插件创建（`DIR_CREATED yes`）；状态「已建好 demo.kore.test（2 步全部完成）」 |
| 5 | 点「在浏览器打开」 | 新页 `http://demo.kore.test/`，正文「站点已创建 … 把你的网站文件放到这个目录即可」 |

- 真服务校验：`curl -H 'Host: demo.kore.test' http://127.0.0.1/` → **HTTP 200**，返回默认首页 HTML（`PC_HTTP=200`）。
- 手机端同样走通：390×844 下填 `demo2.kore.test` → 成功卡，`MOBILE_DIR_CREATED yes`；成功卡按钮实测高度 `[44,44,44,44]`（裁决41 触摸目标）。
- 商店路径：搜索「站点」→ 安装 → 卡片状态「安装成功 · 已自动启用 / 去创建第一个站点」，链接 `href="#/sites"`（真实点击断言）。
- 无 nginx 场景（另一隔离实例 18884，无容器）：网站页出现「本机还没有可用的 nginx … 打开连接配置」，桌面按钮 32px、手机 44px。

> 环境准备（非用户步骤，报告中如实标注）：本机**没有**宿主 nginx 二进制，故用站点插件官方 docker 模式 + `nginx:alpine` 容器等价替代（插件 auto 也会自动发现容器）；另用一个种子站点把「自动推断目录前缀」锚到工作区内可写目录（沙箱只允许工作区写；真实主机默认 /var/www 可直接写）。种子站点在截图前已删除。过期条件：隔离实例停止 / 容器删除即失效。

## 4. 证据（命令 + 退出码）

```text
$ for f in app sites site-edit store; do node --check web/$f.js; done
OK web/app.js / OK web/sites.js / OK web/site-edit.js / OK web/store.js     # 各 exit 0

$ GOCACHE=... go test -timeout 200s ./... 
ok  ...internal/core/{httpapi,store,supervisor,...} 16 包全部 ok                     exit 0

$ make secret-check
secret-check: 0 FAIL / 22 处匹配（占位写法均合规）                                  exit 0

$ make web-dist && bash scripts/frontend-check.sh
[OK] 首屏体积达标：81528 字节 ≤ 307200 字节，余量 225672 字节                      exit 0
[OK] i18n 增量达标：2922 字节 ≤ 3072 字节（未新增 i18n 键）

$ bash scripts/usability-check.sh --no-run-tests
53 FAIL 全部落在别的插件仓 A3 存量/在途文案（db-postgres / runtime-node|php|python / firewall），
web/{app,sites,site-edit,store}.js 零新增 FAIL（A4/A5/A6 均无指向本页的新违规）
```

G-28 双端截图（`identify` 实测尺寸，md5 全异）：

| 场景 | PC | 手机 |
| --- | --- | --- |
| 安装站点插件落点 | `golden-journey-install-desktop-01.png` 1440×900 | `golden-journey-install-mobile-01.png` 390×844 |
| 建站成功 + 下一步 | `golden-journey-created-desktop-01.png` 1440×900 | `golden-journey-created-mobile-01.png` 390×844 |
| nginx 缺失「怎么办」 | `golden-journey-no-nginx-desktop-01.png` 1440×952 | `golden-journey-no-nginx-mobile-01.png` 390×844 |
| 概览可点服务行 / 商店下一步 / 站点真容 | `golden-journey-overview-desktop-01.png` 1440×900 / `golden-journey-store-installed-desktop-01.png` 1440×900 / `golden-journey-live-site-desktop-01.png` 1440×900 | — |

## 5. G-29 与写域

- **本轮未改动主实例运行态**：`.kore-local.yaml`、`.kore-local-state/`、`.kore-local-run/`、`bin/kored` 均未动；8787 未重启。所有验证在 `kore/.tmp/gj/run{1,2,3}` 隔离实例（18883/18884/18885）完成，容器 `kore-gj-nginx` 用后 `docker rm`，`/etc/nginx/conf.d` 未写。
- 写域：`web/app.js` `web/sites.js` `web/site-edit.js` `web/store.js` + 本报告 + `screenshots/golden-journey-*`。未改 `shell.js` / `onboarding.*` / 其它插件仓 / 后端。

## 6. 产品定位自评（G-28 ③）

1. **本页解决什么用户问题**：把「装完不知道下一步」变成一条能点的路——没装插件就地一键装；建好就给「在浏览器打开」；打不开给 hosts / nginx 的具体做法。
2. **与宝塔/1Panel 同类功能差距**：宝塔「一键部署」把建站收敛到一个弹窗，1Panel 有「网站 → 创建网站」向导；Kore 现在是单表单 + 成功出口，差距主要在**后续运营引导**（域名解析检查、证书到期提醒、备案/防篡改），本卡未覆盖。
3. **当前状态**：**可用**（真实点击 + curl 200），非占位；无后端改动需求，未发现需后端配合的阻塞点。

一句话：新用户从刚装好 Kore 到第一个站点在浏览器打开，现在是 5 步、每步都有明确下一步，且「没装插件 / 没 nginx / 打不开」三种卡点都给了可点的「怎么办」。
