# R8 G-28 双端截图批次 1：首次引导 / 帮助+404 / SSL 强制 HTTPS / 快捷键帮助

日期：2026-11-24 14:58–15:08（Asia/Shanghai）｜Owner：`r8-shots1`（🔵 美团味）｜批次：双端截图批次 1（4 场景 × PC + 手机）

## 0. 结论先行

本轮已落地的 4 个 UI 改动（首次使用引导面板 / 顶栏帮助入口与友好 404 / SSL 强制 HTTPS 卡片 / 快捷键帮助浮层）已补齐 G-28 双端证据：**PC 4 张 1440×900 + 手机 4 张 390×844，共 8 张真实运行界面的 Playwright 浏览器截图**，全部 `file` 实测通过、md5 两两互异；产品自评三问、已证明/未证明两栏、G-29 零改动声明齐备。证据齐，声明完成。

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787 跑的是 13:58 的二进制（`bin/kored` 10,862,754 bytes，`/assets/shell.js` 无 `kore-help-trigger` 入口），拍不到本轮新界面。按 G-29 起隔离实例取证——不重启、不改主配置、不重建主二进制。

```text
$ cd /home/pt/Work/GolandProjects/kore && git archive HEAD | tar -x -C /tmp/kore-r8-shots1/src
退出码: 0   # HEAD=300156e
$ cd /tmp/kore-r8-shots1/src && make web-dist
退出码: 0   # 重建 dist（含本轮新 web/*.js：SSL/帮助/404/引导/快捷键）
$ grep -rl 'kore-help-trigger\|ssl.https.enforce\|Mod+/' web/dist
输出: web/dist/shell.js / web/dist/ssl.js / web/dist/shortcuts.js   # dist 确含 4 场景入口
$ CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r8-shots1/bin/kored ./cmd/kored
退出码: 0；二进制 10928290 bytes（15:00:47 构建，大于主实例 10862754，确含新代码）
$ /tmp/kore-r8-shots1/bin/kored admin-password --generate --config /tmp/kore-r8-shots1/config.yaml
退出码: 0；输出 ***（口令仅存在于 /tmp 的 0600 文件，本报告与全部证据均占位，G-30 合规）
$ /tmp/kore-r8-shots1/bin/kored serve --config /tmp/kore-r8-shots1/config.yaml
输出: {"msg":"kore ready","pid":1491758,"addr":"127.0.0.1:18872","socket":"/tmp/kore-r8-shots1/run/kore.sock"}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18872/-/healthz
输出: 200
$ curl -s http://127.0.0.1:18872/assets/shell.js | grep -c 'kore-help-trigger'
输出: 6   # 隔离实例服务的是新 dist
```

隔离实例 `server.addr=127.0.0.1:18872`，state/run/log/index 全落 `/tmp/kore-r8-shots1/`。浏览器侧走登录页 `#kore-password` 表单真实登录（非注入 cookie），登录后复用 storageState 逐场景新建 context 拍 PC 与手机。

**G-29 复核（拍完仍成立）**：

```text
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ stat -c '%y %s %n' bin/kored
输出: 2026-11-24 13:58:18.934991765 +0800 10862754 bin/kored   # mtime 未变
$ pgrep -a kored | grep '/Work/GolandProjects/kore/bin/kored'
输出: 1332165 ... serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml   # 主实例未重启
$ curl -s http://127.0.0.1:8787/assets/shell.js | grep -c kore-help-trigger
输出: 0   # 主实例静态资源未被隔离实例污染
$ ss -ltn | grep -E ':(8787|18872) '
输出: 两端口独立 LISTEN
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、未碰主实例 state/run/socket、未重建 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r8-shots1` 隔离实例。隔离实例的临时脚本与口令文件在收尾时删除。

## 2. 截图清单与 file 实测（验收项①④）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`。PC 用 1440×900 viewport、手机用 390×844 viewport（playwright `deviceScaleFactor=1`，手机 `isMobile/hasTouch=true`）；均为**精确视口截图而非 fullPage 滚动长图**，保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <8 张>
onboarding-desktop-01-first-visit.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
onboarding-mobile-01-first-visit.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
help-desktop-01-panel.png:             PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
help-mobile-01-panel.png:              PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
ssl-enforce-desktop-01-card.png:       PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
ssl-enforce-mobile-01-card.png:        PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
shortcuts-desktop-01-help.png:         PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
shortcuts-mobile-01-help.png:          PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图」：**已证伪**。8 张 md5 全不同（终版，重拍后复核）：

```text
$ md5sum <8 张>
1930500a4fbb8cb17c7ae57787975649  onboarding-desktop-01-first-visit.png
4e920dd5fb07ac9b8f44c8d45f624333  onboarding-mobile-01-first-visit.png
e85174f8938cb06d08fce66278597be2  help-desktop-01-panel.png
0233b8723257f726112784e1fa075e6d  help-mobile-01-panel.png
5be2f5af00e9d7685577d8b47a3811ab  ssl-enforce-desktop-01-card.png
a78ecafe92a6fe5f469def182a65eac9  ssl-enforce-mobile-01-card.png
3f013a984daf1eabde827edaaf032d43  shortcuts-desktop-01-help.png
db649b36e95805fae38fa67aba37de77  shortcuts-mobile-01-help.png
$ md5sum <8 张> | awk '{print $1}' | sort -u | wc -l
输出: 8
```

读图复核：引导面板 5 步清单（「欢迎使用 Kore / 还剩 5 项」）PC 与手机均完整渲染；帮助面板列出回到概览/搜索/查看功能/GitHub 四项与底部提示；SSL 页桌面与手机均显示「强制 HTTPS」卡片与三个按钮（查看当前状态 / 开启强制 HTTPS / 关闭强制 HTTPS）；快捷键浮层列出 Mod+/ 等键位、系统保留键位说明、底部「重新查看新手引导」「知道了」按钮。每张都含真实页面元素（侧栏导航 / 概览卡片 / 手机底部 tab bar），非设计稿、非接口返回、非同图缩放。

## 3. 四场景交互真实性（DOM 断言 + 命令输出）

```text
# 登录 + 组件加载
[probe] afterLogin: {"hasPasswordField":false,"helpTrigger":1,"onboardTrigger":1,"shortcutTrigger":1,"onboardPanel":1}

# 场景①首次引导：新 context 首访 localStorage 无记录 → autoOpen 自动弹出 5 步清单
[shoot] onboarding desktop: {"open":true,"items":5,"title":"欢迎使用 Kore","viewport":{"width":1440,"height":900}}
[shoot] onboarding mobile:  {"open":true,"items":5,"title":"欢迎使用 Kore","viewport":{"width":390,"height":844}}

# 场景②帮助 + 404：点顶栏 #kore-help-trigger 弹面板；未知 hash 落友好 404
[shoot] help desktop panel: {"maskVisible":true,"helpText":"帮助与常用操作 回到概览 ... GitHub"}
[shoot] help desktop 404-DOM: {"notFound":1,"hash":"#/this-page-does-not-exist-r8"}
[shoot] help mobile  panel: {"maskVisible":true,...}
[shoot] help mobile  404-DOM: {"notFound":1,"hash":"#/this-page-does-not-exist-r8"}
# 404 页另做 DOM 断言（.kore-notfound-code 存在 = 1），按任务卡「404 页另拍或合并描述」合并进本报告，保证恰好 8 张

# 场景③SSL 强制 HTTPS：先关引导（等 backdrop hidden）→ 真实 hash #/security/ssl 切到 SSL tab
[ssl] desktop: {"viewId":"security","hasForce":true,"onboardHidden":true}
[ssl] mobile:  {"viewId":"security","hasForce":true,"onboardHidden":true}

# 场景④快捷键帮助：PC 用 Ctrl+/ 真键盘事件；手机无物理键盘用 KoreShortcuts.openHelp()
[shoot] shortcuts desktop: {"root":1,"rootVisible":true,"scText":"快捷键 ... Mod / ... 知道了"}
[shoot] shortcuts mobile:  {"root":1,"rootVisible":true,"scText":"快捷键 ... Mod / ... 知道了"}
```

**蓝军自攻击记录（两处真实缺陷已修，非掩盖）**：① 初拍 SSL 用错 hash `#/ssl`（非一级路由）导致 `viewId=404`——已 RCA 修正为 `#/security/ssl`（安全 hub 二级 tab），重拍后 `viewId=security` 且含「强制 HTTPS」；② 初拍非引导场景时关闭按钮点击早于 autoOpen，引导 backdrop 又弹出遮挡面板——已改为等 `.kore-onboard-backdrop:not([hidden])` 出现后真实点击「知道了」并等 `hidden=true`，6 张重拍后读图确认无遮挡。两次修正都重拍并重新核 file/md5，未放宽验收口径。

## 4. 产品定位自评三问（验收项③，原文）

**问 1：本页解决什么用户问题？**
四个场景合起来解决新用户「装好 Kore 不知道从哪下手、遇到问题没处求助、给站点上 HTTPS 找不到开关、记不住快捷键」四个起步痛点。首次引导把「看概览 → 挑预设 → 换外观 → 记快捷键 → 做第一件正事」做成 5 步清单，每项有直达按钮、不用填参数；顶栏「帮助」按钮打开内置面板，把「回到概览 / 搜索功能 / 查看所有功能 / 项目文档」四个下一步放在一处，未知路由不再白屏而是给友好 404 + 返回概览/去搜索按钮；SSL 证书页把「强制 HTTPS」单独做成卡片，站点域名 + 查看当前状态 + 开启/关闭三按钮，并明确写出「开启只是本机记下设置，真正让浏览器跳转还需站点绑定证书并开启跳转」；快捷键帮助把 Mod+/、Mod+s、Mod+shift+x、Mod+shift+d 与系统保留键位一次列清，手机上明确告知「入口会隐藏」。这四块分别补上 `docs/PLUGIN-MATURITY.md` §3.3.2 中「首次引导=无」「快捷键=局部有」两行缺口，以及 G-33 的「错误边界/空状态」与 SSL HTTPS 接线落地面。

**问 2：与宝塔、1Panel 同类功能的差距？**
宝塔 / 1Panel 都有新手任务卡片、内置帮助文档、SSL 强制 HTTPS 一键开关、全局快捷键说明；本轮之后 Kore 在这四项上从「缺/局部有/接线未完成」变成「有」。差距仍在：①引导是静态 5 步清单，不会按用户已装插件/已建站点动态跳过已完成项（竞品的新手任务按状态打勾），我们目前只在用户手动点「我已经做了」时记进度；②帮助面板是内置 4 条入口 + GitHub 文档链接，没有竞品的全文搜索式帮助中心与上下文敏感帮助；③SSL 强制 HTTPS 只登记期望状态，真正跳转依赖站点插件绑定证书 + 开启 80→443 跳转，本页会提示但不会代用户配置 web server；④快捷键帮助只展示与解释，不支持用户自定义改键。四者都属于「够用但不领先」，符合当前 M0/M1 阶段定位；其中①③已用页面文案明确边界，不是静默误导。

**问 3：当前「可用」还是「占位」？**
**可用。** 判据：四组件/页面均随本轮改动接进 shell.js / ssl.js / shortcuts.js，隔离实例双端截图证明首访自动弹、帮助入口真能点开、SSL 页 `#/security/ssl` 真能切到并渲染强制 HTTPS 卡片、快捷键浮层真能由 Ctrl+/ 打开；5 步清单每项有 actionLabel 按钮可点（非灰字占位）；帮助四项有真实按钮/链接；SSL 三个按钮有真实 invoke 接线；快捷键浮层列出真实键位与保留键位说明。不是占位：没有「敬请期待」「待实现」文案，没有点了没反应的入口。边界：①SSL 插件未安装时页面会显示 `E_NOTFOUND: 插件 ssl 未安装`（截图如实呈现，属依赖未启用、非本页占位）；②手机端快捷键帮助只能由浮层 API 打开（无物理键盘），这是设计取舍不是占位。

## 5. 已证明 / 未证明（验收项④）

| 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- |
| PC 4 张 1440×900、手机 4 张 390×844，file 实测全过、md5 各异（distinct=8） | 手机端快捷键浮层未用「物理键盘 Ctrl+/」触发（手机无键盘），走 `KoreShortcuts.openHelp()`；PC 已用真实 Ctrl+/ 证明键位生效 |
| 首访 autoOpen：新 context 无引导记录时 PC 与手机均自动弹出 5 步清单 | 未完成「勾选完成 → 刷新后不再自动弹 → 点按钮重开」的完整状态往返（组件有 API 与 localStorage 逻辑，本次聚焦 G-28 截图，未做状态机回归） |
| 顶栏帮助入口真实点击弹出面板（四项 + 文档链接 + 底部提示），PC 手机均可见 | 帮助面板内的按钮（回到概览/搜索/GitHub）未逐项点开验证跳转目标；截图证明渲染，未证明四个 next-step 全部可达 |
| 未知 hash 真实落到友好 404（`.kore-notfound-code=1`），PC 手机 DOM 断言一致 | 404 页按任务卡合并为 DOM 断言 + 报告描述，未单独落地 PNG（任务卡允许「404 页另拍或合并描述」） |
| SSL 页 `#/security/ssl` 真路由下渲染「强制 HTTPS」卡片与三按钮，PC 手机均有；读图确认无引导遮挡 | 未真实点击「开启强制 HTTPS」触发 `ssl.https.enforce`（本批只取证界面呈现；插件 ssl 未安装，运行 invoke 会 E_NOTFOUND，属依赖边界） |
| 快捷键浮层（含键位表、系统保留键位说明、两个底部按钮）PC 手机均渲染，宽度贴合手机 | 未验证自定义改键（组件当前不提供改键 UI，设计如此，非本轮范围） |
| 登录门真实表单登录（非注入 cookie）、G-29 主实例零改动、G-30 明文凭据 0 FAIL | 未在主实例 8787 上取证（其二进制早于本轮改动，拍不到新界面）；主实例后续上线新构建后建议由 owner 补一轮生产态抽查 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 8 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 下本卡 4 场景 PNG + 本报告；未改任何源码、Makefile/embed、运行态资产；未碰 r8-shots2 的 search/progress/terminal/english 前缀文件。
- **G-28**：PC + 手机 + 自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（本报告第 1 节复核）。
- **G-30**：报告无任何明文口令，口令全程 `***` 占位；`make secret-check` → 0 FAIL，退出码 0。
- **临时资产**：隔离实例脚本/口令/日志全在 `/tmp/kore-r8-shots1/`，收尾删除；工作区零残留。

> ▎💼 [P8 自检] 冰山下面还有冰山：初拍两处缺陷（SSL 路由拍成 404、引导遮挡面板）都是读图复核抓出来的——只跑 DOM 断言会漏掉视觉遮挡。修完重拍、重核 md5、重读图，过程透明，结果说话。
