# PG exec 独立验收报告（G-09 / task-178）

> 2026-11-27 · verifier `pg-exec-verifier`（非 implementer `pg-exec`，角色不兼任 G-09）· 只读复跑，未改任何实现代码、未连宿主 DB、未碰 `.kore-local-*`、未执行主流程 CLI、未 push、未联网。
>
> 复核对象：`kore-plugin-db-postgres@c2e2ff9` / `kore@a780865` / `kore-plugins@4f05921`。
>
> **总评：PASS。** 五项复核范围全部成立；两处环境限制（usability 默认 GOCACHE 只读、WAF A1 在沙箱内 `unshare` 被拒）已如实标注，均非本改动引入，不构成 BLOCKED。

---

## 1. 后端全链路与 PG 方言 writeguard（PASS）

### 1.1 代码复核（逐文件）
- `internal/pgop/call.go`：`businessVerb` 白名单含 `exec`（L74-77）；`Call` switch 分发 `case "exec": return callExec(...)`（L33-34）。
- `internal/pgop/exec.go`：`callExec` 顺序为 **requireAdmin → decodeParams → ValidateWriteSQL → findInstance → exec.Exec → ExecResult**（L20-53）。`ExecResult.Instance/Kind/Executed/Columns/Rows/RowCount`，`Columns`/`Rows` 的 nil 归一为 `[]`，`RowCount = len(Rows)`（L39-52）。拒绝路径不触达执行面（writeguard_test.go L101-108 断言 `fake.gotSQL == ""`）。
- `internal/pgop/types.go`：`Executor.Exec(instance, sql, limit)` 与只读方法同接口（L105-124）；`execParams` 只含 `instance/sql/confirm/confirm_text`（L189-194），**无 confirm_token 入参**——全仓 grep `confirm.token|confirm_token|confirmToken` 零命中，符合「不接内核 confirm-token」口径。
- `internal/pgop/client.go`：`Client.Exec` 走 `runStdin`（L228-246），`psqlStdinArgs` 无 `-c`（L396-399），SQL 由 `cmd.Stdin` 注入（L329、L334）；**写语句不进 argv / ps / docker 命令行**。只读 `Query` 仍走 `-c`（L201-220）。
- `internal/pgop/writeguard.go`：
  - data 白名单 `INSERT/UPDATE/DELETE/MERGE`（L26-31，PG 方言去掉 MySQL 的 `REPLACE`、加入 PG15 的 `MERGE`）；
  - ddl 白名单 `DROP/TRUNCATE/ALTER/CREATE/RENAME/GRANT/REVOKE/REINDEX/CLUSTER/VACUUM/ANALYZE/SET/RESET/COMMENT`（L37-52，PG 方言调整，其余 fail-closed）；
  - 两级确认：`confirm=true` + ddl 额外手打 `confirmPhrase()` 首两个纯字母关键字（L111-123、L129-159）；
  - 拒绝：空语句 / >64 KiB / NUL / 多语句（末尾单分号除外）/ 反斜杠 psql 元命令（复用 `sanitizeSQL`，sqlguard.go L217-218）/ `COPY ... PROGRAM`（L101-103）/ 副作用函数 `forbiddenFunctionsRE`（L106-109，含 pg_sleep、dblink、pg_read_file 等）；嵌套块注释由 `skipBlockComment` 深度计数处理（sqlguard.go L304-323）。
  - 只读首关键字（SELECT/SHOW/EXPLAIN/WITH）在 exec 路径明确拒绝并引导走 query（L85-88）。
- 权限纵深：`exec=system:admin`（info.json L17、capability_test.go L16、methods_test.go 期望表），`query=system:read` 未放开；`requireAdmin(cfg)` 在 `callExec` 入口先行，无 admin → `E_UNAUTHORIZED`（admin.go L20-28，writeguard_test.go L135-141）；`cfg.Admin` 来自 info.json capabilities（config.go L123）。
- 期望表同步：`call_test.go`（fake Exec + 从 unknown 列表移除 exec + businessVerb 白名单）、`methods_test.go`、`main_test.go`（exec 由 E_NOTFOUND 改 E_INVALID）、`capability_test.go`、`tests/fault/inject_test.go` 均已同步；CHANGELOG 有 0.5.0 条目。
- 版本合理性：0.4.2 → 0.5.0，新增方法面（feat）按语义化版本为 minor，info.json/manifest.json 均为 0.5.0；`size_bytes=1676082` 与实际包 1676081 偏差 1 字节（Makefile 收敛容差 ±2，包内 info.json 同为 1676082）。

### 1.2 实跑证据（命令 + 退出码 + 关键输出）
```
$ GOCACHE=<workspace>/.gocache-release-b GOWORK=off go test -count=1 -timeout 200s ./...
ok  github.com/pengtang1024/kore-plugin-db-postgres                0.006s
ok  github.com/pengtang1024/kore-plugin-db-postgres/internal/pgop   0.008s
ok  github.com/pengtang1024/kore-plugin-db-postgres/internal/plugincfg 0.003s
ok  github.com/pengtang1024/kore-plugin-db-postgres/tests/e2e       0.005s
ok  github.com/pengtang1024/kore-plugin-db-postgres/tests/fault     2.015s
EXIT=0

$ GOCACHE=<workspace>/.gocache-release-b make check
gofmt: clean
GOWORK=off go vet ./...
GOWORK=off go test -timeout 200s ./...   （5 包全 ok，同上）
[SKIP] 无 tests/boundary：race 门禁无目标
EXIT=0
```
verbose 关键 case（`go test -count=1 -v -run 'TestValidateWriteSQL|TestCallExec|TestMethodCapabilitiesConsistency' ./internal/pgop`，EXIT=0）：
```
--- PASS: TestMethodCapabilitiesConsistency
--- PASS: TestValidateWriteSQLAllow  （update/insert/insert returning/delete/merge/drop 短语/alter/truncate/create/grant/reindex/vacuum 括号前缀 全 PASS）
--- PASS: TestValidateWriteSQLReject （空语句/读语句走 query/with/show/未确认/ddl 缺短语/短语不匹配/多语句/NUL/超64KiB/反斜杠命令/块注释内分号放行/非白名单前缀/COPY PROGRAM/pg_sleep/dblink/空关键字 全 PASS）
--- PASS: TestCallExec               （拒绝不触达执行面/合法写返回 row_count=1/ddl 缺短语拒绝/无 system:admin → E_UNAUTHORIZED）
ok  .../internal/pgop   0.007s
```

## 2. 门禁复跑（PASS）
```
$ node --check web/db.js            EXIT=0
$ node --check web/db-postgres.js   EXIT=0
$ make frontend                     EXIT=0
  [OK] 首屏体积达标：91092 字节 ≤ 307200 字节（300 KiB），余量 216108 字节
  [WARN] 首屏体积漂移 91092 > 绝对线 90000（非阻断；db-postgres.js 为懒加载模块，不进首屏）
  [OK] i18n 增量达标：2941 ≤ 3072
$ bash scripts/usability-check.sh（默认 GOCACHE）  EXIT=1，19 FAIL
  → 全部为 `open /home/pt/.cache/go-build/...: read-only file system` 的沙箱缓存写入失败，覆盖 19 个插件（含与本改动无关的 app-deploy/waf 等），非代码违规。
$ GOCACHE=<workspace>/.gocache-release-b bash scripts/usability-check.sh
  usability-check: 0 pass, 502 warn, 1 fail, 189 unverified
  [FAIL] A1 waf: ZeroParam 真跑失败
  → 直接复跑 `cd kore-plugin-waf && go test -count=1 -run ZeroParam ./tests/e2e` 得到 `unshare: unshare 失败: 不允许的操作`，为沙箱不允许 namespace 操作所致的存量 waf A1 FAIL；无 PG exec 相关新增 FAIL（符合任务卡「仅 1 存量 waf A1」口径）。
$ cd kore-plugins && bash scripts/validate-index.sh    EXIT=0
  [OK] schema/必填/id 唯一/sha256 格式（24 条）
  [OK] 版本单调 / 同 id@version 唯一 sha
  [OK] 预设引用可解析（47 条）
  [OK] market/plugins.js 与索引逐字节一致（24 个插件）
  [OK] ed25519 签名验证通过（内置公钥）
$ bash scripts/build-market.sh --check               EXIT=0
  [OK] market/plugins.js 与索引逐字节一致（24 个插件）
```

## 3. 索引与资产一致性（PASS）
- dist sha 四处一致，均为 `c3bf8e3342cf1ee7526833ddc1ac71b585a0c1514034830c2aa666d779b0ecc6`：
  ① `dist/db-postgres-0.5.0.tar.gz` 实际 `sha256sum`；② 同目录 `.sha256` 文件；③ `index/plugins.json` 的 db-postgres@0.5.0 条目；④ `index/versions.lock.json` 的 db-postgres@0.5.0 条目。
- size：包体 `stat -c%s` = 1676081；index 条目 `size_bytes` = 1676081；info.json / 包内 info.json = 1676082，偏差 1 ≤ Makefile ±2 收敛容差。
- presets：`presets/db-only.json`、`presets/full.json` 中 db-postgres 均 pin `version: "0.5.0"`。
- market：`market/plugins.js` 内 db-postgres 版本 0.5.0，且 `build-market.sh --check` 与 `validate-index.sh` 双重确认与索引逐字节一致（即 market 已按新索引重建）。
- ed25519：`index/plugins.json.sig` 为 64 字节；`validate-index.sh` 默认全量验签（未设 `KORE_INDEX_SKIP_SIG`），输出 `[OK] ed25519 签名验证通过（内置公钥）`，EXIT=0。

## 4. G-28 双端截图与 mock 边界诚实性（PASS）
- `identify` 实测：`ui-pg-exec-desktop-01.png` = PNG 1440x1884（full-page，高 >900）、228313 B；`ui-pg-exec-mobile-01.png` = PNG 390x844（精确手机视口）、78936 B。二者 sha256 分别为 `cd8865fe…` / `35b0c832…`，**不同图**，非同图缩放冒充。
- `read_image` 实读两图（非只看文本断言）：
  - 桌面：PostgreSQL 连接区（标注 `PostgreSQL 16.16 (mock)`）→「SQL 写入（INSERT / UPDATE / 结构变更）」折叠区展开 → 预设 `INSERT INTO demo (name, created_at) VALUES ('示例', NOW()) RETURNING id` → 已勾选「我已确认」→「执行完成：数据写入 · 目标 default · 影响行数 1」→ 结果表列 `id` / 行 `42`。
  - 手机：窄屏单列，预设按钮换行、textarea 全宽、确认勾选框与执行按钮可见，同一 `影响行数 1` / `id=42` 结果表，底部 tab 条不遮挡关键内容。
- 三问原文已读（`ui-pg-exec-selfeval.md` §2 L23-33）：问1 解决「PG 页此前只有只读入口、写入要找 DBA」；问2 与宝塔/1Panel 差距＝无行级 CRUD/历史/按表白名单，为有意边界；问3 判「可用（受控写范围）」并列 UI/invoke/门禁三条判据。
- **mock 边界诚实性**：自评 §3/§4 明确写「本机没有 PostgreSQL 真服务端」，`instances/status/databases/query/exec` 由 Playwright 路由 mock 返回结构化数据（形状取自真实 `ExecResult`/`QueryResult`），「`INSERT` 真的写进数据库」未在真 DB 执行；invoke 通道/CSRF/前端渲染/mock 边界外 Go 写守卫为真实代码；只读操作员 `exec → E_UNAUTHORIZED` 明确标注「**设计承诺/单测证据，非真机双用户实测**」，由 `TestCallExec` 覆盖。截图里连接版本也直接写 `(mock)`。**未把 mock 描述成真机 DB 写成功，边界如实。**
- 收尾痕迹：`.agents/verify/.pgtmp/` 已不存在（隔离实例/脚本/二进制已清）；`ss -ltn` 无 5432/43327 监听；未动主实例 8787 运行态资产。

## 5. git 纪律（PASS）
- 三仓 HEAD 精确匹配指定 commit，提交文件数与路径精确：
  - `kore-plugin-db-postgres@c2e2ff9`：14 文件（CHANGELOG/info/manifest/call.go/call_test/capability_test/client/exec/types/writeguard/writeguard_test/main_test/methods_test/tests/fault/inject_test）。
  - `kore@a780865`：7 文件（2 张截图 + ui-pg-exec-selfeval.md + Makefile + web/db-postgres.js + web/db.js + web/embed.go）。
  - `kore-plugins@4f05921`：6 文件（index/plugins.json + .sig + versions.lock.json + market/plugins.js + presets/db-only.json + presets/full.json）。
- DCO：三仓 HEAD 均含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`（`git %G?=N` 仅表示无 GPG 签名，任务要求为 DCO trailer，已满足）。
- 未 push：PG `main...origin/main [领先 1]`、kore `[领先 3]`（a780865 + 他人 2 条）、plugins `[领先 1]`；本轮未执行任何 push。
- worktree：`git worktree list` 三仓均只有主工作树 1 行；`git branch --list 'wt-*' 'tmp-*'` 三仓均空。
- 他人 dirty 原样：PG `?? zeroparam_test.go`；kore ` M scripts/usability-pending.txt` + `.agents/.agents/`、`.agents/verify/e2e-*.md`、`run-user-model.md`、`screenshots/adp-debug-desktop-01.png`、`data/`、`dist/` 等 untracked；plugins `?? .tmp-validate-out.txt`、`?? dist/`。本 verifier 未改动/未暂存/未提交其中任何一项。

---

## 6. 结论
五项复核范围（后端全链路与 PG writeguard、门禁、索引资产、G-28 截图与 mock 诚实性、git 纪律）证据均成立，无 BLOCKED 项。两处 FAIL 均为沙箱环境产物且已复跑隔离：usability 默认 GOCACHE 只读导致的 19 FAIL 在可写 GOCACHE 下归零；剩余 1 FAIL 为存量 waf A1 的 `unshare` 限制，与 PG exec 无关。

**总评：PASS。**
