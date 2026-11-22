> 状态: draft · 归属: architect · 更新: 2026-11-22 · 里程碑: M0

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

**业务方法调用形态（硬约束）**：插件业务方法一律走 `POST /api/v1/invoke/<plugin-id>/<method>`，其中 `method` 必须是完整限定名 `<plugin-id>.<action>`——例如 `POST /api/v1/invoke/db-mysql/db-mysql.instances`，**不得**写成裸动词 `POST /api/v1/invoke/db-mysql/instances`。内核按 [PLUGIN-PROTOCOL](PLUGIN-PROTOCOL.md) §7.2 把 `method` 原样转发、不做方法名改写，裸动词只有插件自己保留的兼容层才认；插件一旦收紧命名（如 `db-mysql` 只认 `db-mysql.` 前缀），裸动词立即变成 `E_NOTFOUND 未知方法`。因此每个视图模块的文件头注释都要写明本条调用形态，方法段一律带域前缀（`file.list`、`site.status`、`db-mysql.query` 等）。

`GET /-/healthz` 不进入前端路由，只给探针与 `curl` 用。

## 3. 布局规范

- **顶栏 48px 固定**：左为产品名与当前页标题，右为连接状态点（`GET /api/v1/events` SSE 心跳）、用户菜单（登出、设置入口）。
- **侧栏**：展开 220px、折叠 48px，折叠状态存 `localStorage['kore.sidebar']`；只放插件菜单与管理入口，不做多级嵌套（深度上限 2 级：分组 → 项）。
- **内容区**：自适应剩余宽度，最小 960px；低于 960px 时侧栏强制折叠，不出现横向滚动条（表格内部横向滚动）。
- **滚动策略**：顶栏与侧栏 `position: sticky` 各自独立滚动；内容区是唯一主滚动容器，禁止 `body` 滚动。表格头 sticky，冻结在内容区顶部下方 0px。
- **密度**：行高 32px、表头 36px、区块间距 16px；表单控件高 28px，紧凑模式 24px。

### 3.1 响应式与手机适配（裁决41）

主壳 UI 必须响应式适配手机 / 平板 / 桌面，插件 iframe UI 同样适配；这是硬需求，不是渐进增强项。

- **viewport**：`index.html` 的 `<meta name="viewport">` 必须含 `width=device-width, initial-scale=1`；缺失或写成固定宽度即返工。
- **断点**：只用 CSS media query，三段——`640px` 以下手机、`640px–1024px` 平板、`1024px` 以上桌面；断点值集中在 `style.css` 定义，禁止散落硬编码。
- **禁 JS 探测**：禁止用 `window.innerWidth` / `matchMedia` 等做布局分支（屏幕尺寸判断一律 CSS 负责）；JS 不得因视口宽度切换 DOM 结构或重载组件。
- **触摸目标**：所有可点击元素（按钮、图标、表格操作、表单控件、侧栏项）在触摸视口下命中区 ≥ 44×44 px；视觉尺寸可小于 44px，命中区不得缩小。
- **布局降级**：手机下侧栏折叠为抽屉 / 底部入口，顶栏保留连接状态点与用户菜单；表格改卡片或表内横向滚动，不出现整页横向滚动条（延续 §3 内容区纪律）。
- **插件 iframe**：子帧按自身视口自适应，响应式样式由插件自带；主壳经 postMessage 桥**只传视口元数据**（如宽度档位），不代管子帧布局、不强制尺寸、不注入样式。iframe 容器随主壳断点伸缩，裁决40 的独立 origin / sandbox / 桥校验约束不变。
- **预算不放宽**：移动端首屏 gzip 仍 ≤ 300 KiB（§7），不因适配引入框架、UI 库或额外依赖；断点与触摸规则只用原生 CSS 实现，零框架不变。

## 4. 插件前端契约

**安全边界（裁决40）**：插件 UI **不进主壳 realm**。插件前端在**独立站点 origin 的 iframe** 中运行——必须是与站点不同的 origin，**不只是不同端口**：`SameSite=Strict` 按 site 判定，同站不同端口仍会带主域 cookie，因此子帧必须跨站，读不到 `kore_csrf`、不带主域 cookie。插件不碰主壳 cookie / csrf / DOM，只经 postMessage 桥调 `invoke`。`kore_csrf` 改 HttpOnly；管理 API 永不对桥开放。**服务端根因单列**：管理端点（如 `/api/v1/plugins/{id}/enable`，`middleware.go:24-25` 只查 session+CSRF）缺"按目标操作做 capability 校验"，列为 M4 待办独立修补，客户端 UI 隔离只是兜底，不由本方案代替。

**首屏纪律**：首屏只加载主壳三件套，插件 UI 按需入 iframe，`d(首屏)/d(插件数)=0`——装 100 个插件首屏体积不变。`kore` 的 `go:embed` 只含主壳前端，不含任何插件资产；插件前端永不进主二进制。

### 4.1 清单来源

插件前端不设第二份清单文件：**直接取插件包内 `info.json` 的 `web` 段**（`info.json` 是包内唯一清单，见地基契约）。不引入独立 `plugin.json` 的理由：两份清单必然漂移，且安装校验只需一处真源。

### 4.2 `web` 段字段

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `entry` | string | 是 | 相对包根、以 `.js` 结尾、不含 `..` | ES module 入口，产物须为单入口多 chunk |
| `styles` | string[] | 否 | ≤ 5 项、合计 ≤ 200 KiB | 由 iframe 文档自行加载，主壳不注入样式 |
| `menus` | object[] | 否 | ≤ 8 项、`path` 必须落在 `/p/<id>/` 下 | 侧栏入口，字段 `id`/`label`/`path`/`order`/`icon?` |
| `routes` | object[] | 否 | `path` 必须以 `/p/<id>/` 为前缀 | 仅用于启用时的前缀冲突预检；真实路由由子帧内部管理 |

`web/` 产物结构：

```text
web/
├── index.html     iframe 文档入口，自行加载 entry 与样式
├── index.js       entry，ES module（构建后文件名带 content hash 亦可）
├── index.css      styles 指向的文件，可选
└── chunks/*.js    entry 内部的相对 import，按 URL 解析，不需要清单声明
```

**来源与托管链路**：插件前端在 `kore-plugin-<id>` 仓库内用任意栈（Vite 或其它）构建 → 产物以 `web/` 进包 → 安装时落到 `/var/lib/kore/plugins/<id>/<version>/web/` → 由 kore 以带版本的 `/plugin-assets/<id>@<ver>/` 路径托管（版本化是清缓存与隔离的基础）。**kore 的 `go:embed` 只含主壳前端，不含任何插件资产**：插件前端永不进主二进制，M2 不得以"省事"为由把插件前端打进 kore。

### 4.3 桥接口（window.kore.invoke）

子帧里由主壳提供的几十行 RPC shim 暴露唯一入口 `window.kore.invoke`；插件**只调这个入口**，不接触主壳 cookie / csrf / DOM。管理端点永不对桥开放。

```ts
// 子帧侧（插件调用）
declare global {
  interface Window {
    kore: {
      invoke: (method: string, params?: unknown) => Promise<unknown>
      onEvent: (topic: string, fn: (payload: unknown) => void) => () => void
    }
  }
}
```

桥协议用 postMessage 承载，`req_id` 回投一一对应；请求字段显式定形，禁止 `object` / `any`（G-24）：

```ts
interface KoreBridgeRequest {
  kind: 'kore.invoke'
  req_id: string
  method: string
  params_json: string   // 受控载荷，按插件声明的 schema 校验
}
interface KoreBridgeResponse {
  kind: 'kore.result'
  req_id: string
  ok: boolean
  result_json?: string
  error?: { code: string; message: string }
}
```

> 口径注记：桥实现兼容 `type`/`reqId`/`params` 旧字段，新代码统一用 `kind`/`req_id`/`params_json`（`kore.invoke` / `kore.result`）。

### 4.4 注册时序

```text
安装完成 ──► POST /api/v1/plugins/{id}/enable
                  │
                  ▼
       supervisor 拉起进程 → kore.hello 返回 methods → 标记 ready
                  │
                  ▼
       主壳 GET /plugin-assets/<id>@<ver>/info.json 读 web 段
                  │
                  ▼
       主壳入 iframe（独立站点 origin、非仅跨端口，sandbox 限权）
                  │
                  ▼
       子帧加载 /plugin-assets/<id>@<ver>/<entry>，注入几十行 RPC shim
                  │
                  ▼
       前缀校验 → 子帧内部渲染 → 侧栏菜单由主壳按 web.menus 注册
                  │
                  ▼
       侧栏出现菜单；失败则整个插件 UI 置为 degraded（4.6）
```

主壳收到子帧消息时**必须**校验 `event.origin`（等于插件 asset 的独立 origin）与 `event.source`（等于该 iframe 的 `contentWindow`），两者任一不符即丢弃；随后按该插件 `granted_capabilities` 限权，管理 API 类 method 一律拒绝、不进桥。

### 4.5 卸载与热替换

1. asset 路径恒带版本 `/plugin-assets/<id>@<ver>/`；升级后 `<ver>` 变化 → 新 iframe 加载新路径，无模块缓存残留问题。
2. 卸载顺序固定：通知子帧 `teardown` → 移除 iframe 节点 → 菜单注销 → 清空该插件的桥 `req_id` 映射与 source 引用。不保留闭包，旧文档才能被 GC。
3. 禁止把插件前端 `import` 进主壳 bundle：插件运行时安装，静态收集会把集合固化在构建期并让插件进入主壳 realm（越权）。
4. 热替换 = 卸载旧版本 iframe + 按新 `<ver>` 重新走 4.4；替换过程中该插件菜单置灰，不允许并发二次触发。
5. 子帧内部组件不允许引用主壳内部模块路径——不同 realm，跨包引用一律失败。

### 4.6 失败隔离

iframe 加载、桥握手、前缀校验、子帧渲染全部包在 `try/catch` 内：

- 失败仅影响该插件：菜单隐藏、iframe 移除、详情页展示错误摘要（错误类型 + 发生阶段 + 时间戳，栈截断 8 KiB）。
- 主壳不因此白屏；SSE 通道与其余插件保持可用。
- 连续 2 次启用失败写入审计事件 `plugin.ui_load_failed`，并在 `/plugins` 行内标红。

### 4.7 静态资源路径

插件前端资产由主壳托管在带版本的 `/plugin-assets/<id>@<ver>/*`（鉴权后，但**不把管理 API 挂在该前缀下**）；`Content-Type` 白名单仅 `js`/`css`/`svg`/`png`/`woff2`/`json`/`html`，其余返回 404。带版本的路径统一 `Cache-Control: public, max-age=31536000, immutable`；无版本路径返回 404，不再提供 `no-cache` 的无版本入口。iframe 目标 origin 必须与主站点不同站，子帧不继承主域 cookie。

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
- **M2 已落地 `web/` 壳**：当前主壳前端为零依赖静态产物，**首屏四件套**（`index.html` / `style.css` / `app.js` / `shell.js`）+ **十二个按需视图模块**（`store.js` / `files.js` / `sites.js` / `tasks.js` / `monitor.js` / `settings.js` / `terminal.js` / `db.js` / `logs.js` / `process.js` / `ssl.js` / `backups.js`），`make frontend` 打包十九个文件到 `web/dist` 并由 `scripts/frontend-check.sh` 按 §7 口径只卡首屏四件套 gzip ≤ 300 KiB；另有三个按需子模块：`files-l2.js`（文件上传/下载/压缩/解压/改权限/移动）、`site-edit.js`（SSL/伪静态/反代/重定向/默认文档）与 `config-panel.js`（日志/备份页「设置」打开的通用插件配置面板，见 [PLUGIN-CONFIG.md](./PLUGIN-CONFIG.md)）。上表 Vue/UnoCSS 工具链为后续迭代目标，非当前产物形态。
- **视图清单**：概览（`app.js`）、软件商店（`store.js`）、已装插件（`app.js`）、文件管理（`files.js` + 懒加载 `files-l2.js`）、网站（`sites.js` + 懒加载 `site-edit.js`）、计划任务（`tasks.js`）、监控（`monitor.js`）、设置（`settings.js`）、终端（`terminal.js`）、**数据库（`db.js`）**、**日志（`logs.js`）**、**进程（`process.js`）**、**SSL 证书（`ssl.js`）**、**备份（`backups.js`）**。数据库页提供 MySQL/MariaDB 实例卡（可达性 + 版本）、实例状态条、库列表与只读 SQL 控制台（`mysql.instances` / `databases` / `query` / `status`）；日志页提供来源卡、tail/关键字过滤/全文件搜索与统计条；进程页提供可排序表格、详情抽屉、进程树与二次确认的信号投递；SSL 页提供证书列表（到期天数/issuer/密钥/指纹）、真实 TLS 握手验证、自签、导入与续期，ACME 入口明确置灰；备份页提供打包、校验、恢复到空目录与删除，恢复/删除均为页面内二次确认。

## 9. 构建与 embed（已落地）

```text
web/index.html|app.js|style.css|shell.js|store.js|files.js|sites.js|tasks.js|monitor.js|settings.js|terminal.js|db.js|logs.js|process.js|ssl.js|backups.js ──make frontend──► web/dist ──go:embed──► kore 单二进制 ──net/http──► 浏览器
```

**状态：已落地**（M2-D 零依赖静态壳，M5 扩到十九文件）。当前主壳前端是十九文件静态产物，不依赖 Vite / Vue 工具链；下表 Vue / UnoCSS 相关预算（§7）为后续迭代目标，非当前形态。

- 构建顺序固定：`make frontend`（从 `web/` 复制十九个产物到 `web/dist/` 并卡 §7 首屏 gzip）→ `make build`（`go build ./cmd/kored`）。`make build` / `vet` / `test` 依赖 `web-dist` 目标，缺 `web/dist` 时先自动补齐十九个产物（干净检出可直接构建）；绕过 Makefile 直接 `go build ./...` 时缺 `web/dist` 仍会因 embed 报错失败。
- **首屏口径（四件套）**：`index.html` + `style.css` + `app.js` + `shell.js` 同步加载并计入首屏 gzip 预算（`scripts/frontend-check.sh` 的 `FILES` 只列这四个）。`store.js` / `files.js` / `sites.js` / `tasks.js` / `monitor.js` / `settings.js` 六个视图模块由 `app.js` 的 `ensureModule()` 在切到对应视图时动态注入；`terminal.js` / `db.js` / `logs.js` / `process.js` / `ssl.js` / `backups.js` 是 `shell.js` 内置的第 9–14 个导航项（终端、数据库、日志、进程、SSL、备份），同样按需注入对应 `/assets/<模块>.js`。十二个模块**都不进首屏**，首屏请求数与视图数无关。
- embed 包位于 `web/embed.go`（`package web`，module 路径 `github.com/pengtang1024/kore/web`）。`//go:embed` 不能引用父目录，故 embed 声明与 `dist/` 同处 `web/` 下；**逐个精确列十九个文件**，不用 `all:dist`（embed 必须显式列名是 Go 限制，不构成业务词表）：

```go
package web

import "embed"

//go:embed dist/index.html dist/app.js dist/style.css dist/shell.js dist/store.js dist/files.js dist/files-l2.js dist/sites.js dist/site-edit.js dist/config-panel.js dist/tasks.js dist/monitor.js dist/settings.js dist/terminal.js dist/db.js dist/logs.js dist/process.js dist/ssl.js dist/backups.js
var Dist embed.FS
```

- 该 `//go:embed` 只覆盖主壳十九个产物；插件前端资产来自运行期目录 `/var/lib/kore/plugins/<id>/<version>/web/`，由 httpapi 只读托管，**不进二进制**（见 4.2 与 [SECURITY](./SECURITY.md) 第 10 节）。
- **静态路由（已落地，前缀化）**：`httpapi`（`internal/core/httpapi/server.go` 的 `staticRoutes()`）只注册**两条**路由，从 `web.Dist` 按精确路径读文件，不遍历、不回落：

| 路由 | 资源 | Content-Type |
| --- | --- | --- |
| `GET /` | `dist/index.html` | `text/html; charset=utf-8` |
| `GET /assets/{file}` | `dist/{file}` | 按后缀：`.js` → `application/javascript; charset=utf-8`、`.css` → `text/css; charset=utf-8`、`.html` → `text/html; charset=utf-8` |

  **为什么前缀化（G-01）**：内核不得维护业务域名词表。若逐文件注册 `/app.js`、`/monitor.js` 等，等于把前端视图名硬编码进内核——`monitor` 正是 thin-shell 门禁的业务域词，实测会让 `make check` 第 3 段直接失败。现在内核只认识 `assets` 一条前缀 + 后缀白名单，**不认识任何具体视图名**，新增视图无需改静态路由或 httpapi Go 代码；但 Go 的 `//go:embed` 必须显式列名，新增模块仍需在 `web/embed.go` 加一行。

  `/assets/{file}` 只接受单段文件名（含 `/`、`\`、`.`、`..` 一律 404）且后缀必须在白名单内，其余按未知路由处理。`index.html` 以 `/assets/style.css`、`/assets/shell.js`、`/assets/app.js` 绝对路径引用，三个路径自洽。其它任何路径（含 `/nonexistent`）由 `routes()` 的 `"/"` 兜底返回 404 E_NOTFOUND——**无 SPA 兜底**，未知路径不回落 `index.html`。
- **鉴权边界**：`/` 与 `/assets/` 前缀在 `middleware.go` 的 `isPublicPath` 白名单内（面板壳无敏感数据，未登录也要能加载登录界面）。白名单**只认前缀一条**、不枚举文件名；所有 `/api/v1/*` 端点仍强制会话校验，鉴权与 CSRF 逻辑不因静态托管削弱；插件资产前缀 `/plugin-assets/*` 不在白名单内。视图模块自身的数据请求走 `/api/v1/*`，未登录照样 401——放行只覆盖静态文件本体。
- **访问方式**：kored 默认只开 UDS（`server.addr` 为空），浏览器访问需在配置里显式写 `server.addr: 127.0.0.1:8787`（MVP 只允许回环地址），然后打开 `http://127.0.0.1:8787/`。完整步骤见根 [QUICKSTART.md](../QUICKSTART.md)。
- 单二进制 ≤ 25 MiB（含 embed 前端）是门禁级预算，前端合计体积贡献上限按 300 KiB gzip 反推。

## 10. 可访问性底线

- 文本对比度 ≥ 4.5:1（大字号 ≥ 3:1），令牌表已按此校验；新增颜色必须附对比度计算值。
- 焦点必须可见：`:focus-visible` 统一 `outline: 2px solid var(--kore-info); outline-offset: 2px`，禁止 `outline: none` 无替代。
- Esc 关闭所有弹层（Dialog/Drawer/Dropdown/Popover），且关闭后焦点回到触发元素。
- 表单 `label` 必须与控件 `for`/`id` 关联；错误信息同时用文本与 `aria-describedby`。
- 状态不只靠颜色（见红线 9）；图标按钮必须有 `aria-label`。
- 弹层打开时焦点陷阱（focus trap），关闭时释放；后台内容 `aria-hidden="true"`。
- 表格提供 `<caption>` 或 `aria-label`；排序按钮暴露 `aria-sort`。

## 11. UI 交付证据要求（G-28）

这条不是建议，是验收条件：**任何涉及用户界面的交付，声明"完成"时必须同时提交双端截图与产品定位自评**（G-28，条文见 [AGENTS.md](../AGENTS.md) 硬门禁表与 [.agents/QUALITY-GATES.md](../.agents/QUALITY-GATES.md) §3.1）。

| 项 | 要求 |
| --- | --- |
| PC 截图 | 1440×900 或 1280×800，**full-page**（整页含滚动内容，不只首屏视口） |
| 手机截图 | 390×844（iPhone 14 逻辑分辨率），与 PC 同一场景、同一状态 |
| 存放与命名 | `.agents/verify/screenshots/` 下 `<场景>-desktop-*.png` / `<场景>-mobile-*.png`；场景名 kebab-case（如 `store-home-desktop-1220.png`） |
| 产品定位自评 | 一段话答三问：本页解决什么用户问题 / 与宝塔、1Panel 同类功能的**具体**差距 / 当前是"可用"还是"占位"（占位必须写清缺什么） |

- **判定**：三件套缺任一项即不得声明完成；截图必须来自真实浏览器渲染，分辨率以 `file` / `identify` 读到的 PNG 实际宽高为准；禁止同图缩放冒充双端、禁止设计稿或拼接图。
- **为什么**：接口返回 200 / DOM 断言通过只证明"数据到了"，不证明"用户看到的是可用产品"——呈现层必须用双端截图 + 定位自评收口，否则"接口通了"就会被当成"做完了"。
- **与手机适配（§3.1 / 裁决41）的关系**：响应式是要求，双端截图是这条要求的验收证据，两者缺一不可。

## 12. 交互设计约束（USABILITY 四原则）

产品层面的四原则、判据与当前违反清单见 [USABILITY.md](./USABILITY.md)；本节只写**前端必须落到代码里的部分**——在这里四条原则不是文案要求，是 UI 实现约束：

| 原则 | 前端必须做到 | 验收判据 |
| --- | --- | --- |
| 1 预设优先 | 表单首屏只露默认入口；高级字段放进「自定义」折叠区（`<details>` 或 Dialog），默认收起且可一键复位 | 核心任务点击 ≤3；自定义区原样不动也能提交成功 |
| 2 自动发现 | 可探测字段由后端（`/api/v1/system/info` 或插件探测方法）预填，字段旁标「已自动检测」，带「重新检测」 | 首次打开截图里字段已填 + 来源标注可见 |
| 3 步骤尽量少 | 一个任务一个表单一次提交；多步走同一套向导壳（第 N / 共 M 步、可回退、已填内容保留） | 每功能步骤数列表，>3 必须合并 |
| 4 小白看懂 | 错误 = 白话 `message` + 怎么办的 `hint` + 折叠的 `code`；每项中文 label + 一行帮助；空态给主操作按钮 | 抽 3 页文案给非技术用户，能说出这页干什么 |

落地细则（违反即返工）：

- 「自定义」折叠区收起时不得触发额外请求；展开 / 收起不重置已填值，并有「恢复默认」入口。
- 探测标注用统一徽标组件（文本 + `aria-label`），不许只用颜色区分；探测失败显示「未检测到」+ 安装指引，不显示空输入框。
- 向导必须显示进度并在 `Esc` 退出前提示"已填内容会保留"；禁止把半截状态丢给另一个页面自行拼接。
- 错误区禁止直接渲染原始 JSON / 裸错误码；错误码只进折叠区与 `title`。
- 每个列表视图的空态必须有主操作按钮（如「新建站点」「添加数据库连接」），禁止只写"暂无数据"。
- UI 文案出现「实例 / 生命周期 / capability / revision」即违规，替换表见 [USABILITY.md](./USABILITY.md) §4.1。
- 与 §6 反样板红线、§10 可访问性底线叠加生效：折叠不等于可以跳过键盘可达、label 关联与 `aria-describedby`。

> 判定：任一条不满足，UI 交付不得声明完成；G-28 的双端截图必须能证明首屏默认态（原则 1）、字段已自动填（原则 2）与空态按钮（原则 4）。
