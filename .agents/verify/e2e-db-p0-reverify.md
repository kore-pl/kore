# R21 PG P0 真机复验（db-postgres 0.3.5 / commit 7b6f4cd）

日期：2026-11-24 18:25–18:35（Asia/Shanghai）｜Owner：`r21-pgverify`（🔵 美团味）｜范围：对 r21-pgpanic 类型化 nil error 崩溃修复做**真机回归**——组件层绿不算数，必须真机重跑 grant/changePassword 拿 200 才闭环。

> ▎[🔵 美团味] 做难而正确的事，过程透明、结果说话。P0 闭环的最后一道闸：不拿"组件测试绿"冒充"真机修好了"。两条目标方法均 502→200，防御验证返回结构化 E_NOTFOUND 而非 panic——**P0 闭环成立**。

## 0. 结论先行

| 项 | 修复前（r20-e2edb 真机） | 复验后（本轮真机） | 判定 |
| --- | --- | --- | --- |
| `db-postgres.grant` | `502 E_UPSTREAM`（插件 SIGSEGV） | `200 {"granted":true,...}` | **PASS — 502→200 闭环** |
| `db-postgres.changePassword` | `502 E_UPSTREAM`（插件 SIGSEGV） | `200 {"changed":true,...}` | **PASS — 502→200 闭环** |
| 防御：grant 不存在用户 | 未覆盖 | `404 {"code":"E_NOTFOUND",...}`，无 panic | **PASS — 结构化错误** |
| 插件日志 | 4 次 `classify` SIGSEGV panic | 0 字节，零 panic/SIGSEGV | **PASS** |

**P0 是否闭环：是（PASS）。** 两条 FAIL 方法在真机 18887 隔离实例 + 临时 PG 15433 上重跑均拿到 HTTP 200 + 目标成功字段（granted:true / changed:true），插件日志无新 panic；防御点（真实非 nil 错误）返回结构化 E_NOTFOUND，未触发 panic。满足 r20-e2edb 报告 §7 给出的全部改判条件。

## 1. G-29 声明（主实例 8787 零改动）

- **本轮未改动主实例运行态配置**：不碰 `.kore-local.yaml`、主 state/run/socket、主 `bin/kored`，**未重启 8787**。
- 开工前后各一次只读 `curl http://127.0.0.1:8787/-/healthz` → `HTTP=200`（只读探测，无副作用）。
- 隔离实例端口 **18887**，config/state/run/log/index 全落 `/tmp/kore-pgverify/`；PG 为独立容器 `kore-pgverify-pg:15433`；env `KORE_PG_DOCKER_CONTAINER=kore-pgverify-pg` 只作用于 18887 隔离进程。
- **G-30**：三处口令（admin / PG / 新口令）仅存 0600 临时文件；脚本与本报告全部 `***` 占位，响应体本就不含口令；收尾删除。

## 2. 复验对象确认（认 sha 不返工）

- 修复 commit：**`7b6f4cd`**（r21-pgpanic 已将 `e6f7b95` amend 为 `7b6f4cd`，新增两条防御测试；amend 只加测试、不改生产代码，dist 内容不变）。插件仓 HEAD=`7b6f4cd`。
- 本地 dist：`../kore-plugin-db-postgres/dist/db-postgres-0.3.5.tar.gz`
  - `sha256sum` 实测 = `2a5cddfe9a2543872768d87d7b3a14457ed4787706a4a8079015e9e6cd1ca26f`（与 lead 给定 `2a5cddfe…ca26f` 逐字符一致，退出码 0）
  - 包内 `info.json` version=`0.3.5`；kore 内核 VERSION=`0.1.1`，落在插件 `requires_kore: >=0.1.0 <0.2.0` 区间内。
- 0.3.5 未入索引（market 门会挡未入索引版本，r20-e2e-content 已实证 400 E_INVALID）：按隔离索引口径处理——`/tmp/kore-pgverify/index/plugins.json` 中把 db-postgres 条目改 0.3.5 + 上述 sha + 实际 size_bytes=1570904，隔离配置 `store.allow_unsigned: true`（审计 WARN 已记录在 kored 启动日志）。测试替身仅 /tmp，不碰共享工作区与主索引。

## 3. 环境搭建（逐条命令 + 退出码）

```text
$ git archive HEAD | tar -x -C /tmp/kore-pgverify/src              # exit 0
$ make web-dist                                                    # exit 0
$ CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false \
    -ldflags '-s -w' -o /tmp/kore-pgverify/bin/kored ./cmd/kored   # exit 0, 11190434 bytes
$ kored admin-password --set --stdin --config <0600 隔离 config>   # exit 0（口令 ***，仅 0600 文件）
$ docker run -d --name kore-pgverify-pg -e POSTGRES_PASSWORD=*** \
    -p 15433:5432 postgres:16                                      # exit 0, 容器 id ed9f678c…
$ docker exec kore-pgverify-pg pg_isready -U postgres              # 3s 后 ready, accepting connections
$ KORE_PG_DOCKER_CONTAINER=kore-pgverify-pg \
    kored serve --config /tmp/kore-pgverify/config/config.yaml     # 后台启动, pid 2283276
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18887/-/healthz   # HTTP=200
$ 启动日志 "kore ready" version=0.1.1 addr=127.0.0.1:18887         # 就绪
```

## 4. E2E 逐条命令 + HTTP/JSON（口令 ***）

登录走 `POST /api/v1/auth/login`，从 Set-Cookie 取 `kore_csrf`（非 HttpOnly），所有写请求带 cookie jar + `X-Kore-CSRF` 头；invoke 路径 `/api/v1/invoke/<plugin>/<方法名>`，方法名带 `db-postgres.` 前缀。脚本 `/tmp/kore-pgverify/e2e.py`（Python http.cookiejar + urllib 一次跑完），`exit=0`。

| 步骤 | 请求 | 实际 HTTP/JSON | 判定 |
| --- | --- | --- | --- |
| login | `POST /api/v1/auth/login {"password":"***"}` | `200 {"authenticated":true,"expires_at":"…"}` + csrf token present | PASS |
| store.install | `{"id":"db-postgres","version":"0.3.5","package_path":"<本地dist>","force":true}` | `200 {"id":"db-postgres-0.3.5","version":"0.3.5","state":"succeeded","reload":"reloaded"}` | PASS |
| plugin.enable | `POST /api/v1/plugins/db-postgres/enable` | `200 {"version":"0.3.5","enabled":true,"granted_capabilities":["system:admin"],"method_capabilities":{"db-postgres.grant":"system:admin","db-postgres.changePassword":"system:admin",…}}` | PASS |
| config.set | `{"values":{"host":"127.0.0.1","port":15433,"user":"postgres","password":"***","databases_include_system":false}}` | `200 {"saved":true,"applied":true,"restart_required":false,"warnings":[]}` | PASS |
| instances（对照组） | `{}` | `200 {"instances":[{"name":"default","port":15433,"reachable":true,"version":"PostgreSQL 16.16 …","credential_source":"plugin_config"}],"count":1}` | PASS |
| createDatabase | `{"instance":"default","name":"kore_p0_db"}` | `200 {"created":true,"name":"kore_p0_db"}` | PASS |
| createUser | `{"instance":"default","user":"kore_p0_user","password":"***"}` | `200 {"created":true,"user":"kore_p0_user"}` | PASS |
| **★grant** | `{"instance":"default","user":"kore_p0_user","database":"kore_p0_db","privileges":["CONNECT","CREATE"],"with_grant_option":false}` | **`200 {"granted":true,"user":"kore_p0_user","database":"kore_p0_db","privileges":["CONNECT","CREATE"],"with_grant_option":false}`** | **PASS（502→200）** |
| **★changePassword** | `{"instance":"default","user":"kore_p0_user","password":"***"}` | **`200 {"changed":true,"user":"kore_p0_user"}`** | **PASS（502→200）** |
| 防御：grant 不存在用户 | `{"instance":"default","user":"kore_no_such_user","database":"kore_p0_db","privileges":["CONNECT"],"with_grant_option":false}` | `404 {"code":"E_NOTFOUND","message":"角色 \"kore_no_such_user\" 不存在","detail":""}` | PASS（结构化错误，非 panic/502） |

## 5. 502→200 逐字对比（引用 r20-e2edb 原记录）

r20-e2edb 报告 [`.agents/verify/e2e-db-write.md`](e2e-db-write.md) §3 第 56/57 行原文：

```text
**grant** | granted:true | `502 {"code":"E_UPSTREAM","message":"插件 db-postgres 连接已断开"}` | **FAIL（后端真 bug，见 §5）**
**changePassword** | changed:true | `502 {"code":"E_UPSTREAM","message":"插件 db-postgres 连接已断开"}` | **FAIL（后端真 bug，见 §5）**
```

同报告 §5 原 panic 堆栈（4 次相同）：

```text
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x8 pc=0x5696f2]
github.com/pengtang1024/kore-plugin-db-postgres/internal/pgop.classify({0x60fec0, 0x0})
    .../internal/pgop/call.go:109 +0x72
（changePassword 同栈：callChangePassword admin.go:231 → classify call.go:109）
```

本轮复验（同一 invoke 链路、合法成功路径入参）：

```text
grant          → HTTP 200 {"granted":true,"user":"kore_p0_user","database":"kore_p0_db","privileges":["CONNECT","CREATE"],"with_grant_option":false}
changePassword → HTTP 200 {"changed":true,"user":"kore_p0_user"}
插件日志 /tmp/kore-pgverify/log/plugins/db-postgres.log：size=0 lines=0，grep panic|SIGSEGV|nil pointer|classify 零命中
kored.stdout.log：grep panic|SIGSEGV|nil pointer|连接已断开 零命中
```

**对比结论**：同样的 502 触发路径（成功路径、合法入参），修复后被"真机 200 + 成功字段 + 零 panic"替代；防御路径按 r20-e2edb §7 建议补验，真实非 nil 错误走结构化 E_NOTFOUND 且插件存活——三层判据全过。

## 6. 与 peer 的横向核对（已闭环）

- `r20-e2edb`（发现者）：拿到 §3 逐条 502 原文、§5 panic 堆栈、§7 改判条件与 runbook（CSRF 头、docker exec 回退需注入 `KORE_PG_DOCKER_CONTAINER`、登录 cookiejar 法）；本轮按其判据执行。
- `r21-pgpanic`（修复者）：确认 dist 路径/sha、包内 version=0.3.5、方法名与成功字段（granted/changed）、commit 由 e6f7b95→7b6f4cd 且 dist 内容不变；按"认 sha"口径继续，未返工。
- 共性问题（0.3.5 未入索引被 market 门挡）已由 content 轨道先例 + 本轮隔离索引口径解决，无需 lead 裁决。

## 7. 合规与收尾

- **G-07 证据**：全部判定附命令 + 退出码 + HTTP 码 + JSON 原文；502 原记录逐字引用。
- **G-29**：主实例 8787 零改动（只读 healthz 探测，不重启/不改配置/不覆盖资源）；隔离端口 18887、PG 容器 15433 独立。
- **G-30**：口令仅 0600 临时文件，报告与脚本输出全 `***` 占位；`make secret-check` 见下方收尾记录。
- **写域**：仅本报告（新文件）；未改任何源码/配置、未碰主实例。
- **收尾**：`docker rm -f kore-pgverify-pg`、停 18887 隔离进程、删 `/tmp/kore-pgverify` 全部（源码/bin/config/口令/index/state/log/run/e2e.py/e2e.out）、`git status --short` 复核零残留（本报告为唯一新增文件）。
