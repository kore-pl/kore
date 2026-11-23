> 元信息: 2026-11-23T10:44+08:00 · 执行者 r7-brand-kore · 产品显示名统一 Kore（代码标识保持 kore）· 报告 ≤60 行

# 品牌文案统一：产品显示名 `Kore`

## 1. 改动清单（10 文件 / 20 处文案 + 1 处新增标题）

| 位置 | 改动 |
| --- | --- |
| `web/index.html` | `<title>` → `Kore · 控制台`；首屏 boot 文案 → `Kore 控制台启动中…` |
| `web/shell.js` | 侧栏品牌名 → `Kore`；手机抽屉新增标题 `Kore / 更多导航`（原抽屉无标题） |
| `web/app.js` | 登录卡品牌 → `Kore`；无壳降级页顶栏品牌 → `Kore` |
| `web/settings.js` | 「关于」版本行 → `Kore 版本` |
| `web/firewall.js` | 非 root 提权指引 → `… Kore 不会给单个请求加 sudo …` |
| `web/style.css` | 抽屉标题样式；抽屉 `max-height` + 内部滚动（见 §3） |
| `internal/core/installer/installer.go` | 面向用户错误 → `Kore 版本为空，无法校验 requires_kore` |
| `internal/core/installer/requires.go` | 2 条面向用户错误 → `Kore 版本 …` |
| `README.md` | H1、一句话定位、对比表表头、产品叙述 6 处 → `Kore` |
| `QUICKSTART.md` | H1 → `# Kore 快速开始` |

后端只改 message 里的产品名；`requires_kore` 字段名、`kore.hello` 协议方法、`kore ready` 日志、`kored` 进程名、`Kore-CSRF` 头均未动。

## 2. 刻意没改（清单 + 原因）

- `kore_session` / `kore_csrf` / cookie 名、`/api/v1` 路径、`kore-local*`：协议/运行态契约，改了破坏登录与 CSRF。
- CSS 类 `kore-*`、CSS 变量 `--kore-*`、JS 全局 `KoreShell` 等、`data-kore-*`：代码标识。
- `kore.service`、`/run/kore`、`kore-<id>`、`kore.hello`、`kore.plugin.v1`、`bin/kored`、`kore-plugins/index`：systemd/协议/仓库约定。
- 插件仓库、`docs/DECISIONS/`、`docs/*.md` 内部技术文档：讲的是代码与决策，不是产品显示。
- `docs/site/index.html`（文档站标题 `kore 文档站`）：由 `docs/site/build-index.sh` 生成，需改生成器而非成品；本轮未纳入派发范围，留作后续。
- `cmd/kored/serve.go:53` `slog.Info("kore ready")`：启动日志，不是用户可见文案。

## 3. 附加的最小展示修复（非文案，必需）

手机抽屉原有 13 项，内容高于一屏、顶部被裁，新增标题不可见。给 `.kore-nav-drawer` 加 `max-height` + `overflow-y:auto`、标题 `position:sticky`；不改任何交互逻辑。

## 4. 双端截图（G-28，`.agents/verify/screenshots/`）

| 文件 | 实际尺寸 | 证明 |
| --- | --- | --- |
| `brand-desktop-01-overview.png` | 1440×900 | 侧栏顶栏品牌 `Kore 控制台` |
| `brand-desktop-00-login.png` | 1440×900 | 登录卡品牌 `Kore` |
| `brand-mobile-01-drawer.png` | 390×844 | 手机抽屉标题 `Kore 更多导航` |
| `brand-mobile-02-overview.png` | 390×844 | 手机概览（底部 tab + 品牌链路） |
| `brand-desktop-02-settings.png` | 1440×1099 full-page | 「关于」`Kore 版本 0.1.0` |
| `brand-desktop-03-firewall-hint.png` | 1440×1297 full-page | 非 root 降级提示含 `Kore 不会给单个请求加 sudo` |

标签页标题：服务端 `GET /` 返回 `<title>Kore · 控制台</title>`；登录前后 `document.title` 实测均为 `Kore · 控制台`（CDP 读取，非截图可覆盖区域）。

**产品定位自评**：本页解决「装完能立刻看清内核与插件状态、并安全进入各能力页」的问题；与宝塔/1Panel 相比差距在生态成熟度与向导深度，本页**可用**（非占位），品牌统一只影响呈现层。

## 5. 门禁与回归

| 项 | 命令 | 退出码 |
| --- | --- | --- |
| 聚合门禁 | `make check`（11 段） | 0 |
| 文档门禁 | `make docs-check` | 0（5 pass / 1 warn 不阻断） |
| 前端产物 | `make frontend` | 0（首屏 46553 B ≤ 307200 B） |
| 受影响包测试 | `go test ./internal/core/installer/... ./internal/core/registry/...` | 0 |

回归：`POST /api/v1/auth/login` 200 并下发 `kore_session`(HttpOnly)+`kore_csrf`；带 cookie `GET system/info` / `plugins` / `store/plugins` / `auth/session` 均 200；页面截图由真实登录会话渲染。
运行态（G-29）：仅用同一 `.kore-local.yaml` 重启 kored（改文案需重编 embed 二进制）；未改主配置/state；`system/info` 的 `paths.index_dir` = `kore-plugins/index`。派发时 PID 2645407 已不在，10:38 实测 2711085、10:41 起 2761245（并行任务期间实例被重启过）。
