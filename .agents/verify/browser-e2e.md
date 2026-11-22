> 元信息: 2026-11-22T14:56+08:00 · 执行者 browser-e2e 子 agent · 真实浏览器 CDP 点击测试 · 4 静态/服务页 + 插件桥专项（P1 修复复测全绿）· 报告 ≤100 行

# 浏览器 E2E 点击测试（真实 chromium + CDP）

## 0. 工具与口径
- 浏览器二进制：`~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（已缓存，未装新依赖）。
- 驱动：Python 3.14 标准库 `urllib` + 已装 `websockets 17.2`，手写最小 CDP 客户端（headless=new，`--no-sandbox`，`--remote-debugging-port`）。
- 真服务：隔离 `bin/kored serve`（`/tmp/kore-e2e-state`，`127.0.0.1:18787`，healthz 200）。kored 自身**无静态托管路由**（`GET /` → 404 E_NOTFOUND，`web/embed.go` 不存在，FRONTEND §9 未实现），故用回环代理 `127.0.0.1:18789` 提供 `web/` 静态三件套 + 反代 `/-/*` 与 `/api/*` 到真 kored；外链判定排除 18787/18789 本地地址。
- 证据 JSON：`/tmp/kore-e2e-final.json`（4 页）、`/tmp/kore-e2e-bridge6.json`（桥专项）；原始运行日志 `/tmp/kore-e2e-*.log`。截图目录：`.agents/verify/screenshots/`。

## 1. 四页面点击证据

| 页面 | URL | 加载 | 点击/输入动作 | DOM 变化断言 | console error | uncaught | 外链请求 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 主壳(静态降级) | `file://…/web/index.html` | 200(title=kore · 控制台) | 点击「重新检测」 | 降级提示「后端未连接」持续显示；请求重发 healthz/info/plugins | 0 | 0 | 0 | PASS |
| 市场页 | `file://…/kore-plugins/market/index.html` | 200(title=kore 插件市场 · 静态索引) | 搜索框输入 `site` | 21 卡 → 1 卡，ids=['site']，count 由「共 21 个插件」→「共 1 个插件」 | 0 | 0 | 0 | PASS |
| 文档站 | `file://…/kore/docs/site/index.html` | 200(title=kore 文档站) | 搜索框输入 `SDK` | total=39/items=39 → items=1「第三方插件 SDK 接入指南（30 分钟跑通 hello）」 | 0 | 0 | 0 | PASS |
| 主壳(真服务代理) | `http://127.0.0.1:18789/` | 200(title=kore · 控制台) | 点击「重新检测」 | healthz tag=「正常」详情 ok；system/info=401→「异常」；请求重发 | 0 | 0 | 0 | PASS* |

\* PASS*：system/info 与 plugins 返回 401 E_UNAUTHORIZED（未带会话），产品代码对 rejected 统一渲染降级提示——这是**当前产品行为**，非浏览器测试失败；healthz 真连通、点击链路生效。

- 主壳静态 file:// 的网络日志有 `net::ERR_FILE_NOT_FOUND`（file:///-/healthz 等）——预期降级信号，非 console error。
- 真服务网络日志有 `401`（system/info、plugins）与 `favicon.ico 404`——预期/无害，无外链。

### 截图（最终产物，保留）
- 主壳静态：`screenshots/main-shell-file-before.png`(33863B) / `main-shell-file-after.png`(33863B)
- 市场页：`screenshots/market-before.png`(57670B) / `market-after.png`(43623B)
- 文档站：`screenshots/docs-site-before.png`(42542B) / `docs-site-after.png`(26759B)
- 主壳真服务：`screenshots/main-shell-http-before.png`(33910B) / `main-shell-http-after.png`(33910B)

## 2. 插件桥专项（iframe-bridge-impl 新代码，478 行 app.js）
方法：mock `/api/v1/plugins` 注入 `{id:'echo',enabled:true,web:{entry:'index.js'},granted_capabilities:['echo:ping']}`；hook `setAttribute('srcdoc')` 在沙箱子帧注入自动探针，子帧 `postMessage` 回投主 realm 收集结果。

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 面板「插件 UI（独立沙箱）」渲染 | PASS | panel 列表含该标题，mock 下显示「Echo 插件 · echo」+「卸载 UI」 |
| fail-closed（真 401 无 web 段） | PASS | 真服务下面板显示「插件列表不可达，未挂载任何插件 UI。」，iframe 数=0，页面不白屏 |
| iframe sandbox | PASS | `sandbox="allow-scripts"`，`allow-same-origin` 不存在；srcdoc 2510B |
| 子帧 shim 暴露 | PASS | probe: shim=`object:function`，按钮 `kore-probe` 存在 |
| 负例拒绝 `plugins/enable` | PASS | ERR:方法 plugins/enable 不在桥白名单或未授予能力 |
| 负例拒绝 `/api/v1/plugins/echo/enable` | PASS | ERR:…不在桥白名单或未授予能力 |
| 负例拒绝 `echo:disable` | PASS | ERR:…不在桥白名单或未授予能力 |
| 负例拒绝 `kore.invoke` | PASS | ERR:…不在桥白名单或未授予能力 |
| 正例 `echo:ping`（标准冒号形态） | **PASS（14:56 复测）** | 点击按钮得 `OK {"ok":true,"method":"echo.ping","echoed":true}`；fetchLog 出现 `/api/v1/invoke/echo/echo.ping`（冒号转点分） |
| 对照正例 `echo.ping`（点分形态） | PASS | `OK:{"ok":true,"method":"echo.ping","echoed":true}`，fetchLog 出现 `/api/v1/invoke/echo/echo.ping` |

### 缺口声明
1. **P1 桥白名单拒绝标准 `:action` 形态 — 已修复并复测闭环（14:56）**：原 `METHOD_RE=/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/` 不含冒号，`echo:ping` 被拒；iframe-bridge-impl 于 14:52:46 改为 `/^[a-z][a-z0-9_-]*(?:(?:\.|:)[a-z][a-z0-9_-]*)*$/`。浏览器复测：8 项断言全 true（`positive_colon_echo_ping_OK` / `positive_dot_echo_ping_OK` / `colon_mapped_to_dot_in_fetch` / 4 负例全拒 / 面板 / sandbox / shim），console error 0。证据 `/tmp/kore-bridge-retest.json`，截图 `bridge-retest-colon-fix.png`。
2. **P2 kored 无静态托管**：`web/embed.go` 不存在，`GET /` 走 handleNotFound → 404；FRONTEND §9 的 `go:embed web/dist` + SPA 兜底未实现。浏览器只能经回环代理测真服务分支。
3. **派发时 vs 测试时的事实差**：用户派发时「grep 零命中」是旧快照；测试期间（14:48:12）并行 implementer 已把 iframe/postMessage/kore.invoke 实现写入 app.js（现 grep：iframe=3/postMessage=3/kore.invoke=4）。「裁决40 仅文档未实现」的旧结论已失效，最终以本节的实测为准。

### 桥专项截图
- `screenshots/bridge-mounted.png`(33875B)、`screenshots/bridge-after-click.png`(45823B)、`screenshots/bridge-auto-probe.png`(33875B)、`screenshots/bridge-retest-colon-fix.png`(33875B，P1 修复复测)

## 3. 复盘
- 目标：补真实浏览器点击证据。结果：4 页全绿 + 桥负例全绿 + 发现 1 个 P1 正例缺陷。
- 弯路：srcdoc 是 opaque origin，主 realm 无法读子帧 DOM、CDP 抓不到子帧 context；改用 setAttribute hook + 子帧 postMessage 回投绕过——这是浏览器安全边界，不是缺陷。
- 口径纪律：初版 live 断言写错（空 tags 误判 true），已改为 healthz tag=正常 + 点击生效；外链判定误把本地代理算外链，已排除 18787/18789。
