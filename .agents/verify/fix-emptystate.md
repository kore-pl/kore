> 元信息: 2026-11-23T08:52+08:00 · 执行者 fix-emptystate 子 agent · db-postgres 空态 hint + 方法名契约文档 + PG 前端（方案 A） · 报告 ≤60 行

## 1. 结论
- 问题 1（文档）：`docs/PLUGIN-PROTOCOL.md` 新增 **§7.2.1 方法名调用契约**（固定调用形态 / 必须带域前缀 / 裸名一律 `E_NOTFOUND` / 对错对照表）；`docs/FRONTEND.md` §2.1 调用约定补一句实测口径。
- 问题 2（UX）：`db-postgres.instances` 空态与全不可达返回 `hint`；前端 `web/db.js` 选 **方案 A**（MySQL / PostgreSQL 类型切换，统一实例卡 / 库列表 / 查询台）。

## 2. 插件（`../kore-plugin-db-postgres` 0.2.0 → 0.2.1）
- `instances.go`：`instancesHint()`——`count=0` → 「尚未配置 PostgreSQL 连接。请在插件设置里填写 host/port/user/password，或用 KORE_PG_HOST 等环境变量」；有实例但全部不可达 → 「配置了 N 个实例但均不可达，请检查 host/port 与网络」；有可达实例 → 不带 `hint`。
- `types.go`：`InstancesResult.Hint`（`json:"hint,omitempty"`）；调用始终 200，空列表不是错误。
- 单测 `TestCallInstancesHint`：空实例 / 全部不可达 / 至少一个可达三条分支。
- 版本：`info.json` + `manifest.json` = 0.2.1；`CHANGELOG.md` 0.2.1 条目；README 方法表补 `hint`。
- 门禁：`make check` exit 0（gofmt clean + vet + 5 包 test 全绿）。
- `make dist` 连续两次 exit 0，sha256 一致：`a92cc13140a74954d1b36d3d28e009b83a66a490ac2e25071bdaa308d84b9389`（`dist/db-postgres-0.2.1.tar.gz`，size_bytes 声明=实际=1523427）。

## 3. 前端（方案 A，`web/db.js`）
- 页头新增 `MySQL / PostgreSQL` 分段切换（`aria-pressed`，选择记 localStorage）；`methodFor()` 按类型拼 `db-mysql.*` / `db-postgres.*` 完整限定名，无裸名回退。
- PG：实例卡（端口默认 5432）、状态卡（连接数/库数/运行时长/缓存命中率/命中块）、库列表（`[{name,size_bytes}]` 归一为名字）、只读查询台（SELECT/SHOW/EXPLAIN/WITH）、配置面板走 `KoreShell.openConfig(..., 'db-postgres')`。
- PG 空态原样展示后端 `hint` + 「配置连接 / 重新读取」；不可达实例卡用 PG 版「怎么办」。MySQL 的 discover 一键连接与 L2（建库/用户/导入导出）保持原样；PG 隐藏 L2 并标注「本版只读」。
- 双向切换实测（浏览器）：MySQL 显示已连通实例（127.0.0.1:3306 · 9.7.1）→ PG 显示空态引导 → 切回 MySQL 横幅恢复「已连接 MySQL 9.7.1」。

## 4. 真机证据（8787，重启后 PID 1883713）
- 升级：停旧进程（PID 1726888）→ `make build`（新前端编入二进制）→ `./bin/kored install --package .../db-postgres-0.2.1.tar.gz`（exit 0，`installed db-postgres 0.2.1`）→ `setsid ./bin/kored serve --config .kore-local.yaml` → `/-/healthz` 200；`/plugins` 报 `db-postgres 0.2.1 enabled=true`。
- G-29 复核：`/api/v1/system/info` 的 `paths.index_dir` = `/home/pt/Work/GolandProjects/kore-plugins/index`，配置未改。本轮改动运行态资产：`bin/kored` 重建、插件升级至 0.2.1、kored 重启（在此声明）。
- `POST /api/v1/invoke/db-postgres/db-postgres.instances` → 200：
  `{"instances":[],"count":0,"hint":"尚未配置 PostgreSQL 连接。请在插件设置里填写 host/port/user/password，或用 KORE_PG_HOST 等环境变量"}`
- `POST /api/v1/invoke/db-postgres/instances` → **HTTP 404** `{"code":"E_NOTFOUND","message":"未知方法: instances"}`（协议不变）。
- 回归：`db-mysql.instances` → 200 且 `reachable=true`（9.7.1）；`db-postgres.config.get` → 6 字段 schema，密码字段回空串。
- 截图（G-28）：`screenshots/pg-empty-state-desktop-20261123.png` 1440×900、`pg-empty-state-mobile-20261123.png` 390×844；实测文本含 hint，PG 分段 `aria-pressed=true`。
- 产品定位自评：①本页解决「装了 PG 插件却看不到、空列表不知下一步」——类型切换 + 空态引导 + 一键配置；②与宝塔/1Panel 差距：PG 前端只读（无建库/建用户/导入导出），MySQL 侧有 L2；③当前状态：**可用**（探测/库列表/只读查询/配置），非占位。

## 5. 门禁（kore）
- `make docs-check` exit 0（5 pass / 1 warn：PLUGIN-PROTOCOL 414 行 > 400 软上限，非阻断；RELEASE.md 40 行为既有 WARN）。
- `make frontend` exit 0（首屏 gzip 44558 B ≤ 307200 B）。
- `make check` exit 0（聚合 8 段全绿，末尾 `[OK] 门禁全部通过`）。

## 6. 提交与边界
- kore：`fix(db-postgres,web): 空态引导 + 方法名契约文档`（docs 2 份 + web/db.js + 本报告 + 2 张截图）。
- kore-plugin-db-postgres：同一条 message（6 个文件，`dist/` 被 .gitignore 忽略，不提交）。
- 未 push；插件未打 tag / 未发 release（索引未重签）。发版需 lead 决定后 push + tag + release，并提醒重签索引。
