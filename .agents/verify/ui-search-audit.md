# UI 验收：全局搜索 + 操作审计（G-28）

> 状态: 已验收 | 里程碑: M0–M5 | 场景: R4 主壳通用能力 | 实例: 127.0.0.1:8787（重启后 PID 1435231）

## 1. 端点真契约（先读源码再写前端）

`GET /api/v1/audit` 的真实契约与任务描述不同：`since`（RFC3339）**必填**、`limit` 默认 100 / 上限 1000、**没有 offset**、单条记录**没有时间字段**（时间在 bbolt 键 `%020d-%06d` 的纳秒前缀里）。前端需要「时间列 + 最新优先 + 加载更多」，因此本轮做了最小加法（不改存储结构）：
- `handlers_audit.go`：DTO 增 `at`（由键派生的 RFC3339Nano，仅响应字段）；`AuditQuery` 增 `Desc`，`order=asc|desc`（默认 asc，非法值 400）。
- `cmd/kored/audit.go`：装配层按 `since` 过滤后按需倒序，再套 `limit`。
- 文档同步 `docs/DATA-MODEL.md §9`；新增测试覆盖 `at`、`order` 透传、倒序截断。

## 2. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/search.js` / `web/audit.js` | 0 / 0 | 语法通过（search 250 行 / audit 193 行） |
| `make frontend` | 0 | 25 文件；首屏 44558 B gzip |
| `make docs-check` | 0 | 5 pass / 1 WARN（RELEASE.md 行数，历史）/ 0 fail |
| `make check` | 0 | 11 段全绿，含 frontend / secret / thin-shell |
| `go vet ./...` | 0 | 无输出 |
| `go test -timeout 200s ./...` | 0 | 13 包 ok |
| `make build` | 0 | bin/kored 9,007,266 B |

首屏：改前 43,397 B → 改后 44,558 B（**+1,161 B gzip**，预算余量 262,642 B）。懒加载真机验证（performance resource）：进入面板后 `[]` → 打开搜索后才出现 `search.js` → 切审计 tab 后才出现 `audit.js`。

## 3. 搜索四源与交互（真机 CDP 操作 + 截图）

- 输入「数据」：`跳转到 数据库` / `打开插件详情 · MySQL/MariaDB 管理插件` / `打开插件详情 · Redis 管理插件` / `去商店安装 · PostgreSQL 管理插件` / `执行：新建数据库`；**Enter 后 `location.hash === "#/db"`**。
- 输入「备份」：`跳转到 备份` / `打开插件详情 · 备份插件` / `执行：创建备份`（页面 + 插件 + 操作三组）。
- 输入「zzz」：`没找到「zzz」，试试：数据库 / 站点 / 备份`。
- 动作落地：执行「新建数据库」→ hash `#/db`，并真实弹出 `.kore-modal` 标题「新建数据库」（db-l2 懒加载链打通）。
- 交互实现：200ms 防抖、分组各 ≤5、↑↓/Enter/Esc、顶栏入口与 Ctrl/Cmd+K、手机端入口为 44px 图标。

## 4. 审计列表与筛选（真实数据）

- 产生记录的真实操作：登录（当前版本**未接审计**，源码只有四类生命周期 + `root.action` + `capability.denied` 落库）、`POST /plugins/file/disable`、`POST /plugins/file/enable`（07:28:05 两条）、`POST /invoke/db-mysql/db-mysql.instances`（返回真实实例，但 invoke 当前也**未接审计**）。报告如实记录，未伪造登录/调用审计。
- 列表：50 条/页，真实时间列（如 `2026/11/23 07:28:57`）、操作者、动作、目标、三色结果、可折叠详情；「加载更多（剩余 950 条）」。
- 筛选「denied」：36 条全部为 denied（firewall `root.action` / `ufw-status` / `deny_reason=not_root`），证明筛选不是摆设。
- 快照上限 1000 条并在页面明示；动作下拉从已加载数据聚合 distinct action。

## 5. 截图（`file`/`identify` 实测）

| 文件 | 尺寸 | 内容 |
| --- | --- | --- |
| `.agents/verify/screenshots/search-desktop-01-data.png` | 1280x800 | 数据四源结果 + 选中态 |
| `.agents/verify/screenshots/search-desktop-02-backup.png` | 1280x800 | 备份页 + 插件 + 操作 |
| `.agents/verify/screenshots/search-empty-desktop-03-zzz.png` | 1280x800 | 空态提示 |
| `.agents/verify/screenshots/search-mobile-01-data.png` | 390x844 | 手机端图标入口 + 面板 |
| `.agents/verify/screenshots/search-empty-mobile-03-zzz.png` | 390x844 | 手机空态 |
| `.agents/verify/screenshots/audit-desktop-01-list.png` | 1280x2168 | 设置 tab + 真实列表 + 加载更多（full-page） |
| `.agents/verify/screenshots/audit-desktop-02-denied.png` | 1280x1614 | denied 筛选 36 条（full-page） |
| `.agents/verify/screenshots/audit-mobile-01-list.png` | 390x844 | 手机端 tab + 卡片式列表 |

## 6. 产品定位自评（G-28 三问）

- **解决什么**：主壳 16 个视图 + 插件 + 商店 + 常用动作此前没有统一入口，用户只能靠侧栏逐项找；审计后端有数据、前端 0 入口，危险动作无迹可查。现在一个 Ctrl+K 直达，设置页一处留痕。
- **与宝塔 / 1Panel 差距**：宝塔/1Panel 的全局搜索偏「菜单搜索」，本页做到页面/插件/商店/动作四源并可直接执行动作；差距是没有跨插件业务内容搜索（如按域名搜站点配置）、审计没有 CSV 导出与保留策略可视化、没有命令面板式历史。当前是**可用**（真实 API、真实跳转、真实三色与筛选），不是占位。
- **边界**：搜索插件/商店数据首开拉一次并缓存；审计为「最近 1000 条快照 + 前端筛选/分页」，不是服务端全量分页（接口无 offset、无 result 过滤）；登录与 invoke 审计待后端接入，页面不编造。

## 7. 运行态与回切（G-29）

本轮**未修改** `.kore-local.yaml`；为加载新 embed 资产重启了 8787（旧 PID 1376988 → 新 PID 1435231，启动参数/环境变量保持一致）。复核：`system/info.paths.index_dir = /home/pt/Work/GolandProjects/kore-plugins/index`（与配置一致），商店 24 条，`/_healthz` 正常。提交为本地 commit，未 push。
