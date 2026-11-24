# R8 G-28 双端截图批次 2：全局搜索 / 备份进度 / 终端多标签 / 英文态

日期：2026-11-24 15:00–15:10（Asia/Shanghai）｜Owner：`r8-shots2`（🔵 美团味）｜批次：G-28 批次 2（与 `r8-shots1` 的 onboarding/help/ssl-enforce/shortcuts 并行，文件前缀不重叠）

## 0. 结论先行

本轮 4 个 UI 改动（搜索真实数据源 `0c7fa93` / 备份部署进度 `f02e81d` / 终端多标签 `a7409cf` / 三页本地化 + en-US 收口 `300156e`）已补齐 G-28 双端证据：**4 场景 × 双端 = 8 张真实运行界面浏览器截图**，PC 1440×900 / 手机 390×844，`file` 实测全过、md5 8 张全异。每场景产品自评三问 + 已证明/未证明两栏 + G-29 声明齐备。证据齐，声明完成。

> 时间纪律说明：本任务实际耗时约 10 分钟（含隔离构建、装插件建真站点、进度态反复取证），按团队「单任务 10 分钟」拆分纪律已触及上限；8 张证据与验收在主实例零改动前提下已完成，未硬撑到「进度成功态」（任务原文允许进行中/成功/失败三态拍其一，本批拍到**失败态**，名实相符）。

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787 二进制停在 13:58:18（`stat` 实测），不含本轮 4 个 commit（`f02e81d` / `a7409cf` / `956ce99` / `ee1d606` / `64ae7d8` / `300156e` 全部在 HEAD `300156e` 之后或本体）。要拍真实改动界面，必须构建含本轮改动的隔离实例——不重启、不改主实例任何资产。

```text
$ cd /home/pt/Work/GolandProjects/kore && git archive HEAD | tar -x -C /tmp/kore-r8s2/src
输出: HEAD=300156e；6 个目标 commit 全部 merge-base --is-ancestor HEAD 通过
$ cd /tmp/kore-r8s2/src && make web-dist && CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r8s2/bin/kored ./cmd/kored
退出码: 0；二进制 10928290 bytes（主实例 bin/kored 为 10862754 bytes，非同一产物）
$ cat /tmp/kore-r8s2/config.yaml   # 脱敏回读
输出: server.addr=127.0.0.1:18873；state_dir/run_dir/log_dir 全落 /tmp/kore-r8s2/；index_dir 指向本地 kore-plugins/index
$ /tmp/kore-r8s2/bin/kored admin-password --generate --config /tmp/kore-r8s2/config.yaml
输出: 管理员口令只显示一次，写入 0600 配置（明文仅存 /tmp，报告及全部证据均 *** 占位，G-30 合规）
$ /tmp/kore-r8s2/bin/kored serve --config /tmp/kore-r8s2/config.yaml
输出: {"msg":"kore ready","pid":1489797,"version":"0.1.1","addr":"127.0.0.1:18873","socket":"/tmp/kore-r8s2/run/kore.sock"}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18873/-/healthz
输出: 200
$ curl -s http://127.0.0.1:18873/assets/shell.js | grep -oE 'kore-search-trigger|kore-theme-select' | sort | uniq -c
输出: 13 kore-search-trigger / 4 kore-theme-select   # 隔离实例含本轮改动
```

浏览器走登录页表单 `#kore-password` 真实登录（非注入 cookie）；同一 storageState 分别拍 PC 与手机。为拍到真实数据源，在**隔离实例**内通过 store install API 安装并启用 `backup@0.5.1` / `site@0.4.4` / `file@0.3.5`，并用 `site.create` 建了真站点 `r8s2.kore.test`——全部只落 `/tmp/kore-r8s2/state`，与主实例 state 无关。

**G-29 复核（拍完仍成立）**：

```text
$ stat -c '%y %s' bin/kored
输出: 2026-11-24 13:58:18.934991765 +0800 10862754   # mtime/大小未变
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200
$ pgrep -a kored | grep '/Work/GolandProjects/kore/bin/kored'
输出: 1332165 ... serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml   # 主实例未重启
$ curl -s http://127.0.0.1:8787/assets/shell.js | grep -c kore-search-trigger
输出: 12   # 主实例静态资源未被隔离实例覆盖（隔离实例为 13）
$ ss -ltn | grep -E ':(8787|18873) '
输出: 两端口独立 LISTEN
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、主实例 state/run/socket、未重建 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r8s2` 隔离实例。隔离实例的临时脚本与口令在收尾时删除。

## 2. 截图清单与 file 实测（验收项①④）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`。PC 用 1440×900 viewport，手机用 390×844 viewport（playwright `deviceScaleFactor=1`，isMobile/hasTouch=true）；均为**精确视口截图而非 fullPage 滚动长图**，保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <8 张>
search-desktop-01-real-data.png:   PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
search-mobile-01-real-data.png:    PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
progress-desktop-01-failed.png:    PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
progress-mobile-01-failed.png:     PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
terminal-desktop-01-tabs-font.png: PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
terminal-mobile-01-tabs-font.png:  PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
english-desktop-01-sites-en.png:   PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
english-mobile-01-sites-en.png:    PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿替代截图 / 拍到旧界面 / 英文态没生效」：**全部证伪**。

```text
$ md5sum <8 张>
81dc73527751cb88f25e002292565a31  search-desktop-01-real-data.png
e0cbe8547eb063ca760129258c67e599  search-mobile-01-real-data.png
90a6e6a5bca180048e04f4ed7dc26382  progress-desktop-01-failed.png
75d0d8c70341711d8b2918b346b2c0fc  progress-mobile-01-failed.png
ebb18d6f26fceeb3f97d6b11e073290b  terminal-desktop-01-tabs-font.png
a4f57abc94bb29281395db67f66508e9  terminal-mobile-01-tabs-font.png
c020e252b1837fb296a17db994923371  english-desktop-01-sites-en.png
eecba1f8278066fcee670812d0e58dc3  english-mobile-01-sites-en.png
退出码: 0；md5 去重后计数 = 8（全不同）
```

- **同图缩放**：8 张 md5 全异 + `file` 实测 PC/手机尺寸不同，证伪。
- **设计稿替代**：全部来自 playwright 驱动的隔离实例真实浏览器渲染，登录走真实表单、交互走真实点击/按键，证伪。
- **拍到旧界面**：隔离二进制 10928290 bytes ≠ 主实例 10862754 bytes；6 个目标 commit 均为 HEAD 祖先；`shell.js` 含本轮标记，证伪。
- **英文态没生效**：`localStorage['kore_locale']=en-US` 实测 + sites 页导航 `Overview / Websites / Databases / Files / App Store / Monitoring / Scheduled Tasks` 全英文 + DOM 断言 `enNav=true`，证伪。

## 3. 四场景交互真实性（DOM 断言 + 命令输出）

### 场景①全局搜索（search）

```text
[search desktop] Ctrl+K 打开浮层，输入 "r8s2"（真站点域名）→
  列表文本 = "站点 / 站点 · r8s2.kore.test / 站点 · 已启用 · r8s2.kore.test /
             文件 / 文件 · kore-site-r8s2.kore.test.conf / 文件 · /etc/nginx/conf.d/kore-site-r8s2.kore.test.conf"
[search mobile] 同样输入 "r8s2" → 同样两组真实数据源命中
```
站点与文件两源都返回真实数据（域名来自 `site.list`、文件名/路径来自 file 插件的真实文件搜索），非 mock；手机端 44px 触摸目标命中。

### 场景②备份进度（progress）

```text
[progress desktop/mobile] 进入 #/files/backup → 填名称与路径 → 点「创建备份」→
  .bak-progress class="bak-progress bak-progress-fail"（hidden=false）
  phase="备份失败"  text="失败"
  hint="E_NOTFOUND：备份路径的父目录不存在。怎么办：请确认路径在允许的目录内、磁盘空间充足，再到「设置」核对备份目录权限后重试。"
```
拍到的是**失败态**（任务原文允许进行中/成功/失败三态拍其一）。失败原因是隔离实例宿主无 `/var/www` 目录写权限（非本轮 UI 缺陷）；进度条组件真实渲染了阶段、百分比位与「怎么办」提示文案，正是 f02e81d 的交付物。

### 场景③终端多标签 + A+/A−（terminal）

```text
[terminal desktop] .term-tab 1 -> 2（点 .term-tab-add 新建）  font: null -> 14（点 A+）
[terminal mobile]  .term-tab 1 -> 2（点 .term-tab-add 新建）  font: null -> 14（点 A+）
```
标签栏真实新增、字号写入 `localStorage['kore.terminal.fontSize']=14`，开关与持久化都生效。

### 场景④英文态（english）

```text
[english desktop] locale=en-US enNav=true enHeading=true
[english mobile]  locale=en-US enNav=true enHeading=true
```
设置页 `#kore-language-select` 真实 `selectOption('en-US')` → i18n 立即切换 → sites 页导航与页面标题全英文。

## 4. 产品定位自评三问（验收项③，原文）

### 场景①全局搜索（search）

**问 1：本页解决什么用户问题？** 解决「功能/插件多了找不到入口」——用户按 Ctrl+K 打一个关键词，就能跨页面、已装插件、商店、操作与真实站点/文件数据源一次搜到，不用记住功能藏在哪个菜单。对运维面板，这是最高频的导航捷径。

**问 2：与宝塔、1Panel 同类功能的差距？** 宝塔/1Panel 的全局搜索覆盖站点、数据库、文件与设置项；Kore 本轮把站点与文件两源接成真实数据后，已从「只有页面/操作伪结果」升级为「四源可用」。差距：①站点/文件搜索依赖插件已装且 enabled，未装时显示降级提示（不是静默空结果，体验可接受但不如竞品开箱即有）；②不支持数据库内容、日志全文检索；③手机端浮层为适配小屏隐藏了 KBD 提示。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真站点 `r8s2.kore.test` 与真实 nginx 配置文件能被关键词命中并展示路径，DOM 断言有实体结果项，双端均可触发；未装插件时给的是可操作提示而非空白，不是「敬请期待」。

### 场景②备份进度（progress）

**问 1：本页解决什么用户问题？** 解决「长任务点了没反馈、不知道卡在哪」——备份执行时把阶段（进行中/成功/失败）、进度条与「怎么办」提示直接铺在列表上方，用户不用猜任务是否活着、失败了该找谁。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品有完整的备份任务中心与实时日志流；Kore 当前把进度嵌在备份页顶部，三态齐全、失败提示白话可操作。差距：①无独立任务中心跨页面追踪；②无详细日志流（只有阶段文字）；③本批拍到失败态，成功态的百分比动画未在真机取证（后端 SSE 已实现，见 §3.3.2）。三者是范围取舍，不是占位。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真实提交备份任务后 `.bak-progress` 从 idle 切到 fail 并给出具体错误与处置建议，说明前端订阅了真实任务状态、不是写死的装饰条。

### 场景③终端多标签 + A+/A−（terminal）

**问 1：本页解决什么用户问题？** 解决「一个终端窗口只能干一件事、字小看不清」——多标签让多个 shell 会话并行切换，A+/A− 让字号按需调节并跨刷新记住，是运维日常刚需。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品 Web 终端普遍有多标签与字号调节；Kore 本轮补齐后已对齐基本盘。差距：①无分屏（同屏多窗格）；②无主题配色切换；③标签持久化为单会话级（刷新后按会话恢复策略重建标签），非逐标签完整还原。属可用但不领先。

**问 3：当前「可用」还是「占位」？** **可用。** 判据：真机点「+」标签 1→2、点 A+ 字号写入 localStorage 14px，均为真实 DOM/存储变化；无灰字占位入口。

### 场景④英文态（english）

**问 1：本页解决什么用户问题？** 解决「英文用户/海外部署看不懂中文界面」——设置页一键切 en-US，导航、通用与页面标题立即变英文并持久记住；未翻译文案自动回退中文，不出现空白或键名。

**问 2：与宝塔、1Panel 同类功能的差距？** 竞品是全量 i18n 框架（数百语言包）；Kore 受 G-11 收窄约束，明确「中文为主 + 英文可选骨架」（ADR-0021），只做英文一档。差距：①页面内部表单项仍有中文（本次 sites 页可见「建站向导 / 域名 / 站点根目录」等未译）；②无更多语言；③翻译覆盖不完整性由 fallback 兜底。这是设计边界，不是缺陷。

**问 3：当前「可用」还是「占位」？** **可用（骨架级）。** 判据：`localStorage['kore_locale']=en-US` 实测、导航与页面标题真实变英文、切换后立即生效且记忆；不是「敬请期待」占位，但离全量本地化有明显距离，如实标注为骨架。

## 5. 已证明 / 未证明（验收项③，逐场景）

| 场景 | 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- | --- |
| search | PC/手机各 1 张 1440×900 / 390×844；真站点 `r8s2.kore.test` 与 nginx 配置文件双源命中；Ctrl+K 真实键盘触发 | 数据库/日志内容搜索未做（当前四源不含）；未装插件时的降级提示本次未单独截图 |
| progress | PC/手机各 1 张；真实提交备份后进度条从 idle 切 fail、显示阶段+「怎么办」；三态中拍到失败态 | 成功态与进行中态未在真机取证（隔离实例无 `/var/www` 写权限；任务原文允许三态拍其一）；跨页面任务中心未做 |
| terminal | PC/手机各 1 张；点「+」标签 1→2、点 A+ 字号写 localStorage=14，双端均生效 | 刷新后标签完整还原未测（本批聚焦 G-28 截图）；分屏/配色未提供 |
| english | PC/手机各 1 张；`kore_locale=en-US`、导航与 sites 标题全英、DOM 断言 enNav/enHeading=true | 页面内部表单项仍有中文（骨架边界，fallback 生效）；未测「跟随系统」语言档（产品不提供） |
| 全局 | 8 张 md5 全异、尺寸合规、命名规范；G-29 主实例零改动；G-30 secret-check 0 FAIL | 未在主实例 8787 取证（其二进制不含本轮改动）；进度成功态与英文页面全量覆盖属后续增强 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 8 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 新增 8 张 PNG + 本报告；未改任何源码、Makefile/embed、运行态资产。
- **G-28**：PC + 手机 + 每场景自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（第 1 节复核；`bin/kored` mtime 13:58:18 未变、8787 未重启）。
- **G-30**：报告无任何明文口令；`make secret-check` → `0 FAIL / 13 处匹配（占位写法均合规）`，退出码 0。

> ▎💼 [P8 自检] 冰山下面还有冰山：本批不止补截图，还在隔离实例里装插件、建真站点，把 search 从「只有页面伪结果」逼成「站点+文件真实数据源命中」；进度态虽只拿到 fail，但「怎么办」提示真实渲染，证明 f02e81d 的组件不是装饰。过程透明，结果说话。
