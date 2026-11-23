> 状态: accepted · 归属: architect · 更新: 2026-11-23 · 里程碑: M5
> ADR 状态: accepted（2026-11-23 增补裁决）· 关联: ../FRONTEND.md §4、.agents/LOG/DECISIONS.md 第 58 条（裁决40）

# ADR-0040: 插件 UI 分发链（v1.0 前不补，插件 UI = 主壳视图）

## 0. 背景与原始裁决

2026-11-22 的裁决（`.agents/LOG/DECISIONS.md` 第 58 条、`docs/FRONTEND.md` §4「插件 UI」）确定：插件 UI 走**独立站点 origin 的 iframe + postMessage RPC 桥**，产物以 `web/` 进包、安装到 `<pluginRoot>/<id>/<ver>/web/`，由内核以 `/plugin-assets/<id>@<ver>/` 版本化路径托管，`kore_csrf` 改 HttpOnly。

该裁决此前只落在 `FRONTEND.md` 与决策台账，**未单独落 ADR 正文**（`docs/DECISIONS/` 原只到 0029）。本文件是 2026-11-23 增补时补建的 ADR-0040，原始设计以上述两处为准；本文件只记录**实施现状与本次裁决**。

## 1. 实施现状（2026-11-23 核实，证据 `.agents/verify/plugin-ui-delivery.md` @ `53694c2`）

- **24 仓盘点**：仅 `kore-plugin-backup`（真页面 `web/index.html`）与 `kore-plugin-echo`（`web/.gitkeep`）有 `web/`；**24 仓 dist 里 `web/` 命中全为 0**。打包规则见 `kore-plugin-backup/Makefile:19`（只列 `info.json` + `bin/<id>` + `SHA256SUMS`）。
- **内核侧无路由**：`internal/core/httpapi/handlers.go:57-64` 只有 `/plugins`、`/plugins/{id}`、enable/disable/root-action/confirm-token/invoke，**没有 `/plugin-assets/`**；`web/app.js:925` 的 `frame.src` 指向**不存在的路径**；`httpapi/types.go:15-17` 的 `Entry` / `Styles` 字段**无人消费**（`Entry` 只用于 `bin/<id>`，见 `registry/validate.go:99`）。
- **安装侧**：解包逻辑存在（`installer_test.go:37` 断言 `web/index.js` 落到 `<pluginRoot>/<id>/<ver>/web/`），但**没有 serve 路径**，且 dist 里本来就没有 `web/` 可解。
- **运行证据**：`.agents/verify/` 中 `iframe` 命中全部是设计/决策文档，**没有任何「插件 iframe 加载成功」的截图或 URL 证据**——这条链从未端到端跑通。
- **影响面**：`kore-plugin-backup/web/index.html` 是**死代码**；主壳 `web/*.js` 共 **32 个**才是真实 UI；补全整条链约 **3–5 人日**（24 Makefile + 内核静态路由/独立 origin/CSP + 安装解包权限 + 桥白名单 + 双端验收 + 相关插件重发）。

## 2. 裁决（2026-11-23）

1. **v1.0 前不补**插件 iframe 分发链：不投入 3–5 人日去补一条从未被验证、且当前无任何插件真正需要的链路。
2. **插件 UI = 主壳视图**：所有插件界面在 `kore/web/<id>.js` 实现，走主壳导航、权限与响应式适配（裁决41）；插件不携带自己的前端入口。
3. 插件仓 `web/` 标记「**未启用、勿新增**」；已有 `backup/web/index.html` 的完整性校验页搬进主壳 `web/backups.js`（已另派，当天可交付）。
4. `docs/FRONTEND.md` §4 的 iframe 设计保留为**未来方案**，但必须标注「未实现」，避免再有人按它去建链。

## 3. 复审条件（何时应重新评估补链）

出现以下任一情况时重新评估，而不是永久关闭：

- 出现**必须由插件自带 UI 才能表达、主壳无法承载**的能力（插件自带交互式编辑器 / 图表 / 第三方生态 UI 独立演进）；
- 插件数量或更新频率使「每次 UI 改动都要发主壳」成为实际瓶颈；
- 插件生态需要**独立 origin 安全隔离**的真实诉求（当前无插件 UI，隔离收益为零）。

复审时必须先补端到端 PoC（dist 打包 + 内核 `/plugin-assets/` 静态路由 + 桥白名单 + 双端验收），再改本裁决；**不得只补打包、不补 serve**（当前 `web/app.js:925` 指向不存在路径的教训）。

## 4. 事故记录：插件注册依赖状态库（2026-11-23，ssh-guard 实测）

- `kored serve` 启动扫描插件目录时，会**跳过「目录存在但状态库未登记」的插件**，打 WARN：`插件目录存在但状态库未登记，跳过 plugin_id=…`。
- `kored install --package` 会打开 state.db 并原子落库安装；`--scenario` 当前只做参数解析并明确回未实现。**手工解包到 `state/plugins/` 不会写状态库**——目录在、进程不加载、面板看不到。
- 结论：**「手工解包」不等于安装**。离线安装必须先确认状态库已登记（`GET /api/v1/plugins` 可见），再排查文件权限/版本；否则会得到「文件都在、就是不出现在面板」的静默失败。
