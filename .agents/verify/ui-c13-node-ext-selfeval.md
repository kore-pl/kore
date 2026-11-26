# C13 Node 扩展管理 · UI 自评（G-28）

> 2026-11-26 · 执行者 `c13-node-ext`（task-139）· 隔离实例 `127.0.0.1:18963`（独立 config/state/run/log/bin，非 8787）· 截图时安装 runtime-node 0.4.0（最终发布版 0.4.1，仅把两处服务端 `invalid()` 文案补齐引导词以满足 G-33 A3，UI 与截图逐字一致）· playwright 1.65.1 headless Chromium · 收工已停实例并删临时目录/脚本。

## 0. 交付概览

Node tab 内新增「扩展管理」分区（不是新的一级控件 / hub / tab）：输入包名 → 点「安装扩展」→ 列表显示已装隔离扩展 → 点「移除」。后端 `ext.install/list/remove` 把包装进 `<state>/global/node_modules`（npm `--prefix` 固定隔离前缀），绝不 `npm -g`、不改宿主全局 npm。UI 复用既有 `rt-venv-*` 样式与包校验助手，`tr()` 中文原地回退，未新增 CSS / i18n 首屏字节。

## 1. 截图证据（G-28 双端）

| 文件 | identify -format | 观察 |
| --- | --- | --- |
| `ui-c13-node-ext-desktop-viewport.png` | 1440x900 | PC 视口：运行环境 → Node.js tab，版本列表 / 进程守护 / **扩展管理**（标题、副标题「装到插件隔离目录，不影响系统全局 npm」、包名输入框 placeholder `chalk commander==12.0.0`、「安装扩展」按钮、空态「还没有隔离扩展」）/ 项目扫描依次可见。 |
| `ui-c13-node-ext-desktop.png` | 1440x1326 | PC 全页：同上，底部健康检查完整。 |
| `ui-c13-node-ext-mobile-viewport.png` | 390x844 | 手机精确视口：顶栏图标 + 底部 tab 条，Node.js tab 高亮，前两个面板可见。 |
| `ui-c13-node-ext-mobile.png` | 390x1891 | 手机全页：**扩展管理**面板单列呈现，输入框与按钮触屏尺寸，空态文案可读，无横向溢出。 |

四张图 sha256 各不相同（桌面视口 `fb8e1d37…` / 手机视口 `af0e4585…` / 两张 full-page 亦不同），非同图缩放冒充。浏览器登录走真实 UI + CSRF，插件经本地 tar.gz（`store/install package_path`，离线）安装并 enable，页面错误数 0。

## 2. 自评三问

**问 1：本页解决什么用户问题？**
此前 Node 运行时只能"看版本 / 扫项目"，装扩展得让用户自己敲 `npm install -g`——既改宿主全局环境、又不可回滚、还要求用户懂命令行。现在在同一个「运行环境」页的 Node tab 里直接填包名即可安装到插件隔离目录：看得见（列表）、装得上（隔离前缀）、卸得掉（行内「移除」），全程不碰系统 npm。错误提示给「怎么办」（包名格式 / 超时 / 刷新），空状态给下一步按钮，符合易用性四原则。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔 / 1Panel 有"Python 项目管理器 / Node 版本管理"面板，可一键切换版本、装依赖，但普遍依赖宿主全局环境或常驻进程（如 pm2 守护）。本实现有意走更克制路线：扩展只进插件状态目录、无常驻 supervisor（沿用 G-05/G-19）、不引入框架。差距：①没有依赖树可视化 / 版本冲突提示（本次只做装/列/卸三件事）；②包名白名单刻意窄（不收 `@scope` / `git+` URL），对高级用户不如 npm 原生灵活；③没有 npm registry 镜像选择 UI（靠 npm 配置）。这些属有意边界，后续如要补需单独裁决。

**问 3：当前是"可用"还是"占位"？**
**可用。** 判据：①UI 路径——隔离实例真实浏览器登录后，Node tab 渲染出「扩展管理」面板，双端截图肉眼可见输入框 / 按钮 / 空态；②API 路径——同一隔离实例上用真实插件二进制 + 假 npm 执行面真跑 `ext.list→ext.install→ext.remove`，10 条断言全 PASS（包落在 `<state>/global/node_modules`、argv 无 `-g/--global`、移除后清理、-g 注入被拒），宿主全局 npm 目录零引用；③门禁——`make frontend` 首屏 90924 B ≤ 300 KiB、`node --check` exit 0、`usability-check` 0 FAIL、页面错误 0。

## 3. 诚实边界

- 隔离实例的 ext 安装用假 npm 执行面（真实 npm 联网被任务卡禁止）；真机联网 `npm install` 行为未验证，但 argv 固定为 `install --prefix <state>/global --no-audit --no-fund --ignore-scripts <包名>`，与 npm CLI 契约一致。
- 截图里的版本列表显示宿主已装 Node 24.21.0（隔离实例继承宿主 PATH）；扩展列表为空态——真装包截图用假 npm 时的 API 断言代替，未在浏览器里展示"已装包"状态（假执行面只在 verify harness 的 PATH 中生效，不在 kored 进程环境）。
- 本轮未改动主实例 8787 的 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored`（启动时 make build 覆盖 bin/kored 是本地二进制、与 8787 运行中的进程解耦；8787 未重启、未验证其页面）。
- 收尾：停 18963 进程、删除 `.agents/verify/iso-c13/`（含 config/state/run/log/bin/gocache/go.mod/verify.go/shot.js/cred.txt/npm-argv.log/fakebin）；仅保留四张交付截图与本文件。
