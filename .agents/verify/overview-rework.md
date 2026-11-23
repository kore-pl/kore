# R8 · 概览重排（P0-3）+ 退出下沉（P0-1）真机验收

> 日期: 2026-11-23 · 执行者: r8-overview-rework（implementer）· 待 verifier 独立复跑
> 隔离实例: `/tmp/kore-r8`（`--config /tmp/kore-r8/config.yaml`，`server.addr=127.0.0.1:18844`，state/run/log 全落 `/tmp`）。
> **本轮未改动主实例（8787）的运行态配置**：未改 `.kore-local.yaml` / `.kore-local-state/` / `bin/kored`；
> 对 8787 只做过只读 GET/POST invoke 探测（monitor.system / site.list / ssl.list / discover / audit），无写操作。
> 验证浏览器: chromium-1248 headless（手写 CDP，无 Playwright）；口令经环境注入，不入档。

## 1. 改动与门禁

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 改动文件 | `web/app.js`（概览重排 + 顶栏退出→设置入口 + 退出函数删除）、`web/settings.js`（账户与安全合并 + 退出二次确认弹层）、`docs/FRONTEND.md`（§3 顶栏 / §5 尺度表 / §8 视图清单） | — |
| 样式注入 | `ensureAppCss`（app.js，id=kore-app-css，含 `--kore-font-32`）与 settings TAB_CSS 扩展（settings.js）——均随视图注入，未进 `style.css` | ✓ |
| `node --check web/app.js web/settings.js` | exit 0 | ✓ |
| `make frontend` | 首屏 gzip 59,308 / 307,200 B；i18n 增量 2,787 / 3,072 B；exit 0 | ✓ |
| `make docs-check` | 5 pass / 1 warn / 0 fail；exit 0 | ✓ |
| `make check`（11 段） | 门禁全部通过；exit 0 | ✓ |

## 2. 概览首屏文字量：12 → 5 行说明文字（其余全部为数字/色点/进度条）

- 前：12 行同字号键值（系统信息 6 行 + 插件概览 6 行，审计 §2 判「文字堆砌、无焦点」）。
- 后（真机 DOM 计数）：可见说明文字 = 5 行 `.ov-caption`（4 张指标卡各 1 行口径 caption + 插件卡常驻槽位 1 行）
  + 告警摘要 1 行（本轮为 1 条黄条告警）+ 折叠「系统信息」1 行（收起）。
  判定口径：**键值说明行 12 → 5**；首屏 1 秒内先看到 4 个 32px 大数字（`getComputedStyle` 实测 32px），
  其次状态点（服务/插件卡 7 行 `[色点]+[数字]`），最后才是 caption 说明——符合「有重点和非重点区分」。

## 3. 真机断言（chromium CDP，实例 18844，全部通过，console error 0 / 异常 0）

- 桌面 1440×900：`.ov-card`=4、`.ov-num` font=32px、`.ov-bar`=4、`role=progressbar`=4、状态卡 2 块
  （服务 3 行 / 插件 4 行）、告警面板有结果、「系统信息」`<details>` 收起、chip=4；
  顶栏：`退出` 按钮 0 个，`#kore-topbar-settings` aria-label=「设置」，`.conn` 按钮=[搜索, 告警中心, 设置]。
- 手机 390×844：无横向溢出（scrollWidth≤innerWidth）、指标卡 4、顶栏无退出、设置图标触摸区 44px。
- 设置页：卡片顺序=语言 | **账户与安全** | 运行参数 | 关于；退出按钮 color=rgb(248,81,73)（danger 红字）；
  点击后弹层标题=「确定退出 Kore 控制台？」，按钮=[取消, 确定退出]；取消后弹层关闭且保持登录。
- 截图（PNG 实测宽高）：`ov-desktop-01-overview.png` 1440×900（full-page，sha256 前缀 53063117b2330da6）·
  `ov-mobile-01-overview.png` 390×1189（467158c87808c0d4）·
  `ov-logout-confirm-desktop-01.png` 1440×900（03fbfba212f22c99），均在 `.agents/verify/screenshots/`。

## 4. 操作位置分级表（C10）

| 操作 | 级别 | 位置 | 确认 | 本轮状态 |
| --- | --- | --- | --- | --- |
| 退出登录 | 三级 | 设置 → 账户与安全 | 二次确认弹层 | **本轮落地**：顶栏双入口已删，全站唯一入口在设置页 |
| 删除类（站点/文件/备份/库） | 三级 | 行内/列表 | 二次确认 | 维持现状（审计 §5 判合规） |
| 启停类（插件启用/停用、启停任务） | 二级 | 行内/页面主按钮 | 无需 | 维持现状 |
| 查看类（概览、监控、日志、设置入口） | 一级 | 顶栏/导航/首屏 | 无需 | 顶栏新增「设置」图标入口（高频、可逆、误触≈0） |

## 5. G-28 三问自评（产品定位）

1. **本页解决什么用户问题**：管理员打开控制台 1 秒内要知道「机器健康吗、服务在不在、插件跑没跑」——
   现在 4 个大数字 + 4 条进度条直接回答资源问题，两张状态卡用色点+计数回答业务问题，告警摘要把
   「要不要处理」放到底部，不再要求用户从 12 行同字号键值里自己找重点。
2. **与宝塔 / 1Panel 的差距**：宝塔首页同为大数字卡但含营销/推广位、点击即跳深度页；1Panel 首页以
   图表为主但缺少「插件/服务」业务态汇总。本页没有图表与营销元素，胜在口径诚实（插件缺席显示
   「未启用」而不是编 0；降级采样显式标注），差距是尚无趋势 sparkline（审计 P1-3，未在本轮范围）。
3. **当前是「可用」还是「占位」**：**可用**。指标来自真实 `monitor.system`（不可用时降级内核采样并标注）、
   服务卡来自真实 site/ssl/discover invoke、告警摘要四源聚合（阈值与 alerts.js 同一本账）、退出确认弹层
   真实可取消/可退出（取消路径已断言）；未做的是趋势图与指标卡下钻（后续 P1）。

## 6. 边界与移交

- `docs/FRONTEND.md` 的 §5 尺度表/层叠两行由并行 P0-7 路由在 `a8a4c91 feat(web): 设计基座` 中先行合入，
  本路由的 §3 顶栏与 §8 视图清单改动也被其整文件提交带入 HEAD；收尾一行（令牌来源改由 style.css 提供）
  随 redis 路由的 `203ec7f` 再次整文件带入。`--kore-font-32`（C1 Display）现由 style.css 令牌表统一提供，
  本路由的 `ensureAppCss` 不再重复定义，移除后已重建隔离实例并复跑全部断言通过。
  **移交 lead**：FRONTEND.md 由多个并行路由共享写域，safe-commit 的整文件口径会互相扫走对方的行——
  建议后续把 docs/FRONTEND.md 拆分归属或改用 hunk 级暂存，并在派发台账修正归属。
- 未顺手改：已装插件页重排、移动端铃铛角标裁剪（P0-2，已由 a8a4c91 落地）、P0-7 全站字号迁移。
- 验证临时产物均在 `/tmp/kore-r8/`（实例 + CDP 脚本），工作区无临时脚本残留。
