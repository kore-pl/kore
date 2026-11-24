# R24 告警中心手机端布局修复 · 验收报告

> owner: r24-alertlayout · 味道: 🔵 美团（过程透明，结果说话） · 日期: 2026-11-24

## 1. 用户问题与根因

用户提供手机截图（390×735）：标题「告警中心」被挤成竖排（告/警/中/心 每行一字），「共 16 条 · 未读 7」断成两行，三个操作按钮被挤压换行。

根因（改前 `web/alerts.js`）：

- `web/alerts.js:35-36`（改前）：`.kore-alert-head{display:flex;align-items:center;gap:...}` 单行 flex，无 `flex-wrap`，5 个子项硬挤一行。
- `web/alerts.js:37`（改前）：`.kore-alert-title{...;flex:1}` `flex:1` 无 `min-width`/`white-space`，被按钮挤压到极窄宽度后逐字竖排。
- `web/alerts.js:38`（改前）：`.kore-alert-count` 无 `white-space:nowrap`，被挤断行。
- `web/alerts.js:60-61`（改前）：`@media(max-width:639px)` 只改 panel 尺寸与 `.kore-alert-act`，头部完全未适配。

## 2. 修复方案（仅改 web/alerts.js 内联 CSS + DOM，不碰全局 style.css 与其它视图）

- 头部拆两组：`.kore-alert-headline`（标题 + 计数，`white-space:nowrap; flex:none` 保横排）+ `.kore-alert-ops`（3 按钮，`margin-left:auto` 桌面右对齐）。head 加 `flex-wrap:wrap`。
- 手机 ≤639px：headline 与 ops 各占满一行（`flex:1 1 100%`）；按钮 `flex:1 1 auto; min-height:var(--kore-touch)`（44px）+ `white-space:nowrap`，平分整行不溢出。
- 桌面：按钮维持 32px、右对齐，无回归。
- 卡片正文原已有 `overflow-wrap:anywhere`（`web/alerts.js:57-58`），截图验证长正文正确换行不溢出，无需额外改动。

## 3. 验证证据（命令 + 退出码 + 实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| JS 语法 | `node --check web/alerts.js` | exit 0 |
| 首屏预算 | `bash scripts/frontend-check.sh`（先 `make web-dist`） | exit 0；首屏 gzip 合计 **77763 字节 ≤ 307200**（余量 229437）；i18n 2922 ≤ 3072 |
| 隔离构建 | `git archive HEAD` → 工作树修复的 alerts.js 覆盖 → `make web-dist` + `CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build ... ./cmd/kored` | kored 11776162B，exit 0 |
| 隔离实例 | 独立端口 **18898**，config/state/run/log 全落 `/tmp/r24-alert-isolated`；真登录（`POST /api/v1/auth/login` authenticated=true） | healthz/登录均 OK；运行态零改动 |
| 双端截图 | headless playwright（`chromium.launch`）× 390×844 手机 + 1440×900 桌面 full-page，点铃铛开面板 | VERIFY_EXIT=0；两图 `file` 实测见下 |

**截图实测**（`file` + `identify`）：

- `.agents/verify/screenshots/alerts-layout-fixed-mobile-1124.png` — PNG **390×844**, 99944B
- `.agents/verify/screenshots/alerts-layout-fixed-desktop-1124.png` — PNG **1440×900**, 182440B

**DOM 量测**（playwright `page.evaluate`，真实渲染后）：

| 指标 | 手机 390×844 | 桌面 1440×900 | 判据 |
| --- | --- | --- | --- |
| 标题高度 / 行高 | 24 / 24（单行横排） | 24 / 24 | 不再竖排 ✅ |
| 按钮数 / 高度 | 3 / [44,44,44] | 3 / [32,32,32] | 手机 ≥44px，桌面不回归 ✅ |
| 按钮文字 | 全部标为已读 / 重新检查 / 关闭 | 同 | 完整不挤压 ✅ |
| 面板宽 / 左边 | 390 / 0（贴边） | 400 / 1040（右贴） | 不溢出 ✅ |
| 文档滚动宽 / 视口宽 | 390 / 390 | 1440 / 1440 | 无横向滚动 ✅ |
| 计数文本 | 共 16 条 · 未读 7 | 共 16 条 · 未读 7 | 层级清晰 ✅ |

读图目视复核：手机图标题横排、计数同行、三按钮平分整行、特意写长的告警正文（"用于验证手机窄屏下告警卡片正文能够正确换行、不溢出视口"）正确换行到末字；桌面图按钮回到标题右侧单行。**量测绿 + 目视绿双证据**。

## 4. 数据真实性标注

隔离实例为全新初始化，历史 `alerts` bucket 为空，**无法自然产生用户截图里的 16 条告警**。为精确复现用户场景，playwright 用 `page.route` 注入符合 `GET /api/v1/alerts` 真实响应形状的 mock（16 条 / unread=7，含一条超长 detail 测卡片换行）；其余四源走真实隔离实例 API。DOM/CSS/布局均为真实渲染，非设计稿/拼接图。**标题横排与按钮不挤的结论在空态下同样成立**（头部 DOM/CSS 与告警条数无关）。

## 5. G-28 产品定位自评（三问）

1. **本页解决什么用户问题**：告警中心把后端历史告警与四类本地检查（操作审计 / 插件状态 / 资源采样 / 槽位统计）聚合到一处，让运维人员在最短路径看到"哪里异常 + 去哪处理"；本次修复解决手机窄屏下标题竖排、按钮挤压、文字断行导致看不清、点不准的问题。
2. **与宝塔 / 1Panel 同类功能的差距**：宝塔/1Panel 的告警多绑定各自面板生态、以邮件/Webhook 通知为主；Kore 告警中心是主壳内聚合视图，优势是零外部依赖、与审计/插件/资源同源可回溯。差距：告警规则尚不可在 UI 自定义阈值（阈值为代码内常量），通知渠道仅站内铃铛、无邮件/IM 推送——属后续迭代项，本次不扩张范围。
3. **当前是"可用"还是"占位"**：**可用**。历史可回溯、未读标记、一键全部已读、重新检查、跳转处理均真跑通；本次修复后手机端标题/按钮/文字布局达标。未做的自定义阈值与外部通知属能力边界，不影响"当前可用"判定。

## 6. 收尾

临时口令、mock JSON、截图脚本、隔离目录 `/tmp/r24-alert-isolated` 均随脚本 trap 删除；端口 18898 已释放；未碰用户共享桌面/Edge 窗口；未改运行态资产（G-29）。提交不 push。
