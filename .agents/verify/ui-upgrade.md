# UI 升级检测与一键升级 · 真机验收

> 状态: PASS（真机验证 + 双端截图；4 个插件真实升级，门禁全绿） · 里程碑: M0–M5 · 2026-11-23T04:58+08:00 · 实例 PID 545729

## 1. 方案选择：A（后端对齐）

选 A：`GET /api/v1/plugins` 每条已装记录增加 `latest_version` / `latest_sha256` / `update_available`。
理由：内核已持有已验签索引与已装清单，一次调用即可给前端完整数据；前端不必同时拉两个接口、也不必复制索引读取与验签口径。G-01 边界：`httpapi.alignIndexVersions` 只按 id 对齐两个数据源、比较版本字符串是否相同，不判方向、不判策略；索引不可读时字段留空并 WARN，已装插件页不因商店故障整体不可用。

## 2. 四态逻辑（web/store.js + web/app.js）

| 状态 | 判定 | 商店卡片 | 已装插件行 |
| --- | --- | --- | --- |
| 未安装 | 无已装记录 | 安装 / 离线安装 | — |
| 已安装（最新） | 索引版本 == 已装版本 | 「已安装 ✅」「已是最新」+ 重装 | 最新版本灰字 |
| 可升级 | 索引版本 > 已装版本（semver 三段数字） | 「可升级 v旧 → v新」+ 主按钮「升级到 v新」 | 黄字 `v旧 → v新` + 「升级」按钮 |
| 索引未收录 | 已装但索引无此 id，或索引版本 ≤ 已装版本 | 「索引未收录」灰标，重装禁用 | 灰字「索引未收录」 |

升级走 `POST /api/v1/store/install {download:true, force:true, version:索引版本}`；确认面板明示「当前 v旧 → 新 v新；升级会保留配置与启用状态」。成功状态显示「已升级到 vX · 已重新启用/保持停用（reload）」，失败显示后端 message + 按错误码补 hint。

## 3. 真机升级 db-mysql（前后版本）

- 升级前：`GET /api/v1/plugins` → `db-mysql 0.1.0`，索引 `0.2.0`，`update_available=true`；商店卡片按钮「升级到 v0.2.0」。
- 确认面板：`当前 v0.1.0 → 新 v0.2.0；升级会保留配置与启用状态。`
- 执行：点击确认 → `POST /store/install {id:db-mysql,version:0.2.0,download:true,force:true}` → 200。
- 升级后：API `db-mysql 0.2.0`、`latest_version=0.2.0`、`update_available=false`、`desired=enabled`；卡片「已是最新」。
- 另一条真实响应（process 0.1.0→0.1.1）验证升级语义字段：
  `{"previous_version":"0.1.0","stale_versions":["0.1.0"],"reload":"restarted","message":"已从 v0.1.0 升级到 v0.1.1"}`。
- 旧版本目录：磁盘保留 `db-mysql/0.1.0`，响应 `stale_versions` 回传；内核**不自动删除**，卡片成功状态提示「旧版本 … 目录保留，可手动清理」。未新增删除端点（避免扩大 API 面）。

## 4. 一键全部升级

`web/app.js` 与 `web/store.js` 各自实现固定清单串行升级：进度写「正在升级 N/M · 插件（v旧 → v新）」，失败收集后一次性列出、不中断剩余队列；完成后刷新列表与汇总。实测点击后 1/12 → 2/12 → 3/12，截图抓到 `正在升级 1/12 · backup（v0.2.0 → v0.2.1）`；按任务允许只验证流程，本轮实际完成 backup、container 两个批量升级后停止。

## 5. 首屏数字

- 升级前商店/已装插件页：**14 个已安装，13 个可升级**（桌面截图证据）。
- db-mysql 升级后：14 个已安装，12 个可升级。
- 本轮共真实升级 4 个：db-mysql 0.2.0、backup 0.2.1、container 0.2.0、process 0.1.1；当前余 **9 个可升级**（真实状态，未回滚）。

## 6. 截图（`.agents/verify/screenshots/`，实测宽高 + sha256 前 12）

| 文件 | 尺寸 | sha256 | 前后断言 |
| --- | --- | --- | --- |
| upgrade-store-desktop.png | 1440×2116 | 0fd8e08678cc | 已登录 + 「14 个已安装，13 个可升级」+ db-mysql「升级到 v0.2.0」 |
| upgrade-store-mobile.png | 390×844 | bce430c4d974 | 已登录 + 汇总条 + 「12 个可升级」 |
| upgrade-plugins-desktop.png | 1440×1480 | 87fedef04c09 | 已登录 + 「最新版本」列 + `0.1.0 → 0.2.0` 黄标 + 13 个升级按钮 |
| upgrade-plugins-mobile.png | 390×844 | b44df79fb204 | 已登录 + 最新版本列 + 升级按钮 |
| upgrade-db-mysql-confirm-desktop.png | 1440×900 | 5ae76c583857 | 确认面板「当前 v0.1.0 → 新 v0.2.0」「保留配置与启用状态」 |
| upgrade-db-mysql-after-desktop.png | 1440×2076 | 883155b0f9dc | 「已是最新」+「12 个可升级」 |
| upgrade-batch-progress-desktop.png | 1440×900 | 22c37482e4df | 「正在升级 1/12 · backup（v0.2.0 → v0.2.1）」 |

每张截图前/后各做一次 DOM 断言（无登录表单、顶栏含「退出」、页面特征文本命中），7 张 sha256 两两不同。移动端商店在 db-mysql 升级后采集，故计数为 12；桌面基线图保留升级前 13。

## 7. 门禁退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `go test -timeout 200s ./...` | 0 | 全部 ok |
| `make check` | 0 | 5 项全绿（docs/依赖/薄壳/仓库边界/前端首屏 42,015 B） |
| `make frontend` | 0 | 首屏 42,015 B ≤ 307,200 B |
| `make docs-check` | 0 | 5 pass / 1 WARN（RELEASE.md 40 行，既有） / 0 fail |

## 8. 环境说明与剩余风险

- **索引签名**：`kore-plugins` HEAD（9c3a24f）刚把 discover 0.2.0 写入索引，签名待下一轮统一重签；直接指向该目录会 401。为完成真机验收，本地未跟踪配置 `.kore-local.yaml` 的 `index_dir` 指向冻结已验签快照 `.kore-local-state/signed-index/`（来自 kore-plugins d38862c，13 个版本差）。**未改索引仓库、未改签名**。
- 测试实例已按需重启（原 PID 481149 → 545729）以加载新二进制与快照；新二进制构建自本次改动。
- 产品定位自评：本页解决「版本落后不可见、无升级入口」；对比宝塔/1Panel 的更新红点与一键升级，当前达 **可用**（四态、单个升级、批量进度、失败可见）；差距：无更新日志、无自动更新策略、无回滚 UI、旧版本清理仅提示。
