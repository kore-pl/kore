# 安全红队 Round 26：近 26 轮新增攻击面对抗复验

> 执行者：`security-r26`（red-team，独立于 implementer / verifier）· 时间：2026-11-27 20:32–20:45 CST
> 任务卡：`task-223`（持续目标 round 26 安全维度）· 写域：仅本报告
> 结论：**六场景未确认可利用缺陷**；记录 5 条有意边界/观察项，均非单管理员形态下的提权或越权通道。
> 凭据口径：本报告所有口令/哈希/密钥/查询串值一律以 `$VAR` 或 `<REDACTED>` 占位，符合 G-30。

## 0. 隔离环境与可信度声明

| 项 | 值 |
| --- | --- |
| 工作目录 | `/home/pt/Work/GolandProjects/kore-pl/kore` |
| 二进制 | `bin/kored`（2026-11-27 19:26 构建；`git log --since="2026-11-27 19:00" -- cmd internal pkg go.mod` 零命中，HEAD `3690018` 仅 docs，故与 HEAD 代码一致） |
| 独立配置 | `<repo>/.tmp/security-r26-r26/config.yaml`（`server.addr: 127.0.0.1:55131`；独立 state/run/log/index/plugins；管理员口令由 `$PW` 提供，哈希不落报告） |
| 启动命令 | `env -u KORE_CONFIG -u KORE_STATE_DIR -u KORE_PLUGIN_DIR KORE_PROFILE=portable nohup ./bin/kored serve --config "$BASE/config.yaml" --state-dir "$BASE/state" > "$BASE/kored.stdout.log" 2>&1 &` |
| 探活 | `curl -sS -i --max-time 5 http://127.0.0.1:55131/-/healthz` → `HTTP/1.1 200 OK` / `{"status":"ok"}` / exit 0 |
| 未触碰 | 8787 主实例、`.kore-local-*`、`$HOME`、外网真实服务、真实插件安装/升级；出站仅到 127.0.0.1:55132/55133 自建接收端 |
| 临时资产 | 全部位于 `.tmp/security-r26-r26/`，收尾停进程并删除（见 §8） |

> 说明：bash 每次调用处于独立 PID namespace，后台进程随调用结束退出，因此每个阶段在**单次调用内**启动实例 → 探测 → `stop_kored`；状态库持久化在隔离 state 目录，会话按登录脚本重建。

## 1. 场景① PG `exec`/`query` 的 `database` 注入

**方法**：把真实插件仓复制到隔离临时目录，加一次性 harness（`internal/pgop/redteam_r26_test.go`），对 `pgop.Call` 注入并用 `fakeExec.gotDB` 断言执行面未被触达。执行面为 fake，**不连接任何真实数据库**。

```
cd <base>/pg-harness
GOCACHE=<base>/gocache-pg GOPROXY=off GOFLAGS=-mod=mod \
  go test ./internal/pgop -run TestRedteamR26DatabaseInjection -count=1 -v
# TEST_EXIT=0（首轮 harness 未给 exec 传 confirm，被 confirm 门先拦；修正后重跑全绿）
```

原文节选（17 组 × query/exec 共 34 例；以下为代表性行，完整日志落临时目录并随清理删除）：

```
query case=semicolon      input="db; DROP TABLE users" code="E_INVALID" executor_got_db=""
exec  case=semicolon      input="db; DROP TABLE users" code="E_INVALID" executor_got_db=""
query case=single-quote   input="db' OR '1'='1"        code="E_INVALID" executor_got_db=""
exec  case=backslash      input="db\\\\evil"           code="E_INVALID" executor_got_db=""
query case=path           input="../../etc/passwd"     code="E_INVALID" executor_got_db=""
exec  case=abs-path       input="/etc/passwd"          code="E_INVALID" executor_got_db=""
query case=overlong64/1000 input=<64/1000 字符>        code="E_INVALID" executor_got_db=""
query case=unicode/fullwidth input="数据库"/"ｄｂ"     code="E_INVALID" executor_got_db=""
exec  case=nul/newline/tab/percent/sql-comment/argv-dash  code="E_INVALID" executor_got_db=""
query case=number-db/object-db  code="E_INVALID" msg="params 解析失败，请检查 JSON 格式"
query case=dup-last-good  input={"database":"evil;","database":"kore_app"} code="" executor_got_db="kore_app"
query/exec case=control-valid input="kore_app" code="" executor_got_db="kore_app"
R26-PG-HARNESS-DONE / ok github.com/pengtang1024/kore-plugin-db-postgres/internal/pgop
```

**断言**：所有注入串（分号/单双引号/反斜杠/相对与绝对路径/64 与 1000 字符/中文/全角/NUL/换行/Tab/百分号/SQL 注释/`-d` 选项形）在 query 与 exec 两条路径都返回 `E_INVALID`，`fakeExec.gotDB` 恒为空 → 未拼入 `psql -d`、未越库。非字符串 JSON 类型也在 decode 阶段 `E_INVALID`。
**边界（非缺陷）**：`resolveDatabase` 先 `strings.TrimSpace`，`"  kore_app  "` 被裁成合法库名后放行；裁剪后仍是白名单标识符，不构成注入。JSON 重复键按 Go 最后一个键生效，最后一值为合法库名时放行，同理不构成注入。
**代码点**：`kore-plugin-db-postgres/internal/pgop/validate.go:25,51-57` 白名单；`internal/pgop/call.go:109-118` 统一 `resolveDatabase`；`internal/pgop/query.go`、`internal/pgop/exec.go` 两条调用路径共用。**单测之外未找到绕过**。

## 2. 场景② scheduler 任意 plugin/method

**命令**（隔离实例内，管理员会话，CSRF 头随 cookie）：

```
post -X POST -d '{"name":"p1","plugin":"kore","method":"audit.clean","interval_s":3600}' "$API/api/v1/scheduler/tasks"
# HTTP 400 / exit 0
{"code":"E_INVALID","message":"定时任务参数非法: plugin \"kore\" 是内核内置任务的保留名，不能通过 API 创建任务；内置任务由内核自行注册","detail":""}
post -X POST -d '{"name":"v1","plugin":"Kore",...}'  → E_INVALID plugin "Kore" 不合法
post -X POST -d '{"name":"v2","plugin":"kore.",...}' → E_INVALID plugin "kore." 不合法
post -X POST -d '{"name":"v3","plugin":"kore ",...}' → E_INVALID plugin "kore " 不合法
post -X POST -d '{"name":"p2","plugin":"system","method":"install","interval_s":3600}' ... → HTTP 200，任务创建成功
post -X POST -d '{"name":"p3","plugin":"db-postgres","method":"exec","interval_s":3600,"params":{"sql":"SELECT 1"}}' ... → HTTP 200
post -X POST -d '{"name":"p4","plugin":"db-postgres","method":"root-action","interval_s":3600}' ... → HTTP 200
post -X POST -d '{"name":"p5","plugin":"evil/../x","method":"a;b",...}' → E_INVALID plugin 不合法
```

立即执行三条危险任务：

```
post -X POST "$API/api/v1/scheduler/tasks/tsk-e8311fff34a2f892/run"   # plugin=system/method=install
{"status":"failed","error":"E_NOTFOUND: 插件 system 未安装","dur_ms":0}   # exit 0
post -X POST "$API/api/v1/scheduler/tasks/tsk-199b32b5b0adbba5/run"   # db-postgres/exec
{"status":"failed","error":"E_NOTFOUND: 插件 db-postgres 未安装","dur_ms":0}
post -X POST "$API/api/v1/scheduler/tasks/tsk-77afcec8948d39d7/run"   # logs/root-action
{"status":"failed","error":"E_NOTFOUND: 插件 logs 未安装","dur_ms":0}
```

**断言/观察**：保留名 `kore` 三种大小写/标点变体均被 `pluginIDPattern` 或保留名检查拦下；危险字符串能建成任务（未走 `authorizeInvoke` 的方法级 capability），但本隔离实例插件目录为空，执行面统一 `E_NOTFOUND`，未产生任何提权执行。
**边界（如实标注，非缺陷）**：`internal/core/scheduler/input.go:85-112` 只校验 plugin id 形状与保留名，不校验 method capability；`internal/core/scheduler/run.go:57` 经 `cmd/kored/serve_runtime.go:172` 的 `daemon.Invoke` 直调插件，不经 HTTP 层 `authorizeInvoke`。创建/运行端点本身要求 `system:admin`（`internal/core/httpapi/handlers_scheduler.go:51-68`），且当前为单管理员模式（任意有效会话视为全权，`internal/core/httpapi/invoke_capability.go:106-112`），故**无法用低权身份复现提权**；多用户 RBAC 落地前，这条是设计边界而非已证实漏洞。未安装任何真实插件（硬纪律）。

## 3. 场景③ webhook SSRF（ADR-0054）

本地接收端：`python3 <base>/receiver.py 55132 <base>/recv-a.log` 与 `55133/recv-b.log`（仅 127.0.0.1）；A 对 `/redirect` 返回 302→`http://127.0.0.1:55133/internal`，对 `/slow` sleep 30s。

```
post -X POST -d '{"kind":"webhook","name":"r26probe","events":["audit"],"url":"<URL>","secret":"$WH_SECRET"}' "$API/api/v1/webhook"
```

| URL | HTTP | 原文 | exit |
| --- | --- | --- | --- |
| `file:///etc/passwd` | 400 | `{"code":"E_INVALID","message":"URL 只支持 http:// 或 https://"}` | 0 |
| `gopher://127.0.0.1:55132/_x` | 400 | 同上 | 0 |
| `http://user:***@127.0.0.1:55132/ok` | 400 | `{"code":"E_INVALID","message":"URL 不得含凭据、空白或空主机名"}` | 0 |
| `http://127.0.0.1:55132/ok?token=$QUERY_SECRET` | 200 | 建成 `ch-1`，`secret_set:true` | 0 |
| `http://127.0.0.1:55132/redirect` | 200 | 建成 `ch-2` | 0 |
| `http://127.0.0.1:55132/slow` | 200 | 建成 `ch-3` | 0 |

```
post -X POST -d '{}' "$API/api/v1/webhook/ch-2/test"    # → {"queued":true,"event":"webhook_test"} exit 0
post -X POST -d '{}' "$API/api/v1/webhook/ch-1/test"    # → 同上
post -X POST -d '{}' "$API/api/v1/webhook/ch-3/test"    # → 同上；响应立刻返回（0s）
sleep 12; get "$API/api/v1/webhook"
```

原文（历史记录）：

```
{"id":"d-3","target_id":"ch-1","status":"failed","attempts":3,
 "err":"Post \"http://127.0.0.1:55132\": context deadline exceeded",
 "target_ref":"http://127.0.0.1:55132"}
{"id":"d-4","target_id":"ch-2","status":"ok","http_code":200,"attempts":1,
 "target_ref":"http://127.0.0.1:55132"}
```

接收端原文：`recv-a.log` 恰好 3 条 `/slow`（3 次重试）+ 1 条 `/redirect` + 1 条 `/ok?token=<REDACTED>`；`recv-b.log` **0 条** → 302 未被跟随，未打到内网 55133。
泄漏检查：`grep -rn '$QUERY_SECRET\|$WH_SECRET\|token=' <base>/log <base>/kored.stdout.log` → 无命中，exit 0（grep 无匹配时由 `head` 管道归零，已用文件逐行复核）；响应/历史的 `err` 与 `target_ref` 只含 `scheme://host`。
**断言**：非 http(s) 与内嵌凭据被 `validateWebhookURL` 拒绝；不跟随重定向（`CheckRedirect` 返回 `ErrUseLastResponse`）；短超时 3s × 3 次有界重试；凭据不落日志。
**边界（非缺陷）**：`127.0.0.1` 私有地址**未被拒绝**（白名单只查 scheme/host/凭据/控制字符）——这是 ADR-0054 第 2 节「用户显式配置出站」的有意边界，且 URL 只能由 `system:admin` 经管理 API 提交，不是请求体注入；ADR §6 条件⑤（地址可被请求体注入形成 SSRF）未触发。代码点：`internal/core/httpapi/webhook.go:427-441`（校验）、`:37,896-901`（超时/不跟随）、`:881-894`（错误脱敏）；`docs/DECISIONS/0054-user-configured-webhook-egress.md` §2/§6。

## 4. 场景④ `POST /api/v1/alerts` 滥用（C9 桥接）

```
# 未登录 + 无 CSRF：401 {"code":"E_UNAUTHORIZED","message":"CSRF 校验失败"}  exit 0
# 仅持 CSRF、无会话：401 {"code":"E_UNAUTHORIZED","message":"未授权"}       exit 0
post -X POST -d '{"severity":"superman","source":"evil","title":"x"}' "$API/api/v1/alerts"
# 400 E_INVALID "severity 须为 critical/warning/info，source 须为 audit/plugin/resource/slot，title 1..200 字符，detail ≤512 字符"
post -X POST -d '{"severity":"critical","source":"plugin","title":"R26 redteam probe","detail":"controlled"}' "$API/api/v1/alerts"
# 200 {"id":"0179...","severity":"critical","source":"plugin","title":"R26 redteam probe","detail":"controlled","seen":false,"count":1}
```

出站桥接（启用已配置通道后）：

```
post -X PATCH -d '{"enabled":true}' "$API/api/v1/webhook/ch-2"     # 200
post -X POST -d '{"severity":"critical","source":"plugin","title":"bridge-probe","detail":"r26"}' "$API/api/v1/alerts"
# 200；2s 后 GET /api/v1/webhook 历史新增 {"event":"plugin","severity":"critical","status":"ok","http_code":200,"attempts":1}
# 接收端收到 {"source":"plugin","severity":"critical","title":"bridge-probe","detail":"r26","test":false}
```

**断言**：未登录/无会话均 401；受控词表拒绝任意 `source`/`severity`；合法告警按 ADR-0054 判据 3（仅告警事件触发）派发一次出站，无自动/定时出站。
**边界**：单管理员会话具备 `system:admin`，可写合法告警；不存在低权账号可供复现越权（多用户 RBAC 属 G-11 明确不做）。代码点：`internal/core/httpapi/handlers_alerts.go:66-81,111-136,183-197`。

## 5. 场景⑤ audit capability 伪造 / detail 上限（UDS）

专用 UDS：`$BASE/run/kore-selfupdate.sock`（与主 `kore.sock` 分立；先误用主 socket 得到 401，已纠正）。

```
curl -sS -i --unix-socket "$SOCK" -X POST -H 'Content-Type: application/json' \
  -d '{"source_path":"/nonexistent","sha256":"000...","version":"1.2.3","confirm":true,"capability":"system:admin"}' \
  http://localhost/api/v1/system/self-update
# 400 {"code":"E_INVALID","message":"请求体非法：json: unknown field \"capability\""} exit 0
# "action":"capability.denied" 同样 → 400 unknown field "action"
# "confirm":false → 400 "必须显式确认（confirm=true）"
```

长度上限（改 `version` 字段，审计 `target_version` 值）：

| version | HTTP | 原文/日志 |
| --- | --- | --- |
| 256×`a` | 403 | 审计先写入，随后 `{"code":"E_NEED_ROOT","message":"当前进程不是 root，无法自升级"}`（审计先于执行，fail-closed 成立） |
| 257×`a` | 503 | `{"code":"E_INTERNAL","message":"更新审计写入失败，本次更新未执行"}`；日志 `detail[target_version] 超过 256 字符` |
| 256×`<` | 503 | 同上；日志 `detail 序列化后 1608 字节 > 1024` |

审计查询（管理员，主 socket）原文：

```
{"subject":"uid:1000","action":"system.self_update","result":"ok",
 "detail":[{"key":"capability","value":"system:self_update"},{"key":"channel","value":"unix"},
           {"key":"target_version","value":"aaa..."}]}
```

**断言**：UDS 请求体严格解码（`DisallowUnknownFields`），无法注入 `capability`/`action`/`result`；审计记录的 `capability` 由服务端硬编码 `system:self_update`，未出现伪造的 `capability.denied` 记录；值 ≤256 与序列化 ≤1KiB 实测生效，超限即拒绝更新（fail-closed）。
**边界**：键 ≤32 字符、键数 ≤16 由 `internal/core/store/audit.go:25-29,83-109` 统一校验，但现有 UDS/HTTP 入口的 detail 全部由服务端构造，无外部输入可达这两项，故只做代码级确认，未做运行态注入。代码点：`internal/core/httpapi/selfupdate_local.go:126,180-198`；`internal/core/httpapi/selfupdate.go:259`。

## 6. 场景⑥ 统一 401 不泄露

未登录访问（TCP，逐条 `curl -sS -i`）：

```
GET /api/v1/alerts | /audit?since=... | /webhook | /scheduler/tasks | /system/info
GET /api/v1/plugins | /log-alerts | /security | /nope | /invoke/echo/echo
→ 全部 HTTP/1.1 401 Unauthorized
  {"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
  exit 0
```

未登录 POST（`/api/v1/alerts`、`/scheduler/tasks`、`/webhook`、`/invoke/echo/echo`、`/system/restart`、`/auth/password`）：全部 401 `{"code":"E_UNAUTHORIZED","message":"CSRF 校验失败","detail":""}`，exit 0。
UDS 主 socket（CSRF 豁免路径，排除 CSRF 掩盖）复验：`GET /api/v1/alerts`、`GET /api/v1/audit`、`GET /api/v1/scheduler/tasks` 及 `POST /api/v1/alerts` 均为 401 `{"message":"未授权"}`。
**断言**：响应体恒为固定三字段，无内部路径、无用户名、无堆栈；未知路径 `/api/v1/nope` 也回 401 而非伪装 404。代码点：`internal/core/httpapi/handlers.go:205-207`、`internal/core/httpapi/middleware.go:242-270`。

## 7. 发现清单（如实）

**确认的可利用缺陷：0。**

边界/观察项（均不构成单管理员形态下的越权，供 lead 裁决是否需要后续卡）：

1. **B-1 scheduler 不做方法级 capability 校验**：任意 plugin/method 字符串可建成任务并经 `daemon.Invoke` 执行（`input.go:85-112`、`run.go:57`、`serve_runtime.go:172`）；创建端点要求 `system:admin`，本次因隔离实例无插件全部 `E_NOTFOUND`，未证实提权。多用户 RBAC 落地前应视为设计边界。
2. **B-2 webhook 不拒绝 127.0.0.1/内网地址**：仅 ADR-0054 六判据约束；由 `system:admin` 显式配置，非请求体注入（`webhook.go:427-441`）。若未来放开低权用户配置，此边界须重审。
3. **B-3 `database` 参数 `TrimSpace` 后放行 `"  name  "`**：裁剪结果仍在白名单内，无注入面（`call.go:109-118`）。
4. **B-4 JSON 重复键按末值生效**：末值为合法库名时放行，无注入面（Go `encoding/json` 通用语义）。
5. **B-5 UDS 审计 detail 键长/键数上限无外部输入路径**：代码级确认生效，运行态不可达（`store/audit.go:25-29,83-109`）。

> 未自行修改任何生产代码/配置；未安装或升级真实插件；未 push；verifier 另派。

## 8. 收尾

```
BASE=$(realpath -m <repo>/.tmp/security-r26-r26)   # RESOLVED 与 EXPECT 逐字相等才继续
curl -sS --max-time 2 http://127.0.0.1:55131/-/healthz   # curl: (7) Failed to connect；probe_exit=7（实例已停）
rm -rf -- "$BASE"                                  # rm_exit=0
test ! -e "$BASE"                                  # GONE=yes
ss -ltnp | grep -E '55131|8787'                    # 仅 8787 主实例在监听，55131 已释放
pgrep -af "bin/kored|security-r26"                 # 无残留进程
```

已删除：独立 config/state/run/log/index/plugins、两个本地接收端脚本与日志、`r26-common.sh`、PG 插件副本与一次性 harness、两份 Go 构建缓存、cookie jar、PID/输出日志。未改动 `.kore-local-*` 与 8787 主实例。
