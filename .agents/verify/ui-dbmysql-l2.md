# UI 数据库页 L2 验收报告（建库 / 删库 / 用户 / 授权 / 导入导出）

> 元信息: 2026-11-23T06:25+08:00 · 执行者 ui-dbmysql-l2 · 隔离实例 18861 · 真机 chromium 1248 + playwright-core · 报告 ≤80 行

## 0. 环境与真相

- 任务开始时 **8787 的 db-mysql 是 0.2.0**（`/api/v1/plugins`），按派发口径改用隔离实例 `127.0.0.1:18861`（state / run / log 全在 `/tmp/kore-l2-test`，`store.allow_unsigned=true`），安装本地包 `dist/db-mysql-0.3.0.tar.gz` 并启用，实测 `db-mysql 0.3.0`。
- 数据库：本机 MySQL **9.7.1** @`127.0.0.1:3306`（沿用主实例 root 凭据，密码只走 env；不进 argv / 文件 / 本报告）；导出根 `KORE_DB_EXPORT_DIR=/tmp/kore-l2-test/exports`。
- **8787 全程未写**：验收前后 `/-/healthz` 均 200，未改主实例配置 / state / `bin/kored`。任务期间并行 agent 把 8787 的 db-mysql 升到 0.3.0，非本轨改动。
- 前端二进制在 `/tmp/kore-l2-build`（rsync 副本）接线后 `make frontend` + `go build` 到 `/tmp/kore-l2-test/kored`，**不在共享树重建 `bin/kored`**（G-29 运行态写边界）。

## 1. 实现（改动面）

- `web/db.js`（585→717）：库行拆为「名称按钮 + 导出 / 删除」；工具栏「新建数据库 / 导入 / 显示系统库」；「用户与授权」折叠区（展开才注入 L2）；`ensureL2()` / `l2Ctx()` / `withL2()` 懒加载器 + 行布局样式。
- `web/db-l2.js`（新增 **419 行 ≤420**）：声明式弹层 + 全部 L2 动作 —— `createDatabase`（库名 `^[a-zA-Z0-9_]{1,64}$` + 字符集 utf8mb4/utf8/latin1）、`dropDatabase`（**手输库名**解锁，`confirm:true`）、`createUser`（host 默认 `%`、24 位随机密码 + 复制按钮、可选授权）、`grant`（9 种权限多选）、`dropUser`（**手输用户名**，root 行无入口）、`export`（预填 `<库名>-<时间戳>.sql`）、`import`（红框警告「会写入目标库」）。
- 接线：`Makefile` 的 `WEB_SRC_FILES`、`web/embed.go` 的 `//go:embed`（22→23 文件）、`docs/FRONTEND.md` / `QUICKSTART.md` 口径同步（G-06）。
- 错误呈现：一律后端 `code：message` 原文 + 按错误码给「怎么办」（E_UNAUTHORIZED / E_INVALID / E_NOTFOUND / E_CONFLICT / E_UPSTREAM / 文件不存在）。

## 2. 真机链路（浏览器真实点击，22 项断言 PASS · 桌面 + 移动各一轮）

| 步骤 | 结果与证据 |
| --- | --- |
| 新建库 `kore_ui_test` | 列表出现 + 绿条「创建成功」；字符集默认 utf8mb4（断言）· `dbl2-create-db-desktop-01-created` |
| 建用户 `kore_ui_user@%` + 授权 SELECT | 用户表出现；`SHOW GRANTS` = `GRANT SELECT ON \`kore_ui_test\`.* TO \`kore_ui_user\`@\`%\`` · `dbl2-users-desktop-01-created` |
| 导出 | 预填 `kore_ui_test-<ts>.sql`；落盘 `/tmp/kore-l2-test/exports/kore_ui_test-20261123-062146.sql`（1337 B，脚本内 `existsSync` 断言）· `dbl2-export-desktop-01-exported` |
| 删库（手输确认） | 未输入时「永久删除」`disabled`；输入完全一致才解锁；确认后行消失 · `dbl2-drop-confirm-desktop-00-modal` / `-02-done` |
| 删用户（手输确认） | 同上；root 行只显示「root 不可删除」，无删除按钮 · 断言覆盖 |
| 系统库 | 勾选「显示系统库」后 `mysql` / `information_schema` / `performance_schema` / `sys` 行**无删除按钮**、导出仍在；非系统库仍有删除 · `dbl2-system-db-desktop-01-no-delete` |
| 错误呈现 | 导入不存在的文件 → `E_INVALID：文件不存在: …` + 「怎么办：路径必须落在导出目录内…」· `dbl2-import-error-desktop-01-error` |

- 移动端（390×844）同流程全 PASS，`scrollWidth == innerWidth == 390`（无整页横向滚动）；移动导出落盘 `kore_ui_test_m-20261123-062415.sql`（1339 B）。

## 3. 双端截图（G-28）

| 场景 | 桌面（1440 宽） | 手机（390 宽） |
| --- | --- | --- |
| 建库 | `dbl2-create-db-desktop-00-modal` / `-01-created` | `dbl2-create-db-mobile-00-modal` / `-01-created` |
| 用户与授权 | `dbl2-users-desktop-01-created` | `dbl2-users-mobile-01-created` |
| 导出 | `dbl2-export-desktop-00-modal` / `-01-exported` | `dbl2-export-mobile-00-modal` / `-01-exported` |
| 删库确认 | `dbl2-drop-confirm-desktop-00-modal` / `-02-done` | `dbl2-drop-confirm-mobile-00-modal` / `-02-done` |
| 系统库无删除（附） | `dbl2-system-db-desktop-01-no-delete` | `dbl2-system-db-mobile-01-no-delete` |
| 错误呈现（附） | `dbl2-import-error-desktop-01-error` | `dbl2-import-error-mobile-01-error` |

全部为 `fullPage` 实拍，18 张 sha256 两两不同；实测尺寸桌面 1440×1003…1558、手机 390×1637…2259（`identify` 回读）。

## 4. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/db.js` / `web/db-l2.js` | 0 / 0 | — |
| `make frontend` | 0 | 23 文件；首屏 gzip **43,381 B / 307,200 B** |
| `make docs-check` | 0 | 5 pass / 1 warn（既有 `docs/RELEASE.md` 行数）/ 0 fail |
| `make vet` | 0 | `go vet` 通过（新 embed 路径可编译） |
| `make check` | 0 | 11/11 段全绿；secret-check 0 FAIL / 7 处占位合规 |

## 5. 首屏数字

首屏四件套 gzip 合计 **43,381 B**（index 683 + style 16,997 + app 18,564 + shell 7,137）/ 预算 307,200 B，余量 263,819 B。`db.js` 不计首屏（视图按需注入），`db-l2.js` 再晚一步（首次写操作 / 展开用户区才注入）。

## 6. 产品定位自评（G-28 三问）

1. **解决什么用户问题**：不登 SSH、不手写 SQL 就能建库建号、授权、导出导入；删库/删用户必须手输名字，把误操作成本从「误点一下」抬到「抄一遍名字」。
2. **与宝塔 / 1Panel 差距**：对方有表结构编辑、权限模板、定时备份与恢复向导、导出进度；本页是单实例、同步调用（大库导入导出会顶到 10 分钟超时），没有导出文件列表 / 下载、没有 GRANT 回显（需手跑 SHOW GRANTS）。
3. **可用还是占位**：**可用**——真实例、真写操作、真错误、真危险确认；但不是完整 DBA 面板。

## 7. 清理与残留

- 18861 实例已停止；`/tmp/kore-l2-test`（state / exports / 日志）保留作证据，`/tmp/kore-l2-build` 与 E2E 脚本在 `/tmp`，均未进仓库。
- 测试对象已删净：`db-mysql.databases` 无 `kore_ui_test*`，`mysql.user` 无 `kore_ui*`。

## 8. 口径偏差（必须披露）

`web/db.js` 由 585 行增至 **717 行**，未达成「≤420」：既有 L1（实例卡 / 自动检测 / 只读 SQL 台）本就 585 行，本轮只加 132 行挂载点与行布局；**L2 逻辑全部落在 `db-l2.js`（419 行 ≤420）**。若要求 `db.js` 回到 420，需先拆既有 L1，超出本次授权范围。
