# R23 新功能7「日志告警」G-28 双端截图验收报告

> 元信息：2026-11-24T19:3x+08:00 · 执行者 r23-logalert 子 agent · 新 HEAD `3fcf520`（integration 接线后）· `git archive` 隔离实例 127.0.0.1:18898（config/state/run/log 全落 /tmp，守 G-29）· chromium 159 headless（playwright-core 裸驱动）· 主实例 8787 全程零请求零写入。

## 1. 截图清单与尺寸实测（G-28 验收项①②）

```
$ cd .agents/verify/screenshots && file log-alerts-desktop-01.png log-alerts-mobile-01.png
log-alerts-desktop-01.png: PNG image data, 1440 x 900, 8-bit/color RGBA, non-interlaced
log-alerts-mobile-01.png:  PNG image data, 390 x 844, 8-bit/color RGBA, non-interlaced
```

| 场景 | 文件 | 实测 | 字节 | 内容 |
| --- | --- | --- | --- | --- |
| 桌面 full-page | `log-alerts-desktop-01.png` | 1440×900 | 101414 | monitor hub「日志告警」tab 选中；标题+划界说明+空态引导+「新增第一条规则」+「立即扫描」控件同屏 |
| 手机 | `log-alerts-mobile-01.png` | 390×844 | 81629 | 同视图卡片纵向堆叠；触摸目标可见；底部导航为固定栏（截图机制，非 UI 缺陷） |

两张均为真实浏览器渲染截图（非同图缩放、非设计稿）。首轮截图被首访「新手引导」弹窗遮挡，脚本中点击「以后再看」关闭后重拍，最终截图无遮挡。

## 2. 真机渲染与 DOM 断言（证据原文）

隔离实例从 HEAD `3fcf520` 归档构建；`git show --stat 3fcf520` 含 `log-alerts` 挂 monitor hub 注册（SHELL_VIEWS + HUB_DEFS）。浏览器登录随机口令（仅 /tmp 0600，随清理删除）后导航到 `#/monitor/log-alerts` 并点击「日志告警」tab。

```
[INFO] page-state={"view":"monitor","nav":true,
  "text":"...监控\n系统体检\n运行报告\n服务拓扑\n日志\n进程\n告警规则\n故障演练\n日志告警\n日志告警\n打开告警中心\n这里配置「日志文本命中关键字就告警」，和「告警规则」页的监控指标阈值（CPU / 内存 / 磁盘）是两种不同规则。规则保存在当前进程内存中，重启后需重新配置；命中片段已脱敏。\n告警规则\n新增规则\n还没有日志告警规则\n配置一条规则后，在日志页读到含关键字的行、点本页「立即扫描」就能收到站内告警。\n新增第一条规则\n最近命中\n所有来源\n立即扫描\n扫描是一次性动作：只读取日志页当前可读取的最近 200 行做匹配，不会在后台持续跟随日志。\n还没有命中记录...",
  "tabs":"监控|系统体检|运行报告|服务拓扑|日志|进程|告警规则|故障演练|日志告警"}
```

断言结论：`KoreShell.current() === 'monitor/log-alerts'`；tab 列表含「日志告警」且为选中态；页面含空态引导与划界文案；无 JS 错误输出（pageerror 未触发 WARN）。

## 3. 产品定位自评（G-28 验收项③）

**问1：本页解决什么用户问题？** 告警中心此前只有内核埋点，用户无法自行配置「日志文本命中关键字就告警」。本页让用户以三个字段（关键字/来源/级别）配规则，点一次「立即扫描」把日志行送进服务端匹配，命中写入现有告警中心并可查脱敏历史；与「告警规则」页的监控指标阈值形成互补。

**问2：与宝塔、1Panel 同类功能的差距？** 同类面板的日志告警多为商业版或需装第三方日志套件；本页的优势是零依赖、内置于 Kore 主壳、与告警中心/通知通道直接打通，且命中片段服务端脱敏。差距：规则存进程内存、重启需重配；扫描是用户主动的一次性动作（受 G-19 硬约束，不起常驻 tail 循环），不是实时跟随告警——这是刻意的设计取舍，不是缺陷隐藏。

**问3：当前「可用」还是「占位」？** **可用（空态可用态）**。判据：真机渲染出完整空态引导、划界文案、「新增第一条规则」「立即扫描」按钮及来源下拉，非空壳。诚实标注：隔离实例无已配置日志来源，本轮未真机点击「新增规则→保存→扫描→命中」全链路（该链路的后端语义已由 go test httpapi 包与请求级扫描源码覆盖）；截图证明的是空态与入口可用，非空态写入闭环。

## 4. 运行态写边界与收尾（G-29）

- 本轮**未改动主实例运行态配置**：`.kore-local.yaml`/`.kore-local-state/`/`.kore-local-run/` 零写入，8787 全程零请求；
- 隔离实例端口 18898（分配端口 18897 被他人 chrome-headless 占用，peer 裁决改空闲端口，未杀他人进程）；
- 收尾：已停止隔离 kored 与 chromium，删除 `/tmp/kore-logalert-run`、`/tmp/kore-logalert-src`、`/tmp/kore-logalert-bin`、`/tmp/kore-logalert-shot.*`、`/tmp/kore-logalert-run.sh`、`/tmp/kore-logalert-build.log`，复核端口无监听、无残留进程；口令为一次性随机值，随 /tmp 删除，未落档；
- 写域：仅 `.agents/verify/screenshots/` 两张 PNG + 本报告；未改任何源码/配置；commit 由各 owner 各自掌握，本卡截图证据不产生源码提交。

## 5. 证据链与未覆盖项

- G-28 双端截图：`file` 实测尺寸 + 真机 DOM 断言 + 产品自评三问齐备 → **PASS**；
- 未覆盖：真实日志来源下的"规则命中→告警写入→webhook 出站"端到端实跑（隔离实例无日志插件来源配置）；该链路的后端逻辑由 httpapi 包 `go test` 与请求级扫描源码证据覆盖，已在问3 明示；
- 首轮端口冲突与截图脚本 createRequire/cookie const 赋值两次失败均为工具链问题，已换端口/换 CommonJS 路径/改 let 后成功，非产品缺陷。
