# R10 G-28 双端截图批次 1：进程趋势图 / 日志占比环 / 防火墙白话化 / 改口令骨架

日期：2026-11-24 15:57–16:10（Asia/Shanghai）｜Owner：`r10-shots1`（🔵 美团味）｜批次：双端截图批次 1（4 场景 × PC + 手机）

## 0. 结论先行

本批已落地的 4 个 UI 改动（进程页 CPU/内存 Canvas 趋势图 / 日志页 SVG 来源·级别占比环 / 防火墙页白话化 / 设置页改口令交互骨架）已补齐 G-28 双端证据：**PC 4 张 1440×900 + 手机 4 张 390×844，共 8 张真实运行界面的 Playwright 浏览器截图**，全部 `file` 实测通过、md5 两两互异（distinct=8）；产品自评三问、已证明/未证明两栏、G-29 零改动声明齐备。证据齐，声明完成。

## 1. 隔离实例（G-29：主实例 8787 零改动）

主实例 8787 已是本批新构建（PID 1659842 / `bin/kored` sha 01fa793d），但按 G-29 截图走隔离实例——不重启、不改主配置、不重建主二进制。

```text
$ cd /home/pt/Work/GolandProjects/kore && git archive HEAD | tar -x -C /tmp/kore-r10s1/src
退出码: 0   # HEAD=321c34d7，含本批 4 commit：0c4d1f9 / b685155 / 699cf4f / c8dcb9e
$ git merge-base --is-ancestor <每个 commit> HEAD   # 4 个全部 IN-HEAD
$ cd /tmp/kore-r10s1/src && make web-dist && CGO_ENABLED=0 GOAMD64=v1 go build \
    -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-r10s1/bin/kored ./cmd/kored
退出码: 0；二进制 11051170 bytes
$ curl -s http://127.0.0.1:18874/assets/process.js | grep -c 'proc-chart-canvas'
输出: 4   # 隔离实例服务的是含新图表的 dist
$ curl -s http://127.0.0.1:18874/assets/logs.js | grep -c 'logs-chart-donut'
输出: 3
$ /tmp/kore-r10s1/bin/kored serve --config /tmp/kore-r10s1/config.yaml
输出: {"msg":"kore ready","pid":1683198,...,"addr":"127.0.0.1:18874"}
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18874/-/healthz
输出: 200
```

隔离实例 `server.addr=127.0.0.1:18874`，state/run/log/index 全落 `/tmp/kore-r10s1/`。为确保图表拍到真实数据而非空图：① 从主实例 state 只读 `cp -a` 一份插件快照进 `/tmp`（主资产零改动，插件已装好）；② 进程页 `process.history` 插件硬编码 30s 真实采样间隔，用后台脚本每 31s 真实 invoke 采样，截图时已积累 7–8 个真实点（CPU 0.0%→9.2%→12.1%→9.3%，非伪造）；③ 日志页在隔离 config 里登记一份多级别真实日志文件（600 行 INFO/WARN/ERROR/DEBUG 四级别），`logs.aggregate` 真读文件出四段占比。管理员口令由 `kored admin-password --set --stdin` 写入隔离 config（明文仅经脚本环境变量传递，报告与全部证据均为 `***` 占位，G-30 合规），浏览器侧走登录页 `#kore-password` 表单真实登录（非注入 cookie）。

**G-29 复核（拍完仍成立）**：

```text
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
输出: 200   # 主实例全程存活
$ stat -c '%y %s %n' bin/kored
输出: 2026-11-24 15:53:23.063504568 +0800 11051170 bin/kored   # 主二进制 mtime 未变
$ pgrep -a kored | grep '/Work/GolandProjects/kore/bin/kored'
输出: 1659842 ... serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml   # 主实例未重启
$ ss -ltn | grep -E ':(8787|18874) '
输出: 两端口独立 LISTEN（8787 主实例 / 18874 隔离实例）
```

**本轮是否改动过主实例的运行态配置：否。** 未碰 `.kore-local.yaml`、未碰主实例 state/run/socket、未重建 `bin/kored`、未重启 8787；全部证据来自 `/tmp/kore-r10s1` 隔离实例。隔离实例的脚本、口令、日志、state 在收尾时删除。

## 2. 截图清单与 file 实测（验收项①）

全部截图存 `.agents/verify/screenshots/`，命名 `<场景>-<desktop|mobile>-*.png`（场景名严格用任务卡指定前缀 `proc-chart` / `log-chart` / `firewall-plain` / `passwd-ui`）。PC 用 1440×900 viewport、手机用 390×844 viewport（playwright `deviceScaleFactor=1`，手机 `isMobile/hasTouch=true`，`fullPage=false` 精确视口截图），保证 `file` 实测尺寸恰好匹配门禁。

```text
$ cd .agents/verify/screenshots && file <8 张>
proc-chart-desktop-01-canvas-hover.png:    PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
proc-chart-mobile-01-canvas-hover.png:     PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
log-chart-desktop-01-donut.png:            PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
log-chart-mobile-01-donut.png:             PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
firewall-plain-desktop-01-text.png:        PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
firewall-plain-mobile-01-text.png:         PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
passwd-ui-desktop-01-dialog.png:           PNG image data, 1440 x 900, 8-bit/color RGB, non-interlaced
passwd-ui-mobile-01-dialog.png:            PNG image data, 390 x 844, 8-bit/color RGB, non-interlaced
退出码: 0
```

蓝军自检「同图缩放冒充双端 / 设计稿 / 拍到旧界面」：**已证伪**。8 张 md5 全不同：

```text
$ md5sum <8 张>
4ddc891c376a2ccb4b0aeacdb82a76da  proc-chart-desktop-01-canvas-hover.png
3626ccfd28573d95760c1c9462d3a54b  proc-chart-mobile-01-canvas-hover.png
4b9265e4fb77e52ef70f2817c367b01f  log-chart-desktop-01-donut.png
da9467f40acb2887d515321fbb05dcd3  log-chart-mobile-01-donut.png
b095cc7b73751d3a0c666d1510836d82  firewall-plain-desktop-01-text.png
50cdf05f5dbee54de95ca05ca9758935  firewall-plain-mobile-01-text.png
b8283e8aa2d9aa6cefba8b0e1121244f  passwd-ui-desktop-01-dialog.png
cfe488191ec1b44002ba4690ce4a619e  passwd-ui-mobile-01-dialog.png
$ md5sum <8 张> | awk '{print $1}' | sort -u | wc -l
输出: 8
```

读图复核（逐张）：①proc-chart 桌面图见监控>进程 tab、系统资源趋势面板、CPU 蓝线标注 0.0%/9.2%/9.2%/10.7%/8.2%/9.3%、内存绿线 24xxx MiB、hover 读数框「16:06:07 / CPU 使用率 8.2%」带单位、图注「共 7 点·采样间隔 30s」、下方真实进程表；②log-chart 桌面图见 SVG 环心「500 条」、ERROR/WARN/INFO/DEBUG 四段各带「62 条·12.4%」等单位、tooltip「ERROR / 62 条·12.4%」、按来源/按级别 tab、真实彩色日志行；③firewall 见白话文案「查看防火墙工具与规则…」「UFW（系统防火墙工具）」「没有系统管理员权限」，无"后端"；④passwd 见设置>账户与安全、弹窗「修改管理员口令」+ 降级说明 + 三输入框 + 取消/确认按钮。每张都含真实页面元素（侧栏导航 / 顶栏 / 真实数据），非设计稿、非接口返回、非同图缩放。

## 3. 四场景交互真实性（DOM 断言 + 命令输出）

```text
# 登录 + 真实路由（hub/sub 结构：#/monitor/process 等；直接 #/process 会 404，已修正）
[shoot] desktop afterLogin: {"pwdGone":true,"errs":[]}

# 场景①进程趋势（commit 0c4d1f9）：等 Canvas aria-label「N 点」≥2，hover 出带单位读数
[shoot] desktop proc-chart: {"tip":"16:06:07CPU 使用率8.2%","aria":"CPU 使用率 趋势图：7 点，区间 0.0% ~ 12.1%，最近 9.3%；悬停或点按可读出该点时间与数值","errs":[]}
[shoot] mobile  proc-chart: {"tip":"16:06:07CPU 使用率8.2%","aria":"CPU 使用率 趋势图：8 点，区间 0.0% ~ 12.1%，最近 10.2%","errs":[]}

# 场景②日志占比环（commit b685155）：切多级别来源 r10demo + 「按级别」tab，四段带单位
[reshot] desktop log-chart: legend=["62 条 · 12.4%","125 条 · 25.0%","251 条 · 50.2%","62 条 · 12.4%"] tip="ERROR62 条 · 12.4%" errs=[]
[reshot] mobile  log-chart: legend=同上四段（tip 未固定命中，触屏边界见未证明栏）

# 场景③防火墙白话化（commit 699cf4f）：文字断言
[shoot] desktop firewall-plain: {"hasTool":false,"hasAdmin":true,"hasBackend":false}
  # 注：hasTool=false 是脚本只查精确字面「当前系统防火墙工具」所致；
  # 页面实际呈现等价白话「UFW（系统防火墙工具）」+「没有系统管理员权限」（读图已确认），无"后端"
[shoot] mobile  firewall-plain: 同上

# 场景④改口令骨架（commit c8dcb9e）：点 #kore-pw-change 弹降级对话框
[shoot] desktop passwd-ui: {"hasBtn":true,"hasBanner":true,"hasHint":true,"errs":[]}
[shoot] mobile  passwd-ui: 同上
```

**蓝军自攻击记录（两处真实缺陷已修，非掩盖）**：① 初拍用错路由 `#/process` / `#/logs` / `#/firewall` → 全部落 404（`body` 含「这个页面不存在」），RCA 修正为 hub/sub 路由 `#/monitor/process` 等后重拍，Canvas/环图均出现；② 初拍 log-chart 默认单来源 syslog 无级别词 → 环图只有「其他级别 500 条·100%」单段，无法证明"每点带单位"多段占比——切到隔离内多级别真实来源 + 「按级别」tab 后重拍 2 张，得到四段带单位图例与 tooltip。两次修正都重拍并重核 file/md5，未放宽验收口径。首访引导遮罩用真实点击「知道了」关闭，未用 JS 强制隐藏。

## 4. 产品定位自评三问（验收项②，原文）

**问 1：本页解决什么用户问题？**
四个改动合起来解决运维用户「想知道进程 CPU/内存历史趋势却只能看瞬时值、看日志只看到文字墙无法一眼分清来源和级别占比、看防火墙被'后端/root'等内部术语劝退、想改管理员口令却找不到安全入口」四个实际问题。进程页把系统资源 history 做成 Canvas 双曲线（CPU% + 内存 MiB），每个点 hover/点按都出带单位的读数面板，<12 点直接标在点上，不用装第三方图表库也不增加首屏负担；日志页在 stats 区加 SVG 来源/级别占比环，按来源/按级别一键切换，四段图例与 tooltip 都带「条」和「%」单位，把「最近 500 条里 ERROR 占多少」变成一眼可读；防火墙页把错误提示与按钮文案全部换成白话——「查看防火墙工具与规则」「先预览真实命令，确认后再执行」「没有系统管理员权限：表单已禁用」，并给出可执行下一步（以管理员身份运行后刷新 / 查看运行手册），不再出现"后端"这类内部词；设置页在「账户与安全」加「修改管理员口令」按钮，点开有完整交互骨架（当前/新/确认三输入框 + 取消/确认），同时用降级横幅诚实说明「当前版本内核还没有在线改口令接口…命令行改口令会吊销所有会话」，不伪造成功。四块均对应 `docs/USABILITY.md` 四原则尤其是「小白能看懂」与「空状态给下一步按钮」。

**问 2：与宝塔、1Panel 同类功能的差距？**
宝塔 / 1Panel 都有资源历史曲线、日志可视化统计、防火墙图形化管理与改密入口；本轮之后 Kore 在这四项上从「无/文字墙/术语劝退/无入口」变成「有」。差距仍在：①进程趋势图是自研 Canvas + LTTB，只有 CPU/内存两条系统级曲线，没有竞品的网络/磁盘 IO 多维与自定义时间范围（单进程趋势需打开详情抽屉且受 2s 差分间隔限制）；②日志占比环只统计「最近命中」（上限 500 条样本），不是全时段聚合，也没有竞品的时间直方图与下钻联动；③防火墙页在非 root 隔离实例下呈"只读降级"态（需 root 才能读真实规则），本轮证明的是白话文案与降级引导，不是完整规则管理；④改口令当前是"完整交互骨架 + 诚实降级"，端点就绪前按钮点击不会真的改密。四者都属于「够用但不领先 / 边界已明示」，符合当前 M0/M1 阶段定位；其中③④已用页面文案明确边界，不是静默误导。

**问 3：当前「可用」还是「占位」？**
**可用（带诚实降级边界）。** 判据：四改动均随本批 4 个 commit 落在 web/dist，隔离实例双端截图证明——进程页真实 `process.history` 7–8 点采样绘出双曲线且 hover 出「8.2%」带单位读数；日志页真实 `logs.aggregate` 四级别 500 条绘出多段环与「62 条·12.4%」tooltip；防火墙页真实渲染白话文案与「系统管理员权限」引导、无"后端"；改口令按钮真实弹窗、降级说明逐字呈现、三输入框与操作按钮齐全。不是占位：没有「敬请期待」「待实现」文案，没有点了没反应的入口。边界：①改口令端点未接入，按钮当前只到"弹窗 + 降级说明"，这是骨架的明确定义（commit c8dcb9e 即"交互骨架与诚实降级"），不是伪装可用；②手机端日志环的 tooltip 未固定命中（tap 触点偏移），但四段图例本身带单位且在图中可读，桌面已证明每点 hover 可读，触屏精确命中是待优化点。

## 5. 已证明 / 未证明（验收项③）

| 已证明（本次真机证据） | 未证明（如实列出，非缺陷即边界） |
| --- | --- |
| PC 4 张 1440×900、手机 4 张 390×844，file 实测全过、md5 各异（distinct=8） | 手机端日志环 tooltip 未固定命中（tap 触点偏移）；四段带单位图例双端可读、桌面 hover tooltip 已证明，触屏精确命中待优化 |
| 进程页真实 `process.history` 7–8 点采样绘出 CPU/内存双 Canvas 曲线，hover 出「8.2%」带单位读数，图注标采样间隔 30s | 未做「单进程详情抽屉趋势图」的独立截图（本批场景 1 聚焦系统资源 history；单进程趋势需开抽屉且受 2s 差分限制，不在本卡 4 场景内） |
| 日志页真实 `logs.aggregate` 四级别 500 条绘出 SVG 多段环，图例各段带「条·%」、桌面 tooltip「62 条·12.4%」 | 环图统计仅「最近命中 500 条样本」，未证明全时段聚合或时间范围筛选（实现口径如此，非本轮范围） |
| 防火墙页白话文案真实渲染（「UFW（系统防火墙工具）」「没有系统管理员权限」等），无"后端"字样 | 未在 root 实例下证明完整规则读写（隔离实例非 root，页面如实进入只读降级态；root 运行属部署前提） |
| 改口令按钮真实弹窗 + 降级说明 + 三输入框 + 操作按钮，双端均渲染 | 未真实执行改密（端点未接入，弹窗明示降级；commit 定义即骨架，非缺陷） |
| 登录门真实表单登录（非注入 cookie）、hub/sub 路由真实导航、G-29 主实例零改动、G-30 明文凭据 0 FAIL | 未在主实例 8787 上取证（本卡按 G-29 走隔离；主实例已是新构建，如需生产态抽查由 owner 另派） |
| 蓝军自攻击修正两处真实缺陷（路由 404、环图单段）并重拍重核 | 临时隔离脚本/口令/state 已列入收尾删除清单，删除动作见 §6 |

## 6. 合规与门禁

- **G-07 证据**：全部结论附命令 + 退出码 + 输出；`file` 实测 8 张尺寸；DOM 断言原文照录。
- **G-12 写域**：仅 `.agents/verify/screenshots/` 下本卡 4 场景共 8 张 PNG + 本报告 `.agents/verify/r10-ui-shots-batch1.md`；未改任何源码、Makefile/embed、运行态资产；未碰 r10-shots2 的 resume/labels/english/plugins-overview 前缀文件。工作区另有其他 agent 在途改动的源码文件（session.go / handlers.go / server.go / handlers_password.go），非本卡写域，不提交、不触碰。
- **G-28**：PC + 手机 + 自评三问 + 已证明/未证明 + 禁止同图缩放（md5 全异）——逐条满足。
- **G-29**：主实例运行态零改动（本报告第 1 节复核）。
- **G-30**：报告无任何明文口令，口令全程 `***` 占位（实际口令仅经脚本环境变量传入浏览器与隔离 config，未入任何文件/报告）；`make secret-check` → **0 FAIL / 13 处匹配（占位写法均合规）**，退出码 0。
- **临时资产**：隔离实例脚本/口令/日志/state 全在 `/tmp/kore-r10s1/`，收尾 kill 实例 + rm -rf 目录，工作区零残留。

> ▎💼 [P8 自检] 冰山下面还有冰山：初拍两处缺陷（路由拍成 404、环图只有单段 100%）都是读图和 DOM 断言交叉复核抓出来的——只跑截图不核对数据会交出"看起来有图其实无效"的证据。修完重拍、重核 md5、重读图，过程透明，结果说话。做难而正确的事，猛将必发于卒伍。
