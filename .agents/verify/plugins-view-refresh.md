# 已装插件页：进视图重拉（修复「装完看不到」）

> 2026-11-23 · kore-impl-monitor · 隔离 18883（portable）· commit 4d5fca0

## 改前/改后

- 改前 `renderPluginsView`（app.js:1805-1808）只渲染 `state.plugins` 缓存；安装后进视图不重拉，只有点「刷新列表」（app.js:791-793 → loadDashboard）才更新。
- 改后：进入视图先渲染缓存，再 `refreshPluginsView()` **补拉一次** `GET /api/v1/plugins`；数据有变化才 `renderDashboard()` 重绘，未变化不打断；401 走统一登录失效处理。无 `setInterval`/`setTimeout` 轮询，只有进入视图与手动刷新两个触发点。
- 刷新按钮行为不变。

## 证据（隔离 18883，商店装 file）

- 商店点安装 → `安装成功 · 已自动启用`；**未点刷新**，点左侧「已装插件」→ 立即出现 `tr[data-plugin-id=file]`（rows=1）。
- 5 秒内 `/api/v1/plugins` 资源请求数 7 → 7（无增长，证无轮询）。
- 截图：`plugins-stale-fix-desktop.png` **1440×901** full-page；`plugins-stale-fix-mobile.png` **390×844**；scrollWidth=innerWidth=1440/390。

## 门禁

`node --check web/app.js` 0；`make frontend` 0（首屏 gzip 60,926 → **61,187 B，+261 B**；app.js 在首屏，增量=一次补拉 + diff 守卫的代码，仍远低于 300 KiB 预算）；`make build` 0；另 `make docs-check` 未跑（本卡未要求，docs 另有卡）。

## store.js 配合

不需要：安装后无事件也能靠「进视图拉一次」兜住；若未来要避免重复请求，可让 store.js 安装成功后置 `state.pluginsStale=true`（本卡不改 store.js，仅报告）。

## 清理

18883 无监听、`/tmp/kore-app192` 已删；主实例 8787 零写入（仅 healthz 200）。
