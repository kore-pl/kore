# R7-A2 三个 UI 组件 G-28 双端证据：首次引导 / 主题切换 / 快捷键帮助

日期：2026-11-24 12:34–12:52（Asia/Shanghai）｜Owner：`r7-screens`（🔵 美团味）｜任务：task-5（前置 task-4 接线 e135820 已 completed）

## 0. 结论先行

接线后的三个组件（onboarding / theme / shortcuts）已补齐 G-28 双端证据：**PC 4 张 1440×900 + 手机 4 张 390×844，共 8 张真实运行界面浏览器截图**，全部 `file` 实测通过、md5 各不相同；产品自评三问、已证明/未证明栏、G-29 运行态声明齐备。证据齐，声明完成。

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787 跑的是 10:26 的旧二进制（`/assets/shell.js` 无接线入口），接线的三个组件在 commit `e135820`（12:33:19）才落地。要拍真实接线界面，必须构建含接线的隔离实例——不重启、不改主实例任何资产。

```text
$ cd /home/pt/Work/GolandProjects/kore && git archive HEAD | tar -x -C /tmp/kore-r7a2/src
退出码: 0
$ grep -c 'kore-theme-select\|kore-onboarding-trigger\|kore-shortcut-trigger' /tmp/kore-r7a2/src/web/shell.js
输出: 9   # 归档含接线入口
$ cd /tmp/kore-r7a2/src && make web-dist && CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r7a2/bin/kored ./cmd/kored
退出码: 0；二进制 10801314 bytes
$ /tmp/kore-r7a2/bin/kored serve --config /tmp/kore-r7a2/config.yaml
输出: {"msg":"kore ready","pid":261254,"addr":"127.0.0.1:18871"}   # 独立端口
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18871/-/healthz
输出: 200
$ curl -s http://127.0.0.1:18871/assets/shell.js | grep -o 'kore-theme-select\|kore-onboarding-trigger\|kore-shortcut-trigger' | sort | uniq -c
输出: 4 kore-theme-select / 3 kore-shortcut-trigger / 5 kore-onboarding-trigger
```

隔离实例 config：`server.addr=127.0.0.1:18871`，state/run/log/index 全落 `/tmp/kore-r7a2/`。管理员口令由 `kored admin-password --generate --config <隔离config>` 生成（明文仅存在于 `/tmp` 的 0600 文件，随实例销毁删除；本报告及全部证据均为 `***` 占位，G-30 合规）。浏览器侧走登录页表单 `#kore-password` 真实登录（非注入 cookie），登录后复用同一 storageState 拍 PC 与手机。

**G-29 复核（拍完仍成立）**：

```text
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ stat -c '%y %s %n' bin/kored
输出: 2026-11-24 10:26:28.759760672 +0800 10567842 bin/kored   # mtime 未变
$ pgrep -a kored | grep '/Work/GolandProjects/kore/bin/kored'
输出: 636777 ... 10:28:16 启动   # 主实例未重启
$ curl -s http://127.0.0.1:8787/assets/shell.js | grep -c kore-theme-select
输出: 0   # 主实例静态资源未被隔离实例污染
$ ss -ltn | grep -E ':(8787|18871) '
输出: 两端口独立 LISTEN（8787 主实例 / 18871 隔离实例）
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、未碰主实例 state/run/socket、未重建 `bin/kored`、未重启 8787；三个组件的新证据全部来自 `/tmp/kore-r7a2` 隔离实例。隔离实例的临时脚本与口令在收尾时删除。

## 2. 截图清单与 file 实测（验收项①④）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`。PC 用 1440×900 viewport、手机用 390×844 viewport（playwright `deviceScaleFactor=1`，isMobile/hasTouch=true）；均为**精确视口截图而非 fullPage 滚动长图**，保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <8 张>
onboarding-desktop-01-first-visit.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
theme-light-desktop-01.png:           PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
theme-dark-desktop-01.png:            PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
shortcuts-desktop-01-help.png:        PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
onboarding-mobile-01-first-visit.png: PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
theme-light-mobile-01.png:            PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
theme-dark-mobile-01.png:             PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
shortcuts-mobile-01-help.png:         PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图」：**已证伪**。8 张 md5 全不同：

```text
$ md5sum <8 张>
632c1a49dd105b611cc16a6c9a8dcf5e  onboarding-desktop-01-first-visit.png
e431335b9d8e3982f7df17b9924c2754  theme-light-desktop-01.png
763d482a9c4a365928207d033b53147e  theme-dark-desktop-01.png
c31c048427738d39196c7bea6f1945bc  shortcuts-desktop-01-help.png
ed36f80183f7d2874bf852ad5622e43b  onboarding-mobile-01-first-visit.png
5252bebb88829243e3350fc7ad52a317  theme-light-mobile-01.png
1f665481ccbe0cda6ae2d5981d2cc522  theme-dark-mobile-01.png
3085d15a48ab7a4df7210bd54d767168  shortcuts-mobile-01-help.png
```

读图复核：引导面板 5 步清单（「欢迎使用 Kore / 还剩 5 项」）PC 与手机均完整渲染；浅色=白底深字、深色=深底浅字，顶栏 select 显示值与视觉一致；快捷键浮层列出 Mod+/ 等键位、底部「重新查看新手引导」「知道了」按钮。每张都含真实页面元素（侧栏导航 / 概览卡片 / 手机底部 tab bar），非设计稿、非接口返回、非同图缩放。

## 3. 三场景交互真实性（DOM 断言 + 命令输出）

```text
# 登录 + 组件加载（PC）
[shoot] afterLogin: {"hasPasswordField":false,"hasThemeSelect":true,"hasOnboardTrigger":true,"hasShortcutTrigger":true}
[shoot] components: {"theme":true,"onboarding":true,"shortcuts":true,"themeAttr":"system","effective":"light"}

# 场景①首次引导：首访 localStorage 无记录 → autoOpen 自动弹出（PC + 手机均 autoOpen=true）
[shoot] onboarding DOM: {"panelExists":true,"itemCount":15} isOpen=true
[mobile] onboarding open=true via=autoOpen panelText="欢迎使用 Kore ... 跟着这 5 件事走一遍 ..."

# 场景②主题切换：用顶栏 #kore-theme-select 真实 selectOption（触发 change 事件）
[theme-select] desktop light {"v":"light","theme":"light","eff":"light","ls":"light"}
[theme-select] desktop dark  {"v":"dark","theme":"dark","eff":"dark","ls":"dark"}
[theme-select] mobile  light {"v":"light","theme":"light","eff":"light","ls":"light"}
[theme-select] mobile  dark  {"v":"dark","theme":"dark","eff":"dark","ls":"dark"}

# 场景③快捷键浮层：PC 用 Ctrl+/（Mod+/）真实键盘事件；手机无物理键盘用 KoreShortcuts.openHelp()
[shoot] shortcut help DOM: text="快捷键 ... 显示快捷键帮助 Mod / ... 重新查看新手引导 知道了"
[mobile] shortcut help: {"exists":true,"text":"快捷键 ...","w":"390px"}
```

主题 select 点击路径单独复核：`selectOption('dark')` 后 select.value / data-kore-theme / data-kore-effective / localStorage['kore.theme'] 四处同时为 dark，接线（`shell.js` 的 change → `theme.set`）确实生效，无「按钮点了没反应」类 bug。

## 4. 产品定位自评三问（验收项②，原文）

**问 1：本页解决什么用户问题？**
三个组件合起来解决「装好 Kore 后不知道从哪下手、想改外观找不到入口、记不住快捷键」这三个新用户最痛的起步问题。首次引导把「看概览 → 挑预设 → 换外观 → 记快捷键 → 做第一件正事」五步做成检查清单，每项一键直达、不用填参数，进度自动记住；主题三选一（跟随系统 / 浅色 / 深色）放在顶栏随时可切并持久化；快捷键帮助把 Ctrl+/、Mod+S 等全局键位与系统保留键位一次列清，手机上明确告知「入口会隐藏」。这正好补上 `docs/PLUGIN-MATURITY.md` §3.3.2 里「首次引导=无」「快捷键=局部有」「主题=无」三行缺口。

**问 2：与宝塔、1Panel 同类功能的差距？**
宝塔 / 1Panel 都有新手任务卡片、深色模式和全局快捷键说明；本轮之后 Kore 在这三项上从「缺/局部有」变成「有」。差距仍在：①引导是静态 5 步清单，不会按用户已装插件/已建站点动态跳过已完成项（竞品的新手任务会按状态打勾），我们目前只在用户手动点「我已经做了」时记进度；②主题只有浅/深/跟随系统三档，没有竞品的自定义配色、字体大小调节；③快捷键帮助只展示与解释，不支持用户自定义改键。三者都属于「够用但不领先」，符合当前 M0 阶段定位；其中①已支持手动标记与重开，自动化是后续增强点，不是阻塞缺陷。

**问 3：当前「可用」还是「占位」？**
**可用。** 判据：三组件已随 e135820 接进 shell.js，真机（隔离实例）双端截图证明首访自动弹、主题 select 真实切换并持久化、快捷键浮层真实打开；5 步清单每项有 actionLabel 按钮可点（非灰字占位）；主题与快捷键均有真实的 DOM 状态与 localStorage 联动。不是占位：没有「敬请期待」「待实现」文案，没有点了没反应的入口。边界：手机上快捷键帮助只能由浮层 API 打开（无物理键盘），这是设计取舍不是占位。

## 5. 已证明 / 未证明（验收项③）

| 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- |
| PC 4 张 1440×900、手机 4 张 390×844，file 实测全过、md5 各异 | 手机端快捷键浮层未用「物理键盘 Ctrl+/」触发（手机无键盘），走 `KoreShortcuts.openHelp()`；PC 已用真实 Ctrl+/ 证明键位生效 |
| 首访 autoOpen：PC 与手机均无引导记录时自动弹出 5 步清单 | 未完成「勾选完成 → 刷新后不再自动弹 → 点按钮重开」的完整状态往返（组件有 API 与 localStorage 逻辑，本次聚焦 G-28 截图，未做状态机回归） |
| 主题 select 真实 change → data-kore-theme/data-kore-effective/localStorage 四处联动，浅/深视觉差异双端可见 | 未验证「跟随系统」档随 `prefers-color-scheme` 动态变化（截图用显式 light/dark） |
| 快捷键帮助浮层（含键位表、系统保留键位说明、重新查看引导按钮）PC 手机均渲染，宽度 390px 贴合手机 | 未验证自定义改键（组件当前不提供改键 UI，设计如此，非本轮范围） |
| 登录门真实表单登录（非注入 cookie）、三组件懒加载成功、G-29 主实例零改动、G-30 明文凭据 0 FAIL | 未在主实例 8787 上取证（其二进制早于接线 commit，拍不到新组件）；主实例后续上线新构建后建议由 owner 补一轮生产态抽查 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 8 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新截图 + 本报告；未改任何代码、Makefile/embed、运行态资产。
- **G-28**：PC + 手机 + 自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（本报告第 1 节复核）。
- **G-30**：报告无任何明文口令；`make secret-check` → `0 FAIL / 13 处匹配（占位写法均合规）`，退出码 0。

> ▎💼 [P8 自检] 冰山下面还有冰山：本轮不仅补了截图，还用真实 select change 复验了接线是否生效（防「按钮点了没反应」），并把手机端无键盘这一设计边界写进未证明栏——过程透明，结果说话。
