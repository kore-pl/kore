# 插件 UI 分发链核实（task-194，2026-11-23）

> 结论先行：**机制未端到端实现；插件仓 `web/` 目前是死代码；真实 UI 走主壳视图 `kore/web/<id>.js`。**
> 证据均在下方，未运行任何服务、未改代码。

## 1. 24 仓盘点（web/ 与 dist 内容）

命令：
```
for d in kore-plugin-*; do w=$(git -C $d ls-tree -r --name-only HEAD web/ | wc -l);
  dist=$(ls $d/dist/*.tar.gz 2>/dev/null | tail -1);
  c=$(tar tzf "$dist" 2>/dev/null | grep -cE '^\.?/?web/'); echo "$d web=$w dist_web=$c"; done
```
结果摘要：
- **仅 2 个仓有 `web/`**：`kore-plugin-backup`（`web/index.html`，1 个真页面）、`kore-plugin-echo`（`web/.gitkeep` 占位）。
- 其余 **22 仓无 `web/` 目录**。
- **所有 24 仓的 dist 里 `web/` 命中 = 0**（`backup-0.4.2.tar.gz` 只有 `info.json` / `bin/backup` / `SHA256SUMS`）。
- 打包规则见 `kore-plugin-backup/Makefile:19`：「info.json + bin/<id> + SHA256SUMS，显式列条目」——**没有 web/**。

## 2. 内核侧：有没有服务插件 UI 的路由 / iframe 桥？

```
grep -rn "iframe\|plugin-ui\|pluginui\|postMessage" internal/core cmd web/*.js
```
- **前端有 iframe 桥代码（但是"目标态"写法）**：`web/app.js:925` 把 frame.src 写成
  `https://<asset-origin>/plugin-assets/<id>@<ver>/index.html`；`:1015` / `:1078` 的 `postMessage` 桥、`:1127` 创建 iframe。
- **内核没有对应路由**：`internal/core/httpapi/handlers.go:57-64` 只有 `GET /plugins`、`GET /plugins/{id}`、enable/disable/root-action/confirm-token/invoke；**没有 `/plugin-assets/` 或任何按插件 id 提供静态资源的 handler**。
- `internal/core/httpapi/types.go:15-17` 虽定义了 iframe 文档用的 `Entry` / `Styles` 字段，但**没有任何代码消费它们**（grep `\.Entry` 只命中 `bin/<id>` 可执行入口，见 `registry/validate.go:99`）。
- `middleware.go:138` 的注释提到「客户端 UI 改走独立 origin iframe + postMessage 桥」——**注释是设计意图，不是实现**。

## 3. 安装侧：解包 web/ 吗？

```
grep -rn "web" internal/core/installer/*.go
```
- 解包逻辑存在：`installer_test.go:37` 断言 `web/index.js` 被放到 `<pluginRoot>/<id>/<ver>/web/`（`archive_test.go:120` 也构造 web 条目）。
- 但**没有 serve 路径**（见 §2），且 dist 里没有 web/ 可解，所以实际安装后也不会有 web/。

## 4. 历史上有没有人在 iframe 里加载成功过？

```
grep -rln "iframe" .agents/verify/*.md
```
- 命中均为**设计与决策类**（`ui-decision-analysis.md`、`web-settings-ui.md`、`browser-e2e.md`、`app-deploy-ui.md`、`round1-full-evidence-raw.json`），**没有任何「插件 iframe 加载成功」的运行证据**（截图/URL 命中）。
- 结论：这条链**从未被端到端验证过**。

## 5. 三选一结论

**选 b（机制尚未实现），并附带 c 的事实（当前 UI 走主壳）。**

- 不是「只差 dist 打包」：即使补上 24 个 Makefile 的 tar 条目，也**没有内核路由**去 serve `/plugin-assets/<id>@<ver>/`，iframe 仍拿不到文档（`web/app.js:925` 指向一个不存在的路径）。
- 也不是「主壳视图方案」能解释全部：ADR-0040 明确插件 UI 走独立 origin iframe，前端桥与 manifest 字段都按这个方向写了，但**内核服务端与打包两端都缺**，属于「设计已定、实现半途」。
- 当前**真实可用的 UI 全部在主壳**：`kore/web/*.js` 共 **32 个**（`ls kore/web/*.js | wc -l`），包括 `backups.js`、`container.js`、`db-l2.js` 等按插件能力做的视图。

## 6. 影响面

- **死代码**：`kore-plugin-backup/web/index.html`（含本轮刚做的「完整性校验」按钮）——**按当前 dist 永远到不了用户机器**；`echo/web/.gitkeep` 仅占位，无影响。
- **可复用**：若把 backup 的校验页搬进主壳 `kore/web/backups.js`，是**当天可交付**的替代路径（1–2 小时）。
- **补全链路的工作量**（若要按 ADR-0040 走通）：dist 打包规则（24 Makefile，实际只有 2 仓有 web/）+ 内核 `/plugin-assets/<id>@<ver>/*` 静态路由（含独立 origin/CSP）+ 安装解包与权限 + 桥白名单与 CSRF 校验 + 双端截图验收 ≈ **3–5 人日**，且需重发相关插件版本。
- **建议（供 lead 裁决）**：v1.0 前**不补**插件 iframe 链路，明确「插件 UI = 主壳视图」并在 `PLUGIN-MATURITY`/`FRONTEND` 标注；插件仓 `web/` 标记为"未启用、勿新增"，把 backup 校验页搬进主壳。

## 7. 证据清单（可复跑）

```
for d in kore-plugin-*; do ...; done                      # §1 盘点
grep -rn "iframe|plugin-ui|postMessage" internal/core cmd web/*.js   # §2
grep -rn "web" internal/core/installer/*.go               # §3
grep -rln "iframe" .agents/verify/*.md                    # §4
ls kore/web/*.js | wc -l                                  # 32 个主壳视图
```
