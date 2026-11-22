元信息: 设置视图（账户 / 安全 / 运行参数 / 关于）真浏览器验证 | 2026-11-22 19:33–19:38 +08 | 执行: ui-settings 子 agent | 隔离实例 127.0.0.1:18797（新二进制 7848098 B）+ 8787 真实服务（旧二进制，见 §5 披露） | 结论: PASS（四块卡片 / 退出登录 / 缺失端点标注 / 关于页版本全绿；1 项集成缺口如实披露）

# 设置视图验证证据

## 1. 交付物与写域

| 项 | 事实 |
| --- | --- |
| 新增 | `web/settings.js` **249 行**（≤250），零框架、零 CDN、零外部资源，仅暴露 `window.KoreSettings = { render, endpoints }` |
| 追加 | `web/style.css` 第 719–862 行「设置视图」段（**仅追加，不改既有规则**）：分组卡片、只读字段、disabled 按钮说明、`<640px` 单列、`1024px+` 双列 |
| 生成 | `web/dist/*`（`make frontend`，3 件套；`web/dist` 被 .gitignore 忽略，不入库） |
| 未改 | `web/app.js`、`web/index.html`、`web/embed.go`、任何 Go 代码、任何 tests/evals |
| 端点 | 只用 `GET /api/v1/auth/session`、`GET /api/v1/system/info`、`POST /api/v1/auth/logout`（全部实测存在） |

## 2. 四块内容与数据来源（每条都能指到真端点或硬编码常量）

| 卡片 | 字段 | 来源 |
| --- | --- | --- |
| 账户 | 会话状态（会话有效/无效/未知）、认证主体 admin、过期时刻（RFC3339 → 本地时间 + 剩余时长）、数据端点 | `GET /api/v1/auth/session` → `{authenticated,expires_at}`（实测 200） |
| 账户 | 退出登录按钮 → `POST /api/v1/auth/logout` + `X-Kore-CSRF` | 实测 200，回登录页 |
| 安全 | CSRF 双提交机制说明 | SECURITY §4 + `middleware.go:withCSRF` |
| 安全 | `kore_csrf` cookie 存在性（只读展示） | `document.cookie`（非 HttpOnly；实测登录后存在） |
| 安全 | `kore_session` HttpOnly / SameSite=Strict 说明 | `auth/session.go:SetCookie` |
| 安全 | 会话有效期（`auth.session_ttl` 滑动，默认 12h） | DATA-MODEL §3 |
| 安全 | **修改口令：disabled + 标注缺失端点** | 实测 `POST /api/v1/auth/password` → **501 E_UNSUPPORTED** |
| 运行参数 | 资源预算 4 行（主壳 16/8、单插件 24/12、合计 48/24、常驻 ≤3） | AGENTS G-03 + ADR-0016（硬编码常量，注释注明来源） |
| 运行参数 | GOGC / GOMEMLIMIT / GOMAXPROCS / 数据目录 / socket = **「—」** | 端点不提供，不伪造（G-21 禁止用 `SetGCPercent(-1)` 读数，故不做客户端探测） |
| 运行参数 | 当前版本 / 常驻插件 / 重启计数 | `GET /api/v1/system/info` |
| 关于 | 版本 0.1.0、协议 kore.plugin.v1、MIT、GitHub 链接、21 插件 / 8 预设 | system/info + `pkg/pluginapi.Protocol` + LICENSE + ROADMAP §5 / SCENARIOS §2 |

## 3. 缺失端点清单（诚实口径，未伪造）

| 端点 | 实测结果 | UI 处理 |
| --- | --- | --- |
| `POST /api/v1/auth/password` | **501** `{"code":"E_UNSUPPORTED","message":"该端点尚未实现（M2 支持）"}`（命中 `/api/v1/auth/` 兜底） | 按钮 `disabled` + `aria-describedby` 指向说明；页面明写「需补 POST /api/v1/auth/password」，不做本地假改 |
| `GET /api/v1/self` | **404 E_NOTFOUND**（CORE §2.4 列了该路由，实现未落地） | 不用它；会话信息改由 `/auth/session` 提供 |
| 运行期 GOGC/GOMEMLIMIT/GOMAXPROCS | system/info 不返回 | 显示「—」+ 指路 `make mem` / 启动日志「资源锚点」 |
| 数据目录 / socket 路径 | system/info 不返回 | 显示「—」+ 说明来自配置文件，改动需重启 |

## 4. 真浏览器验证（chromium-1248 + 手写 CDP，无 Playwright 依赖）

隔离实例 `127.0.0.1:18797`，新二进制 `bin/kored` 7848098 B（2026-11-22 19:33 构建），state/run/log 全在 `/tmp/kore-settings-verify/iso`。服务端实际发出的 `style.css` sha256 = `55f0618f…b584`，与 `web/style.css` 源文件**逐字节一致**（证明新 CSS 已进 embed）。

| # | 动作 | 实测断言 | 截图 |
| --- | --- | --- | --- |
| ① | 打开 `/` | 登录表单存在（`#kore-password`） | — |
| ② | 口令 `kore2026` | `POST /auth/login` → **200**；cookie = `kore_session` + `kore_csrf` | — |
| ③ | 渲染设置视图 | 四块 `panel-title` = `['账户','安全','运行参数','关于']` | `settings-01-desktop-account-security.png`（95,050 B） |
| ④ | 退出按钮 | `[data-kore-action=logout]` 存在 | 同上 |
| ⑤ | 修改口令 | `disabled === true`；说明含 `POST /api/v1/auth/password` 且含 `501` | 同上 |
| ⑥ | 关于页 | 含 `0.1.0`、`kore.plugin.v1`、`MIT`；外链 `href=https://github.com/pengtang1024/kore`、`target=_blank`、`rel=noopener noreferrer` | `settings-02-desktop-fullpage.png` |
| ⑦ | 外部资源 | `document.querySelectorAll('img,iframe,link[rel=preconnect],script[src^=http]').length === 0` | 同上 |
| ⑧ | **实测退出登录** | 点击后 URL 回 `/`、登录表单重现（`#kore-password` true）、cookie `['kore_csrf','kore_session'] → ['kore_csrf']`（**kore_session 已清除**） | `settings-03-after-logout-login.png`（19,126 B） |
| ⑨ | 手机 390×844 | 无横向溢出（`scrollWidth≤390`）、退出按钮高 **44 px**、`.settings-root` 单列（`366px` 无空格分隔 = 1 列） | `settings-04-mobile-390.png`（149,535 B） |
| ⑩ | 桌面 1280 | `1024px+` 双列：账户/安全并排，运行参数与关于各占整行 | `settings-02-desktop-fullpage.png` |

预算表实测渲染值：`主壳空载 VmRSS ≤16 MiB / 8 MiB`、`单常驻插件 ≤24 MiB / 12 MiB`、`常驻合计 ≤48 MiB / 24 MiB`、`同时常驻插件数 ≤3 个 / 1–2 个`。

## 5. 集成缺口披露（必须上游处理，不在本任务写域内）

**`/settings.js` 当前没有静态路由。** `web/embed.go` 只 `//go:embed dist/{index.html,app.js,style.css}`，`httpapi/server.go:staticRoutes()` 只注册 3 条精确路由，实测：

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18797/settings.js
404
```

本任务写域明确写「不改 Go 代码」「不改 app.js/shell.js」，因此**浏览器验证按 `render(container)` 契约注入模块完成**（`(0,eval)(源码)` → `window.KoreSettings.render(host)`，host 为真实 `main.content`）。要让页面自然加载该模块，需上游做两件事之一：

1. `web/embed.go` 增加 `dist/settings.js` + `server.go` 注册 `GET /settings.js`（并让 `make frontend` 复制该文件）；
2. 或由壳把模块源码内联进 `app.js`。

同理，8787 现有进程（PID 1545063，19:25 启动）是**旧二进制**：它发出的 `style.css` sha256 = `b549041d…475a` ≠ 源 `55f0618f…b584`，`grep -c settings-root` = 0。本任务不杀共享进程，故 8787 上的设置样式需重启 kored（或重新 `make build` 后重启）才生效——这是部署事实，不是样式缺陷。

## 6. 门禁退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/settings.js` | **0** | 无输出（249 行） |
| `make frontend` | **0** | 首屏 gzip **18,329 B** / 307,200 B（余量 288,871）：index 287 + css 6,668 + js 11,374 |
| `make docs-check` | **0** | `docs-check: 6 pass, 0 warn, 0 fail` |
| `make check` | **0** | **10/10 段全绿**，末行 `[OK] 门禁全部通过` |
| CDP 全量断言 | **0** | `RESULT: PASS`（4 类 14 项断言） |

## 7. 清理

隔离实例 `127.0.0.1:18797`（PID 1677349）已 TERM 停；`/tmp/kore-settings-verify` 已整目录删除；未在仓库内留任何一次性脚本。共享的 8787 进程与 `.kore-local*` 未被触碰。
