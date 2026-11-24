# R20 PG/MySQL 写方法真机 E2E 验证（隔离实例 18881）

日期：2026-11-24 18:02–18:16（Asia/Shanghai）｜Owner：`r20-e2edb`（🔵 美团味）｜范围：第11轮接入的 PG/MySQL 写方法前端 invoke 真链路（补"组件+自测"未覆盖的端到端一环）

> ▎[🔵 美团味] 做难而正确的事，过程透明、结果说话。本轮拿到一个**真 P0**：grant/changePassword 真调触发插件 nil pointer panic，前端契约没问题，是后端执行面的类型化 nil error 缺陷。不伪装成功、不隐瞒失败。

## 0. 结论先行

| 判定 | 数量 | 方法 |
| --- | --- | --- |
| **PASS（真机跑通）** | 10 | login / store.install / plugin.enable / config.set / instances(reachable:true) / createDatabase / databases(带 instance) / createUser / dropDatabase / dropUser / rolname 列表查询(84c24f1) / **grant（真机复验 200 granted:true）** / **changePassword（真机复验 200 changed:true）** |
| **FAIL（真 bug，需报 lead）** | 0 | 原 2 项 `grant`、`changePassword`（HTTP 502 E_UPSTREAM「插件 db-postgres 连接已断开」，插件 SIGSEGV panic，502 历史原文保留于 §3）**已由 r21-pgverify 真机复验 200 改判 PASS**（见 §7 / e2e-db-p0-reverify.md） |
| **环境阻塞** | 0 | PG 用临时容器 kore-e2edb-pg:15432 真跑通；MySQL 本机有 common-mysql:3306（见 §4 说明未在本轮覆盖） |

**关键定性**：原 FAIL 的 2 个方法**不是前端契约错误、不是环境限制**，是插件后端 `classify()` 对类型化 nil error 解引用导致进程 panic 的 P0 真缺陷——已由 r21-pgpanic 修复（commit `7b6f4cd`）并经 r21-pgverify 真机复验 200（grant `granted:true` / changePassword `changed:true`，dist sha `2a5cddfe`）**改判 PASS，P0 闭环成立**。502 历史原文不删，保留作 502→200 对比基线。

## 1. 隔离实例（G-29：主实例 8787 零改动）

```text
HEAD=bc9b237f0a71aa079889de213177f43a2085b8ae
git archive HEAD | tar -x -C /tmp/kore-e2edb/src        # exit 0
make web-dist + go build → /tmp/kore-e2edb/bin/kored    # exit 0, 11190434 bytes
admin-password --set --stdin（明文仅 0600 /tmp/kore-e2edb/admin.pw，报告 *** 占位，G-30）  # exit 0
kored serve --config /tmp/kore-e2edb/config/config.yaml # 隔离端口 18881，state/run/log 全落 /tmp
healthz http=200
PG: docker run -d --name kore-e2edb-pg -e POSTGRES_PASSWORD=*** -p 15432:5432 postgres:16
    PostgreSQL 16.16，pg_isready OK
隔离实例重启一次以注入 KORE_PG_DOCKER_CONTAINER=kore-e2edb-pg（本机无 psql，走 docker exec 回退）
```

**G-29 声明**：本轮**未改动主实例运行态配置**——不碰 `.kore-local.yaml`、主 state/run/socket、主 `bin/kored`，未重启 8787；PG 容器名 `kore-e2edb-pg` 独立，端口 15432 独立，KORE_PG_DOCKER_CONTAINER env 只作用于 18881 隔离进程。

**采纳 r20-e2e-content 教训（横向交流）**：安装前核对 db-postgres@0.3.4 索引 sha 与本地 dist 一致（`3f1e228b…` match=YES），且 dist 二进制含六个写方法 verb——避免把索引滞后误判成前端契约错（该轨道发现 site@0.4.4 dist 缺三方法，本轨道无此问题）。

## 2. 前端契约核对（只读，非"跑通"）

- 前端 `web/db.js:70-100`：`invokeAt` = `POST /api/v1/invoke/<plugin>/<全限定方法名>` + `X-Kore-CSRF`（取 kore_csrf cookie）+ JSON body；PG 方法名带 `db-postgres.` 前缀。
- 前端 `web/db-l2.js:358-522`：六个写方法入参与后端 `kore-plugin-db-postgres/internal/pgop/types.go` 的 `createDatabaseParams`/`createUserParams`/`grantParams`/`changePasswordParams`/`dropUserParams`/`dropDatabaseParams` **逐字段对齐**。
- `84c24f1` 修复点确认：`web/db-l2.js:574` 用 `SELECT rolname AS role_name FROM pg_roles …`，避开 PG 保留字 `AS user`；paint 侧 `:549` 兼容 role_name/rolname/User（r19-pgwrite 提交）。

## 3. E2E 逐条命令 + 退出码 + 关键 JSON（口令一律 *** 占位）

方法 | 预期 | 实际 HTTP/JSON | 判定
--- | --- | --- | ---
login | 200 authenticated | `200 {"authenticated":true,"expires_at":"…"}` + session(43字符csrf) | PASS
store.install db-postgres@0.3.4 | state=succeeded | `200 {"state":"succeeded","version":"0.3.4","reload":"reloaded"}` | PASS
plugin.enable | enabled | `200 {"enabled":true,"desired":"enabled","granted_capabilities":["system:admin"],"method_capabilities":{"db-postgres.changePassword":"system:admin",…}}` | PASS
config.set | saved/applied | `200 {"saved":true,"applied":true,"restart_required":false,"warnings":[]}` | PASS
instances | reachable:true | `200 {"instances":[{"name":"default","host":"127.0.0.1","port":15432,"reachable":true,"version":"PostgreSQL 16.16 …","credential_source":"plugin_config"}],"count":1}` | PASS
databases `{}` | 库列表 | `400 {"code":"E_INVALID","message":"缺少必填参数 instance"}` | 脚本入参问题（前端真实调用带 instance，见下一行）
databases `{"instance":"default"}` | 库列表 | `200 {"instance":"default","databases":[{"name":"postgres",…}],"count":1}` | PASS
createDatabase | created:true | `200 {"created":true,"name":"kore_e2e_db"}` | PASS
databases.after_create | 新库出现 | 同库列表调用方式，createDatabase 返回 created:true；after_create 用 `{}` 再次 E_INVALID（脚本入参问题） | 部分验证
createUser | created:true | `200 {"created":true,"user":"kore_e2e_user"}` | PASS
query rolname (84c24f1) | 用户列表加载含新用户 | `200 {"columns":["role_name"],"rows":[{"role_name":"kore_e2e_user"}],"row_count":1}` | PASS——保留字修复生效
**grant** | granted:true | `502 {"code":"E_UPSTREAM","message":"插件 db-postgres 连接已断开"}`（历史基线，保留） | **PASS（真机复验 200 granted:true，见 §7 / e2e-db-p0-reverify.md）**
**changePassword** | changed:true | `502 {"code":"E_UPSTREAM","message":"插件 db-postgres 连接已断开"}`（历史基线，保留） | **PASS（真机复验 200 changed:true，dist sha 2a5cddfe，见 §7 / e2e-db-p0-reverify.md）**
dropUser（先于 dropDatabase） | dropped:true | `502 E_UPSTREAM` + docker psql `ERROR: role "…" cannot be dropped because some objects depend on it` | 清理顺序问题（非契约错），重排后 PASS
dropDatabase | dropped:true | `200 {"dropped":true,"name":"kore_e2e_db"}` | PASS
dropUser（正确顺序重排后） | dropped:true | `200 {"dropped":true,"user":"kore_e2e_u2"}` / `200 {"dropped":true,"user":"kore_e2e_user"}` | PASS

补验脚本（e2e2.py）：`grant.retry` 仍 502（稳定复现，非偶发）；`databases{instance}` 200。所有测试库/用户已按"先删库再删用户"顺序清理干净。

## 4. MySQL 覆盖说明

本机有 `common-mysql`（mysql:9.7.1，3306，healthy）。本轮时间预算（10 分钟）在 PG 链路 + P0 定性上耗尽，**MySQL changePassword/instances 冒烟未执行**，如实标注为未覆盖（非环境阻塞——环境具备）。建议后续补验。

## 5. P0 FAIL 根因（堆栈原文，判定后端缺陷）

隔离实例插件日志 `/tmp/kore-e2edb/log/plugins/db-postgres.log` 4 次相同 panic，完整堆栈：

```text
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x8 pc=0x5696f2]
goroutine 1 [running]:
github.com/pengtang1024/kore-plugin-db-postgres/internal/pgop.classify({0x60fec0, 0x0})
    .../internal/pgop/call.go:109 +0x72
github.com/pengtang1024/kore-plugin-db-postgres/internal/pgop.callGrant(...)
    .../internal/pgop/admin.go:194 +0x46a
（changePassword 同栈：callChangePassword admin.go:231 → classify call.go:109）
```

**根因**：`client_admin.go` 的 `Grant`/`ChangePassword` 在成功路径返回了**类型化 nil error**（`error` 接口持有 `(*OpError)(nil)`）。`classify()`（`call.go:106-125`）的 `errors.As(err, &opErr)` 对类型化 nil 返回 true，随后 `opErr.Code` 解引用 nil 指针 → SIGSEGV → 插件进程 panic 退出 → 内核 bus 检测到连接断开 → HTTP 502 E_UPSTREAM。

**责任判定**：**后端插件缺陷，非前端契约错、非环境限制**。理由：① 前端入参与后端 types.go 完全一致（§2）；② 同实例 createDatabase/createUser/dropDatabase/dropUser/query 全部 200，证明环境/连接/鉴权正常；③ 堆栈直指插件源码 `call.go:109` / `admin.go:194,231`；④ 稳定复现两次（首轮 + 补验重试）。

**修复建议（供 lead 派发，不在本写域实施）**：`classify()` 入口加 `if err == nil { return nil }` 且 `errors.As` 后判 `opErr != nil`；或 `Grant`/`ChangePassword` 成功路径明确返回 `nil`（非类型化 nil）。修复后需重跑本 E2E 的 grant/changePassword 两条。

## 6. 合规与收尾

- **G-07 证据**：全部判定附命令 + HTTP 码 + JSON 原文；P0 附 panic 堆栈原文。
- **G-29**：主实例 8787 零改动（不重启、不改配置、不覆盖资源）；隔离端口 18881、PG 容器 15432 独立。
- **G-30**：所有口令仅存 0600 临时文件与环境变量，报告全 `***` 占位；`make secret-check` 待收尾复核。
- **写域**：仅本报告；未改任何源码/配置、未碰 git、未碰主实例。
- **收尾**：临时 PG 容器 `docker rm -f kore-e2edb-pg`、隔离实例停掉、`/tmp/kore-e2edb` 删除、`e2e.py`/`e2e2.py` 临时脚本删除；`git status` 零残留（报告为唯一新增文件）。

## 7. 修复跟踪（后续补充，状态如实标注）

- r21-pgpanic 已提交组件层修复：`e6f7b95`，版本 bump `0.3.5`。措施：Grant/ChangePassword 成功返回裸 nil；`isNilError`（reflect 通用识别装箱 nil）用于六写方法执行面判断；classify/errorText/execError 的 errors.As 后判空 + 入口挡类型化 nil；全仓 4 处 errors.As 加固。回归测试构造类型化 nil，堆栈 `classify({0x635220,0x0})` 与本真机 `classify({0x60fec0,0x0})` 同构。
- 我以真机入参向 r21-pgpanic 核对变体：两条 FAIL 都是**成功路径**（用户/库/口令均合法），非校验失败、非 SQL 错误；`FaultError` 与 `fmt.Errorf("%w", typedNil)` 两种变体真机链路不产生（execDDL 直返 *OpError，无包装）。建议补一条"真实非 nil 错误仍正常映射不崩"的回归作为额外防御。
- **【历史状态 · 复验前】** 当时 grant/changePassword 记 FAIL（真机 502），组件修复 ≠ 真机复验通过；改判条件为：0.3.5 修复版真机重跑、拿到 200/granted:true/changed:true。此段保留作改判由来的留痕（G-23）。
- **【当前状态 · 已改判 PASS】** r21-pgverify 真机复验已满足上述全部改判条件，本报告 §0 汇总表与 §3 判定列已随新证据更新为 PASS。**证据冻结纪律（G-07/G-23）：§3 两条 502 原文与 §5 panic 堆栈作为历史基线原样保留不删，只更新判定、不改写历史。**
- **【复验结果已到达 · 2026-11-24 18:35】** r21-pgverify 已独立真机复验（隔离实例 18887 + 临时 PG 15433，插件 0.3.5 / commit `7b6f4cd`）：`grant → HTTP 200 {"granted":true,"user":"kore_p0_user","database":"kore_p0_db","privileges":["CONNECT","CREATE"],"with_grant_option":false}`；`changePassword → HTTP 200 {"changed":true,"user":"kore_p0_user"}`；插件日志零 panic；防御点 grant 不存在用户 → `404 {"code":"E_NOTFOUND",…}`（结构化错误、未崩）。完整证据见 `.agents/verify/e2e-db-p0-reverify.md`。上述结果满足本节原设的全部改判条件；**§3 两条 502 历史原文保留不动**（作为 502→200 对比基线，抹掉即等于抹证据）。**本条为改判依据；判定已按 lead 裁决落地为 PASS（见 §0/§3 及上方当前状态），P0 闭环成立。**
