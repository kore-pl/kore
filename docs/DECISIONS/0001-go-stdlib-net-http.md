> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: architect · 关联: [FRONTEND](../FRONTEND.md)

# ADR-0001: Go + 标准库 net/http，不引 Web 框架

## 背景

主壳空载 RSS 预算 ≤ 8 MiB（目标 5–6，GOGC=200），主壳直接依赖上限 3 个，且依赖白名单明令禁止 Gin/Echo/chi。HTTP API 规模在 MVP 是 `/api/v1` 业务端点 **13 个**；加上 3 条静态前缀（`/`、`/assets/*`、`/plugin-assets/<id>/*`）与 `/-/healthz`（探针不带业务前缀），共 **17 项路由**。路由形态固定为 `/api/v1/<资源>[/{id}][/<动作>]`。

## 决策

主壳 HTTP 层只用 Go 标准库 `net/http`：路由用 Go 1.22 起的 `http.ServeMux`（支持 `GET /plugins/{id}` 式方法与路径参数），中间件按 `func(http.Handler) http.Handler` 手写并显式串联。链路顺序以 [CORE](../CORE.md) 为唯一真源，固定为 `req_id → recover → access_log → body_limit → auth → csrf → rate_limit → router`，禁止调换；CSRF 是独立层，只服务 `auth` 之后的写操作。JSON 编解码用 `encoding/json`。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| `net/http` + `ServeMux` | 零依赖、无反射、二进制最小、pprof 直连 | 中间件与参数校验手写（约 200 行） | 选它：预算与白名单都指向它 |
| Gin | 生态成熟、绑定与校验开箱即用 | 依赖树膨胀、反射开销、框架抽象穿透 | 契约明令禁止；且 8 MiB RSS 预算容不下额外依赖 |
| Echo | 中间件体系完整、文档友好 | 同上，且默认 logger/recover 行为需覆盖 | 同上 |
| chi | 轻量、`net/http` 兼容 | 仍是一个外部依赖，换来的只是路由树便利 | 功能收益被 Go 1.22 ServeMux 覆盖 |
| 自研极简 mux（正则表驱动） | 完全可控 | 要自己处理路径参数、方法匹配、404/405 语义 | 与标准库重复造轮子，且易在尾斜杠语义上出错 |

## 后果

**正面**：主壳 HTTP 依赖为零；`go build` 产物不受框架版本影响；中间件链显式可见，安全顺序（会话在 CSRF 前、限速在业务前）不会被框架默认顺序打乱；`net/http/pprof` 可直接挂到独立监听。

**负面**：请求体解码、参数校验、错误映射要逐端点手写；`ServeMux` 不支持路由级通配符（如 `/plugin-assets/<id>/*` 需要 `/*` 前缀 + 手动切分）；中间件顺序一旦写错，安全边界即失效。

**技术债**：若 M3 端点数量翻倍到 40+，路由表会变成一块长函数，需要拆成按资源分组的 `register*Routes(mux)`；尾斜杠与大小写规范化需自行统一，标准库不会代劳。

## 验证方式

```bash
go list -m all | grep -vE '^(kore|gopkg.in/yaml.v3|go.etcd.io/bbolt)$'   # 应无输出
ps -o rss= -p $(pgrep -f 'kored$')                                        # 60s 中位数 ≤ 8192 KiB
go vet ./... && go test -timeout 200s ./internal/core/httpapi/...          # 断言固定链顺序与 CSRF 在 auth 之后
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz    # 200
curl -s -X POST http://127.0.0.1:8787/api/v1/plugins                      # 无 CSRF 头应 401 而非 404/405
```

## 复审条件

出现以下任一信号即重开：端点数量 > 40 且路由注册代码无法按资源拆分；中间件链 > 10 层，或出现跨层依赖（后层需读前层私有状态）——当前 8 层在阈值内，不构成重开理由；`pprof` 证明 `ServeMux` 匹配占请求耗时 > 5%；Go 版本升级移除或改变 `ServeMux` 的方法/通配语义。
