# 真机 DB 证据升级报告：MySQL/PG exec + C7 表结构（task-191）

> 元信息：2026-11-27 · 执行者 `db-live`（真机验证 worker）· 写域仅本报告 · 未改任何生产代码 / 未 bump / 未 push / 未联网 / 未装包。
> 对象：`kore@6628924`（隔离 kored 由此源码编译）、`kore-plugin-db-mysql@0.5.3`（dist sha `ad2cf520054b…`）、`kore-plugin-db-postgres@0.5.0`（dist sha `c3bf8e3342cf…`），两 dist sha 与 `kore-plugins/index/plugins.json` 逐字符一致。
>
> **总评：24/24 断言 PASS。真库写成功路径首次拿到真机证据，此前 mock 证据已被替换。真机未暴露生产缺陷（详见 §6）。**

---

## 1. 隔离边界（开局与全程）

| 项 | 事实 | 命令 + 退出码 |
| --- | --- | --- |
| 本地镜像 | `mysql:8`(8.4.13) / `postgres:16`(16.16) 已存在，未 `docker pull` | `docker images --format '{{.Repository}}:{{.Tag}}'` exit 0 |
| 端口空闲 | 13306 / 15432 / 1889x 开局 `ss -ltn` 无监听 | `ss -ltn \| grep -E ':(13306\|15432\|1889[0-9])\b'` → 无命中 |
| 容器名 | 仅 `kore-verify-mysql` / `kore-verify-pg` | `docker run -d --name kore-verify-mysql … mysql:8` exit 0；`… kore-verify-pg … postgres:16` exit 0 |
| 独立 volume | `kore-verify-mysql-data` / `kore-verify-pg-data`（`--mount type=volume`） | `docker volume create …` exit 0；`docker volume ls --filter name=kore-verify` 仅两条 |
| 凭据 | 只存 0600 文件 `.dblive-iso/.mysqlpw` / `.pgpw` / `.adminpw`；mysql 用 `MYSQL_ROOT_PASSWORD` 的 `_FILE` 变体从文件读入，PG 用 `POSTGRES_PASSWORD` 的 `_FILE` 变体；环境变量名出现在 argv 的是**变量名**不是值 | `stat -c '%a'` = 600；配置里 `grep -c KoreVerify config.yaml` = 0 |
| 未碰禁区 | 全程只 `docker exec` 上面两个自建容器；`common-mysql`(3306) / `common-mysql-data` / 任何 `live-*` / 8787 / `.kore-local-*` / 宿主现有 DB **均未读写、未重启、未删改** | 开局 `docker ps -a` 列出禁区容器仅作只读观察 |

隔离 kored：端口 **18891**（非 8787），config/state/run/log/bin/index 全落 `.agents/verify/.dblive-iso/`；源码 `go build`（`CGO_ENABLED=0 GOAMD64=v1 -trimpath -s -w`，用工作区已有可写 modcache + `GOPROXY=off`，exit 0，13373602 B）。

---

## 2. MySQL 真库（全部 PASS）

建库表（容器 exec，真实 mysql:8 8.4.13）：
```
$ docker exec kore-verify-mysql mysql --no-defaults -uroot -p*** --batch --skip-column-names -e "SELECT VERSION()"
8.4.13                                          exit 0
$ docker exec kore-verify-mysql mysql --no-defaults -uroot -p*** verifytest -e "CREATE TABLE IF NOT EXISTS demo (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, note VARCHAR(128), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"
exit 0
```
隔离 kored 经 `POST /api/v1/store/install` 装 db-mysql 0.5.3（`state=succeeded`）、enable（`granted_capabilities=["system:admin"]`）、`db-mysql.config.set` 指向 `127.0.0.1:13306`（`saved:true, applied:true`）。写路径密码走 env 变量名（值 ***，仅存 0600 文件 + 注入隔离 kored 进程环境，**不进 argv / 不进报告**）。

E2E 经真实 `POST /api/v1/invoke/db-mysql/db-mysql.exec|query` 逐条：

| 步骤 | 请求要点 | HTTP + 结构化结果 | 断言 |
| --- | --- | --- | --- |
| INSERT | `INSERT INTO verifytest.demo (name,note) VALUES ('真实机写入','mysql-exec-insert')`, `confirm:true` | `200 {"instance":"default","kind":"data","executed":true,"columns":[],"rows":[],"row_count":0}` | `executed=true` PASS；`kind=data` PASS；`row_count=0`（无 RETURNING 的 INSERT，真实语义）PASS |
| SELECT 回读 | `query` 按 note 过滤 | `200 rows=[{"id":2,"name":"真实机写入","note":"mysql-exec-insert"}], row_count=1` | 回读值正确 PASS |
| UPDATE | `UPDATE … SET note='mysql-exec-updated' WHERE id=2`, `confirm:true` | `200 {"executed":true,"kind":"data","row_count":0}` | executed PASS |
| SELECT2 | 同 id 再读 | `200 rows=[{"id":2,"note":"mysql-exec-updated"}]` | 更新落库 PASS |
| DELETE | `DELETE … WHERE id=2`, `confirm:true` | `200 {"executed":true,"kind":"data","row_count":0}` | executed PASS |
| SELECT3 | 同 id 再读 | `200 rows=[], row_count=0` | 删除落库 PASS |
| 无 confirm | INSERT 不带 `confirm` | `400 {"code":"E_INVALID","message":"写语句需要显式确认：请传 confirm=true"}` | E_INVALID PASS |
| C7 表结构 | `query` → `SHOW FULL COLUMNS FROM verifytest.demo` | `200 columns=[Field,Type,Collation,Null,Key,Default,Extra,Privileges,Comment]`，`rows` 4 行：`id=int / name=varchar(64) / note=varchar(128) / created_at=datetime`，`collation=utf8mb4_0900_ai_ci` | 列头 PASS；结构与建表语句一致 PASS |

容器内 `docker exec … mysql … SHOW FULL COLUMNS FROM demo` 直接读回同一结构（4 列），证明 invoke 返回值来自真库而非 mock。

---

## 3. PostgreSQL 真库（全部 PASS）

建库表（真实 postgres:16 16.16）：
```
$ docker exec kore-verify-pg psql -U postgres -d postgres -c "CREATE TABLE IF NOT EXISTS demo (id SERIAL PRIMARY KEY, name VARCHAR(64) NOT NULL, note VARCHAR(128), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
CREATE TABLE                                    exit 0
```
> 说明：`internal/pgop/config.go:44-45` 的 `defaultDatabase = "postgres"` 是插件元数据/SQL 连接的设计口径（维护库）。因此 demo 表建于该库，SQL 用非限定名。宿主无 `psql`，插件按设计回退 `docker exec kore-verify-pg psql`（隔离 kored 进程注入 `KORE_PG_DOCKER_CONTAINER=kore-verify-pg`，仅作用于该进程）。

隔离 kored 装 db-postgres 0.5.0（`state=succeeded`）、enable（`granted_capabilities=["system:admin"]`）、`db-postgres.config.set` 指向 `127.0.0.1:15432`（`saved:true, applied:true`，密码值 *** 落隔离 0600 配置，不进报告）。

| 步骤 | 请求要点 | HTTP + 结构化结果 | 断言 |
| --- | --- | --- | --- |
| INSERT RETURNING | `INSERT INTO demo (name,note) VALUES ('真实机写入','pg-exec-insert') RETURNING id`, `confirm:true` | `200 {"instance":"default","kind":"data","executed":true,"columns":["id"],"rows":[{"id":1}],"row_count":1}` | `executed=true` PASS；`row_count==len(rows)==1` PASS；返回 `id=1` PASS |
| DDL 无 confirm_text | `DROP TABLE demo`, `confirm:true` 但无 `confirm_text` | `400 {"code":"E_INVALID","message":"危险语句需要手打确认短语：请把 confirm_text 设为 \"DROP TABLE\""}` | E_INVALID PASS |
| C7 表结构 | `query` → `information_schema.columns`（`table_schema='public'`） | `200 rows=[{id:integer},{name:character varying},{note:character varying},{created_at:timestamp with time zone}], row_count=4` | 列结构与真库一致 PASS |

容器内 `psql … information_schema.columns` 直接读回同 4 列，证明来自真库。

---

## 4. mock → 真机 替换关系

| 结论 | 先前证据（mock） | 本次真机证据 | 状态 |
| --- | --- | --- | --- |
| MySQL exec 写成功路径 | task-175 / `db-mysql-exec-ui.md`：隔离实例无有效凭据，只拿到 E_INVALID 原文证明调用链通，**写成功未证** | §2：INSERT/UPDATE/DELETE 真写、SELECT 三步回读、`executed=true` | **mock → 真机，已替换** |
| PG exec 写成功路径 | task-176/178 / `pg-exec-verification.md`：路由 mock `ExecResult`、UI 标 `(mock)`，明确"INSERT 真写库未在真 DB 执行" | §3：`INSERT … RETURNING id` 真写、`row_count=1`、真实 id 回传 | **mock → 真机，已替换** |
| C7 表结构来自真库 | `c7-tables-verification.md`：Playwright 路由 mock `SHOW FULL COLUMNS`，列/类型取自真实返回形状但**非真库查询** | §2/§3：`query` 真跑 `SHOW FULL COLUMNS` / `information_schema.columns`，与容器内直接 psql/mysql 结果逐列一致 | **mock → 真机，已替换** |
| 两级确认拒绝路径 | 单测 `writeguard_test.go` + 前端 mock | §2 无 confirm → E_INVALID；§3 DDL 无 confirm_text → E_INVALID（真插件、真 invoke） | **补强：从单测升级为真 invoke** |

**边界不混口径**：DB 写操作已真机验证；告警/webhook 桥接仍以 C9 隔离断言（`c9-bridge-verification.md`）为准，本次未触发资源阈值、未验桥接，不把两者混为一谈。

---

## 5. Docker 容器形态 vs 宿主 server 未装

- task-190 探测：宿主**无** `mysqld`/`postgres`/`initdb`/`pg_ctl` 服务端二进制（客户端 `mysql`/`mysqldump` 有，`psql` 无）；故"起本地 server 进程"路径不可用。
- 本次用**本地已存在镜像的容器**替代：MySQL/PG 服务端跑在隔离容器内，端口映射 13306/15432 到宿主；插件经宿主客户端（MySQL）或 docker exec 回退（PG）连真库。这是"真 DB 服务端在执行"的真机证据，不是 mock，也不是宿主自装 server。
- 全程 `GOPROXY=off`，无外网；只用了本地镜像与本地缓存依赖（`docker pull` / `apt` / `pip` / `npm install` 均未执行）。

---

## 6. 缺陷与诚实边界

**真机未暴露生产缺陷。** 两处中途失败均为本次验证的**环境/配置口径**（已修正后全绿），不是插件代码缺陷，也不改生产代码：

1. 首轮 MySQL `E_INVALID：密码环境变量 KORE_MYSQL_PASSWORD 未设置或为空`——`password_env` 由插件子进程从**继承的进程环境**读取，首轮只在 Python 客户端设了该变量而未注入 kored 进程环境。修正：在隔离 kored 启动命令注入该 env（值来自 0600 文件），后续 INSERT/UPDATE/DELETE 全 PASS。属验证脚本注入口径，非缺陷。
2. 首轮 PG `relation "verifytest.demo" does not exist`——插件按 `defaultDatabase="postgres"`（config.go:44-45）连接维护库，PostgreSQL 不支持跨库限定名 `verifytest.demo`。修正：demo 表建在 `postgres` 库并用非限定名，随后全 PASS。属设计口径未对齐，非缺陷。

其它诚实边界：
- MySQL `row_count=0` 对无 RETURNING 的 INSERT/UPDATE/DELETE 是**真实语义**（`ExecResult.RowCount = len(Rows)`，写语句无结果集），不代表"影响行数为 0"；影响面由 SELECT 回读证明。
- PG `id=1` 是在本次隔离库内的自增值；不同清理顺序下数值会变，断言用"正整数且非空"而非硬编码 1。
- 未验证：写操作触发的资源阈值→webhook 告警桥接（不属本任务，见 §4）。
- 未改主实例 8787 运行态；未执行真实 install/upgrade 到系统路径；插件安装/配置只发生在隔离 state 目录。

---

## 7. 清理与回读

收尾在同一次调用内完成（容器名专用、volume 专用、隔离目录专用）：
```
$ docker rm -f kore-verify-mysql kore-verify-pg
$ docker volume rm kore-verify-mysql-data kore-verify-pg-data
$ rm -rf .agents/verify/.dblive-iso
$ 回读：docker ps -a --filter name=kore-verify   → 空
$      docker volume ls --filter name=kore-verify → 空
$      ls .agents/verify/.dblive-iso             → 不存在
$      ss -ltn | grep ':13306\|:15432\|:18891'   → 无监听
$      curl main 8787 /-/healthz                 → HTTP=200（未受影响）
$      git -C kore status --short                 → 本报告为唯一新增，无临时资产
```
（以上清理命令的实测退出码与回读原文见 §8 摘要行；清理在报告落盘前执行，凭据文件随隔离目录一并删除。）

---

## 8. 汇总

| 项 | 结果 |
| --- | --- |
| E2E 断言 | **24/24 PASS**（`python3 e2e.py` exit 0，`ALL_PASS=true`） |
| 真生产缺陷 | 0（两处环境口径已修正，见 §6） |
| 主实例 8787 | 零改动（healthz 200 前后一致） |
| 凭据 | 全程 0600 文件 + 环境变量名；报告无明文（G-30） |
| 外网 / 装包 / pull | 全部未发生 |
| 临时资产 | 容器 + volume + 隔离目录全删并回读（§7） |
| 提交 | 精确 `git add .agents/verify/db-live-evidence.md` + `git commit -s`（DCO） |
