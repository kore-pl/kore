# PG 业务库选库 · 独立验收报告（G-09 / task-196）

> 2026-11-27 · verifier `pg-dbselect-verifier`（独立于实现者 pg-dbselect）· 只读复核
> 三仓 HEAD：PG `73f06b9` / plugins `ed44e0a` / kore `417bf8e`。
> 硬纪律：不改代码、不启动容器、不执行主流程 CLI、不碰 `.kore-local-*` / 宿主 DB / 8787 / common-mysql；唯一写入 = 本报告，精确 `git add` + `git commit -s`。
> **总评：PASS（局部环境说明见 §2.2 / §2.3，不构成 BLOCKED）**

## 0. 结论总表

| 范围 | 结论 | 关键证据 |
| --- | --- | --- |
| ①后端读码+复跑 | PASS | resolveDatabase 空回落/白名单、targetFor→psql -d、执行面二次校验、安全门不变；`make check` exit 0；新单测 verbose PASS；v0.5.0→0.6.0 minor 合理 |
| ②前端读码+验证 | PASS | db.js 点库带 database + table_catalog 过滤、无新增一级控件；node --check exit 0；首屏 91092 B ≤ 300 KiB；usability 静态 0 FAIL |
| ③真机证据复核 | PASS | pg-dbselect-live.md 6/6 断言均有 E2E 源码支撑；容器/卷/端口/临时目录清理回读干净；无明文口令；未碰禁区 |
| ④索引/资产 | PASS | dist sha eaee8be2… 四处一致、实算匹配、size 偏差 2 B 在 ±2 容差内；presets 2 处 + market pin 0.6.0；validate-index/build-market --check/validate-presets 全 exit 0；ed25519 验签通过 |
| ⑤G-28 截图 | PASS | read_image 实读双图；desktop 1440×1487、mobile 390×844（identify 实测）；myapp 点选 + myapp.demo 两列两端可见；两图 hash 不同；DOM 3/3、JS 0；mock 边界诚实标注 |
| ⑥git | PASS | 三仓 commit 精确路径 15/6/6 + DCO Signed-off-by；均 1 ahead / 0 behind（未 push）；worktree 仅主树；他人 dirty 原样未动 |

## 1. git 状态（只读核对）

| 仓 | HEAD | 文件数 | DCO | ahead/behind | worktree |
| --- | --- | --- | --- | --- | --- |
| kore-plugin-db-postgres | `73f06b9660e257bdc795372fbe37a59aafdb70c2` | 15 | Signed-off-by: pengtang1024 <pengtang1024@qq.com> | 1 / 0（未 push） | 仅主树 [main] |
| kore-plugins | `ed44e0a7390688a693bc8f38fb1256baf2ed842c` | 6 | Signed-off-by: pengtang1024 <pengtang1024@qq.com> | 1 / 0（未 push） | 仅主树 [main] |
| kore | `417bf8ef4b3ccbce9d1faaa05b8e197ca4bbd004` | 6 | Signed-off-by: pengtang1024 <pengtang1024@qq.com> | 1 / 0（未 push） | 仅主树 [main] |

- PG 15 文件：CHANGELOG/info.json/call.go+test/client.go/client_admin.go/client_backup.go/client_test.go/exec.go/query.go/slowlog.go/types.go/manifest.json/tests/e2e/tests/fault。
- plugins 6 文件：index/plugins.json + .sig + versions.lock.json、market/plugins.js、presets/db-only.json、presets/full.json。
- kore 6 文件：.agents/verify/pg-dbselect-live.md、两张 G-28 截图、ui-pg-dbselect-selfeval.md、web/db-postgres.js、web/db.js。
- 他人 dirty 原样：PG `?? zeroparam_test.go`；kore `M scripts/usability-pending.txt` + 多个 `??`（.agents/.agents/、verify/*.md、screenshots/adp-*、data/、dist/）；plugins `?? .tmp-validate-out.txt`、`?? dist/`。本轮均未触碰。

## 2. 后端读码 + 复跑

### 2.1 读码确认

- `internal/pgop/types.go`：`queryParams`/`execParams` 各含可选 `Database string \`json:"database"\``；注释明确空回落维护库。
- `internal/pgop/call.go:109 resolveDatabase`：先 `strings.TrimSpace`，空 → `defaultDatabase`，非空 → `ValidateDatabaseName`，非法 → E_INVALID。
- `internal/pgop/validate.go:25`：`databaseNameRE = ^[a-zA-Z0-9_]{1,63}$`；`ValidateDatabaseName` 空串拒绝、正则不符拒绝。
- `internal/pgop/client.go:356 targetFor`：trim → 空回落 → `ValidateDatabaseName` 二次校验（E_INVALID），非 docker 直接构造 `psqlTarget{database}`，docker 走 `dockerTarget`；`psqlBaseArgs` 用 `"-d", target.database` 进 argv，**库名只作为独立 argv 元素、不拼进 SQL**。`Query`/`Exec` 进入执行面前再各调一次 `resolveDatabase`（client.go:203/234），纵深双重。
- 安全门不变：`sqlguard.go` 保留 64 KiB `maxSQLBytes`、反斜杠 psql 元命令拒绝、多语句拒绝、只读首关键字白名单、SELECT INTO / 加锁读 / 副作用函数（pg_sleep/dblink/pg_read_file 等）拒绝；`writeguard.go` 两级确认不变；`callQuery` 无 requireAdmin、`callExec` 保留 requireAdmin。
- 能力面不变：`info.json.method_capabilities` 中 `db-postgres.query=system:read`、`db-postgres.exec=system:admin`，与 0.5.0 一致；`capability_test.go` 期望表一致。
- 版本：`info.json`/`manifest.json` 均 `0.6.0`；CHANGELOG 0.6.0 记为新增能力 feat → minor（0.5.0→0.6.0）合理。

### 2.2 复跑命令 + 退出码

```
cd kore-plugin-db-postgres
GOCACHE=<workspace>/.gocache-pg-dbselect GOWORK=off make check
EXIT_CODE=0
gofmt: clean
GOWORK=off go vet ./...
GOWORK=off go test -timeout 200s ./...
ok  .../kore-plugin-db-postgres        0.004s
ok  .../internal/pgop                   0.007s
ok  .../internal/plugincfg              (cached)
ok  .../tests/e2e                       0.004s
ok  .../tests/fault                     2.017s
[SKIP] 无 tests/boundary：race 门禁无目标
```

新增单测 verbose（关键 ok 行）：

```
go test -count=1 -v -run 'TestCallQueryDatabase|TestCallExecDatabase' ./internal/pgop/
=== RUN   TestCallQueryDatabase
--- PASS: TestCallQueryDatabase (0.00s)      # database 透传 / 缺省回落 / 注入拒绝 E_INVALID 且不触达执行面
=== RUN   TestCallExecDatabase
--- PASS: TestCallExecDatabase (0.00s)       # exec database 透传 / 缺省回落 / 非法名拒绝
ok  .../internal/pgop  0.004s   EXIT=0

go test -v -run 'TestTargetForDatabase|TestValidateDatabaseName|TestResolveDatabaseWhitespace' ./internal/pgop/
=== RUN   TestTargetForDatabase     --- PASS  # psql argv 含 "-d myapp"；dockerTarget 映射；注入名拒绝
=== RUN   TestValidateDatabaseName  --- PASS  # 白名单 ^[a-zA-Z0-9_]{1,63}$
=== RUN   TestResolveDatabaseWhitespace --- PASS  # trim 不改有效名、非法名拒绝
ok  .../internal/pgop  0.005s   EXIT=0
```

## 3. 前端读码 + 验证

### 3.1 读码确认（git show HEAD -- web/db.js web/db-postgres.js）

- `useDb()`：点库设 `S.selectedDb = name`，PG 分支调 `loadPgTables(name)` 并 `runQuery`（内部带 database）。
- `runQuery()`：`if (isPg() && S.selectedDb) params.database = S.selectedDb`；未点库则缺省（插件回落 postgres）。
- `loadPgTables(dbName)`：`invoke(query, {instance, database: dbName, sql: "SELECT tablename FROM pg_tables WHERE table_catalog = '<db>' AND schemaname='public' ..."})`，库名先过 `isSafeIdent`。
- `structSQL(dbName, tableName)`：PG 分支追加 `AND table_catalog = '<db>'` + public schema + table_name；`showTableStructure` 组装 params 时 `if (isPg() && dbName) params.database = dbName`。
- `db-postgres.js`：exec 写入 params 用实时 `ctx.getSelectedDb()`（db.js render ctx 注入 getter，面板只挂载一次，后续点库也跟随）；未点库空串回落。
- **不新增一级控件**：diff 仅为参数传递 + SQL 过滤 + getter，UI 减法口径保持；G-28 义务由双端证据 + 自评履行。

### 3.2 验证命令 + 退出码

```
node --check web/db.js            EXIT=0
node --check web/db-postgres.js   EXIT=0
bash scripts/frontend-check.sh    EXIT=0
  [OK] dist 无 source map / .vite / 全量字体
  首屏合计（gzip -9）: 91092 字节 / 预算 307200（300 KiB），余量 216108
  i18n 增量 2941 ≤ 3072，OK
  [WARN] 首屏体积漂移：91092 > 基线+5%(87341) / 绝对线(90000) —— 非阻断（脚本明示 WARN 不改退出码）
```

> `web/dist/db.js`、`web/dist/db-postgres.js` 与源码 `cmp` IDENTICAL，门禁针对的产物就是本次源码。

```
bash scripts/usability-check.sh --no-run-tests   EXIT=0
  usability-check: 0 pass, 502 warn, 0 fail, 189 unverified
```

### 3.3 全量 usability 的说明（非本变更回归）

全量 `bash scripts/usability-check.sh` 首次在默认 GOCACHE 下 19 FAIL（go build cache 只读）；换用可写 GOCACHE 后仅剩 **1 FAIL**：`A1 waf: ZeroParam 真跑失败`，直接复跑确认根因为 `unshare: 不允许的操作`（waf e2e 用 namespace 隔离，被本沙箱拒绝），waf 仓未在本变更中触碰（`git log -1` = waf-revive-fix 63b7b89），属环境限制、非 pg-dbselect 回归。pg-postgres 自身 A1：`go test -run ZeroParam -count=1 ./...` exit 0。故以静态规则口径 0 FAIL 判定本变更 usability 达标，waf 环境 FAIL 如实记录。

## 4. 真机证据复核（pg-dbselect-live.md，未启动容器）

- 报告记录的测试：`go test -count=1 -timeout 300s -v -run '^TestRealPostgresBusinessDb$' ./tests/e2e`，env `KORE_PG_E2E=1 KORE_PG_DOCKER_CONTAINER=kore-verify-pg2`，exit 0，日志贴有 `--- PASS` / `ok ... 0.774s`。
- 逐条核对测试源码 `tests/e2e/postgres_e2e_test.go:401-468`，6/6 断言均有代码支撑：
  1. `dockerExec` 在容器内建 myapp/demo 并插入 (1,'alpha')（前置，exit 0）。
  2. `query database=myapp` → `rows=[{"id":1,"name":"alpha"}]` row_count=1，断言含 `"name":"alpha"`（postgres 库无 demo，读到即证切库）。
  3. 缺省 database → `SELECT current_database() AS db` → `{"db":"postgres"}`（向后兼容）。
  4. `exec database=myapp` INSERT (2,'beta') RETURNING → `executed=true, kind=data, rows=[{"id":2}]`。
  5. 容器内直读 `psql -d myapp -tAc 'SELECT count(*) FROM demo'` → `2`（不经插件自证，证明写入落 myapp）。
  6. 非法库名 `myapp;DROP TABLE demo` → `E_INVALID` 且 result=nil；随后容器直读 count 仍为 2。
- `buildPlugin` 每次从当前工作树 `go build`，真实二进制 + 临时 UDS + kore.plugin.v1 帧协议 + 真 `psql`（宿主无 psql → docker exec 回退），非 mock。
- 隔离边界与清理（只读回读，未启动任何容器）：
  - `docker ps -a --format '{{.Names}}' | grep kore-verify-pg2` → 无命中；`docker volume ls ... | grep kore-verify-pg2` → 无命中；`ss -ltn | grep :15432` → 无监听；`.agents/verify/.pgdbselect-tmp` → 不存在。清理到位。
  - 凭据：仅 0600 文件 + `POSTGRES_PASSWORD_FILE` 变量名进 argv，报告全文无口令值；`grep` 明文口令模式只命中描述变量名的文字（G-30 合规）。
  - `common-mysql` 容器仍存在但本轮未读写/未重启；8787 / `.kore-local-*` 未触碰；未执行 install/upgrade。
- 诚实边界：真机只覆盖插件方法面 database 语义；UI 传参由 mock 覆盖（见 §5）；多实例/远程 PG 未测，报告已明示。

## 5. G-28 截图与自评（read_image 实读）

- `identify` 实测：`ui-pg-dbselect-desktop-01.png` PNG **1440×1487**（full-page）；`ui-pg-dbselect-mobile-01.png` PNG **390×844**（viewport）。
- sha256：desktop `902fae7b…` / mobile `b607cc9e…`，不同图，非同图缩放。
- `read_image` 逐张目视：
  - 桌面：数据库页 → 默认连接可达 → 库列表 `myapp` 点选 → SQL 控制台显示 myapp 库大小查询、结果 `myapp 7.3 MB` → 表结构 `myapp · 1 张表` / `demo` chip / `表结构：myapp.demo`，列 `id integer`、`name text` 两行 → 无新增一级控件。
  - 手机：窄屏单列 `myapp / 备份 / 删除`，SQL textarea 满宽，执行按钮可见；`myapp · 1 张表`、`表结构：myapp.demo` 两列可见；底部 tab 条不遮挡。
- 自评文档 `ui-pg-dbselect-selfeval.md` 三问原文齐备（解决什么问题 / 与宝塔·1Panel 差距 / 可用 vs 占位 = 可用受控范围）；DOM 断言 PC/手机 3/3 query 带 `database=myapp`、SQL 含 `table_catalog`、JS 错误 0、无横向溢出。
- mock 边界诚实：invoke 响应用 route mock（真实结构化形状），只验前端传参/渲染；真库读写由 §4 真机报告覆盖，二者互补不互冒。
- 收尾只读回读：`.agents/verify/.pgdbselect-ui/` 不存在、隔离端口 18897 无监听。

## 6. 索引 / 资产

- dist sha 四处一致：`db-postgres-0.6.0.tar.gz` 实算 `eaee8be25b02d9d6cb08d34ae09ced9e75e6bf7ae9b1e9b9c4c920eca47be948`，与 `dist/*.sha256`、`index/plugins.json:243`、`index/versions.lock.json:660` 四处一致。
- size：索引声明 `size_bytes=1676869`，实算 `1676867`，偏差 2 B，在 Makefile `dist` 明示的「≤2 字节抖动」容差内，非缺陷。
- presets 2 处（`db-only.json`、`full.json`）均 pin `db-postgres 0.6.0`；`market/plugins.js` pin `0.6.0`。
- 只读门禁：`bash scripts/validate-index.sh` → exit 0（schema/唯一性/单调递增/预设引用/market 逐字节/ed25519 内置公钥验签全 OK）；`bash scripts/build-market.sh --check` → exit 0（market 与索引逐字节一致 24 插件）；`bash scripts/validate-presets.sh` → exit 0（8 预设 / 24 插件 / 0 FAIL / 0 WARN）。

## 7. 总评

**PASS**。六项范围全部有命令+退出码+产物支撑；唯一两处非绿说明（usability 全量运行中 waf 的 `unshare` 沙箱拒绝、首屏体积漂移 WARN）均非本变更引入、非阻断，已如实记录。未发现证据不成立项，不报 BLOCKED。
