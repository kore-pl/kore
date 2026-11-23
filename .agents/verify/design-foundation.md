# 设计基座 P0 验收报告（字号五档 / 角标裁剪 / z-index 表 / 商店图标）

> 任务: r8-design-foundation · 执行: implementer · 日期: 2026-11-23 · 写域: web/style.css · web/shell.js · web/store.js · docs/FRONTEND.md

## 1. 改动概览（4 文件）

| 文件 | 改动 |
| --- | --- |
| web/style.css | +2 字号令牌（15/32）、+7 层叠令牌（C9）；9 处裸写 11px → Caption 令牌；9 处 z-index → 令牌；panel/modal/empty-state 标题 14→15（H2）；monitor-num 20→32（Display）；logs-stat-value 13→14；移动端 `.conn` 角标防裁 padding；商店停用钮 danger→中性 |
| web/shell.js | 仅角标相关：`.kore-alert-badge` 加 `z-index:var(--z-badge)`、2px 同底描边、字号 10px→令牌（共 3 行） |
| web/store.js | 21 个 emoji 功能图标 → 内联线性 SVG（20×20 viewBox，stroke 1.6，继承 `--kore-text-2`，与导航同线型）；3 处 `✅` → SVG 勾（badge 1 + 状态条 2，状态条 ok 态统一渲染 SVG 勾）；`store-btn-danger` → `store-btn-muted` |
| docs/FRONTEND.md | §5 尺度表回写：字号七令牌口径 + 层叠令牌一行（G-06 同检查点） |

## 2. 字号分布（style.css 全量 font-size 统计，改动前后同口径）

| 档 | 改前 | 改后 | 说明 |
| --- | --- | --- | --- |
| 裸写 11px | 9 | **0** | 全部转 Caption 令牌（12px） |
| 12px | 139 | 148 | +9 即上述违规转正；Caption 专用 |
| 13px | 32 | 32 | 正文 Body |
| 14px | 17 | 14 | -4 标题升 H2，+1 logs-stat-value 值提级 |
| 15px (H2) | 0 | 4 | panel / 商店预设 / 弹窗 / 空态标题 |
| 16px | 3 | 3 | 不变 |
| 20px (H1) | 5 | 3 | -2：monitor-num 升 Display、store-icon 改 SVG 后无字号 |
| 32px (Display) | 0 | 1 | `.monitor-num`（监控指标卡主数字） |

- 12px 占比改前 139/206（67%，审计基线 71%）——Caption 收敛后其余档位语义各归其位；值/label 对比达成：指标卡 32 vs 12，stat-value 14 vs 12。
- 未动布局：无间距/网格/容器结构改动（另一路 P0-3 概览改版不受影响）。

## 3. z-index 层级表（C9）

- style.css 顶部新增：`--z-content:0 / --z-card:10 / --z-float:20 / --z-drawer:30 / --z-modal:40 / --z-tip:50 / --z-badge:60`。
- 归位 9 处：`.topbar`/`.kore-topbar`/移动 `.kore-nav`→card；`.kore-nav-backdrop`→float；`.kore-nav-drawer`/`-head`→drawer/content；`.kore-modal`→modal；`.proc-mask`/`.proc-drawer`→drawer（同层，DOM 顺序保证 drawer 在上）。
- shell.js 角标 → `--z-badge`(60)；实测弹窗 40 / 搜索面板 60 / 抽屉 30（见 §5）。
- **写域外遗留**（本报告登记，不属本任务）：alerts.js 70/71、search.js 60、integrity.js 80、config-panel.js toast 900 为裸值；下一路改这些文件时按 C9 归位。

## 4. 移动端角标裁剪（P0-2，像素级）

- 根因确认：`@media(max-width:639px)` `.kore-topbar .conn{overflow-x:auto}` 使 `overflow-y` 计算为 auto，角标 `top:-6px` 上半圈被裁。
- 修法：`.conn` 加 `padding-top:8px; padding-right:8px`（≥6px 负偏移 + 2px 描边），角标落在 padding box 内；横向滚动行为不变，零 DOM 改动。
- 实测（390×844，顶栏 72px 裁图，角标以非零告警点亮后截取；黄色为 is-warn 态，同一裁剪路径）：

| 指标 | 修复前（8787 旧构建） | 修复后（18845 隔离实例） |
| --- | --- | --- |
| getBoundingClientRect | 16×16 @ top 3 | 16×16 @ top 11 |
| 红系像素行高（PIL 扫描） | **11px**（rows 8–18，顶部削平） | **16px**（rows 11–26，完整圆） |
| 宽度 | 16px | 16px |

- 证据：ds-badge-mobile-before.png（顶平）/ ds-badge-mobile-after.png（完整圆）；bbox 实测行高 11 → 16，无裁剪。

## 5. 真机验证（隔离实例 127.0.0.1:18845，未触碰 8787 主实例）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 指标卡 Display | `.monitor-num` computed = **32px** | ds-metric-desktop.png（CPU/负载/运行时长/磁盘/主壳 RSS 五卡大数字） |
| 商店无 emoji | 12/12 图标为 SVG，textContent 含 emoji = 0，全文正则扫描 0 | ds-store-desktop.png |
| SVG 勾 | 「已安装」badge + ok 状态条均为内联 SVG 勾 | ds-store-installed-card-desktop.png |
| 危险色降级 | 「停用」computed color `#9DA7B3`(text-2) / border `#30363D`(border-1)，页面 danger 按钮 0 | 同上 + ds-store-installed-desktop.png |
| 层级 | 弹窗 z=40、搜索面板 z=60、移动抽屉 z=30，遮罩/内容次序正确 | ds-modal-desktop.png / ds-search-desktop.png / ds-nav-drawer-mobile.png |
| 角标 | 前后 bbox 对比见 §4，16px 无裁剪 | ds-badge-mobile-{before,after}.png |

- 截图 9 张均 sha 去重通过；`identify` 实际分辨率：桌面 1440×900（full-page 1440×1088 商店），移动 390×844。
- 控制台仅 3 条预期请求状态：401 = 登录前探测；404 = 隔离实例未装 monitor/file 插件的 `/api/v1/invoke/*`（装 echo 后即消除对应路径），非前端缺陷。

## 6. 门禁与提交

- `make frontend` PASS（首屏 59308 B / 307200 B）；`make docs-check` 5 pass/1 warn/**0 fail**；`make check` 11/11 段全过、secret-check 0 FAIL。
- 隔离实例已停、/tmp 临时脚本与配置已删；本轮未改动 8787 主实例任何运行态配置。
- 提交：`feat(web): 设计基座——字号五档/角标修复/z-index 表/商店图标`（本地 commit，不 push，safe-commit CAS）
