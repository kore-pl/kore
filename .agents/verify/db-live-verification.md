# 真机 DB 证据独立验收报告（G-09 / task-192）

> 2026-11-27 · verifier `db-live-verifier`（非 implementer `db-live`，G-09 角色不兼任）· 只读复核 commit `e8edbd8`（父 `6628924`）。
> 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）。唯一写操作 = 本报告（`git add` 精确路径 + `git commit -s`）；未改任何生产代码 / 未 bump / 未 push / 未联网 / 未启动容器 / 未碰宿主 DB 与 8787 写操作（仅只读 GET healthz）/ 未碰 `.kore-local-*`。
>
> **总评：PASS（带 3 处已披露的可核验性边界，见 §6）。** 五项复核范围逐条成立；未发现证据伪造、口径混淆、隔离越界或未清理残留。报告的「24/24」经 implementer 提供精确拆分后账目自洽（7 setup + 11 MySQL + 6 PG = 24），详见 §1。

---

## 0. 基线事实（命令 + 退出码 + 关键输出）

```
$ git rev-parse HEAD                          → e8edbd8e8c56e9255f8d5c556d7aeac23d69d348   exit 0
$ git show --stat --format='%H%n%P%n%B' e8edbd8
  e8edbd8e8c56e9255f8d5c556d7aeac23d69d348
  6628924ec446712d2afaa0b21d83c9564911fdb4
  [agent:db-live] docs(verify): 真机 DB 证据升级——MySQL/PG exec + C7 表结构 24/24 PASS
  Signed-off-by: pengtang1024 <pengtang1024@qq.com>                        exit 0
$ git diff-tree --no-commit-id --name-only -r e8edbd8
  .agents/verify/db-live-evidence.md                                       exit 0   （精确 1 文件）
$ git cat-file -t 6628924                     → commit                       exit 0
$ git diff --name-only 6628924..e8edbd8       → 仅 .agents/verify/db-live-evidence.md  （无生产代码改动）
$ git show HEAD:.agents/verify/db-live-evidence.md | sha256sum
  8e2e94b0091f982bfdc2126228bfd5e256d6ad16c240308ac96dd5d550158808
$ sha256sum .agents/verify/db-live-evidence.md
  8e2e94b0091f982bfdc2126228bfd5e256d6ad16c240308ac96dd5d550158808       exit 0   （工作区 == 提交内容）
```

DCO：commit message 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`，成立。提交首行带 `[agent:db-live]` 前缀，符合 kore/AGENTS.md §3。

---

## 1. 报告可信度：MySQL / PG 断言与 24 计数

### 1.1 报告逐项内容（读回原文，`.agents/verify/db-live-evidence.md`，138 行）

- §1 隔离边界表（L12–21）：本地镜像 `mysql:8`=8.4.13 / `postgres:16`=16.16、`docker images` exit 0；端口空闲 `ss -ltn` 无命中；容器名 `kore-verify-mysql` / `kore-verify-pg`、`docker run -d` exit 0；独立 volume `kore-verify-mysql-data` / `kore-verify-pg-data` `docker volume create` exit 0；凭据 0600 文件 + `_FILE` 变体、argv 仅变量名、`stat -c '%a'`=600、`grep -c KoreVerify`=0；禁区未碰。
- §2 MySQL（L25–49）：`docker exec … SELECT VERSION()` → `8.4.13` exit 0；`CREATE TABLE … demo` exit 0；经 `POST /api/v1/invoke/db-mysql/db-mysql.exec|query` 8 行表格，每行给请求要点 + `HTTP + 结构化结果` + 断言：
  - INSERT → `200 {"instance":"default","kind":"data","executed":true,"columns":[],"rows":[],"row_count":0}`，断言 `executed=true` / `kind=data` / `row_count=0`（无 RETURNING 的真实语义）；
  - SELECT 回读 → `200 rows=[{"id":2,"name":"真实机写入","note":"mysql-exec-insert"}], row_count=1`；
  - UPDATE → `200 {"executed":true,"kind":"data","row_count":0}`；SELECT2 → `rows=[{"id":2,"note":"mysql-exec-updated"}]`；
  - DELETE → `200 {"executed":true,...}`；SELECT3 → `rows=[], row_count=0`；
  - 无 confirm → `400 {"code":"E_INVALID","message":"写语句需要显式确认：请传 confirm=true"}`；
  - C7 → `query` 跑 `SHOW FULL COLUMNS FROM verifytest.demo`，`columns=[Field,Type,Collation,Null,Key,Default,Extra,Privileges,Comment]`（9 列头），`rows` 4 行 `id=int / name=varchar(64) / note=varchar(128) / created_at=datetime`，collation `utf8mb4_0900_ai_ci`；另容器内直接 `SHOW FULL COLUMNS` 读回同 4 列（L49）。
- §3 PG（L53–70）：`docker exec … CREATE TABLE` → `CREATE TABLE` exit 0；装插件 `state=succeeded` / enable `caps=["system:admin"]` / config `saved:true, applied:true`；3 行表格：
  - INSERT RETURNING → `200 {"instance":"default","kind":"data","executed":true,"columns":["id"],"rows":[{"id":1}],"row_count":1}`；
  - DDL 无 `confirm_text` → `400 {"code":"E_INVALID","message":"危险语句需要手打确认短语：请把 confirm_text 设为 \"DROP TABLE\""}`；
  - C7 → `query` 跑 `information_schema.columns`（`table_schema='public'`）→ `rows=[{id:integer},{name:character varying},{note:character varying},{created_at:timestamp with time zone}], row_count=4`；容器内 `psql` 直读同 4 列（L70）。
- §4–§7：mock→真机替换表、容器形态 vs 宿主未装、缺陷/诚实边界、清理回读。

### 1.2 24 断言计数核对（核心关注点）

我实读报告表内显式 `PASS` 字样共 16 处（MySQL 11 + PG 5），与「24」差 8。就差额向 implementer `db-live` 发消息取证，其回复给出精确拆分（原文摘要）：

```
e2e.py 每次 check(name, cond, detail) → results.append((name, bool(cond)))，打印
[ASSERT] {"name":...,"pass":...,"detail":...}；结尾：
passed = sum(1 for _, ok in results if ok)
total  = len(results)
emit("SUMMARY", {"passed": passed, "total": total, "all_pass": passed == total})
sys.exit(0 if passed == total else 1)
最后一次成功运行 stdout 末两行：
[SUMMARY] {"passed": 24, "total": 24, "all_pass": true}
E2E_EXIT=0
```

24 条清点（implementer 逐条映射报告行号，我逐条核对报告 prose 是否支撑）：

| 组 | 条数 | 明细（报告对应位置） |
| --- | --- | --- |
| setup（仅 prose，无 PASS 字样） | 7 | login(L34 前)、install.db-mysql(L34)、enable.db-mysql(L34)、config.mysql(L34)、install.db-postgres(L62)、enable.db-postgres(L62)、config.pg(L62) |
| MySQL | 11 | L40 三（executed / kind_data / rowcount）、L41 readback、L42 update.executed、L43 update.readback、L44 delete.executed、L45 delete.readback、L46 noconfirm、L47 两（columns_header / real_structure） |
| PG | 6 | L66 四（executed / rowcount_eq_len / rowcount_1 / id_correct）、L67 ddl_noconfirmtext、L68 real_structure |
| **合计** | **24** | 7 + 11 + 6 = 24 |

差额 8 = 7 setup（报告 prose 以 `state=succeeded` / `granted_capabilities=["system:admin"]` / `saved:true, applied:true` 叙述，确实为真 check 但未标 PASS）+ 1 条 `pg.exec.rowcount_1`（在 L66 与 `rowcount_eq_len` 合并为一个「`row_count==len(rows)==1`」字样）。

**判定：24 自洽，属「有明确拆分」情形**，满足 task-192「确认断言数 24 自洽（9+6+清理等分项和或有明确拆分）」的后者。task 卡里「MySQL 9 / PG 6」的 9 应指 §2 表 8 行 + C7 的 9 列头语境，implementer 的权威口径是 11 MySQL + 6 PG + 7 setup；报告数字与拆分不矛盾。

### 1.3 技术断言与源码交叉核对（我用 `read`/`grep` 只读核对，非实现者自述）

| 报告断言 | 源码事实（当前 HEAD / 插件仓） | 结论 |
| --- | --- | --- |
| MySQL 无 confirm → `E_INVALID`：`写语句需要显式确认：请传 confirm=true` | `kore-plugin-db-mysql/internal/mysqlop/writeguard.go:101` 字面量逐字一致 | 成立 |
| MySQL `row_count=0` 语义 = 无 RETURNING 写语句无结果集 | `internal/mysqlop/client.go:262,274,288` 三处 `result.RowCount = len(result.Rows)` | 成立 |
| PG 无 `confirm_text` → `请把 confirm_text 设为 "DROP TABLE"` | `kore-plugin-db-postgres/internal/pgop/writeguard.go:118` 模板逐字一致；`:127-144 confirmPhrase()` 取前两个关键字 → `DROP TABLE` | 成立 |
| PG `row_count == len(rows)` | `internal/pgop/client.go:217,244`、`pgop/exec.go:18`、`types.go:198` 均 `RowCount = len(rows)` | 成立 |
| PG `defaultDatabase="postgres"` 口径 | `internal/pgop/config.go:44-45` 逐字一致 | 成立 |
| 首轮 MySQL 失败信息 | `internal/mysqlop/config.go:260` 模板 `实例 %q 的密码环境变量 %s 未设置或为空` 逐字一致 | 成立 |
| 插件版本 / dist sha | `info.json` db-mysql `0.5.3`、db-postgres `0.5.0`；`kore-plugins/index/plugins.json` sha `ad2cf520054b12c5d7…` / `c3bf8e3342cf1ee75…` 与报告前缀逐字一致 | 成立 |

---

## 2. mock → 真机替换口径（§4 + §6 成立）

报告 §4 四行替换表逐条核对：

1. **MySQL exec 写成功**：先前 `db-mysql-exec-ui.md`（实际文件存在，L11/33/60-61 实证「隔离实例无有效 DB 凭据，只拿到 E_INVALID 原文证明调用链通…未证写成功路径」）→ 本次 §2 真写 + 三步回读 → 标注「已替换」成立。
2. **PG exec 写成功**：`pg-exec-verification.md`（存在，L86/92 实证「`(mock)`」、`INSERT` 真写「未在真 DB 执行」）→ 本次 §3 `INSERT … RETURNING id` 真写 → 「已替换」成立。
3. **C7 表结构**：`c7-tables-verification.md`（存在，L63 实证 Playwright mock `SHOW FULL COLUMNS`、`invoke`/query 白名单是真代码）→ 本次 §2/§3 真库查询 + 容器内直读逐列一致 → 「已替换」成立。
4. **两级确认拒绝路径**：从 `writeguard_test.go` + 前端 mock 升级为真 invoke → 「补强」成立（与源码 §1.3 核对一致）。

**webhook 未混口径**：报告 L83 明确「DB 写操作已真机验证；告警/webhook 桥接仍以 C9 隔离断言（`c9-bridge-verification.md`）为准，本次未触发资源阈值、未验桥接」。我读 `c9-bridge-verification.md`（存在，G-09/task-184，L1/§2）确认该文件确为独立 C9 桥接验收，报告未把 DB 真机证据冒充桥接证据。成立。

**两处中途失败标为验证口径非缺陷、未改生产代码**：
- §6.1 MySQL env 注入（首轮只在 Python 客户端设 `KORE_MYSQL_PASSWORD`，未注入 kored 进程环境）——报告标「验证脚本注入口径，非缺陷」；`git diff 6628924..e8edbd8` 仅 1 文件证据文档，源码零改动，佐证「未改生产代码」。
- §6.2 PG `verifytest.demo does not exist`（`defaultDatabase=postgres` 维护库 + PG 不支持跨库限定名）——报告标「设计口径未对齐，非缺陷」；`config.go:44-45` 源码佐证口径真实存在。成立。

---

## 3. 隔离边界（§1/§5 + 当前只读回读）

- **仅本地镜像、无 pull/apt**：报告 §1 列 `docker images` exit 0、未 pull；§5 L91 明确「`docker pull`/`apt`/`pip`/`npm install` 均未执行，`GOPROXY=off`，无外网」。
- **容器名 / 端口**：`kore-verify-mysql` / `kore-verify-pg`；13306 / 15432 / 隔离 kored 18891（非 8787）。当前回读（见 §4）确认这些容器/端口已不存在或无监听。
- **凭据 0600 不进 argv / 报告**：报告 §1 说明 `_FILE` 变体从 0600 文件读入、argv 仅变量名，L18 写 `stat -c '%a' = 600`；报告全文 `grep -niE 'password|secret|token|pw='` 仅命中环境变量名与 `***` 占位（L18/L99），无明文值；`make secret-check` exit 0（§4）。凭据文件随隔离目录删除，当前无法再 stat（边界见 §6）。
- **禁区未碰（当前实证）**：`docker ps -a` 显示 `common-mysql` Up 4 days (healthy)、21 个 `live-*` 容器全部 Up；无任何 `kore-verify-*`；`common-mysql-data` / `live-*` volume 均在。`ss -ltn` 仅见 8787 监听。与报告「禁区未读写/未重启/未删改」一致。
- **隔离 kored 来源**：报告 L21 称由 `kore@6628924` 编译（`CGO_ENABLED=0 GOAMD64=v1 -trimpath -s -w`，`GOPROXY=off`，exit 0，13373602 B）。我核对 `6628924` 为 e8edbd8 父提交、是 docs-only（仅 `docs/FEATURE-GAP-BACKLOG.md`），`6628924..e8edbd8` 仅证据文档变化——即隔离 kored 与 e8edbd8 的生产代码逐字相同。成立。

---

## 4. 清理与回读（我本轮独立实测，命令 + 退出码 + 原文）

```
$ docker ps -a --format '{{.Names}}\t{{.Status}}'
  live-game-auction-dev Up 17 hours (healthy) … common-mysql Up 4 days (healthy) … common-redis Up 6 days   exit 0
  （无 kore-verify-mysql / kore-verify-pg；common-mysql 与 21 个 live-* 全在）
$ docker volume ls --format '{{.Name}}'
  … common-mysql-data / common-redis-data / live-games_live-log-data / live-games_mysql-data / live-games_nats-data   exit 0
  （无 kore-verify-mysql-data / kore-verify-pg-data）
$ docker ps -a --filter name=kore-verify --format '{{.Names}}'   → 空   exit 0
$ docker volume ls --filter name=kore-verify --format '{{.Name}}' → 空   exit 0
$ ls -la .agents/verify/.dblive-iso
  ls: cannot access '.agents/verify/.dblive-iso': No such file or directory   exit 2（= 不存在，符合预期）
$ ss -ltn | grep -E ':(13306|15432|18891|8787)\b'
  LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:*                          grep_exit 0
  （13306/15432/18891 无监听）
$ curl -s -o /dev/null -w 'HTTP=%{http_code}\n' --max-time 5 http://127.0.0.1:8787/-/healthz
  HTTP=200                                                          curl_exit 0（只读 GET，未改主实例）
$ make secret-check
  [RUN ] secret-check
  secret-check: 0 FAIL / 23 处匹配（占位写法均合规）                 exit 0
$ git worktree list
  /home/pt/Work/GolandProjects/kore-pl/kore e8edbd8 [main]          exit 0（仅主树）
$ git status --short
   M scripts/usability-pending.txt
  ?? .agents/.agents/  ?? .agents/verify/e2e-*.md  ?? data/  ?? dist/  …（均为他人既有 dirty，本轮无新增残留）
$ git for-each-ref --format='%(refname) %(objectname:short)' refs/remotes | grep /main
  gitea/main 812f9fc / gitee/main 62506db / github/main 62506db / origin/main 6628924
  （均非 e8edbd8 → 未 push；`git branch -a --contains e8edbd8` 仅 `* main`）
```

结论：容器 / volume / 隔离目录删净且回读为空；端口仅 8787；healthz 200 前后一致；common-mysql 与 live-* 完好；secret-check exit 0；commit e8edbd8 精确 1 文件 + DCO；未 push；worktree 仅主树；他人 dirty 原样。全部成立。

---

## 5. 诚实边界（报告 §5/§6/§7，成立）

- **容器形态 vs 宿主未装**：报告 §5 引 task-190 探测（宿主无 `mysqld`/`postgres`/`initdb`/`pg_ctl` 服务端二进制，客户端 `mysql`/`mysqldump` 有、`psql` 无），明确本次用本地已存在镜像的容器替代，是真 DB 服务端在执行、不是 mock、也不是宿主自装 server。口径清楚。
- **无外网**：§5 L91 `GOPROXY=off`、无 pull/apt/pip/npm install，成立。
- **验证口径边界**：§6 明列 MySQL `row_count=0` 是真实语义（已与 `client.go` 三处核对）、PG `id=1` 是隔离库自增值且断言用「正整数非空」而非硬编码、webhook 桥接未验（转 C9）、主实例 8787 零改动、未执行真实 install/upgrade 到系统路径。均在报告中披露，无夸大。

---

## 6. 可核验性边界（如实披露，不构成 BLOCKED）

1. **原始 stdout 未留档**：报告 §8 的 `24/24` / `ALL_PASS=true` 来自已删除的 `e2e.py` + `e2e.out`（按任务卡「临时资产删净」纪律随隔离目录删除）。我无法独立复跑同一实例（容器/volume/凭据/隔离目录均按纪律删除且回读为空），24 条拆分由 implementer 直接提供、并与报告 prose（7 setup 的 `state=succeeded`/`saved:true, applied:true`）+ 我读源码（§1.3）+ 当前清理回读（§4）交叉印证。属「证据未持久化」边界，非数字矛盾。
2. **§8 措辞**：`ALL_PASS=true` 实为 e2e.py JSON 键 `all_pass: true` 的转述（implementer 已认），非脚本原样字面；不影响断言结论。
3. **凭据 0600 与容器 run 参数无法二次 stat/replay**：相关文件/容器已删，本报告对该项的判定基于报告原文（L18 `stat -c '%a'=600`、`_FILE` 变体、argv 仅变量名）+ `make secret-check` exit 0（无明文入库）+ 当前无残留回读，非现场重放。

以上三点是清理纪律的必然结果，implementer 已如实说明；task-192 要求「若报告数字/证据不自洽如实报 BLOCKED」——本例数字经拆分后自洽、证据无相互矛盾，故判 PASS 而非 BLOCKED。

---

## 7. 总评

| 复核范围 | 结论 |
| --- | --- |
| 1. 报告可信度（MySQL/PG 断言命令+退出码+原文；24 自洽或明确拆分） | PASS（24 = 7 setup + 11 MySQL + 6 PG，明确拆分成立；技术断言与源码逐条吻合） |
| 2. mock→真机替换口径 / webhook C9 未混 / 两处失败标口径非缺陷 | PASS |
| 3. 隔离边界（本地镜像、容器/端口、凭据 0600、禁区未碰、kored@6628924） | PASS |
| 4. 清理回读 / secret-check / commit 精确 1 文件+DCO / 未 push / worktree | PASS（本轮独立实测） |
| 5. 诚实边界（容器 vs 宿主未装、无外网、口径） | PASS |
| 可核验性边界 | 3 处，已披露（§6） |

**总评：PASS。** 真机 DB 证据升级报告（e8edbd8）在断言自洽性、替换口径、隔离纪律、清理回读、git 纪律五方面均成立，未发现伪造或越界；三处可核验性边界属清理纪律的必然结果且已如实记录。verifier 未改生产代码、未 push、未启动容器、未碰宿主 DB / 8787 写操作 / `.kore-local-*`。
