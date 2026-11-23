# 本机免密通道 CSRF 令牌断链修复（2026-11-23）

## 1. 根因链（file:line）

1. `internal/core/httpapi/middleware.go:46-53`：`withAuth` 对 UDS / loopback 免密放行，
   **不再经过登录**。
2. `internal/core/httpapi/handlers_auth.go:86`：`kore_csrf` 只在登录成功（`handleLogin`）
   时由 `setCSRFCookie` 下发——本机免密路径永远走不到这里。
3. `internal/core/httpapi/middleware.go:169-177`：`withCSRF` 对所有非幂等方法要求
   `cookie == X-Kore-CSRF` 且非空，否则 401。
4. `web/app.js:112-120`：`ensureCsrf()` 只做一次 GET `/api/v1/system/info` 再读 cookie；
   服务端从不在 GET 上下发，兜底恒为空。`web/discover.js:39`、`web/monitor.js:121`
   等视图直接读 `document.cookie`，同样为空。

结论：**令牌从未下发**（不是 HttpOnly 读不到，也不是时机问题）。浏览器 `document.cookie`
为空、手工空 token 同路径 401、discover 与 monitor 同时失败，三处现象同源。

## 2. 修复（通用层，未逐视图打补丁，未改 `web/**`）

- 新增 `internal/core/httpapi/csrf_local.go`：`withLocalCSRF` 外层中间件，在
  **幂等方法 + 本机通道（UDS / loopback） + 尚未携带 `kore_csrf`** 时补发令牌；
  令牌进程内稳定（互斥缓存），避免首屏并发 GET 各自 Set-Cookie 互相覆盖导致
  POST 头与 cookie 不同步。
- `internal/core/httpapi/server.go`：`Server` 增加 `localCSRFMu/localCSRFTokenValue`，
  在鉴权中间件链上挂 `withLocalCSRF`。
- `internal/core/httpapi/handlers_auth.go`：登录下发与本机补发共用
  `writeCSRFCookie` 单一写入点，属性（非 HttpOnly / Path=/ / SameSite=Strict / Secure）
  不再两处漂移。

CSRF 防护未被削弱：远程（非本机）请求不下发令牌；跨站页面读不到 cookie 值、
也不能给简单表单/跨源 fetch 加 `X-Kore-CSRF` 头，伪造 POST 仍 401。远程仍需登录换会话。

## 3. 验证

### 3.1 Go 单测（新增 `csrf_local_test.go`）

```text
go test -count=1 -timeout 200s ./internal/core/httpapi/
ok  github.com/pengtang1024/kore/internal/core/httpapi
```

覆盖：loopback/UDS GET 均下发 `kore_csrf`（属性断言）；无 token / 只带 cookie /
只带头 / 头与 cookie 不一致 / 带 `Origin: http://evil.example` 的伪造 POST 全部 401
且原因为 CSRF；正确双提交放行；远程 GET 不下发令牌、远程带双提交仍 401（会话缺失）。

### 3.2 真实浏览器（隔离实例 127.0.0.1:18877，独立 config/state/run/log）

Chromium + Playwright，1440×900 与 390×844 各跑一轮：

| 观测 | desktop | mobile |
| --- | --- | --- |
| `document.cookie` 含 `kore_csrf` | 是 | 是 |
| monitor 视图 | 「系统监控 · 数据来源：monitor 插件 · /proc」CPU 9.5% / 内存 47.3% / 负载 2.70，最后更新 22:23:09 | CPU 6.3% / 内存 47.5% / 负载 2.56 |
| discover 视图 | 「本机已就绪：检测到 Nginx 与 MySQL」已检测服务 11 个 / 共探测 22 项 / 在听端口 104 个；端口号 22/53/631/1053… | 同数值 |
| `/api/v1/invoke/*` 响应 | discover/monitor 全部 200 | 全部 200 |
| 「缺少 CSRF / 读取失败 / 插件请求失败」 | 无 | 无 |

截图：`csrf-local-monitor-{desktop,mobile}.png`、`csrf-local-discover-{desktop,mobile}.png`
（本目录 `screenshots/`）。

### 3.3 curl 对照（同隔离实例）

```text
GET  /api/v1/system/info                 → 200 + Set-Cookie: kore_csrf=...; SameSite=Strict
POST /api/v1/invoke/discover/...（无 token）→ 401 {"code":"E_UNAUTHORIZED","message":"CSRF 校验失败"}
POST 同路径（cookie+header）              → 200 {"ready":true,"web_server":"nginx","db":"mysql",...}
GET  --unix-socket .../system/info        → 200 + Set-Cookie: kore_csrf
POST --unix-socket .../invoke/...（无 token）→ 200（UDS 无浏览器 CSRF 面，按设计豁免）
```

### 3.4 门禁

```text
make frontend  首屏 62754 B / 307200 B；i18n 增量 2909 B / 3072 B  → OK（未改前端）
make build     [OK] ./bin/kored（bin/kored 被重建，主实例未重启）
go vet ./...   → 全绿
```

## 4. 产品自评（G-28 三问）

1. **解决什么用户问题**：本机免密后，面板所有数据视图不再因拿不到 CSRF 令牌而空屏/报错。
2. **与宝塔/1Panel 差距**：同机面板无需口令即可管理（文件系统权限即认证），
   仍在 loopback 保留双提交 CSRF；远程面板仍需登录，安全模型未放宽。
3. **可用还是占位**：discover / monitor 均显示真实采集数据，属可用。
