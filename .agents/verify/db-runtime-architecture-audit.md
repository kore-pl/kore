# 验收报告：多数据库 / 环境管理组织方式（ADR-0050）

> 任务：核实 + 裁决 + 计划，**不改代码**（除 ADR）。写域：`docs/DECISIONS/0050-db-and-runtime-aggregation.md`、本文件。
> 时间：2026-11-24 10:2x +08:00。工作树有他人未提交改动，本轮只提交上述两个文件。

## 0. 结论速览

- 模型 B（按能力域聚合）**已是既成事实**，不是待选项：`web/db.js`（MySQL/PG）、`web/runtimes.js`（Node/PHP/Python）、`web/redis.js` 均由主壳 `shell.js` 的 `lazyView` 注册，同属 `NAV_GROUPS` 业务组。
- 内核不提供、也不得提供聚合 API：`handlers.go:73` 只有 `POST /api/v1/invoke/{plugin}/{method}`（G-01）。
- `runtime-php` / `runtime-node` 只读（写盘零命中）；**`runtime-python` 有写**（venv / pip）——任务卡的「runtime-* 一律只读」需修正。
- `site` 无法绑定 PHP 版本：22 方法零 runtime、`fastcgi|php-fpm` 零命中、站点结构无字段——链路三环节全缺。
- `redis` 的数据管理深度**高于**两个关系型插件（键浏览 + 分型值编辑 + TTL），但无导出、无导入（有意）。
- 额外发现：`db-mysql` / `db-postgres` 的 `conflicts` 只声明、内核不执行（`validate.go:322-324` 只校验 id 格式）。

## 1. 核实命令与原始证据

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `ls docs/DECISIONS/ \| sort \| tail -3` | 0 | `0047-method-name-charset.md` / `0048-post-upgrade-hook.md` / `0049-privilege-direct-execution.md`（→ 新 ADR 取 0050） |
| 2 | `python3 -c "…json.load(info.json)…"`（三 DB 插件） | 0 | db-mysql 0.4.1 / 15 方法；db-postgres 0.3.4 / 13；redis 0.6.0 / 21（全文见 ADR §1.1） |
| 3 | 同上（三 runtime 插件） | 0 | php 0.2.2 / 5 全 read；node 0.2.5 / 5 全 read；**python 0.3.2 / 9，含 venv.create、pip.install（admin）** |
| 4 | `grep -rn 'os.WriteFile\|os.Create\|OpenFile\|os.Mkdir' kore-plugin-runtime-php --include=*.go \| wc -l` | 0 | `0` |
| 5 | 同上 `runtime-node` | 0 | `0` |
| 6 | 同上 `runtime-python` | 0 | `1` → `internal/pyop/venv.go:390 os.MkdirAll`；另有 `venv.go:484 exec.CommandContext` |
| 7 | `grep -rn '只管理 CLI\|不管理 FPM' kore-plugin-runtime-php` | 0 | `internal/phpop/types.go:30`、`README.md:36`、`tests/boundary/boundary_test.go:11` |
| 8 | `sed -n '174,178p' kore-plugin-runtime-php/README.md` | 0 | 「不真起 / 不管理 PHP-FPM 进程池、不切 `/etc/alternatives/php`、不改站点配置（`use` 方法在 0.2.0 移除）」 |
| 9 | `grep -n 'db.js\|runtimes.js\|redis.js' web/shell.js` | 0 | `:596` db→`/assets/db.js`、`:601` redis→`/assets/redis.js`、`:607` runtimes→`/assets/runtimes.js`（均 `lazyView`） |
| 10 | `grep -n 'NAV_GROUPS' -A 4 web/shell.js` | 0 | `:69` 业务组 `ids: ['sites','db','redis','tasks','runtimes']` |
| 11 | `grep -n 'dbType\|db-postgres' web/db.js` | 0 | `:77-78` `methodFor()` 按 `dbType` 拼限定名；`:1028` 页头 MySQL/PostgreSQL 切换 |
| 12 | `grep -n 'KoreDb\|KoreRuntimes\|KoreRedis' web/*.js`（排除自身） | 0 | 仅 `web/shell.js:596/601/607` 引用 → 无重复聚合实现 |
| 13 | `grep -rn 'fastcgi\|php-fpm' kore-plugin-site --include=*.go \| wc -l` | 0 | `0` |
| 14 | `grep -rn 'type Site struct' -A 40 kore-plugin-site/*.go` | 1 | 无命中 → 站点结构无 runtime 字段（grep 无匹配即退出 1，符合预期） |
| 15 | `python3 -c "…site/info.json…"` | 0 | site 0.4.4 / 22 方法，无任何 runtime/php/version 方法 |
| 16 | `grep -rn 'Conflicts' internal/ cmd/ --include=*.go \| grep -v _test` | 0 | 仅 `registry/validate.go:322-324`（校验 id 格式）、`registry/manifest.go:131-132`、`market/types.go:38-39` → **无运行期互斥判定** |
| 17 | `grep -n 'FLUSHALL\|EVAL' kore-plugin-redis/internal/redisop/whitelist.go` | 0 | `:44` FLUSHALL、`:46-47` EVAL/EVALSHA、`:48` SCRIPT → 拒绝并给替代（`redis.keys` SCAN + `redis.delete`） |
| 18 | `grep -n 'rename\|move\|copy' kore-plugin-redis/internal/redisop/call.go` | 0 | `:38-40` `callRename` / `callMove` / `callCopy` 已实现 |
| 19 | `grep -n '\[\]InstanceConfig\|instance := make' kore-plugin-db-mysql/config.go` | 0 | `:291` `instances := make([]mysqlop.InstanceConfig, 0, len(envInstances)+1)` → 多实例已支持 |
| 20 | `sed -n '70,72p' kore-plugin-db-mysql/README.md` | 0 | `query` 返回 `{columns,rows,row_count,truncated}`；**无 tables 方法** |
| 21 | `grep -n 'db-postgres' -A 1 docs/PLUGIN-MATURITY.md`（:84 行） | 0 | 「仍缺备份恢复（无对应方法）」 |
| 22 | `grep -n 'invoke' internal/core/httpapi/handlers.go` | 0 | `:73 POST /api/v1/invoke/{plugin}/{method}` → 严格按插件路由，无跨插件组合 |

## 2. 与本卡书面前提的偏差（照实记，不掩盖）

| 任务卡写的 | 代码事实 | 处理 |
| --- | --- | --- |
| 「三个插件，三个页面」（DB 与 runtime 各三页） | 主壳已聚合：`db.js` 一页两引擎、`runtimes.js` 一页三 tab | ADR §1.3 写明，裁决改为「显式化已有的 B」 |
| 「runtime-* 只能看到已装版本」 | `runtime-python` 有 `venv.create` / `pip.install` 写方法 | ADR §1.2 修正为「php/node 只读，python 能写自己管的 venv，但都不装不切」 |
| `types.go:「只管理 CLI」` | 实际路径是 `internal/phpop/types.go:30`（仓根无 `types.go`） | ADR §1.2 用真实路径 |
| `README:176` | 行号准确，原文已抄录 | — |

## 3. 门禁

```
$ make docs-check
（见下方回填：本轮 commit 前执行）
```

## 4. 未改动声明

- 本轮**未改任何业务代码**、未动任何插件仓、未改运行态资产（`.kore-local*` / `bin/kored`）。
- 只新增 `docs/DECISIONS/0050-db-and-runtime-aggregation.md` 与本文件。
