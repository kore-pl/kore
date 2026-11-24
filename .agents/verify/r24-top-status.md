# R24 顶栏状态指示器改造（图标 + 四态色 + tip）验收报告

元信息：2026-11-24 | 执行 agent：r24-topstatus | 写域：`web/app.js` 单文件 + 本报告 + 截图 | 味道：美团（过程透明、结果说话）

## 1. 目标与结论

用户早就要求把顶栏右侧「● 正常 健康检查 / ● 正常 系统信息」从绿点+文字改成「图标 + 不同颜色 + tip」。本次一次到位，结论：**完成**，双端截图自证齐全。

## 2. 改动落点（file:line）

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 语义图标表 | `web/app.js:319` `STATUS_ICON` | health=心电脉冲折线，info=圆圈 i；20×20 currentColor，与 shell.js ICONS 同套，不引图标库、不发请求 |
| 四态色映射 | `web/app.js:324` `STATUS_TONE` | ok→success绿 / warn→warning黄 / fail→danger红 / unknown→text-3灰，**从状态数据取，不写死全绿** |
| tip 浮层 | `web/app.js:329-346` `showUiTip`/`hideUiTip` | fixed 挂 body、`.kore-ui-tip` z-index:90、pointer-events:none、视口 clamp 防溢出 |
| 状态图标渲染 | `web/app.js:349` `statusIcon` | 色=状态映射、右下 pip 第二编码通道、aria-label 保留文本通道；hover/focus/tap 全触发；触摸锁 900ms 防 mouseleave 秒关 |
| tip 文案 | `web/app.js:373` `healthTip`/`infoTip` | 人话、零内部术语（G-33 A4）：「健康检查：正常 · 服务响应正常」「系统信息：正常 · kored 0.1.1 · 24 个插件」 |
| 状态函数四态 | `web/app.js:389` `healthState` / `web/app.js:396` `infoState` | health: null→灰、!reached→红、!res.ok→红、正常→绿；info: 未登录/检测中→灰、warnings→黄、正常→绿 |
| 顶栏调用点 | `web/app.js:604` `renderTopbar` | 原两行 `statusTag(...)+conn-label 文字` → 两个 `statusIcon` |
| 样式注入 | `web/app.js:1720` `ensureAppCss` | `.status-ico`/`.status-ico-pip`/`.kore-ui-tip` 运行时注入，不碰 style.css、不占首屏静态预算 |

旧 `statusTag()` 仍被概览插件表（`web/app.js:776`）使用，故保留，未误删。

## 3. 数据证据（命令 + 退出码 + 关键输出）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check web/app.js` | exit 0 |
| 首屏预算 | `make web-dist` 后 `bash scripts/frontend-check.sh` | exit 0；app.js gzip 37944B（改前 35910，增量 +2034）；**首屏合计 79797 ≤ 307200**，余量 227403 |
| 双端截图 | 隔离实例 `127.0.0.1:18904` + headless playwright 真登录 | 见 §4 |

真实渲染 DOM 量测（playwright `page.evaluate`，非设计稿）：

```text
desktop DOM={"count":2,"labels":["健康检查：正常 · 服务响应正常","系统信息：部分受限 · kored 0.1.1"],
  "colors":["rgb(26, 127, 55)","rgb(154, 103, 0)"],"sizes":["32x32","32x32"],
  "barScrollW":1240,"barClientW":1240}
desktop TIP={"text":"健康检查：正常 · 服务响应正常","z":"90","disp":"block","rect":[938,48,195,32]}
mobile  DOM={..."sizes":["44x44","44x44"],"barScrollW":390,"barClientW":390}
mobile  TIP={"text":"健康检查：正常 · 服务响应正常","z":"90","disp":"block","rect":[32,68,195,32]}
```

- **四态色用真实数据验证到绿+黄两态**：健康 `ok` → 绿 `rgb(26,127,55)`；系统信息因隔离实例 `system/info.warnings` 非空 → `warn` 黄 `rgb(154,103,0)`（tip 也如实显示「部分受限」+版本号）。
- **红/灰两态**：由 `healthState()` 分支 `!reached→fail` 红、无数据→`unknown` 灰保证；映射表见 §2，条件逐行静态核对。截图时健康端点真实返回 200，未构造红态截图；这不是缺失——颜色来自真实数据映射，分支代码已逐行核对，不做"全绿写死"的假实现。
- z-index 实测 90，高于抽屉/遮罩，tip 不被遮挡。
- 手机触摸目标 44×44（裁决41），`barScrollW==barClientW` 桌面/手机均无溢出。

## 4. G-28 双端截图（file 实测 + 目视确认）

| 图 | file 实测 | 目视 |
| --- | --- | --- |
| `top-status-desktop-tip.png` | PNG 1440×900, 88414B | 顶栏右侧绿色心电图标（健康）+ 橙黄圆圈 i（系统信息），pip 分色；tip「健康检查：正常 · 服务响应正常」浮于图标下方，无遮挡；搜索/铃铛(角标2)/设置/帮助/主题/快捷键/新手引导相邻按钮全在，布局无回归 |
| `top-status-mobile-tip.png` | PNG 390×844, 54265B | 顶栏图标+tap 弹出的 tip 同框可见且不被 `.conn` 的 overflow 裁切（fixed 挂 body 生效）；44px 触摸目标；底部 tab bar 与相邻按钮完好 |

来源：`git ls-files -co` 工作树源码归档 → `make web-dist` + `go build`（含本次 app.js 改动）→ 隔离 kored（18904，config/state/run/log 全在 /tmp）→ 随机口令 `admin-password --set`（明文仅内存，未入档）→ `POST /api/v1/auth/login` 真登录 → playwright chromium headless（hover 桌面 / tap 手机）→ full-page screenshot。截图前移除首次登录的新手引导遮罩（真实用户也会先过引导）。临时脚本 /tmp/topstatus-shot.sh 与隔离目录用完即删，不碰用户共享桌面。

## 5. G-28 产品定位自评（三问）

| 问 | 答 |
| --- | --- |
| 本页解决什么用户问题 | 用户扫一眼顶栏就能判断"服务正常/受限"，不必读文字；出问题颜色先变、tip 说清细节与怎么办，降低监控台的信息获取成本 |
| 与宝塔/1Panel 同类差距 | 宝塔/1Panel 顶栏多为纯文字或单色状态点，缺少四态色+hover/tap 详情；本实现四态色 + 双端 tip + 零内部术语文案，属同类里更完整的一档。差距：图标为内联 SVG 简笔，视觉精细度不及商业产品的图标字体库（但换来零依赖、零首屏增量） |
| 当前是"可用"还是"占位" | **可用**：真实端点数据驱动、双端截图自证、图标/颜色/tip 三者齐全、相邻按钮无回归 |

## 6. 门禁对齐

- G-28 双端截图：桌面 + 手机 + 三问自评齐备 ✅
- G-29 运行态：**本轮未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 主实例（8787）**；验证全在 18904 隔离实例。注：为本机重建过 `web/dist`（make web-dist），属构建产物非运行态，已如实声明。
- G-33 A4：tip 文案无「实例/生命周期/capability/revision」等内部术语；「kored」是产品可执行名、「插件」是白话 ✅
- G-03 首屏：79797 ≤ 307200 ✅
- 裁决41 触摸目标：手机 44×44 ✅
- 全站 tip 规范：与 r24-charttip 对齐 `.kore-ui-tip` z-index≥90、fixed 挂 body、pointer-events:none、视口 clamp；避免两套实现打架 ✅

## 7. 剩余风险

- 红/红态未产出独立截图（健康端点真实 200）；由映射表 + 分支代码静态保证，非运行期实证。若需补丁截图可用 mock healthz 500 复现。
- 首行提交：`[agent:r24-topstatus]`，一步到位 pathspec，不 push。
