# C13 PHP 扩展管理 · UI 自评（G-28）

> 2026-11-26 · 执行者 `c13-php-ext`（task-142）· 隔离实例 `127.0.0.1:18945`（独立 config/state/run/log/bin，非 8787，未碰 `.kore-local-*`）· playwright 1.49.1 + 缓存 chromium headless shell（真实浏览器，登录走 UI + CSRF，插件经 CLI `install --package` 离线安装 v0.4.0 + enable）· 收工已停实例并删临时目录/脚本。

## 0. 交付概览

PHP tab 内新增「扩展管理」分区（不是新的一级控件 / hub / tab）：输入扩展包名 → 点「安装扩展」→ 列表显示已装隔离扩展 → 点「移除」。后端 `ext.install/list/remove` 把扩展装进 `<state>/global/php_ext`（`pecl install -d extension_dir=<state>/global/php_ext` 固定隔离前缀），绝不 `apt install php-*`、不写宿主 php 扩展目录。前端与 Node 共用一套面板实现（仅文案/示例按运行时切换），零新增 CSS、零新增常驻一级控件。

## 1. 截图证据（G-28 双端）

| 文件 | identify -format | 观察 |
| --- | --- | --- |
| `ui-c13-php-ext-desktop-viewport.png` | 1440x900 | PC 视口：网站 → 运行环境 → PHP tab 高亮；版本列表 / 进程守护 / **扩展管理**（标题、副标题「装到插件隔离目录，不碰宿主 php / apt 全局扩展」、`redis memcached-3.1.5` 输入框占位、「安装扩展」按钮、空态「还没有隔离扩展」）/ 健康检查依次可见。 |
| `ui-c13-php-ext-desktop.png` | 1440x1344 | PC 全页：同上，底部的 4 项健康检查（宿主未装 PHP 为既有提示，与本功能无关）完整可见。 |
| `ui-c13-php-ext-mobile-viewport.png` | 390x844 | 手机精确视口：顶栏图标 + 网站/运行环境/应用部署 tab 条，PHP tab 高亮，前两个面板可见。 |
| `ui-c13-php-ext-mobile.png` | 390x1684 | 手机全页：**扩展管理**面板单列呈现，输入框与按钮触屏尺寸，空态文案可读，底部 tab 条不遮挡，无横向溢出。 |

四张图 sha256 各不相同（桌面视口 `b6f5005b…` / 手机视口 `…` / 两张 full-page 亦不同），非同图缩放冒充。浏览器页面错误数 0；截图脚本 stdout 见 `iso-c13-php-ui/shot.log`（随临时目录删除，结论留此文）。

## 2. 自评三问

**问 1：本页解决什么用户问题？**
此前 PHP 运行时只能"看版本 / 扫项目"，装扩展得让用户自己敲 `pecl install` 或 `apt install php-*`——前者写宿主全局 php 目录、不可回滚，后者更是 G-31 零侵入红线禁止的宿主变更。现在在同一个「运行环境」页的 PHP tab 里直接填包名即可安装到插件隔离目录：看得见（列表）、装得上（隔离前缀）、卸得掉（行内「移除」），全程不碰宿主 php / apt。错误提示给「怎么办」（包名格式 / 超时 / 刷新），空状态给下一步按钮，符合易用性四原则。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 有 PHP 版本管理 + 扩展开关面板，但普遍依赖宿主全局 PHP（apt/源码编译到 /usr），升级/回滚影响整机。本实现有意走克制路线：扩展只进插件状态目录、无常驻 supervisor、不引入框架（尊重 G-05/G-19/G-31）。差距：①只做装/列/卸三件事，没有扩展启用/禁用开关与 php.ini 片段管理；②包名白名单刻意窄（不收 URL / 多版本复杂约束），对高级用户不如 pecl 原生灵活；③没有 PECL 镜像选择 UI（靠 pecl 配置）。这些属有意边界，后续补齐需单独裁决。

**问 3：当前是"可用"还是"占位"？**
**可用。** 判据：①UI 路径——隔离实例真实浏览器登录后，PHP tab 渲染出「扩展管理」面板，双端截图肉眼可见输入框 / 按钮 / 空态，页面错误 0；②API 路径——同一插件二进制经 UDS 真跑 `ext.list→ext.install→ext.list→ext.remove→apt 注入拒绝`，10 条断言全 PASS（包落在 `<state>/global/php_ext`、argv 无 apt/-g/--global、移除后清理、apt 注入被拒），宿主 php/apt 全局 before/after 快照 sha 一致（见 `c13-php-live-assertions.md`）；③门禁——`make frontend` 首屏 90924 B ≤ 300 KiB、`node --check` exit 0、`usability-check` 0 FAIL、php `make check` exit 0（含 production 四类 fault 注入）。

## 3. 诚实边界

- 隔离实例的扩展安装用假 pecl 执行面（宿主本就没有 php/pecl，联网真编译不可验）；真机 `pecl install` 的编译行为未验证，但 argv 固定为 `install -d extension_dir=<state>/global/php_ext <包名>`，与 PECL CLI 契约一致。
- 截图里的版本列表显示"未检测到 PHP"（隔离实例继承的宿主确实没有 php）——这是既有健康提示，不影响扩展管理面板本身的可用性展示；扩展列表为空态——真装包截图用假执行面时的 API 断言代替，未在浏览器里展示"已装包"状态（假执行面只在 harness 的 PATH 中生效，不在 kored 进程环境）。
- 本轮未改动主实例 8787 的 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`（隔离实例用独立二进制副本与独立 config/state/run；8787 未重启、未验证其页面）。
- 收尾：停 18945 隔离实例、删除 `.agents/verify/iso-c13-php-ui/`（含 config/state/run/log/kored.log/cookies.txt/shot.js/shot.log/pid），仅保留四张交付截图、本报告与断言证据。
