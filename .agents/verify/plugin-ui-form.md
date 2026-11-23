# 插件 UI 形态裁定：主壳懒加载视图 vs 独立 origin iframe 桥（2026-11-24）

> 结论先行：**真源是 ADR-0040 —— 插件 UI = 主壳懒加载视图。裁决40 的 iframe + postMessage 桥已被 ADR-0040 取代，v1.0 前不补；它不是"当前要求"，是未实现的未来方案。**
> 另发现一处口径错误：**`kore_csrf` 不是 HttpOnly**（代码 + 实测响应头双重证据），`AGENTS.md` §6 那句把它写成 HttpOnly 是错的。
> 取证锚点：`HEAD=409ca75`（引用行号均按该提交的 blob 解析）。**注意**：`web/app.js` 取证期间有他人未提交在途改动（工作区 mtime 00:20，+82 行），本报告不依赖工作区行号。
> 本轮未改任何代码、未实现 iframe 桥、未改动主实例运行态配置（仅对 8787 发起只读 GET）。

## 1. 现状五问

### 1.1 插件 UI 今天实际怎么渲染？

**主壳 realm 内的懒加载视图模块，没有任何插件 UI 经 iframe 加载。**

| 证据 | 位置（HEAD=409ca75） |
| --- | --- |
| 首屏只加载 4 个脚本：i18n-zh-CN、i18n、shell、app | `web/index.html:19-22` |
| 主壳路由表 8 项，其中 6 项用 `moduleView` 懒加载 | `web/app.js:1940-1949` |
| `moduleView` → `ensureModule` 动态注入 `/assets/<模块>.js` | `web/app.js:1389`、`web/app.js:1342` |
| 壳内置 16 项视图用 `lazyView`，首次切视图才注入 | `web/shell.js:356`、`web/shell.js:595-610` |
| 合计 22 个视图模块（app.js 6 + shell.js 16） | 见下方计数命令 |
| 前端产物全部编进 Go 二进制（插件前端永不进二进制） | `web/embed.go:63` 及 `//go:embed` 清单 |

计数命令与输出：

```
$ grep -o "moduleView('[^']*', '/assets/[a-z-]*\.js'" web/app.js | sed "s/.*assets\///;s/\.js'//" | sort | tr '\n' ' '
files monitor settings sites store tasks
$ grep -o "lazyView('[^']*', '/assets/[a-z-]*\.js'" web/shell.js | sed "s/.*assets\///;s/\.js'//" | sort | tr '\n' ' '
appdeploy backups container db discover dns firewall integrity logs process redis runtimes sshguard ssl terminal waf
$ # 去重合计
22
```

### 1.2 插件 `web/` 资源怎么被服务？

**没有被服务。** 内核静态路由只有一个前缀 `/assets/`，且只认单段文件名 + 后缀白名单；`/plugin-assets/` 路由不存在。

| 证据 | 位置 |
| --- | --- |
| 静态路由注册：`s.mux.HandleFunc("GET "+staticURLPrefix, s.handleAsset)` | `internal/core/httpapi/server.go:464-467` |
| `handleAsset` 只剥 `/assets/` 前缀并校验文件名/后缀 | `internal/core/httpapi/server.go:471-480` |
| `internal/` + `cmd/` 内 `plugin-assets` 路由代码：**零命中**（仅注释提到它不在白名单） | `grep -rn "plugin-assets" internal/ cmd/ --include='*.go'` → 只有 `middleware.go:103` 注释 |
| 实测：`GET /plugin-assets/echo@0.1.0/index.html` → **404** | `curl -o /dev/null -w "%{http_code}"` 输出 `404` |
| 24 个插件仓 dist 的 `web/` 命中为 0（打包规则只列 info.json + bin + SHA256SUMS） | `.agents/verify/plugin-ui-delivery.md`（2026-11-23 盘点，结论仍成立） |

### 1.3 有没有 iframe？

**有一个 iframe，但它是主壳 realm 的 srcdoc 模拟沙箱，不是插件资产文档；而且实际永远挂载 0 个。**

| 证据 | 位置 |
| --- | --- |
| 唯一的 `createElement('iframe')` | `web/app.js:1238` |
| 帧内容来自 `srcdocFor(...)` 内联 HTML，**不是** asset URL | `web/app.js:1243`、`web/app.js:1108-1170` 一带 |
| `frame.src` 指向 `/plugin-assets/` 的写法**只存在于注释** | `web/app.js:1036`（注释） |
| 建帧前置条件：`plugin.web` 且 `plugin.web.entry` 为字符串，否则 `continue`（fail-closed） | `web/app.js:1295` |
| 后端**会**回填 `status.Web`（取自 info.json 的 `web` 对象） | `cmd/kored/serve_daemon.go:133-137` |
| 但 24 个插件仓 + 已装 24 个插件的 `info.json` 中，`"web": {` 对象**零命中**（`"scenario_tags": ["web",...]` 是数组元素，不是 web 段） | 见下方命令 |
| `"web"` 段的类型定义存在但无人使用 | `internal/core/registry/manifest.go:41-49,142`；`internal/core/httpapi/types.go:10-17` |

命令与输出（证明没有插件声明 web 段）：

```
$ for f in ../kore-plugin-*/info.json; do grep -qE '"web"[[:space:]]*:[[:space:]]*\{' "$f" && echo "DECLARES web: $f"; done
（无输出）
$ for f in .kore-local-state/plugins/*/*/info.json; do case "$f" in *bak*) continue;; esac; grep -qE '"web"[[:space:]]*:[[:space:]]*\{' "$f" && echo "INSTALLED web: $f"; done
（无输出）
```

结论：已装插件页会渲染"暂无可展示的插件界面"提示（`web/app.js:1297` 一带的 `mounted === 0` 分支），**没有一个插件帧被挂上**。桥代码是"设计意图 + 演示骨架"，不是可用能力。

### 1.4 `kore_csrf` 的实际可见性：**不是 HttpOnly**

**代码证据（唯一写入点）**

| 证据 | 位置 |
| --- | --- |
| `writeCSRFCookie` 是 `kore_csrf` 唯一写入点，`HttpOnly: false` | `internal/core/httpapi/csrf_local.go:59-67`（`HttpOnly: false` 在 :64） |
| 登录路径复用它，注释写明"非 HttpOnly 是双提交的硬要求" | `internal/core/httpapi/handlers_auth.go:83-86` |
| 会话 cookie `kore_session` 才是 HttpOnly | `internal/core/auth/session.go:296`（`HttpOnly: true`） |
| 前端用 `document.cookie` 读它做 `X-Kore-CSRF` 双提交 | `web/app.js:1066` `readCookie('kore_csrf')` |
| 回归测试显式断言 `kore_csrf` **不得** HttpOnly | `internal/core/httpapi/csrf_login_test.go:74` `if csrf.HttpOnly { t.Fatal(...) }` |

**实测响应头**（主实例 8787，只读 GET，未改运行态配置）：

```
$ curl -s -D- -o /dev/null http://127.0.0.1:8787/api/v1/system/info | grep -i '^set-cookie'
Set-Cookie: kore_csrf=***; Path=/; SameSite=Strict
```

属性串中**没有 `HttpOnly`**——与代码一致。而 `kore_session` 走 `auth.SetCookie`，带 `HttpOnly`。

**因此 `AGENTS.md` §6 的「`kore_csrf` 为 HttpOnly」是错误口径**：它是裁决40 里"改成 HttpOnly"的**目标态**，从未落地；当前双提交方案要求前端可读，前端确实靠读 cookie 工作。把目标态写成现状，会让后续实现者按错误前提动 CSRF 层。

### 1.5 管理 API 对插件桥开放吗？

**桥代码里有客户端白名单/拒绝分支；但服务端"按目标操作做 capability 校验"仍是 TODO，桥从未跑在真实隔离边界上。**

| 证据 | 位置 |
| --- | --- |
| `PluginBridge` 存在，方法白名单 `METHOD_RE` + `ADMIN_RE` | `web/app.js:1042-1094` 一带 |
| 管理面形态一律拒绝：`/api/...`、`plugins` 段、`enable/disable/install/uninstall/upgrade/remove` | `web/app.js:1053-1054`（`ADMIN_RE`） |
| 协议保留方法 `kore.*` 不对桥开放 | `web/app.js:1085` 一带 |
| 桥把请求经**主壳 realm** 的 `fetch` 转发（在主壳里贴 CSRF 头 + cookie） | `web/app.js:1175-1210` 一带 `forward()` |
| `event.origin` 校验：srcdoc 为 `'null'`，真实 asset origin 未接 | `web/app.js:1215-1225` 一带 |
| 服务端目标操作 capability 校验仍是 TODO（`authorizeTargetAction` 挂点） | `internal/core/httpapi/middleware.go:190-192` 注释 + `handlers_plugins.go:114` 注释 |

**这两点要分清**：
- "管理 API 不对桥开放"在**客户端**有明确拒绝分支；
- 但桥的转发发生在主壳 realm（主壳自己贴 cookie/CSRF），**不是**裁决40 设计的"子帧读不到 cookie、只经 postMessage 调 invoke"的隔离形态。真实隔离边界从未建立，所以服务端 capability 校验（M4 待办）仍是权威兜底——这与裁决42 的分层判定一致。

## 2. 裁决40 与 ADR-0040 谁在生效

| 文档 | 状态 | 关键内容 |
| --- | --- | --- |
| `.agents/LOG/DECISIONS.md` 2026-11-22 那条（条目标题即"插件 UI 如何集成进主壳页面"，被后续文档称为**裁决40**） | **已被取代** | 选③：独立站点 origin iframe + postMessage 桥 + `kore_csrf` 改 HttpOnly |
| `docs/DECISIONS/0040-plugin-ui-distribution.md` | **accepted（2026-11-23 增补裁决）**，现行真源 | §2.2「插件 UI = 主壳视图，所有插件界面在 `kore/web/<id>.js` 实现」；§2.1「v1.0 前不补 iframe 分发链」；§2.4 iframe 设计保留为**未来方案**且必须标注未实现 |
| `docs/FRONTEND.md:105` | 已标注 | iframe + `/plugin-assets/` 是**未来方案，当前未实现** |
| `AGENTS.md` §6 第 6 条 | **未同步（漂移源）** | 仍写"插件 UI 走独立 origin iframe + postMessage 桥…`kore_csrf` 为 HttpOnly（裁决40）" |

**判定：ADR-0040 在生效，裁决40 的 iframe 桥要求已被它取代。** 依据不是 ADR 措辞，而是：ADR-0040 标题即「插件 UI = 主壳视图」，§2.2 是明确裁决，且 22 个视图模块的代码事实与之吻合；同时 iframe 链的三段（打包 / serve / 独立 origin）全部缺失（见 §1.2、§1.3）。两边不可能同时为真，缺链的那一边不是现行要求。

**附带纠正一处旧证据误读**：`.agents/verify/plugin-ui-delivery.md:52` 写「ADR-0040 明确插件 UI 走独立 origin iframe」，与 ADR-0040 §2.2 相反——那是把已取代的裁决40 当成了 ADR-0040 的结论。该文件为冻结证据，本卡不改，此处留痕。

## 3. 唯一真源与 `AGENTS.md` 改动

真源 = **ADR-0040**。`AGENTS.md` §6 第 6 条那一句改为：

> **插件 UI = 主壳懒加载视图（`web/<id>.js`，走主壳 realm 与主壳 API）；`kore_csrf` 为非 HttpOnly 的 CSRF cookie（双提交要求前端可读）；管理 API 不对插件桥开放——独立 origin iframe + postMessage 桥在 v1.0 前不补、未实现，属未来方案（ADR-0040 已取代裁决40）。**

改动要点：
1. 形态：iframe 桥 → 主壳懒加载视图（对应 ADR-0040 §2.2 与 22 个视图模块的代码事实）；
2. `kore_csrf`：HttpOnly → 非 HttpOnly（对应 `csrf_local.go:64` 与实测响应头）；
3. 保留"管理 API 不对插件桥开放"：桥的客户端白名单仍然有效，且服务端 capability 兜底是既有安全口径；
4. 明说 iframe 桥"不补、未实现、属未来方案"，避免再被当成现行要求去建链。

ADR-0040 追加注记：记「已取代裁决40 的 iframe 桥要求」+ 指向本报告。

## 4. 能力缺口（iframe 桥未实现，明确标注、不假装已实现）

| 缺什么 | 证据 | 影响谁 |
| --- | --- | --- |
| `/plugin-assets/<id>@<ver>/` 静态路由（含 Content-Type 白名单 / 版本化缓存头 / 不挂管理 API） | `grep -rn "plugin-assets" internal/ cmd/` 仅注释命中；实测 404 | 任何想自带 UI 的插件；`docs/FRONTEND.md` §4 描述的链路 |
| 插件 dist 打包 `web/`（24 仓 Makefile 只打 info.json + bin + SHA256SUMS） | `.agents/verify/plugin-ui-delivery.md` 盘点 | 24 个插件仓；`kore-plugin-backup/web/index.html` 仍是死代码 |
| 独立**站点** origin（非仅跨端口）托管 | 无任何 asset origin 配置/路由 | 裁决40 的隔离前提；当前 `assetOrigin` 硬编码 `'null'`（`web/app.js:1249` 一带） |
| 真实 asset 文档建帧（现为 srcdoc 模拟） | `web/app.js:1238-1243` 用 `srcdoc`，注释里的 `frame.src` 无实现 | 已装插件页的"插件 UI"区块（当前恒为空态） |
| 服务端按目标操作 capability 校验（`authorizeTargetAction` 仍是 TODO） | `internal/core/httpapi/middleware.go:190` 注释、`handlers_plugins.go:114` 注释 | 越权面兜底；裁决40/42 的 M4 待办 |
| `kore_csrf` 改 HttpOnly 的配套（客户端不再读 cookie，改由服务端会话绑定） | `csrf_local.go:64` 非 HttpOnly；`auth.Session` 无 csrf 字段（TODO 同处） | CSRF 层；若将来上 iframe 桥需先做这步 |

**结论：这是能力缺口，不是已实现能力。** 本卡只裁定口径，不实现桥（3–5 人日量级，ADR-0040 §1 已估算）。

## 5. 残余口径漂移（不在本卡写域，留给后续卡）

1. `docs/FRONTEND.md:74` 仍以裁决40 的 iframe 设计为"安全边界"描述现行方案；虽 :105 有"未实现"注记，但同一节内自相矛盾，建议下一张文档卡在 :74 加一句"以下为未来方案"。
2. `docs/SECURITY.md:118` 写服务端比对 `header == cookie == sessions.csrf`（三方），**代码只做 header==cookie 两方**（`middleware.go:158-172`），`auth.Session` 无 csrf 字段——这是第三处口径错误，本卡不越界修改。
3. `internal/core/httpapi/middleware.go:144` 的 TODO 仍写"把 kore_csrf 改为 HttpOnly"；作为 TODO 可保留，但需与 ADR-0040 的"未来方案"绑定，避免被当成当前缺陷。
4. `AGENTS.md` §6 同条后半句（裁决41）仍写"主壳与插件 iframe UI 均响应式适配"；这是未来态表述，本卡只改指向前半句，未动它。

## 6. 本轮执行与限制

- 只读取证：`grep`/`git grep`/`curl` GET/文件读取。
- 对主实例 8787 仅发起**只读 GET**（`/api/v1/system/info`、`/assets/app.js`、`/plugin-assets/...`），**未改动任何运行态配置或状态**（G-29）。
- 未运行 `make docs-check` 之前的任何代码改动；未实现 iframe 桥。
- 取证期间他人在途修改 `web/app.js`（工作区），本报告行号一律锚定提交 `409ca75`，不受其影响。
