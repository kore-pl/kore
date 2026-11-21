> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0
> ADR 状态: accepted · 日期: 2026-11-21 · 决策者: architect · 关联: [FRONTEND](../FRONTEND.md) · [ADR-0001](./0001-go-stdlib-net-http.md)

# ADR-0006: Vue3 构建产物 go:embed 单二进制，不引微前端框架/独立 Nginx

## 背景

主壳前端是 Vue 3 + Vite + TypeScript 的 SPA，插件前端是运行时安装的 ES module，需要在同一个页面里动态 `import()`。交付目标是"一个二进制就是全部"：单二进制 ≤ 25 MiB（含 embed 前端）、首屏 ≤ 300 KiB gzip、无额外进程与端口、版本天然一致。

## 决策

- `vite build` 产出 `web/dist`，经 `//go:embed all:dist` 编入二进制（声明放在 `web/embed.go`，因为 `go:embed` 不能引用父目录）。
- `net/http` 直接托管：`index.html` 走 `no-store`，hashed 资源走 `immutable`，`/api` 前缀永不回落到 SPA。
- 插件前端**不用微前端框架**：主壳在运行时 `import(/plugin-assets/<id>/<entry>?v=<version>&h=<hash>)`，把导出对象的 `routes`/`menus` 注入 Vue Router 与菜单注册表；URL 版本化替代清模块缓存（详见 [FRONTEND](../FRONTEND.md) 第 4 节）。
- 开发期 `KORE_WEB_DEV=1` 把非 `/api` 请求反代到 `127.0.0.1:5173`，生产不启用该分支。

## 备选方案对比

| 方案 | 优点 | 代价 | 为何不选 |
| --- | --- | --- | --- |
| `go:embed` 单二进制（选） | 单文件交付、零额外进程、前后端版本强一致、部署与回滚都是一次 `cp` | 前端改动要重编；二进制体积随前端增长；无法独立 CDN 缓存 | 选它：与"资源零侵占 / 完全归属使用者"一致 |
| qiankun / single-spa 微前端 | 插件应用隔离成熟、生态约定清晰 | 引入运行时框架（约 30–60 KiB gzip）+ 沙箱开销；插件需按框架约定打包 | 预算与"薄壳"冲突；原生 `import()` 已能满足路由注入 |
| 独立 Nginx 托管前端 | 静态资源与缓存策略成熟、可独立发布 | 多一个常驻进程与端口、多一份配置与运维、跨域/同源要额外处理 | 违反红线②（不引常驻中间件）且增加攻击面 |
| SSR（Nuxt 等） | 首屏更快、SEO 友好 | 需要 Node 运行时；运维工具无 SEO 需求 | 纯增复杂度与进程，收益为零 |
| 前端独立二进制 + 反向代理 | 前后端可分离发布 | 仍需代理进程或额外端口，且版本一致性靠约定 | 与"单二进制"目标矛盾 |

## 后果

**正面**：`make build` 产出单个 `kored`，`scp` 过去即可用；前端与后端 API 永远同版本，不会出现"新前端配旧后端"；插件资产与主壳同源，cookie 与 CSRF 天然生效，不需要跨域白名单。

**负面**：改一行 CSS 也要重编二进制（开发期靠 vite 反代规避，仅生产受影响）；embed 使二进制随前端线性增长，25 MiB 预算需要持续盯；无法把静态资源交给 CDN，多实例部署时每个实例都带一份前端。

**技术债**：构建顺序耦合——`Makefile` 必须先前端后后端，缺 `web/dist` 时 `go build` 因 embed 报错而失败，这既是门禁也是新人的第一个坑；插件前端与主壳共享同一 origin，插件样式泄漏会污染主壳（靠 `teardown` 移除 `<style>` 兜底，无法根治）。

## 验证方式

```bash
pnpm -C web build && go build -trimpath -ldflags="-s -w" -o /tmp/kored ./cmd/kored
ls -l /tmp/kored                                    # ≤ 26214400 字节（25 MiB）
curl -s http://127.0.0.1:8787/ | head -5            # 返回 index.html
curl -sI http://127.0.0.1:8787/assets/$(ls web/dist/assets | head -1) | grep -i cache-control   # immutable
# 首屏预算（gzip 后合计）
find web/dist/assets -name '*.js' -o -name '*.css' | xargs -r gzip -9 -c | wc -c   # ≤ 307200
# 无独立静态服务
ss -lntp | grep -E ':(80|443|8080)\b' || echo "无额外静态服务"
```

## 复审条件

出现以下任一信号即重开：前端产物 > 8 MiB（占二进制预算 1/3 以上）；需要独立发布前端或灰度；需要多实例共享静态资源与 CDN 缓存；插件样式隔离问题在真实使用中造成主壳功能异常（届时评估 Shadow DOM 或 iframe，而不是直接上微前端框架）。
