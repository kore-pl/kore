# PG 业务库选库 · 真机复验报告（task-195 / round 19）

> 2026-11-27 · 执行者 `pg-dbselect`（实现 worker，非 verifier）· 复用 task-191 的本地 `postgres:16` 隔离容器路径（新容器 `kore-verify-pg2` + 独立 volume + 空闲端口 15432，非 8787、非任何 `live-*` / 宿主 DB）。凭据只存 0600 文件并经 `POSTGRES_PASSWORD_FILE` 注入容器，口令值不进 argv / 本报告 / 源码。收工已删容器 / volume / 端口回读 / 临时目录。
> 真插件二进制由 E2E harness 每次从当前工作树 `go build`（不复用 `bin/` 旧产物），经临时 UDS + `kore.plugin.v1` 帧协议调用，SQL 走真实 `psql`（宿主无 psql → 插件回退 `docker exec kore-verify-pg2 psql`）——**真机，不是 mock**。

## 0. 隔离边界（开局与收尾）

| 项 | 事实 | 命令 + 退出码 |
| --- | --- | --- |
| 本地镜像 | `postgres:16`（16.16）已存在，未 `docker pull` | `docker images --format '{{.Repository}}:{{.Tag}}' \| grep -i postgres` → `postgres:16` / `postgres:16-alpine`，exit 0 |
| 端口空闲 | 15432 / 15433 开局 `ss -ltn` 无监听 | `ss -ltn \| grep -E ':(15432\|15433)\b'` → 无命中 |
| 容器 / volume | 仅 `kore-verify-pg2` + `kore-verify-pg2-data`，`--mount type=volume` 独立数据盘 | `docker volume create` / `docker run -d` exit 0；开局 `docker ps -a` / `docker volume ls` 无同名残留 |
| 凭据 | 口令仅写入 0600 文件 `.agents/verify/.pgdbselect-tmp/.pgpw`，容器用 `-e POSTGRES_PASSWORD_FILE=/run/secrets/pgpw` + 只读 bind；argv 里只有**变量名** `POSTGRES_PASSWORD_FILE`，无口令值 | `stat -c %a` = 600；本报告全文无口令值（G-30） |
| 禁区未碰 | 未读写 / 未重启 / 未删除 `common-mysql`、宿主现有 DB、任何 `live-*`、8787、`.kore-local-*`；未执行 install/upgrade | 全程只 `docker exec kore-verify-pg2`，插件配置落 `t.TempDir()` |

收尾（报告写完后执行）：`docker rm -f kore-verify-pg2` → `docker volume rm kore-verify-pg2-data` → `ss -ltn | grep :15432` 无监听 → `rm -rf .agents/verify/.pgdbselect-tmp`。

## 1. 真机断言（6/6 PASS）

测试：`go test -count=1 -timeout 300s -v -run '^TestRealPostgresBusinessDb$' ./tests/e2e`，env `KORE_PG_E2E=1 KORE_PG_DOCKER_CONTAINER=kore-verify-pg2`，exit **0**。原始日志（贯穿证据，无删改）：

```
=== RUN   TestRealPostgresBusinessDb
    config.set → {"saved":true,"applied":true,"restart_required":false,"warnings":[]}
    query database=myapp → {"columns":["id","name"],"rows":[{"id":1,"name":"alpha"}],"row_count":1,"truncated":false}
    query 缺省库 → {"columns":["db"],"rows":[{"db":"postgres"}],"row_count":1,"truncated":false}
    exec database=myapp → {"instance":"default","kind":"data","executed":true,"columns":["id"],"rows":[{"id":2}],"row_count":1}
    非法库名 → E_INVALID: database 需要是合法的库名（字母、数字、下划线，1-63 位）：数据库名非法：只允许字母、数字与下划线，长度 1-63
    非法库名后 myapp.demo 行数=2（未被改动）
--- PASS: TestRealPostgresBusinessDb (0.77s)
PASS
ok  	github.com/pengtang1024/kore-plugin-db-postgres/tests/e2e	0.774s
```

| # | 断言 | 真实结果 | 判定 |
| --- | --- | --- | --- |
| 1 | 容器内建业务库 `myapp` + `demo` 表（id/name）并插入 `(1,'alpha')`；维护库 `postgres` 无 demo 表 | `docker exec ... -d myapp -c CREATE TABLE/INSERT` exit 0 | PASS（前置） |
| 2 | `query` 带 `database=myapp` 读到业务库 demo 行 | `rows=[{"id":1,"name":"alpha"}]` row_count=1；postgres 库无该表，读到即证明切库生效 | **PASS（展示落 myapp）** |
| 3 | 缺省 `database` 回落维护库 | `SELECT current_database()` → `{"db":"postgres"}` | **PASS（向后兼容）** |
| 4 | `exec` 带 `database=myapp` 写 `(2,'beta')` 返回 RETURNING | `executed=true, kind=data, rows=[{"id":2}], row_count=1` | PASS |
| 5 | 容器内直读回证（不经插件自证）：`psql -d myapp -tAc 'SELECT count(*) FROM demo'` | `2`（含新写入的 beta） | **PASS（写入落 myapp 而非 postgres）** |
| 6 | 非法库名 `myapp;DROP TABLE demo` → `E_INVALID`，且 myapp.demo 仍 2 行（未执行 DROP） | `E_INVALID` + 行数 2 未变 | **PASS（注入拒绝且不触达 DB）** |

## 2. 能力面未放宽（设计与单测双重）

- `info.json.method_capabilities`：`db-postgres.query=system:read`、`db-postgres.exec=system:admin` 与 0.5.0 完全一致，本轮未改；`callQuery` 无 `requireAdmin`，`callExec` 保留 `requireAdmin` 纵深防御。
- 安全门全部保留：psql 元命令（反斜杠）禁令 / 多语句拒绝 / DDL 两级确认 / 64 KiB / 副作用函数白名单 / COPY PROGRAM 拒绝，见 `sqlguard.go` + `writeguard.go`（未改动）；新增的仅是可选 `database` 的白名单校验（`validate.go:ValidateDatabaseName`）。
- `database` 参数在方法层（`call.go:resolveDatabase`）和执行面（`client.go:targetFor`）双重白名单校验，空串 trim 后回落 `postgres`，`psql -d` 只吃白名单内的 argv 元素。

## 3. 诚实边界

- 真机断言经真实插件二进制 + 真实 postgres:16 容器，SQL 由 psql 实际执行；E2E harness 的 UDS 帧协议扮演内核侧（等同 task-191 口径），不经过 8787 主实例。
- 本轮**未**在隔离实例起 kored + 浏览器做端到端 UI 点击（G-28 的双端截图另由 `.agents/verify/ui-pg-dbselect-selfeval.md` 覆盖，用隔离 kored + Playwright route mock 验证前端传参）；真机报告只覆盖插件方法面的 `database` 参数语义。
- 未验证多实例（`KORE_PG_INSTANCES`）与远程 PG 下的 database 切换；本次仅默认实例 + 本机容器端口映射路径（task-191 同款）。
- 口令值始终未进入本报告、源码、argv 或提交；容器 / volume / 端口 / 临时凭据文件在收尾步骤全部清理并回读。
