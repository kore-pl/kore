> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M0

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

**补充（2026-11-23 真机实测）**：已收紧命名的插件不保留裸动词兼容层，裸方法名直接 404 `E_NOTFOUND 未知方法`；前端视图、脚本与插件桥一律写死完整限定名，不做裸名回退或前缀猜测（契约原文见 [PLUGIN-PROTOCOL](PLUGIN-PROTOCOL.md) §7.2.1）。

`GET /-/healthz` 不进入前端路由，只给探针与 `curl` 用。

## 3. 布局规范

- **顶栏 48px 固定**：左为产品名与当前页标题，右为连接状态点（`GET /api/v1/events` SSE 心跳）、全局搜索、告警铃铛与「设置」图标入口。**退出登录不在顶栏**（C10：一级位置只放高频可逆操作，退出不可逆）：全站唯一入口在「设置 → 账户与安全」，红字 + 确认弹层「确定退出 Kore 控制台？」——顶栏设置入口 → 账户与安全 → 退出，2 次点击可达。
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
| 字号 | 令牌 `--kore-font-12/13/14/15/16/20/32`（12/13/14/15/16/20/32 px） | 12 仅限 Caption（标签/时间戳/单位/列名）；正文 13；数值与控件 14+；15 区块/卡片标题（H2）；16 辅助强调；20 页面标题（H1）；32 Display 单页核心数字（每页 ≤4）；禁止裸写字号，统一走令牌 |
| 层叠 | 令牌 `--z-content/card/float/drawer/modal/tip/badge` = 0/10/20/30/40/50/60 | 角标父容器 `overflow` 必须 `visible` 或预留 ≥6px 溢出空间；角标层永远最高（60） |
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
| i18n 骨架（gzip） | ≤ 3 KiB | `i18n.js` + `i18n-zh-CN.js` 同批进首屏；`en-US` 切语言时才注入（ADR-0021） |
| Element Plus | 按需 | `unplugin-vue-components` + `unplugin-auto-import`，禁整库 `import ElementPlus` |
| 图标 | 逐图标编译 | `unplugin-icons` + `@iconify-json/lucide`，禁止运行时拉取图标集 |
| CSS | 原子化 | UnoCSS preset-wind，禁止引入完整 UI 框架样式包 |
| 状态管理 | 无 | composables + `provide/inject`，不引 Pinia |
| 首屏请求数 | ≤ 3 | 静态资源合并出 1 CSS + 1 JS + 1 字体，字体 `font-display: swap` |
| 图表（ECharts 5） | **不进首屏**（`d(首屏)/d(图表数)=0`） | 按需 ESM + 懒加载 vendor chunk（`web/dist/charts.js` + `charts-echarts.js`），首屏 `FILES` 不列图表产物，见 §13 / [ADR-0027](./DECISIONS/0027-echarts-chart-standard.md) |

预算自检（构建后执行，数值为 gzip 后字节数之和）：

```bash
gzip -9 -c web/dist/assets/*.js web/dist/assets/*.css | wc -c   # 单文件口径
find web/dist/assets -name '*.js' -o -name '*.css' | xargs -r gzip -9 -c | wc -c  # 合计口径
```

合计口径 ≤ 307200 字节为通过。i18n 两个首屏文件的 gzip 合计另有 3072 字节硬预算（`scripts/frontend-check.sh` 独立卡，不靠总预算余量）。超预算优先删依赖与路由，不删可访问性。

## 8. 开发工作流

- `vite dev` 起在 `127.0.0.1:5173`，`server.proxy` 把 `/api` 与 `/plugin-assets` 反代到 `http://127.0.0.1:8787`（主壳的可选 HTTP 监听）。
- 主壳只开 UDS 时，开发期用 `KORE_HTTP_ADDR=127.0.0.1:8787` 启动 `kored`，仅监听回环。
- **mock 策略**：`web/mock/` 下按 URL 命名存放 JSON（如 `plugins.get.json`），vite 插件按 `import.meta.env.DEV` 分支挂中间件；生产构建时该分支被 tree-shake，mock 不进产物。
- **类型来源**：API 与帧类型以 `pkg/pluginapi` 的 Go 类型为唯一真源。M1 起用 `tygo` 生成 `web/src/types/pluginapi.d.ts`，生成物入库，禁止手改；前端不从后端复制类型。
- 提交前本地门禁：`pnpm -C web typecheck`（`vue-tsc --noEmit`）、`pnpm -C web build`、预算自检。
- **M2 已落地 `web/` 壳**：当前主壳前端为零依赖静态产物，**首屏六件套**（`index.html` / `style.css` / `app.js` / `shell.js` / `i18n.js` / `i18n-zh-CN.js`）+ **十九个按需视图模块**（`store.js` / `files.js` / `sites.js` / `tasks.js` / `monitor.js` / `settings.js` / `terminal.js` / `db.js` / `logs.js` / `process.js` / `ssl.js` / `backups.js` / `redis.js` / `firewall.js` / `waf.js` / `dns.js` / `runtimes.js` / `integrity.js` / `container.js`），`make frontend` 打包三十四个文件到 `web/dist` 并由 `scripts/frontend-check.sh` 按 §7 口径卡首屏六件套 gzip ≤ 300 KiB 与 i18n 增量 ≤ 3 KiB；`i18n/en-US.js` 拍平为 `i18n-en-US.js`，只在切英文时注入；另有八个按需子模块：`files-l2.js`（文件上传/下载/压缩/解压/改权限/移动）、`site-edit.js`（SSL/伪静态/反代/重定向/默认文档）、`config-panel.js`（日志/备份页「设置」打开的通用插件配置面板，见 [PLUGIN-CONFIG.md](./PLUGIN-CONFIG.md)）、`db-l2.js`（数据库页的建库/删库/建用户/授权/导入导出，首次写操作或展开「用户与授权」时注入）、`monitor-cards.js`（监控页的卡片/面板/表格渲染构件，进入监控视图时才注入）、`search.js`（全局搜索命令面板：页面/已装插件/商店/操作四源，顶栏入口或 Ctrl/Cmd+K 首次唤起时注入）、`alerts.js`（顶栏铃铛的告警中心：首屏后懒探测一次、点铃铛才注入；四类来源本地聚合，不落库）与 `audit.js`（设置页「操作审计」tab，首次切到该 tab 时注入；列表/筛选/分页）。上表 Vue/UnoCSS 工具链为后续迭代目标，非当前产物形态。
- **视图清单**：概览（`app.js`）——按 DESIGN-SYSTEM C4 卡片结构重排（DESIGN-AUDIT P0-3）：顶部四张指标卡（CPU / 内存 / 磁盘 / 负载，32px Display 大数字 + 迷你进度条 + 状态点 chip，`role=progressbar`；数据取 `monitor.system`，插件不可用时降级 `/api/v1/system/metrics` 并显式标注）、中段「服务」（站点数 / 证书数 / 数据库检测，`site.list` / `ssl.list` / `discover.services`，插件缺席显示「未启用」不编 0）与「插件」（已装 / 运行 / 空闲 / 已停用 / 异常 + 常驻槽位与 lazy 配额，口径与 `pluginCounts` 同一本账）两张状态卡、底部告警摘要（最近 3 条：audit denied 激增 / 高危拒绝、插件 failed / 反复重启、槽位满、降级告警，阈值与 `alerts.js` 同一本账；「查看全部」懒加载 `alerts.js` 打开告警中心）、剩余键值（版本 / 平台 / cgroup / 重启计数）折叠进「系统信息」`<details>`；样式随视图注入（`ensureAppCss`，`--kore-font-32` Display 档由 style.css 令牌表提供）。软件商店（`store.js`）、已装插件（`app.js`）——商店卡片与已装插件行按索引版本呈现四态（未安装 / 已安装最新 / 可升级 `v旧 → v新` / 索引未收录），提供单个升级与「一键全部升级」汇总条（进度 N/M、失败列出）；升级走 `store/install {force:true}` 并保留配置与启用状态；文件管理（`files.js` + 懒加载 `files-l2.js`）、网站（`sites.js` + 懒加载 `site-edit.js`）、计划任务（`tasks.js`）、监控（`monitor.js`）、设置（`settings.js`）——「语言 / 账户与安全 / 运行参数 / 关于」四卡 + 「操作审计」tab；**退出登录全站唯一入口在「账户与安全」卡内**（DESIGN-AUDIT P0-1 / C10 三级：红字 + 确认弹层「确定退出 Kore 控制台？」，Esc / 遮罩 / 取消均不退出；顶栏只有「设置」图标入口，2 次点击可达退出）、终端（`terminal.js`）、**数据库（`db.js`）**、**日志（`logs.js`）**、**进程（`process.js`）**、**SSL 证书（`ssl.js`）**、**备份（`backups.js`）**、**Redis（`redis.js`）**、**防火墙（`firewall.js`）**、**运行环境（`runtimes.js`）**：一个页面用 tab 切换 Node.js / PHP / Python，展示版本列表（版本 / 路径 / 来源 / 是否默认）、单版本详情（Node 的 npm/V8/OpenSSL/全局包，PHP 的 ini/扩展/ini_settings，Python 的 pip/site-packages/包数/venv）、项目扫描（预设 `/var/www`、`/opt`、`/home`，每 tab 记住上次根目录）与健康检查（pass/warn/fail，fail 项显示 detail 里的修复命令）；未安装时给安装指引而不是空白页。**完整性（`integrity.js`）**：基线状态卡（未建立 → 大字「尚未建立完整性基线」+ 一句说明 + 建立基线按钮；已建立 → 建立时间 / 条目 / 合计体积 / 上次校验 + 立即校验 / 重建基线）、基线弹层（四个预设路径点击即选 + 自定义路径 + 排除规则，默认 `*.log` `*.tmp` `*/cache/*`）、校验结论（`ok=true` 绿「未检测到改动」/ 红「检测到 N 处改动」）与新增 / 删除 / 修改三张可折叠表（修改行给 `old→new` sha256 前 8 位与 changes，行内「详情」展开完整路径与权限位）、单文件校验（路径 + 期望 sha256 → `match`）；空态与 `E_NOTFOUND` 都给下一步按钮，0 条目基线显示黄底告警而不是「已建立」。数据库页打开先调 `discover.discover.services`，命中本机 MySQL/MariaDB 时显示「自动检测横幅 + 一键连接」，host/port/user 预填并标「已自动填入」，保存只填密码，随后自动验证并展示实例卡；探测不到时给安装指引与手动配置入口（`db-mysql.config.get/set` + `db-mysql.instances` / `databases` / `query` / `status`）；日志页提供来源卡、tail/关键字过滤/全文件搜索与统计条；进程页提供可排序表格、详情抽屉、进程树与二次确认的信号投递；SSL 页提供证书列表（到期天数/issuer/密钥/指纹）、真实 TLS 握手验证、自签、导入与续期，ACME 入口明确置灰；备份页提供打包、校验、恢复到空目录与删除（恢复/删除均为页面内二次确认）、定时备份（选预设或自定义 cron + 保留份数，保存时直接建内核 scheduler 的 `backup.create` + `backup.retention` 两条任务，可暂停/恢复/删除）与保留策略（列表上方汇总总份数/最早/最晚/占用，保留区块先 dry_run 预览再清理）；Redis 页同样先自动检测并支持一键连接（`redis.config.get/set`，host/port 预填，只需填密码），再提供实例可达性/版本、内存与命中率、keyspace、键扫描与批量删除，以及运维面板：顶部四张指标卡（内存用量进度条 + used/maxmemory、碎片率、AOF/RDB 状态点、24h 慢查询数，数据取 `redis.persistence` / `redis.memory` / `redis.slowlog`）、键行点开先看「键详情」侧栏（`redis.keyInfo` 的类型/编码/TTL/内存占用，O(1) 不取值），点「读取值」才经 `redis.get` 拉取内容（替代旧的行点击即盲取值）、慢查询面板（128 条 + slowlog-log-slower-than 阈值说明，只读不改配置）；防火墙页提供后端/启用态/默认入站/规则表，放行/拒绝/删除统一先 `dry_run` 预览命令再确认，非 root 时降级为黄底说明且禁用真实写操作；**Web 应用防火墙（`waf.js`）**：两个平面分开呈现——引擎平面（`waf.status` 的引擎/版本/规则数/模式，只读探测宿主已装的 modsecurity/naxsi/coraza/crowdsec）与 kore 自有的 nft 数据面（表/链/防护模式/封禁数/规则数）；三档模式「只记录不拦截 / 直接拦截 / 关闭防护」一键切换（`waf.toggle`，关闭必须二次确认，切换后回读 `applied`/`verified` 并如实显示），封禁名单表格（IP / IPv4 或 IPv6 封禁集合 / 剩余时间 / 行内解封，读 `waf.bans`、写 `waf.ban`/`waf.unban`，时长用 1 小时/1 天/7 天/永久预设），基础防护规则只读表（编号 / 规则摘要 / 动作 / 命中包数 / 字节数，读 `waf.rules` 的 nft 段）与最近拦截记录（读 `waf.logs`），插件配置经通用配置面板（`waf.config.get/set`）；引擎没装时明确说明「只做 IP 封禁与网络层防护，URL/参数拦截需另装 ModSecurity/Naxsi」并给安装命令，没装 nftables / kored 非 root 时给「怎么办」并整体禁用写操作，绝不出现「能填、提交才报错」。**DNS 解析（`dns.js`）**：解析状态卡（主引擎 / 监听地址 / 上游 / 系统解析器 / 探测时间，引擎明细折叠）+ **即时查询**（域名输入 + A/AAAA/CNAME/MX/TXT/NS 类型预设，结果表给域名/类型/值/TTL 与 rcode、耗时、查询器；NXDOMAIN 与空应答各有「下一步」说明）+ **区域列表**（区域名 / 类型 / 记录数 / 所属引擎 / 「查看记录」，读不到时说明需要 root）+ **区域记录只读表**（类型/名称/TTL/值）；没有 DNS 服务时给安装命令，未装插件时单张「去商店安装」空态；写入走 BIND9 动态更新（需 TSIG 密钥），本页明确标注只读。**容器（`container.js`）**：容器列表（运行中 / 含已停止切换、20 行分页 + 加载更多、CPU/内存 stats 回填）、行内日志与详情抽屉（tail 200 + since 过滤、端口 / 挂载 / 重启策略 / 健康检查）、启停重启（停止 / 重启手输容器名二次确认），保护名单行锁标禁操作，Docker 缺失与插件未装均给「怎么办」指引。

## 9. 构建与 embed（已落地）

```text
web/index.html|app.js|style.css|shell.js|i18n.js|i18n/zh-CN.js|i18n/en-US.js|store.js|files.js|sites.js|tasks.js|monitor.js|monitor-cards.js|settings.js|terminal.js|db.js|db-l2.js|logs.js|process.js|ssl.js|backups.js|redis.js|firewall.js|waf.js|dns.js|runtimes.js|integrity.js|container.js|search.js|audit.js|alerts.js ──make frontend──► web/dist ──go:embed──► kore 单二进制 ──net/http──► 浏览器
```

**状态：已落地**（M2-D 零依赖静态壳，R4 扩到二十五文件，i18n 骨架后为三十二文件）。当前主壳前端是三十二文件静态产物，不依赖 Vite / Vue 工具链；下表 Vue / UnoCSS 相关预算（§7）为后续迭代目标，非当前形态。

- 构建顺序固定：`make frontend`（从 `web/` 复制三十二个产物到 `web/dist/` 并卡 §7 首屏 gzip）→ `make build`（`go build ./cmd/kored`）。`make build` / `vet` / `test` 依赖 `web-dist` 目标，缺 `web/dist` 时先自动补齐三十二个产物（干净检出可直接构建）；绕过 Makefile 直接 `go build ./...` 时缺 `web/dist` 仍会因 embed 报错失败。
- **首屏口径（六件套）**：`index.html` + `style.css` + `app.js` + `shell.js` + `i18n.js` + `i18n-zh-CN.js` 同步加载并计入首屏 gzip 预算（`scripts/frontend-check.sh` 的 `FILES` 只列这六个；其中后两个另有 ≤3 KiB 的独立硬预算，见 ADR-0021）。`i18n-en-US.js` 不进首屏——只有用户把语言切到 English 时才按需注入。`store.js` / `files.js` / `sites.js` / `tasks.js` / `monitor.js` / `settings.js` 六个视图模块由 `app.js` 的 `ensureModule()` 在切到对应视图时动态注入；`terminal.js` / `db.js` / `logs.js` / `process.js` / `ssl.js` / `backups.js` / `redis.js` / `firewall.js` / `waf.js` / `dns.js` / `runtimes.js` / `integrity.js` / `container.js` 是 `shell.js` 内置的第 9–21 个导航项（终端、数据库、日志、进程、SSL、备份、Redis、防火墙、Web 防火墙、DNS 解析、运行环境、完整性、容器），同样按需注入对应 `/assets/<模块>.js`。十九个模块**都不进首屏**，首屏请求数与视图数无关；`monitor.js` 的渲染构件 `monitor-cards.js` 再晚一步——只在监控视图首次渲染时注入；`db-l2.js` 同样再晚一步——只在数据库页首次执行写操作（建库/删库/建用户/授权/导入导出）或展开「用户与授权」时注入。21 项导航按「运维 / 业务 / 资源 / 平台」分组：桌面侧栏显示组标题，手机底部固定「运维」5 个 tab、其余 16 项进「更多」抽屉并按组展示，任一页面 ≤2 次点击可达。
- embed 包位于 `web/embed.go`（`package web`，module 路径 `github.com/pengtang1024/kore/web`）。`//go:embed` 不能引用父目录，故 embed 声明与 `dist/` 同处 `web/` 下；**逐个精确列三十二个文件**，不用 `all:dist`（embed 必须显式列名是 Go 限制，不构成业务词表）：

```go
package web

import "embed"

//go:embed dist/index.html dist/app.js dist/style.css dist/shell.js dist/i18n.js dist/i18n-zh-CN.js dist/i18n-en-US.js dist/store.js dist/files.js dist/files-l2.js dist/sites.js dist/site-edit.js dist/config-panel.js dist/tasks.js dist/monitor.js dist/monitor-cards.js dist/settings.js dist/terminal.js dist/db.js dist/db-l2.js dist/logs.js dist/process.js dist/ssl.js dist/backups.js dist/redis.js dist/firewall.js dist/waf.js dist/dns.js dist/runtimes.js dist/integrity.js dist/container.js dist/search.js dist/audit.js dist/alerts.js
var Dist embed.FS
```

- 该 `//go:embed` 只覆盖主壳三十二个产物；插件前端资产来自运行期目录 `/var/lib/kore/plugins/<id>/<version>/web/`，由 httpapi 只读托管，**不进二进制**（见 4.2 与 [SECURITY](./SECURITY.md) 第 10 节）。
- **静态路由（已落地，前缀化）**：`httpapi`（`internal/core/httpapi/server.go` 的 `staticRoutes()`）只注册**两条**路由，从 `web.Dist` 按精确路径读文件，不遍历、不回落：

| 路由 | 资源 | Content-Type |
| --- | --- | --- |
| `GET /` | `dist/index.html` | `text/html; charset=utf-8` |
| `GET /assets/{file}` | `dist/{file}` | 按后缀：`.js` → `application/javascript; charset=utf-8`、`.css` → `text/css; charset=utf-8`、`.html` → `text/html; charset=utf-8` |

  **为什么前缀化（G-01）**：内核不得维护业务域名词表。若逐文件注册 `/app.js`、`/monitor.js` 等，等于把前端视图名硬编码进内核——`monitor` 正是 thin-shell 门禁的业务域词，实测会让 `make check` 第 3 段直接失败。现在内核只认识 `assets` 一条前缀 + 后缀白名单，**不认识任何具体视图名**，新增视图无需改静态路由或 httpapi Go 代码；但 Go 的 `//go:embed` 必须显式列名，新增模块仍需在 `web/embed.go` 加一行。

  `/assets/{file}` 只接受单段文件名（含 `/`、`\`、`.`、`..` 一律 404）且后缀必须在白名单内，其余按未知路由处理。`index.html` 以 `/assets/style.css`、`/assets/i18n-zh-CN.js`、`/assets/i18n.js`、`/assets/shell.js`、`/assets/app.js` 绝对路径引用，路径自洽（`defer` 保序：语言包先于壳）。其它任何路径（含 `/nonexistent`）由 `routes()` 的 `"/"` 兜底返回 404 E_NOTFOUND——**无 SPA 兜底**，未知路径不回落 `index.html`。
- **鉴权边界**：`/` 与 `/assets/` 前缀在 `middleware.go` 的 `isPublicPath` 白名单内（面板壳无敏感数据，未登录也要能加载登录界面）。白名单**只认前缀一条**、不枚举文件名；所有 `/api/v1/*` 端点仍强制会话校验，鉴权与 CSRF 逻辑不因静态托管削弱；插件资产前缀 `/plugin-assets/*` 不在白名单内。视图模块自身的数据请求走 `/api/v1/*`，未登录照样 401——放行只覆盖静态文件本体。
- **访问方式**：kored 默认只开 UDS（`server.addr` 为空），浏览器访问需在配置里显式写 `server.addr: 127.0.0.1:8787`（MVP 只允许回环地址），然后打开 `http://127.0.0.1:8787/`。完整步骤见根 [QUICKSTART.md](../QUICKSTART.md)。
- 单二进制 ≤ 25 MiB（含 embed 前端）是门禁级预算，前端合计体积贡献上限按 300 KiB gzip 反推。
- **图表 vendor chunk（§13 / [ADR-0027](./DECISIONS/0027-echarts-chart-standard.md)）**：`make charts`（`scripts/build-charts.sh`）产出 `web/dist/charts.js` 与 `web/dist/charts-echarts.js`，必须平铺、禁 `*.map`；是否纳入 `web/embed.go` 的显式清单由实现方按 §13 落定。首屏口径不变——`scripts/frontend-check.sh` 的 `FILES` 仍只列六件套，图表文件进 `web/dist` 但**不进首屏预算**。体积影响复核：`make charts` 后 `gzip -9 -c web/dist/charts*.js | wc -c` 记录 vendor + 封装合计，纳入 embed 后 `make build` 再按 `ls -l bin/kored` 与 `make budget-check` 复核单二进制 ≤ 25 MiB；体积累计见 `make frontend` 输出。

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

## 13. 图表工程规范

**前提**：图表是**非首屏能力**。ECharts 5 以「按需 ESM + 懒加载 vendor chunk」引入，是本仓「零依赖静态产物」形态的**唯一例外**（取舍、被否决选项与复审条件见 [ADR-0027](./DECISIONS/0027-echarts-chart-standard.md)）。首屏六件套不变，`d(首屏)/d(图表数)=0`。

**契约文件（命名固定，由实现方落地）**：

| 文件 | 角色 | 约束 |
| --- | --- | --- |
| `web/charts.js` | 运行时封装（ESM） | 导出 `loadEcharts` / `createLineChart` / `disposeChart` / `disposeAll` / `count()`（当前活动实例数，验收断言用）；同一 host 复用实例、走 `setOption` 增量；页面与视图只经它建图 |
| `web/charts/echarts-entry.js` | ECharts 唯一入口 | 只显式 import 用到的图表 / 组件 / 渲染器（允许 `echarts/core` / `echarts/charts` / `echarts/components` / `echarts/renderers` 子路径） |
| `scripts/build-charts.sh` + `make charts` | 构建 | 产出 `web/dist/charts.js` 与 `web/dist/charts-echarts.js` |
| `web/dist/charts*.js` | 产物 | **平铺**（静态路由 `/assets/{file}` 只接受单段文件名）；禁 `*.map`；不进首屏预算 |

十条细则均为**验收条文**，判据可复跑/可回读，**违反即返工**：

| # | 条文 | 可判定判据（违反即返工） |
| --- | --- | --- |
| 1 | **按需 ESM，禁全量导入**：只经 `web/charts/echarts-entry.js` 显式 import；页面不得直接 import ECharts | `grep -rn "from 'echarts'\|echarts/index\|echarts/dist" web/` 零命中（全量包 / 入口总表 / 预构建 dist 一律禁）；`grep -rn "from 'echarts/" web/` 只允许命中 `web/charts/echarts-entry.js`（排除 `node_modules` 与 `web/dist` 构建产物）；其它文件直引即返工 |
| 2 | **单页独立实例 ≤ 12 个**（秒级刷新场景）；超出必须用 Tab / 折叠拆分，不得靠调参硬扛 | `count()`（`web/charts.js` 暴露）在图表页满载时 ≤ 12，且第 13 个 `createLineChart` 必须硬拒绝（`E_CHART_LIMIT`）而不是静默降级；超限即返工，且返工方式是改页面结构，不是上调上限或关动画 |
| 3 | **迷你趋势卡片不用 ECharts**：概览页指标卡的微型走势（单序列、无坐标轴、无 tooltip）用轻量 canvas 或现有 DOM 进度条 | 指标卡渲染路径不得出现 `createLineChart` / `echarts.init`；出现即返工 |
| 4 | **时序折线**：Canvas 渲染器 + LTTB 采样 + `lazyUpdate: true` + 关闭动画（`animation: false`） | 折线初始化含 `{ renderer: 'canvas', lazyUpdate: true }` 且配置 `animation: false`；> 1000 点未采样即返工（采样兜底也必须可见） |
| 5 | **静态饼图**：SVG 渲染器 | `echarts.init(el, null, { renderer: 'svg' })`；无性能理由却用 Canvas 画饼图即返工 |
| 6 | **销毁**：组件卸载、切 Tab 必须 `dispose` 并置空引用；禁只移除 DOM 不 dispose | 视图 teardown 路径可见 `disposeChart` / `disposeAll` 调用且实例计数回落；只 `removeChild` / `innerHTML=''` / 仅置 `display:none` 即返工 |
| 7 | **resize 统一 100ms 防抖**：由 `web/charts.js` 单点绑定，不逐图各自绑定 | `web/charts.js` 是图表容器的唯一全局 resize 监听（100ms 防抖、实例表空即解绑）；图表页视图内不得再绑 `window` resize 或对图表容器 `ResizeObserver`。非图表模块的既有绑定（如 `terminal.js` 的 `visualViewport`）不属本条判定范围，但**不得借此放宽**图表侧 |
| 8 | **精简配置**：不需要的坐标轴、`tooltip`、高亮（`emphasis`）、标记点（`markPoint`）全部显式关闭 | 每份图表配置里上述项为 `show: false` 或不存在（时序图只保留必要坐标轴）；保留默认开启项即返工 |
| 9 | **单图数据 ≤ 1000 点**：超出由后端预聚合，前端只做兜底截断 / 抽样 | 后端返回点数 ≤ 1000（或显式声明已聚合）；前端 `series.data.length > 1000` 仍未采样即返工 |
| 10 | **验收口径**：满载（12 图）持续秒级刷新不卡顿、内存可回落、无泄漏 | 实现方须给：PC + 手机截图（G-28）、满载刷新 ≥ 10 分钟的 Performance 记录（帧率无持续下降、内存无持续上升）、dispose 后实例计数回 0；缺任一项即返工 |

**与既有门禁的关系**：

- **§7 首屏预算**：图表产物不列入首屏 `FILES`，300 KiB gzip 不因图表数增长；新增图表文件只要被误加进首屏口径即判 G-03 阻断级失败。预算口径的复核命令仍按 §7，图表体积另行按 §9 记录。
- **§9 构建清单**：`make charts` 产物平铺进 `web/dist`，是否进 `web/embed.go` 显式清单由实现方按 §13 落定；纳入后单二进制 ≤ 25 MiB 门禁不变，`*.map` 仍禁，复核命令见 §9。
- **G-03**：首屏 gzip 与单二进制两条硬红线都不得因图表放宽；图表只允许"懒加载后按需占体积"。
- **G-06**：图表契约命名、产物路径、构建目标或渲染器口径一变，必须同轮同步本节的表与 §7/§9 的对应句子，并更新 ADR-0027；文档与实现不一致不得合入。
- **G-28**：图表页属用户界面交付，双端截图与产品定位自评照旧，截图必须包含真实图表实例（不能只截空容器或用设计稿替代）。
