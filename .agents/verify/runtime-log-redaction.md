# 运行时日志 / 审计详情凭据泄漏核实（G-30 运行时面 · task-324）

> 执行：runtime-redact ｜ 2026-11-28 ｜ HEAD=`342316a06ed2092be2d5e91000c25b0035f0ba97`
> 结论：**两阶段均未发现凭据泄漏**。阶段二在隔离实例（非 8787 / 独立 config+state+run+log / 临时 HEAD 二进制）构造四组敏感场景，日志、审计导出、错误响应中均未出现测试凭据原串；阶段一确认的「日志字段白名单未实现」是**文档已声明的 M1-14 待办**，不是本次探测到的真实泄漏，未改生产代码。

## 0. 纪律与边界（先写清楚）

- 不联网业务、不碰主实例 8787 / `.kore-local*` / 宿主 `bin/kored`（G-29）：全程只用 `.tmp/redact-r50/` 隔离树，端口 `55261`（webhook 故障接收端 `55262` 为本地未监听地址），临时二进制由 HEAD 源码现编。
- 敏感串口径（G-30）：真实测试口令 / 错口令 / token marker / webhook 密钥 / URL query key 全部在 harness 进程内用 `secrets.token_urlsafe` 生成，**不进 argv、不进报告**。报告与 stdout 只出现占位符：`<REDACTED_TEST_PASSWORD>` / `<REDACTED_BAD_PASSWORD>` / `<REDACTED_TEST_TOKEN>` / `<REDACTED_WEBHOOK_SECRET>` / `<REDACTED_QUERY_KEY>`。
- 诚实边界：①单机单实例、隔离非 8787；②只探下列构造场景，**不是全覆盖**；③无竞品同口径数据，**不作超越证据**（不说"优于宝塔/1Panel"）；④日志字段白名单（M1-14）仍未实现，本结论只对本次构造场景成立，不代表未来所有出口。
- 一次性资产：`probe.py` 一次性 harness + 隔离树在收尾前删除；唯一保留物为本报告。

## 1. 阶段一 · 只读核实（命令 + 退出码 + 关键输出）

### 1.1 `.agents/verify/` 既有证据：只有静态 G-30，没有运行时四场景测试

| 命令 | 退出码 | 关键输出与判定 |
| --- | --- | --- |
| `grep -rnE '脱敏\|redact\|泄漏\|leak\|secret\|token.*log\|audit.*detail' kore/.agents/verify/` | 0（669 命中） | 命中集中在：`make secret-check` 0 FAIL（docs/ 与报告**明文口令静态扫描**）、隔离实例口令只在内存/0600 文件的声明、`security-redteam-r26.md` 的 webhook 密钥不落日志、凭据 UI 列表不回显。逐项核对后：**没有任何一份现有报告对「错误 Bearer / 失败登录 audit detail / 审计 GET 导出 / 含敏感参数失败请求」四类运行时出口做端到端脱敏验证**。 |
| `grep -n 'sanitizeChannelError\|脱敏' kore/.agents/verify/security-redteam-r26.md` | 0（1 命中） | `:123` 引用 `webhook.go:427-441,881-894` 的代码级证据 + 一次真实投递日志无密钥；属**部分覆盖**（仅 webhook 投递错误）。 |
| `grep -n '口令泄漏检查\|audit.*detail' kore/.agents/verify/round4-audit.md` | 0 | `:33` 对整份审计响应 `grep -c '<口令>' = 0`，但那是静态样本核对，未构造 Bearer/失败登录/敏感参数场景。 |

**结论**：G-30 既有证据是「静态扫 docs/ 与 .agents/verify/ 明文串」+「隔离口令只在内存」，**运行时日志/审计出口确实从未被当作一个面系统验证**，缺口成立 → 进入阶段二。

### 1.2 `docs/SECURITY.md` 脱敏口径（唯一真源）

| 条款 | 口径原文要点 |
| --- | --- |
| `docs/SECURITY.md:41` | 威胁表「日志泄密」：缓解 = 字段白名单 fail-closed + 丢弃非白名单字段；残余 = 插件自写日志不受控。 |
| `:143` | 登录审计 `login.failed` 的 reason ∈ `wrong_password`/`rate_limited`/`no_session`；IP 只前 3 段、UA 100 字符、会话 8 字符前缀，**口令任何形式都不进审计**。 |
| `:153` | API token 明文只在创建时返回一次、库只存 sha256；IP 绑定拒绝固定 401 detail="" 不回显白名单/对端 IP。 |
| `:168` | 自更新审计 detail 仅 `channel`/`capability`/`target_version`，不记口令/token/confirm 原文。 |
| `:312-315` | 审计保留 90 天 + 内置任务清理；`audit.clean` 拒绝留痕 detail 只带可解析的 retention/batch。 |
| `:337` | **「日志字段白名单（M1-14 计划，当前未实现）」**：目标白名单 `ts/level/event/req_id/...`；现状只有 `req_id` 注入，`access_log` 中间件与白名单重建均未实现（`internal/core/httpapi/middleware.go:269` 标注归 M1-14）。 |
| `:338` | 禁止记录：口令、token、cookie、secret、`Authorization`、完整请求体、签名原文；`ip`/`ua` 只存 sha256 前 16 字节。 |

### 1.3 生产代码敏感串出口（逐处读码，非推测）

| 出口 | 代码位置 | 实测口径 |
| --- | --- | --- |
| webhook 投递错误脱敏 | `internal/core/httpapi/webhook.go:879-893` `sanitizeChannelError()` | 把完整 URL（含 query 密钥）换成 `scheme://host`；`:752` 在 `slog.Warn("通知通道投递失败", ..., "err", msg)` 前调用 `truncateRunes(...,240)`；`:757-762` 投递历史 `Err`/`TargetRef` 同源脱敏。单测 `webhook_test.go:261` 覆盖带 query 密钥的错误串。 |
| 鉴权失败 reason | `handlers_auth.go:123-155` | 错口令只记 `wrong_password`/`rate_limited` 常量，`writeError(...,"密码错误...","")`，**请求体不进 detail**；`:67` 错账号记 `wrong_username`；`:76/:161/:173` 的 slog.Warn 只带固定文案 + err（不含口令）。 |
| 审计 detail 构造 | `audit_http.go:95-126` `recordLoginSuccess`/`recordLoginFailed` | 显式 map：`{ip(masked), user_agent(truncated), reason/session_id_prefix}`；注释明写「请求体（含明文口令）从头到尾不进入本函数」。`:228-274` `maskIP`/`truncateUserAgent`/`sessionIDPrefix` 三个脱敏函数。 |
| deny 审计 detail | `middleware.go:277-318` `auditDenied`/`denyAlertDetail` | 只拼 subject/plugin/target/reason，**不含 capability 名、不含 token 原文**；token 主体只以 `token:<id>` 表示。 |
| 审计 GET 导出 | `handlers_audit.go:211-265` `handleAudit`/`toAuditDTO` | 显式 DTO（G-24）：`at/subject/action/plugin/target/result/capability/detail[]`；`detail` 原样透传库内受控标量，**无 password/token/secret 字段定义**。 |
| 日志字段白名单 | `middleware.go:369` 注释 + SECURITY.md:337 | 标注归 M1-14，**未实现**——这是文档已声明的待办，不是隐藏缺陷；阶段二专门验证现有出口是否实际泄漏。 |

## 2. 阶段二 · 隔离实例实测（确认缺口后）

### 2.1 环境构造（全部在 `.tmp/redact-r50/`，用完删）

| 项 | 值 / 命令 | 退出码 |
| --- | --- | --- |
| 当前 HEAD 二进制（临时） | `GOCACHE=<abs>/.tmp/redact-r50/gocache GOMODCACHE=<abs>/.tmp/gomodcache GOPROXY=off CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' -o .tmp/redact-r50/kored ./cmd/kored` | **0**；`go version -m` 显示 deps 与 `bin/kored` 同版本（bbolt v1.5.0 / yaml v3.0.1 / pluginapi v0.1.3），未碰宿主 `bin/kored` |
| 隔离配置 | `.tmp/redact-r50/config/isolated.yaml`：`server.addr=127.0.0.1:55261`；独立 `state_dir`/`run_dir`/`log_dir`/空 `index_dir`；`auth.initialized=true` + 进程内生成的 PBKDF2 哈希（600000 迭代）；会话 TTL 1h；`cookie_secure=false`（纯本机） | 配置文件 0600 |
| 启动 | `.tmp/redact-r50/kored serve --config <iso>/config/isolated.yaml --state-dir <iso>/state` | 后台；healthz 200 就绪；日志 stdout→`<iso>/kored.stdout.log`（serve 把 slog JSON 写 stderr） |
| 主实例零改动 | 全程未读写 8787 / `.kore-local.yaml` / 主 state/run/socket；未重建/重启宿主二进制 | — |

harness 用 Python 标准库 `urllib` + `http.cookiejar`；所有秘密值在进程内生成，写回 `report.json` 前经 `scrub()` 替换为占位符。自检：用一次性正则（含各测试值前缀，此处不重复原文）扫 `report.json` → **0 命中**（无真实值落盘）。

### 2.2 逐场景证据（命令 / 退出码 / 日志原文 / 是否泄漏）

> 以下「退出码」= 场景请求 HTTP 状态（harness 进程 `PROBE_EXIT=0`）；日志原文中的秘密位置一律为占位符或已确认不含秘密，端口/ID/path 为本地隔离值。

**S1 · 错误 Bearer token（内嵌 marker）打受保护 GET**
- 命令：`GET /api/v1/audit?since=...` + `Authorization: Bearer kore_<REDACTED_TEST_TOKEN>`
- 退出码：**401**；响应原文：`{"code":"E_UNAUTHORIZED","message":"API 令牌无效或已过期","detail":""}`
- 日志：全量 stderr log 未出现 token marker（`log_leak_raw.token_marker=false`）
- **是否泄漏：否**（响应 detail="" + 日志无 marker；对应 `middleware.go:129` `auditDenied("token:"+id,...,"token_ip_denied")` 口径）

**S1b · 口令失败登录 → 审计 detail + 日志**
- 命令：`POST /api/v1/auth/login` body `{"username":"admin","password":"<REDACTED_BAD_PASSWORD>"}`
- 退出码：**401**；响应原文：`{"code":"E_UNAUTHORIZED","message":"密码错误，请输入右侧验证码","detail":""}`
- 审计 GET 原文（S3）：`{"action":"login.failed","result":"denied","detail":[{"key":"ip","value":"127.0.0.x"},{"key":"reason","value":"wrong_password"},{"key":"user_agent","value":"Python-urllib/3.14"}]}`
- 日志：无错口令原串（`log_leak_raw.bad_password=false`）
- **是否泄漏：否**（审计只有 `ip/reason/user_agent`，无 password 字段；与 SECURITY.md:143 逐字一致）

**S2 · webhook 配置含凭据的错误 → 脱敏**
- 命令：`POST /api/v1/webhook` body `{"kind":"webhook","name":"rt50probe","events":["audit"],"url":"http://127.0.0.1:55262/hook?key=<REDACTED_QUERY_KEY>","secret":"<REDACTED_WEBHOOK_SECRET>"}` → **200**（`ch-1`）；`POST /api/v1/webhook/ch-1/test` → **200**（`{"queued":true,...}`）；`GET /api/v1/webhook` → **200**
- 配置回显原文：`"url":"http://127.0.0.1:55262/hook?key=<REDACTED_QUERY_KEY>"`（URL 是用户显式配置、按通道契约回显，非 secret 字段；`secret_set:true` 不回显密钥值）
- 投递历史 `err` 原文：`Post "http://127.0.0.1:55262": dial tcp 127.0.0.1:55262: connect: connection refused`；`target_ref`：`http://127.0.0.1:55262`
- 日志原文（stderr JSON）：`{"level":"WARN","msg":"通知通道投递失败","target":"ch-1","kind":"webhook","ref":"http://127.0.0.1:55262","event":"webhook_test","severity":"info","attempts":3,"code":0,"err":"Post \"http://127.0.0.1:55262\": dial tcp 127.0.0.1:55262: connect: connection refused"}`
- **是否泄漏：否**（query key 与 secret 均未进日志/投递历史 err；`sanitizeChannelError` 生效，与 `webhook.go:881-893` 一致）

**S3 · 审计 GET 导出 → 无 token/口令字段**
- 命令：`GET /api/v1/audit?since=...&limit=200`（会话 cookie）→ **200**；另有 `action=login.failed` 过滤查询 → **200**
- 响应顶层字段：`at/subject/action/plugin/target/result/capability/detail/count/total/limit/offset`；detail 观察到的 key 全集：`ip / reason / user_agent / session_id_prefix / captcha_id_prefix`；actions：`login.failed / login.success / captcha.issued / captcha.passed / captcha.failed`
- 原始 body 扫描（`raw_audit_leak`）：password/bad_password/token_marker/webhook_secret/query_key **全部 false**
- **是否泄漏：否**（无 password/token/secret 字段或值；`session_id_prefix` 为 8 字符截断，不是完整 token）

**S4 · 含敏感参数的失败请求 → 日志无泄漏**
- 命令：`POST /api/v1/webhook?debug_key=<REDACTED_QUERY_KEY>`（无会话 / 无 CSRF）body 含 `"secret":"<REDACTED_WEBHOOK_SECRET>"`
- 退出码：**401**；响应原文：`{"code":"E_UNAUTHORIZED","message":"CSRF 校验失败","detail":""}`
- 日志：全量 stderr log 无 query key、无 secret（`log_leak_raw.webhook_secret=false`，`log_leak_raw.query_key=false`）
- **是否泄漏：否**（`writeCSRFDenied` 与 `withAuth` 短路，不回显请求体/查询串）

### 2.3 汇总机器判定

| 判定面 | 结果 |
| --- | --- |
| `log_leak_raw`（5 个真实值对全量 stderr 日志逐字扫描） | password=false / bad_password=false / token_marker=false / webhook_secret=false / query_key=false |
| `response_leak_raw`（全部场景响应体逐字扫描） | 同上全部 false |
| `raw_audit_leak`（完整审计 body 逐字扫描） | 同上全部 false |
| harness 自身退出码 | `PROBE_EXIT=0` |
| `grep -cE 'RT50...' report.json` | 0（无真实凭据落盘） |

## 3. 发现与处置

- **未发现真实泄漏**：上述四场景的日志、审计 detail、错误响应均无凭据原串；无需报 lead 另派修复卡。
- **已知待办（非本次缺陷）**：`docs/SECURITY.md:337` 明写「日志字段白名单（M1-14 计划，当前未实现）」，白名单外字段 fail-closed 尚未落地。本次探测证明**当前实际出口**在四场景下不泄漏，但不能替代 M1-14 白名单实现；未来新增 slog 出口时仍需按 `:338` 禁记清单复核。
- **既有实例脱敏测试如实报告、未重复**：`security-redteam-r26.md`（webhook 密钥日志脱敏 + 单测）、`round4-audit.md:33`（审计响应无口令）、`audit-deny-redteam.md`（token 只哈希前缀）、各 `secret-check` 0 FAIL 均为既有证据；本卡只补运行时四场景端到端空白，未重跑这些测试冒充新证据。

## 4. 清理与提交回读

| 检查 | 命令 | 退出码 / 结果 |
| --- | --- | --- |
| 隔离进程 | harness `finally` 中 `proc.terminate()` + `wait(timeout=10)` | 已退出；端口 55261/55262 无监听 |
| 临时资产删净 | `rm -rf kore/.tmp/redact-r50`（含 `probe.py`、`kored` 副本、config/state/run/log stdout、report.json、gocache、cookies.txt、空 index） | 删除后 `test -e .tmp/redact-r50` → 1（不存在） |
| 主实例零改动 | 未读写 8787 / `.kore-local*`；宿主 `bin/kored` mtime 未变（见 §2.1） | — |
| 报告本体 G-30 | `grep -cE 'RT50...' .agents/verify/runtime-log-redaction.md` → 0；只含占位符 | 0 |
| 精确提交 | `git add .agents/verify/runtime-log-redaction.md && git commit -s -m '[agent:runtime-redact] docs(verify): 运行时日志/审计详情凭据泄漏只读核实+隔离实测'` | 仅本报告入提交；未 push |
