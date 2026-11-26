# UI P0 双端自证（G-28）· 2026-11-26

Owner：`ui-p0`（task-80）｜方案真源：`docs/DESIGN-REDUCTION.md`（commit `6564ed2`）｜
隔离实例：`127.0.0.1:18893`（独立 config/state/run/log，收工已关闭；未碰 8787 主实例 / `.kore-local-*`）。

## 截图清单（真实 headless 浏览器，非设计稿、非同图缩放）

工具：`playwright` + 本机缓存 `chrome-headless-shell`（Google Chrome for Testing），`--headless`，
1440×900 / 390×844 视口，`deviceScaleFactor=1`，手机 `isMobile/hasTouch=true`。
登录走真实表单 `#kore-password`（连错触发图形验证码后按图片 title 的加法题真实作答），
隔离实例安装了 `file@0.3.6` 并写入真实文件 `ui-p0-verify.txt`，勾选态为真实 checkbox 点击。

| 文件 | 实测尺寸（`identify`） | 场景 |
| --- | --- | --- |
| `screenshots/ui-p0-desktop-01-dashboard.png` | 1440×1433 | PC 概览 full-page |
| `screenshots/ui-p0-desktop-01-dashboard-viewport.png` | 1440×900 | PC 概览精确视口 |
| `screenshots/ui-p0-desktop-02-settings.png` | 1440×4979 | PC 设置页 full-page（可见个性化与帮助区） |
| `screenshots/ui-p0-desktop-02-settings-viewport.png` | 1440×900 | PC 设置页精确视口 |
| `screenshots/ui-p0-desktop-03-files-default.png` | 1440×900 | PC 文件默认态（上传/新建/刷新 3 按钮） |
| `screenshots/ui-p0-desktop-03-files-default-viewport.png` | 1440×900 | 同上精确视口 |
| `screenshots/ui-p0-desktop-04-files-selected.png` | 1440×2594 | PC 文件勾选态（上下文栏出现） |
| `screenshots/ui-p0-mobile-01-dashboard.png` | 390×2480 | 手机概览 full-page |
| `screenshots/ui-p0-mobile-01-dashboard-viewport.png` | 390×844 | 手机概览精确视口 |
| `screenshots/ui-p0-mobile-02-settings.png` | 390×6872 | 手机设置页 full-page（个性化 4 入口可见，未隐藏） |
| `screenshots/ui-p0-mobile-02-settings-viewport.png` | 390×844 | 手机设置页精确视口 |
| `screenshots/ui-p0-mobile-03-files-default.png` | 390×940 | 手机文件默认态 full-page |
| `screenshots/ui-p0-mobile-03-files-default-viewport.png` | 390×844 | 手机文件精确视口 |
| `screenshots/ui-p0-mobile-04-files-selected.png` | 390×5782 | 手机文件勾选态（上下文栏出现） |

DOM 实测（两侧相同）：顶栏 `.conn > *` = **4**（`kore-search-trigger` / `kore-alert-trigger` /
`kore-status-combined` / `kore-topbar-settings`）；顶栏已无 `#kore-help-trigger` / `#kore-theme-select`；
设置页 `#kore-personalization-actions` = 4（主题 / 帮助 / 快捷键 / 新手引导，手机端快捷键触发器
不再被旧 `display:none` 补丁吞掉）；文件默认 `.files-default-actions > button` = **3**（上传/新建/刷新），
`.files-context-actions[hidden]=true`；勾选后 `hidden=false`，批量删除仍走 `files-l2.js` 的
「移入回收站确认」二次确认。

## 自评三问（原文）

**问 1：本页解决什么用户问题？**
解决「顶栏 9 个同权重控件抢焦点、手机靠偷偷隐藏按钮才塞得下」与「文件页 10 个按钮并列，
用户先扫按钮再想操作」两件事。改后顶栏只剩搜索 / 告警 / 连接状态 / 设置 4 个高频入口，
主题、帮助、快捷键、引导收进「设置 → 个性化与帮助」，一次点击可达；文件页默认只留上传 / 新建 /
刷新 3 个按钮，压缩 / 改名 / 复制到 / 批量移动 / 批量删除 / 属性只在勾选后出现在上下文栏里，
工具条按当前选择给出「能做的操作」，危险操作不再对空选择可见。健康与信息两盏灯合并为一盏
「连接状态」，点开仍可看两行详情，告警角标独立于滚动容器，未被裁切。

**问 2：与宝塔、1Panel 同类功能的差距？**
宝塔 / 1Panel 的文件管理把上传、新建、批量压缩、权限、删除放在一行常显工具条，用户已形成肌肉记忆；
Kore 改为「先勾选后操作」后，批量类操作多 1 次点击，对老用户是短期成本（已在 §2.4 记为动线变化）。
顶栏方面，竞品把主题、帮助、文档入口常驻或收在右上角个人菜单，Kore 收进设置页二级区，
比竞品的「一级菜单直达」深 1 层；但 Kore 保持薄壳，未增加常驻进程或框架，控件数远低于竞品。
其余差距延续既有事实：插件行按钮密度（P2）、tab 总数 31 > 推荐 24（推荐制、只提示），
以及首页 KPI 卡迁移（P1）尚未落地，这些都已登记到 DESIGN-REDUCTION 后续期。

**问 3：当前「可用」还是「占位」？**
**可用。** 判据：双端截图来自隔离实例真实浏览器与真实登录，DOM 断言证实顶栏 4 控件、
设置页 4 个下沉入口（含手机端不再隐藏的快捷键按钮）、文件页默认 3 按钮、勾选后上下文栏
真实出现；所有功能走原有 `KoreTheme` / `KoreShortcuts` / `KoreOnboarding` 与 `files-l2.js`
代码路径，后端方法、二次确认与 CSRF 双提交均未改动，不是演示壳或占位。未达目标项
（tab 40→31、首页 21 入口未减）如实记为渐进差距，不冒充已达标。

**G-29 声明**：本轮未改动主实例运行态配置 / state / socket / `bin/kored`，未重启 8787；
隔离实例配置、口令、脚本、浏览器 profile 与构建产物在收尾时删除。
