> 元信息: 2026-11-23T11:12+08:00 · 执行者 r7-i18n 子 agent · i18n 骨架（中文为主 / 英文为辅）· 报告 ≤100 行
> 依据: [ADR-0021](../../docs/DECISIONS/0021-i18n.md) · 改动 commit 见文末

# i18n 骨架验收（导航 + 通用文案 + 设置页）

## 0. 口径
- 真服务：`./bin/kored serve --config .kore-local.yaml`（127.0.0.1:8787，PID 2825708 → 2983992）。
- 浏览器：`~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（headless=new + 手写 CDP，零新依赖）。
- 截图：`.agents/verify/screenshots/`，命名 `<场景>-desktop|mobile-*.png`。

## 1. 现状调研（改动前）
| 项 | 数据 | 结论 |
| --- | --- | --- |
| `web/*.js` 中文文案 | 26 模块 / **1425 字符**（行数 1096）；最多 `app.js` 231、`db.js` 151、`store.js` 145 | 全部硬编码字面量，**无任何集中文案表**（`grep -rniE "i18n\|locale\|Accept-Language"` 零命中） |
| 导航标签 | 8 项在 `app.js` 的 `SHELL_ROUTES`、10 项在 `shell.js` 内置路由，`NAV_GROUPS` 分组标题另一份 | 同一类文案三处分散 |
| 后端消息 | `internal/core` 非测试 Go 文件 **1234 行**含中文，分布在 **91 个文件** | 中文为主，无 `Accept-Language` 协商 |
| 插件 `info.json` | 桌面插件仓 21 份 `description` 全中文 | 属插件仓，不在本仓迁移范围 |

## 2. ADR-0021（三方案 → 推荐 A 的零依赖变体）
- A 前后端字符串表（`zh-CN` 默认）→ **采纳**；B 只做中文 → 不采纳（"辅"也是需求，且硬编码分散问题仍在）；C 第三方框架 → 不采纳（Violates 零三方依赖 + 300 KiB 首屏，需求只有 2 语言 / 52 键 / 回退）。
- 关键决策：默认 `zh-CN` 且**不猜浏览器语言**；语言只由设置页显式选择并写 `localStorage`；缺项**回退中文**、不显示键名；后端 `Accept-Language` 延到 M5（本轮内核零改动）；运行期文件名拍平（内核只托管单段文件名，不为子目录放宽遍历面）。
- G-11 的「多语言（i18n）」非目标同步收窄为「**全量框架**」，AGENTS / VISION / USABILITY / OPEN-SOURCE / FRONTEND / V1-GOALS / ROADMAP / FEATURE-PARITY / GLOSSARY / PARITY-GAP / PLUGIN-MATURITY 同轮对齐。

## 3. 实现
| 文件 | 内容 | 行数 |
| --- | --- | --- |
| `web/i18n.js` | `t(key, params)` / `setLocale()` / `onChange()` / `locale()`；默认 `zh-CN`、`localStorage['kore_locale']`、`en-US` 懒加载、`html lang` 同步 | 91 |
| `web/i18n/zh-CN.js` | 主表 **52 键**（导航 18 / 骨架 11 / 通用 16 / 设置 7） | 59 |
| `web/i18n/en-US.js` | 英文 52 键（缺项回退中文） | 59 |
| `web/shell.js` | 导航标签、4 分组标题、「更多」抽屉、品牌副标题、无障碍 aria、搜索入口、加载/失败态改走 `t()`；`onChange` 原地重写文字（不重建导航、不丢视图） | +134/−34 |
| `web/settings.js` | 「语言」卡片：`中文（简体）` / `English` 下拉，切换即重绘、失败不假装成功 | +54 |
| 构建/门禁 | `Makefile` 31 产物（拍平 `i18n-zh-CN.js` / `i18n-en-US.js`）、`web/embed.go` 31 路径、`index.html` 语言包先于壳、`frontend-check.sh` 首屏六件套 + **i18n ≤3 KiB 独立硬预算** | — |

## 4. 门禁（命令 + 退出码）
| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check` ×5（i18n.js / zh / en / shell / settings） | 0 | 无输出 |
| `make frontend` | 0 | 首屏 **51231 B** ≤ 307200（余 255969）；`i18n.js 1594 + i18n-zh-CN.js 1193 = 2787 B` ≤ 3072（余 285） |
| `make docs-check` | 0 | 5 pass / 1 warn（既有 GITEE-MIRROR 等 3 份行数 WARN）/ 0 fail |
| `make check` | 0 | 11 段全绿（含 docs / secret / 依赖 / 薄壳 / 仓库边界 / case-check / frontend） |
| `getent`/`curl` 静态产物 | 200 | `/assets/i18n-zh-CN.js`、`/assets/i18n-en-US.js` 均 200；`index.html` 命中 3 处 i18n 引用 |

## 5. 双端截图（PNG 实际宽高）
| 文件 | 尺寸 | 证据 |
| --- | --- | --- |
| `i18n-zh-desktop-nav.png` | 1440×900 | 默认零记忆 = 中文：概览/监控/…/设置 + 运维/业务/资源/平台 |
| `i18n-en-desktop-nav.png` | 1440×900 | 同机切 English：Overview/Monitoring/…/Settings + Operations/Services/Resources/Platform，`html lang=en-US` |
| `i18n-zh-mobile-nav.png` | 390×845 | 底部 tab 中文：概览/监控/日志/进程/终端/更多 |
| `i18n-en-mobile-nav.png` | 390×845 | 底部 tab 英文：Overview/Monitoring/Logs/Processes/Terminal/More |
| `i18n-zh-desktop-settings.png` | 1440×1326 | 「语言」卡片：界面语言=中文（简体）、meta 中文为主·英文可选 |
| `i18n-en-desktop-settings.png` | 1440×1326 | 同卡片英文：Language / Interface language / English |
| `i18n-en-desktop-fallback.png` | 1440×1400 | 见 §6，侧栏英文中「设置」为中文回退 |
| `i18n-zh-mobile-settings.png` / `i18n-en-mobile-settings.png` | 390×1918 / 390×1937 | 手机端语言卡片两态 |

## 6. 回退验证（删 en 的 key → 中文，不是键名）
1. 运行时在 `en-US` 下 `delete window.KORE_I18N_EN_US['nav.settings']` → `KoreI18n.t('nav.settings')` 返回 **"设置"**。
2. 触发一次语言通知后侧栏标签：`["Overview",…,"Firewall","设置","More"]` —— 仅该键回退中文，其余仍英文；截图 `i18n-en-desktop-fallback.png`（1440 高以露出第 18 项）。
3. 独立 node 断言（vm 加载三文件，跑完即删临时脚本）：默认中文 / `{name}` 插值 / `setLocale('en-US')` / 删键回退中文 / 非键名 / 两表都缺才返回 key / 切回中文写入 `localStorage` —— **8/8 PASS**。

## 7. G-29 / G-30 声明
- **本轮改动过运行态**：`make build` 替换 `bin/kored` 并重启 8787（PID 2825708 → 2983992），**未改** `.kore-local.yaml`（md5 `59315dd0…` 前后一致）、state / run 目录与索引指向；`system/info` 未登录仍 401（鉴权未被静态白名单削弱）。
- 本报告与截图无明文口令（登录口令只用于本机浏览器会话，写为 `***`）。

## 8. 产品定位自评（G-28 三问）
- **解决什么**：非中文用户能看懂"这一栏是干什么的"，且中文用户零成本——默认即中文，不需要任何设置。
- **与宝塔 / 1Panel 差距**：宝塔只有中文；1Panel 支持多语言但走完整 i18n 框架。我们选了更窄的路：**只有导航 + 通用 + 设置可切**，页面内部仍是中文（本 ADR 明确承认的阶段性混合态），差距在"页面级覆盖度"，不在"是否有 i18n"。
- **当前状态**：导航与设置页**可用**；页面内部文案为**占位/未迁移**，按页后续替换。

## 9. 复盘
- 弯路 1：首屏预算写死在脚本里，第一版 i18n 增量 3527 B 超 455 B；靠删冗余注释与 4 个低频键收敛到 2787 B，而不是放宽预算。
- 弯路 2：`web/i18n/<locale>.js` 无法被内核静态路由托管（只认单段文件名）；选择**构建拍平**而不是放宽 `handleAsset` 的遍历面。
- 弯路 3：首张回退截图与英文导航逐字节相同——原因是「设置」在 900 高视口外；改 1400 高重拍才拿到可见证据（不是重跑同一命令）。
