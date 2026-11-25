# PG 备份 / 恢复（竞品清单条目 8）验收报告

日期：2026-11-25 11:25（Asia/Shanghai）｜Owner：`feat-pg-backup`｜写域：`kore-plugin-db-postgres` + `kore/web/db.js` / `kore/web/db-l2.js` / 本报告与截图

## 0. 结论

PG 备份/恢复能力已补齐，与 db-mysql 的 export/import 口径一致：**备份（pg_dump，custom 归档或 SQL、库级/表级、压缩可选）→ 恢复（pg_restore / psql，强制 confirm，恢复前自动快照）→ 列表 / 下载 / 删除**。真机（隔离 kore 实例 + 真实 PostgreSQL 16 容器）点通，双端截图齐备，门禁全绿。

## 1. 依据：竞品清单条目 8（MySQL 有 export/import，PG 没有）

| 域 | 改动前现状（path:line） | 改动 |
| --- | --- | --- |
| MySQL | `kore-plugin-db-mysql/internal/mysqlop/transfer.go:17` `callExport` / `:65` `callImport`；执行面 `client_transfer.go:26` `Export` / `:78` `Import` | 未改动（参照口径） |
| PostgreSQL | 0.3.5 的 `internal/pgop/call.go` `businessVerb` 只有 instances/databases/query/status/slowlog + 6 个写方法，**无 export/import**；`kore/web/db.js:562` 处对 PG 直接隐藏导出入口，注释写「PG info.json 无该方法」 | 新增 5 方法（下表）+ 页面入口 |

新增方法（`kore-plugin-db-postgres/internal/pgop/backup.go:199/277/367/437/471`，执行面 `client_backup.go:57/141`）：

- `db-postgres.backup`：`pg_dump --format=custom|plain`、`-t` 表级、`--schema-only`、`--compress 0-9`（custom 由 pg_dump 压缩，sql 由进程内 gzip）；缺省文件名 `<库>-<时间戳>.dump|.sql|.sql.gz`；>1 GiB 拒绝并删半成品。
- `db-postgres.restore`：按**文件头**判定格式（`PGDMP`→pg_restore，`1f8b`→gzip SQL，其余→SQL）；custom 走 `pg_restore --clean --if-exists --single-transaction --no-owner --no-privileges`，SQL 走 psql 且 stdin 首尾包 `BEGIN/COMMIT`（ON_ERROR_STOP=1，失败整体回滚）；**强制 confirm=true**；恢复前自动快照 `<库>-prerestore-<时间戳>.dump`（可 `snapshot:false` 关闭，快照失败即中止恢复）；目标库不存在时 `create_database:true` 自动建库。
- `db-postgres.backupList` / `backupDelete` / `backupDownload`（4 MiB 分块 base64，前端拼 Blob 另存）。

一致性：备份根目录与 db-mysql 共用 `KORE_DB_EXPORT_DIR`（缺省 `<state>/exports`），路径白名单语义同源（`backuppath.go` 对应 `mysqlop/path.go`），列表按文件头跳过 mysqldump 产物。

安全：固定 argv（库名只作最后位置参数、表名只经 `--table=`，不经 shell）；口令只走 PGPASSWORD（psql 模式）或 stdin 首行（docker exec 模式），不进 argv/日志/响应；备份文件 0600。

## 2. 用户可见行为（真机）

隔离实例：`kored serve --config /tmp/kore-pg-shots/config.yaml`（127.0.0.1:18873，state/run/log 全落 /tmp），插件 `kored install --package dist/db-postgres-0.4.0.tar.gz`（exit 0，`installed db-postgres 0.4.0`），PostgreSQL 16.16 容器 `kore-pg-test`（发布端口 15432）。

页面点击（Playwright，真实登录后操作）：

```text
[instances text] 默认连接 可达 127.0.0.1:15432 PostgreSQL 16.16 on x86_64-pc-linux-musl
[backup notice] 已备份到 /tmp/kore-pg-shots/exports/kore_ui_demo-20261125-112205.dump（1.6 KiB，pg_dump -Z 6）。下载或恢复：工具栏「备份文件」。
[backup files rows] 1（PC）/ 2（手机，含上一轮文件）
[restore warn] 恢复会先删除目标库里的同名对象再重建（pg_restore --clean --if-exists，全程单事务）…
SHOTS_OK  node_exit=0
```

真机 E2E（黑盒，真实 pg_dump/pg_restore/psql，不 mock）：

```text
$ KORE_PG_E2E=1 go test -timeout 300s -v ./tests/e2e -run TestRealBackupRestore
STEP1 backup（custom） → size_bytes=1725，文件名 kore_backup_e2e-20261125-111138.dump
STEP2 restore（custom + 自动快照）→ snapshot=kore_backup_e2e-prerestore-…dump(849)，恢复后 SELECT name → alpha,beta
STEP3 backupList → count=2（备份 + 快照）
STEP4 backupDownload 分块还原 1725 字节与磁盘一致
STEP5a backup（sql+gzip）→ 673 字节；STEP5b restore（sql+gzip，无快照）→ alpha,beta
STEP6 防线：缺 confirm / 路径穿越 / 文件不存在 / 删除缺 confirm → 全 E_INVALID
STEP7 backupDelete → 快照文件已删除
--- PASS: TestRealBackupRestore (1.33s)
```

## 3. G-28 双端截图（`kore/.agents/verify/screenshots/`）

```text
db-pg-backup-desktop-01.png    PNG 1440 x 900   # 备份成功提示（真实文件路径/大小/压缩级别）+ 库行「备份」
db-pg-backups-desktop-01.png   PNG 1440 x 900   # 备份文件弹窗：文件 + 大小·时间 + 下载/恢复/删除
db-pg-restore-desktop-01.png   PNG 1440 x 900   # 恢复确认表单：文件选择 + 目标库 + 自动快照 + 自动建库 + 红色破坏性提示
db-pg-backup-mobile-01.png     PNG  390 x 844
db-pg-backups-mobile-01.png    PNG  390 x 844
db-pg-restore-mobile-01.png    PNG  390 x 844
```

自评三问：① 解决「PG 没有备份/恢复、切到 PG 就没有 MySQL 那套导出导入」的能力缺口；② 对齐宝塔/1Panel 的「备份列表 + 一键恢复 + 下载」路径——宝塔 PG 管理偏弱、1Panel 备份在独立页，本页在库行内一步备份、恢复前强制快照与 confirm，破坏性操作门槛更高；③ 状态：**可用**（真机跑通备份/恢复/列表/下载/删除，非占位）。

## 4. 门禁

```text
kore-plugin-db-postgres: gofmt -l → 空；go vet ./... → exit 0；go test -timeout 200s ./... → ok 5 包（exit 0）
kore: node --check web/db.js web/db-l2.js → 0；make secret-check → 0 FAIL / 22 处匹配（exit 0）
kore: make frontend → 首屏 80910 字节 ≤ 307200（300 KiB），exit 0；i18n 增量 2922 ≤ 3072
E2E: KORE_PG_E2E=1 go test ./tests/e2e -run TestRealBackupRestore → PASS（1.33s）
```

**本轮是否改动主实例运行态配置：否**（未碰 8787、`.kore-local*`、`bin/kored`；取证全在 /tmp 隔离实例，容器 `kore-pg-test` 用后删除）。

## 5. 提交与状态

- `kore-plugin-db-postgres`：`[agent:feat-pg-backup]` 单提交（5 个新文件 + 10 个改动）。
- `kore`：`web/db.js`、`web/db-l2.js`、6 张截图、本报告；未触碰他人写域。
