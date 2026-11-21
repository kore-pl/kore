> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

# kore 前端架构（FRONTEND）

主壳前端是 kore 的操作面，不是 kore 的门面。本文件定义信息架构、布局与设计令牌、插件前端契约、性能与可访问性底线；安全边界见 [SECURITY.md](./SECURITY.md)，框架选型理由见 [ADR-0006](./DECISIONS/0006-vue-embed-single-binary.md)。

## 1. 设计立场

一句话立论：**在最短路径上完成操作，优先于任何观感收益。**

由此推出四条硬约束，违反即返工：

1. **一屏原则**：一个操作所需的输入与确认在同一屏完成；不允许"列表 → 详情 → 再点编辑"的两跳往返。
2. **视觉预算只花在两件事**：状态可读、危险可辨。颜色只用于语义、状态点、焦点环，不做装饰。
3. **键盘是一等公民**：可操作元素可 Tab 到达、可 Enter/Space 激活、弹层可 Esc 关闭。
4. **默认高密度**：默认暗色、表格 32px 行高、正文 13px。大留白属于官网，不属于控制台。

## 2. 信息架构

### 2.1 路由树

```text
/                              Root（无壳）
├── /login                     LoginView     会话缺失/过期时的唯一可达页
└── (Layout 壳：顶栏 48px + 侧栏 220/48px + 内容区)
    ├── /                      重定向 → /plugins
    ├── /plugins               PluginListView
    ├── /plugins/:id           PluginDetailView
    ├── /system                SystemView
    └── /settings              SettingsView
    └── /p/<pluginId>/*        插件自有路由（运行时注册，前缀不可越界）
```

路由守卫：无有效会话 → 只放行 `/login`；有会话访问 `/login` → 重定向 `/plugins`。插件路由统一挂在 `/p/<pluginId>/` 前缀下，前缀与 `pluginId` 不符的注册请求被拒绝（见 4.5）。

### 2.2 页面清单

| 页面 | 作用 | 核心操作 | 数据来源 API |
| --- | --- | --- | --- |
| `/login` | 首启或会话过期时输入口令 | 提交口令、显示错误码与限速剩余次数 | `POST /api/v1/auth/login` |
| `/plugins` | 插件总览与生命周期 | 上传安装、启用、禁用、升级、卸载、进入详情 | `GET /api/v1/plugins`、`POST /api/v1/plugins`、`POST /api/v1/plugins/{id}/enable`、`POST /api/v1/plugins/{id}/disable`、`POST /api/v1/plugins/{id}/upgrade`、`DELETE /api/v1/plugins/{id}` |
| `/plugins/:id` | 单插件详情与调用 | 看 info/resources/triggers、改插件配置、调业务方法、看日志尾部 | `GET /api/v1/plugins`、`POST /api/v1/invoke/{plugin}/{method}` |
| `/system` | 主壳与宿主态势 | 看版本/RSS/磁盘/插件进程、复制诊断包 | `GET /api/v1/system/info`、`GET /api/v1/events` |
| `/settings` | 主壳设置 | 会话信息、日志级别、导出配置、登出 | `GET /api/v1/self`、`GET /api/v1/system/info`、`POST /api/v1/auth/logout` |

`GET /-/healthz` 不进入前端路由，只给探针与 `curl` 用。

## 3. 布局规范

- **顶栏 48px 固定**：左为产品名与当前页标题，右为连接状态点（`GET /api/v1/events` SSE 心跳）、用户菜单（登出、设置入口）。
- **侧栏**：展开 220px、折叠 48px，折叠状态存 `localStorage['kore.sidebar']`；只放插件菜单与管理入口，不做多级嵌套（深度上限 2 级：分组 → 项）。
- **内容区**：自适应剩余宽度，最小 960px；低于 960px 时侧栏强制折叠，不出现横向滚动条（表格内部横向滚动）。
- **滚动策略**：顶栏与侧栏 `position: sticky` 各自独立滚动；内容区是唯一主滚动容器，禁止 `body` 滚动。表格头 sticky，冻结在内容区顶部下方 0px。
- **密度**：行高 32px、表头 36px、区块间距 16px；表单控件高 28px，紧凑模式 24px。

## 4. 插件前端契约

### 4.1 清单来源

插件前端不设第二份清单文件：**直接取插件包内 `info.json` 的 `web` 段**（`info.json` 是包内唯一清单，见地基契约）。不引入独立 `plugin.json` 的理由：两份清单必然漂移，且安装校验只需一处真源。

### 4.2 `web` 段字段

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `entry` | string | 是 | 相对包根、以 `.js` 结尾、不含 `..` | ES module 入口，产物须为单入口多 chunk |
| `styles` | string[] | 否 | ≤ 5 项、合计 ≤ 200 KiB | 按数组顺序注入 `<style>`，卸载时整组移除 |
| `menus` | object[] | 否 | ≤ 8 项、`path` 必须落在 `/p/<id>/` 下 | 侧栏入口，字段 `id`/`label`/`path`/`order`/`icon?` |
| `routes` | object[] | 否 | `path` 必须以 `/p/<id>/` 为前缀 | 仅用于启用时的前缀冲突预检；真实组件由模块导出提供 |

`web/` 产物结构：

```text
web/
├── index.js       entry，ES module（构建后文件名带 content hash 亦可）
├── index.css      styles 指向的文件，可选
└── chunks/*.js    entry 内部的相对 import，按 URL 解析，不需要清单声明
```

**来源与托管链路**：插件前端在 `kore-plugin-<id>` 仓库内用任意栈（Vite 或其它）构建 → 产物以 `web/` 进包 → 安装时落到 `/var/lib/kore/plugins/<id>/<version>/web/` → 由 kore 以 `/plugin-assets/<id>/*` 托管。**kore 的 `go:embed` 只含主壳前端，不含任何插件资产**：插件前端永不进主二进制，M2 不得以"省事"为由把插件前端打进 kore。

### 4.3 模块导出对象

```ts
export interface KorePluginModule {
  routes: Array<{ path: string; name: string; component: Component }>
  menus: Array<{ id: string; label: string; path: string; order: number; icon?: string }>
  setup?: (ctx: PluginCtx) => void | Promise<void>
  teardown?: () => void | Promise<void>
}

export interface PluginCtx {
  pluginId: string
  version: string
  apiBase: '/api/v1'
  invoke: (method: string, params?: unknown) => Promise<unknown>
  onEvent: (topic: string, fn: (payload: unknown) => void) => () => void
}
```

约束：`routes`/`menus` 必须与 `info.json.web` 声明一致（多出项被丢弃）；`setup` 抛错等同加载失败；`teardown` 抛错只记日志，不阻断卸载。

### 4.4 注册时序

```text
安装完成 ──► POST /api/v1/plugins/{id}/enable
                 │
                 ▼
      supervisor 拉起进程 → kore.hello 返回 methods → 标记 ready
                 │
                 ▼
      主壳 GET /plugin-assets/<id>/info.json 读 web 段
                 │
                 ▼
      injectStyles(styles, {v: version})
                 │
                 ▼
      await import(`/plugin-assets/<id>/${entry}?v=${version}&h=${hash}`)
                 │
                 ▼
      前缀校验 → setup(ctx) → router.addRoute() 逐条 → menuRegistry.add()
                 │
                 ▼
      侧栏出现菜单；失败则整个插件 UI 置为 degraded（4.6）
```

### 4.5 卸载与热替换

浏览器不提供模块缓存删除 API，因此**用 URL 版本化替代清缓存**：

1. 加载 URL 恒带 `?v=<version>&h=<assetsHash>`；升级后 version 或 hash 变化 → 新 URL 必然是新模块实例。
2. 卸载顺序固定：`teardown()` → `router.removeRoute(name)` 逐条 → 菜单注销 → 移除注入的 `<style>` 节点 → 清空注册表内对该模块的引用。不保留闭包，旧模块才能被 GC。
3. 禁止 `import.meta.glob` 静态收集插件前端：插件是运行时安装的，静态 glob 在构建期就固化了集合。
4. 热替换 = 卸载旧版本 + 按新 version 重新走 4.4；替换过程中该插件菜单置灰，不允许并发二次触发。
5. `component` 必须是异步组件或已内联在 entry 中，不允许引用主壳内部模块路径（跨包引用一律失败）。

### 4.6 失败隔离

`import`、前缀校验、`setup`、`addRoute` 全部包在 `try/catch` 内：

- 失败仅影响该插件：菜单隐藏、已注册路由移除、详情页展示错误摘要（错误类型 + 发生阶段 + 时间戳，栈截断 8 KiB）。
- 主壳不因此白屏；SSE 通道与其余插件保持可用。
- 连续 2 次启用失败写入审计事件 `plugin.ui_load_failed`，并在 `/plugins` 行内标红。

### 4.7 静态资源路径

插件前端资产由主壳托管在 `/plugin-assets/<id>/*`（鉴权后）；`Content-Type` 白名单仅 `js`/`css`/`svg`/`png`/`woff2`/`json`，其余返回 404。带 `?v=` 的请求 `Cache-Control: public, max-age=31536000, immutable`；不带版本参数的返回 `no-cache`。

## 5. 设计令牌

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--kore-bg-0` | `#0D1117` | 应用最底层 |
| `--kore-bg-1` | `#161B22` | 顶栏、侧栏、表格底 |
| `--kore-bg-2` | `#1C2128` | 悬浮、选中、输入框 |
| `--kore-text-1` | `#E6EDF3` | 主文本 |
| `--kore-text-2` | `#9DA7B3` | 次文本、表头 |
| `--kore-text-3` | `#7D8590` | 辅助说明、占位符 |
| `--kore-success` | `#3FB950` | 运行中、成功 |
| `--kore-warning` | `#D29922` | 降级、待处理 |
| `--kore-danger` | `#F85149` | 失败、危险操作 |
| `--kore-info` | `#58A6FF` | 链接、信息提示 |
| `--kore-border-1` | `#30363D` | 分隔线、表格线、控件边框 |
| `--kore-border-2` | `#21262D` | 弱分隔（区块之间） |

对比度（WCAG 2.1 相对亮度计算）：`text-1` on `bg-0` ≈ 15.2:1，`text-2` on `bg-1` ≈ 7.0:1，`text-3` on `bg-1` ≈ 4.6:1，四个语义色 on `bg-0` 均 ≥ 5:1。

尺度：

| 维度 | 取值 | 约束 |
| --- | --- | --- |
| 间距 | 4 / 8 / 12 / 16 / 24 px | 4px 基线；禁止 5、7、10、18 等非基线值 |
| 字号 | 12 / 13 / 14 / 16 / 20 px | 12 仅限标签与时间戳；正文 13；标题 16/20 |
| 行高 | 正文 1.5；标题 1.2；表格行 32px | 表格单元格内文本单行截断 + `title` 提示 |
| 圆角 | 控件 4px；容器 6px；表格与分隔区 0 | 不允许 > 6px，禁止胶囊按钮 |
| 阴影 | 至多 1 级：`0 4px 12px rgba(0,0,0,.4)` | 仅用于浮层，静态区块不用阴影 |

## 6. 反样板红线

1. 禁止大卡片堆叠：同屏内容区最多 2 个容器级区块，其余用表格与分隔线。
2. 禁止渐变按钮、渐变文字、玻璃拟态。
3. 禁止入场动画 > 150ms；禁止错峰 stagger 超过 3 级；`prefers-reduced-motion` 下动画归零。
4. 禁止径向装饰、光晕、背景网格、装饰性插画。
5. 禁止全屏 loading 遮罩：用按钮内联 loading 或行内骨架，超 300ms 才出骨架。
6. 表格必须键盘可达：Tab 进入、方向键移行、Enter 打开详情、`/` 聚焦搜索框。
7. 禁止自动轮播、公告浮层、引导气泡；帮助走文档链接。
8. 禁止自造图标：只用 `unplugin-icons` 的线性图标，尺寸 16/20px，禁用 emoji 作功能图标。
9. 禁止把状态只靠颜色表达：状态点 + 文本，二者必须同时出现。
10. 禁止用 `...` 菜单藏关键操作：主操作平铺在行内，危险操作可收起但需二次确认。
11. 禁止硬编码色值与间距：必须引用令牌变量，`style` 内出现 `#` 十六进制值即违规。
12. 禁止骨架屏滥用：首屏与列表首次加载可用，切换筛选不重放骨架。
13. 禁止 KPI 磁贴超过 4 个，且每个必须可下钻，否则改成文本行。

## 7. 性能预算与手段

| 指标 | 预算 | 手段 |
| --- | --- | --- |
| 首屏 JS + CSS（gzip） | ≤ 300 KiB | 路由级 `() => import()` code split；登录页独立 chunk |
| Element Plus | 按需 | `unplugin-vue-components` + `unplugin-auto-import`，禁整库 `import ElementPlus` |
| 图标 | 逐图标编译 | `unplugin-icons` + `@iconify-json/lucide`，禁止运行时拉取图标集 |
| CSS | 原子化 | UnoCSS preset-wind，禁止引入完整 UI 框架样式包 |
| 状态管理 | 无 | composables + `provide/inject`，不引 Pinia |
| 首屏请求数 | ≤ 3 | 静态资源合并出 1 CSS + 1 JS + 1 字体，字体 `font-display: swap` |

预算自检（构建后执行，数值为 gzip 后字节数之和）：

```bash
gzip -9 -c web/dist/assets/*.js web/dist/assets/*.css | wc -c   # 单文件口径
find web/dist/assets -name '*.js' -o -name '*.css' | xargs -r gzip -9 -c | wc -c  # 合计口径
```

合计口径 ≤ 307200 字节为通过。超预算优先删依赖与路由，不删可访问性。

## 8. 开发工作流

- `vite dev` 起在 `127.0.0.1:5173`，`server.proxy` 把 `/api` 与 `/plugin-assets` 反代到 `http://127.0.0.1:8787`（主壳的可选 HTTP 监听）。
- 主壳只开 UDS 时，开发期用 `KORE_HTTP_ADDR=127.0.0.1:8787` 启动 `kored`，仅监听回环。
- **mock 策略**：`web/mock/` 下按 URL 命名存放 JSON（如 `plugins.get.json`），vite 插件按 `import.meta.env.DEV` 分支挂中间件；生产构建时该分支被 tree-shake，mock 不进产物。
- **类型来源**：API 与帧类型以 `pkg/pluginapi` 的 Go 类型为唯一真源。M1 起用 `tygo` 生成 `web/src/types/pluginapi.d.ts`，生成物入库，禁止手改；前端不从后端复制类型。
- 提交前本地门禁：`pnpm -C web typecheck`（`vue-tsc --noEmit`）、`pnpm -C web build`、预算自检。

## 9. 构建与 embed

```text
web/src ──vite build──► web/dist ──go:embed──► kore 单二进制 ──net/http──► 浏览器
```

- 构建顺序固定：`vite build --outDir dist` → `go build ./cmd/kored`；`Makefile` 的 `build` 目标先跑前端再跑后端，缺 `web/dist` 时 `go build` 直接失败（embed 报错即门禁）。
- embed 声明放在 `web/embed.go`（`package web`），因为 `//go:embed` 不能引用父目录：

```go
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
```

- 该 `//go:embed` 只覆盖主壳的 `web/dist`；插件前端资产来自运行期目录 `/var/lib/kore/plugins/<id>/<version>/web/`，由 httpapi 只读托管，**不进二进制**（见 4.2 与 [SECURITY](./SECURITY.md) 第 10 节）。
- 产物文件名带 content hash（`assets/index-<hash>.js`）；`index.html` 以 `Cache-Control: no-store` 提供，hashed 资源 `immutable`。
- **dev/prod 静态托管分支**：`KORE_WEB_DEV=1` 且非 `release` 构建时，`httpapi` 把非 `/api` 请求反代到 `127.0.0.1:5173`；否则只从 `web.Dist` 读文件，找不到的路径回落到 `index.html`（SPA 兜底），但 `/api` 前缀永不回落。
- 单二进制 ≤ 25 MiB（含 embed 前端）是门禁级预算，前端合计体积贡献上限按 300 KiB gzip 反推。

## 10. 可访问性底线

- 文本对比度 ≥ 4.5:1（大字号 ≥ 3:1），令牌表已按此校验；新增颜色必须附对比度计算值。
- 焦点必须可见：`:focus-visible` 统一 `outline: 2px solid var(--kore-info); outline-offset: 2px`，禁止 `outline: none` 无替代。
- Esc 关闭所有弹层（Dialog/Drawer/Dropdown/Popover），且关闭后焦点回到触发元素。
- 表单 `label` 必须与控件 `for`/`id` 关联；错误信息同时用文本与 `aria-describedby`。
- 状态不只靠颜色（见红线 9）；图标按钮必须有 `aria-label`。
- 弹层打开时焦点陷阱（focus trap），关闭时释放；后台内容 `aria-hidden="true"`。
- 表格提供 `<caption>` 或 `aria-label`；排序按钮暴露 `aria-sort`。
