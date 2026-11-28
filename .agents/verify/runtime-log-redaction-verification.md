# 运行时日志脱敏独立验收报告（G-09 / task-325）

> 执行：**runtime-redact-verifier**（G-09 独立 verifier，非 runtime-redact、非实现者）
> 日期：2026-11-28 ｜ 被验对象：commit `ce5d19c8c605cbffdd13b2c83f4b8a6efb0ebc37`（`.agents/verify/runtime-log-redaction.md`，121 行）
> 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore` ｜ 全程只读复核，未改生产代码、未启服务、未碰 `.kore-local-*`

## 总评：**PASS**

五场景（S1 / S1b / S2 / S3 / S4）无凭据泄漏的结论**经独立读码 + 证据自洽核算坐实**；隔离清理与 git 提交纪律均成立。发现 3 处**非实质性**的行号引用/文档简写不精确（见 §5），均不改变无泄漏判定，如实登记、不升级为 BLOCKED。诚实边界「日志字段白名单 M1-14 未实现」口径如实（见 §4）。

---

## 1. 阶段一 · 缺口成立与口径核对（只读复跑）

### 1.1 此前无四出口端到端脱敏测试 —— 成立

| 复核命令 | 退出码 / 输出 | 判定 |
| --- | --- | --- |
| `grep -n 'sanitizeChannelError\|脱敏' .agents/verify/security-redteam-r26.md` | 0；仅 `:123` 一处 | 该处是 webhook **代码级**证据 + 一次真实投递日志无密钥，属部分覆盖，非四出口端到端 |
| `sed -n '33p' .agents/verify/round4-audit.md` | 0；`口令泄漏检查：对整份审计响应 grep -c '<口令>' = 0` | 静态样本核对，未构造 Bearer/失败登录/敏感参数场景 |
| `grep -rlnE '错误 Bearer\|失败登录.*detail\|auth/login.*wrong_password\|含敏感参数.*401\|webhook.*query.*脱敏' .agents/verify/ --include='*.md'`（排除被验报告） | 0 命中 | 确认无既有报告覆盖四类**运行时**出口端到端 |

**结论**：缺口成立，阶段二有必要，报告 §1.1 口径属实。

### 1.2 `docs/SECURITY.md` 口径 —— 逐条读码吻合

| 条款 | 报告 §1.2 转述 | 独立回读 | 吻合 |
| --- | --- | --- | --- |
| `:41` | 日志泄密=字段白名单 fail-closed + 丢弃非白名单字段，残余=插件自写日志 | 原文一致 | ✓ |
| `:143` | 登录审计 reason∈wrong_password/rate_limited/no_session；IP 前 3 段、UA 100 字符、会话 8 前缀、口令不进审计 | 原文一致 | ✓ |
| `:153` | token 明文只创建时返回一次、库存 sha256；绑定拒绝固定 401 detail="" 不回显白名单/IP | 原文一致 | ✓ |
| `:168` | self-update 审计 detail 仅 channel/capability/target_version，不记口令/token/confirm 原文 | 原文一致 | ✓ |
| `:337` | 日志字段白名单 M1-14 计划当前未实现；access_log 中间件与白名单重建未实现，当前只有 req_id 注入 | 原文一致 | ✓ |
| `:338` | 禁记口令/token/cookie/secret/Authorization/完整请求体/签名原文；ip/ua 只存 sha256 前 16 字节 | 原文一致 | ✓ |

### 1.3 生产代码敏感出口 —— 逐处读码吻合

| 出口 | 报告引用 | 独立读码结果 | 判定 |
| --- | --- | --- | --- |
| webhook 投递错误脱敏 | `webhook.go:879-893 sanitizeChannelError` | `:881-893` 存在：先 `strings.ReplaceAll(msg, st.view.URL, ref)`，再正则 `https?://[^s"']+` 逐个替换为 `scheme://host`（`url.Parse` 失败返回 `…`）；`:752` 调用点 `truncateRunes(sanitizeChannelError(...),240)`；`:754-756` slog.Warn 写 `ref`/`err`；`:762` channelDelivery `Err`/`TargetRef` 同源；`channelTargetRef` `:858-866` 只返回 `scheme://host`/`host:port` | ✓ |
| 鉴权失败 reason | `handlers_auth.go:123-155` | `:135/:137` 仅常量 `wrong_password`/`rate_limited`；`:140` 只把 reason 传审计；`:154` `writeError(...,401,...,"")`；`:145/:161/:173` slog.Warn 只带固定文案+err/数字，无口令 | ✓ |
| 审计 detail 构造 | `audit_http.go:95-126` + `:228-274` | `:102-106` success map={ip,user_agent,session_id_prefix}；`:118-122` failed map={ip,user_agent,reason}；`:112` 注释明写请求体（含明文口令）不进本函数；`:230-257` maskIP IPv4 前 3 段、IPv6 前 3 组；`:260-266` UA 100 rune；`:269-274` session 8 前缀 | ✓ |
| deny 审计/告警 detail | `middleware.go:277-318` | `:277-293` auditDenied 只拼 subject/plugin/target/capability/reason；`:309-318` denyAlertDetail 仅 subject/plugin/target/原因，**不含 capability 名/token 原文**；token 主体只以 `"token:"+rec.ID` 表示（`:129`） | ✓ |
| 审计 GET 导出 | `handlers_audit.go:211-265` | `:213-238` handleAudit 显式 DTO；`:26-42` auditRecordDTO 字段 at/subject/action/plugin/target/result/capability/detail，**无 password/token/secret 字段**；`:254-265` toAuditDTO 只做受控 Detail map→有序 entries | ✓ |
| 白名单未实现标注 | `middleware.go:369`（报告/SECURITY 写 `:269`） | 实际标注在 `:369`「中间件链完整版（recover/access_log/...）归 M1-14」；`:269` 为空行 —— **行号漂移**，标注本体存在（见 §5-②） | ✓（实质成立） |

补充核实：审计 Detail map 的**全部**生产构造点 = `audit_http.go` 的 ip/user_agent/reason/session_id_prefix + `audit_captcha.go:24` 的 captcha_id_prefix（8 字符截断，`:7-16`），无任何口令/token/secret 值入口。webhook 单测 `webhook_test.go:257-268 TestChannelErrorSanitized` 覆盖「含 query 密钥的错误串被脱敏、不残留 `/robot` 与 `SECRET-VALUE`」，是报告 §1.3 所述单测的实物。

---

## 2. 五场景独立自洽复核（代码重推 + 报告原文交叉）

> 说明：隔离 harness 已按纪律删除（§3），本轮**不重启服务、不复跑 harness**（硬约束）。判定方式为「用当前生产代码独立重推每场景的可观测输出，与报告记录的响应/日志/审计原文交叉核对」。五场景可观测结果与代码路径逐条吻合。

**S1 错误 Bearer → 401 detail="" + 日志无 marker**
- 代码重推：`middleware.go:119-123` 从 `Authorization` 取 plain → `ValidateToken` 失败即 `writeError(w,401,E_UNAUTHORIZED,"API 令牌无效或已过期","")`，**无 slog、无审计、不回显 token**。
- 报告 §2.2 S1：`{"code":"E_UNAUTHORIZED","message":"API 令牌无效或已过期","detail":""}`，`log_leak_raw.token_marker=false` —— 与代码一致。✓ **无泄漏**
- 注：报告把无泄漏归因于 `:129 auditDenied("token:"+id,...,"token_ip_denied")`；实际错误 Bearer 在 `:121-123` 短路、根本不走 `:129`（那是「合法 token + 来源绑定不符」路径）。两路径都 detail=""，结论不受影响，属归因行号不精确（§5-③）。

**S1b 错口令登录 → 审计 detail 只 ip/reason/user_agent**
- 代码重推：`handlers_auth.go:123-155` 失败→常量 reason→`recordLoginFailed`，响应 detail=""；`recordLoginFailed`（`audit_http.go:113-126`）Detail={ip(masked),user_agent(truncated),reason}，函数自注「请求体（含明文口令）从头到尾不进入」。
- 报告 §2.2 S1b：审计 `detail=[{ip:127.0.0.x},{reason:wrong_password},{user_agent:Python-urllib/3.14}]`，无 password 字段；`log_leak_raw.bad_password=false`。与 SECURITY.md:143 逐字一致。✓ **无泄漏**

**S2 webhook URL 带 key + secret → err/ref 脱敏**
- 代码重推：`webhook.go:752` 对 `lastErr.Error()` 先 `sanitizeChannelError`（整 URL→scheme://host）再截断；`:754-756` slog.Warn 的 `ref=channelTargetRef`(scheme://host)、`err=msg`；`:762` 投递记录 `Err=msg`、`TargetRef=channelTargetRef`。ChannelTarget 对外视图（`:123-136`）只有 URL 与 `SecretSet bool`，**无 Secret 字段**；明文密钥只在 `channelStored` 进程内存（`:138` 注释）。
- 报告 §2.2 S2：`err="Post \"http://127.0.0.1:55262\": dial tcp ...: connection refused"`、`ref/target_ref="http://127.0.0.1:55262"`，query key 与 secret 均未进日志/投递历史；配置回显 URL 是用户显式配置（契约回显），`secret_set:true` 不回显密钥值。与代码一致。✓ **无泄漏**

**S3 审计 GET 导出 → 5 测试值全 false**
- 代码重推：`handlers_audit.go:33-42` DTO 无 password/token/secret 字段；Detail 值全来自受控构造（见 §1.3 补充）；`sessionIDPrefix`/`captchaIDPrefix` 仅 8 字符、不可反推完整凭据。
- 报告 §2.2 S3：顶层字段 `at/subject/action/plugin/target/result/capability/detail/count/total/limit/offset`（与 auditRecordDTO+auditListBody 定义逐项吻合）；detail key 全集 `ip/reason/user_agent/session_id_prefix/captcha_id_prefix`（与全部构造点吻合）；`raw_audit_leak` 五值 password/bad_password/token_marker/webhook_secret/query_key 全 false。✓ **无泄漏**

**S4 含 key+secret 失败请求 → 401 detail="" 日志无泄漏**
- 代码重推：`server.go:455-469` 链为 CSRF 外层包 auth；`middleware.go:244-245 writeCSRFDenied → writeError(401,E_UNAUTHORIZED,"CSRF 校验失败","")`；`writeError`（`handlers.go:206-208`）只写 `{code,message,detail}`，不回显请求体/查询串。
- 报告 §2.2 S4：`{"code":"E_UNAUTHORIZED","message":"CSRF 校验失败","detail":""}`，`log_leak_raw.webhook_secret=false`、`query_key=false`。与代码一致。✓ **无泄漏**

### 机器判定汇总核对

| 报告 §2.3 判定 | 独立核对 |
| --- | --- |
| `log_leak_raw` 5 值全 false | 代码路径无对应写出点，与记录一致 ✓ |
| `response_leak_raw` 全 false | 四个响应体均 detail="" 或受控 DTO，与记录一致 ✓ |
| `raw_audit_leak` 全 false | DTO 无凭据字段，与记录一致 ✓ |
| `PROBE_EXIT=0` | harness 已删，无法复跑；按纪律记为「记录值，未独立复跑」，不作为新证据 ✓（诚实边界） |

---

## 3. 报告本体明文扫描 + secret-check

| 复核命令 | 退出码 / 结果 |
| --- | --- |
| `grep -o '<REDACTED_[A-Z_]*>' .agents/verify/runtime-log-redaction.md \| sort \| uniq -c` | 0；只出现 5 种占位符（TEST_PASSWORD/BAD_PASSWORD/TEST_TOKEN/WEBHOOK_SECRET/QUERY_KEY） |
| 长 token 扫描 `grep -oE '[A-Za-z0-9_-]{16,}'` | 0；仅 commit hash / 函数名 / 占位符名，**无真实 base64url 凭据** |
| `grep -nE '"password"\|"secret"\|"token"' （报告内）` | 命中 3 行（:72/:79/:92），值均为 `<REDACTED_*>` 占位符，非明文 |
| `make secret-check`（G-30 门禁，独立复跑） | **exit 0，0 FAIL / 34 处匹配（1 WARN：backup-download-verification.md:125 为 grep 正则模式片段，非凭据，不阻断）** |

**结论**：报告本体无凭据原串；`secret-check 0 FAIL` 属实。关于报告 §2.3/§4 的 `grep -cE 'RT50...' → 0`：字面重跑得 2，命中的是两处**命令描述文本本身**（`:105`/`:120` 写了 `RT50...` 字样），并非真实值泄漏；harness 实际用的是已脱敏的具体前缀（报告中不落原文）。实质结论「报告不含真实凭据」经上面占位符/长 token 双重扫描坐实，属文档简写不精确（§5-④），不构成泄漏。

---

## 4. 诚实边界 —— 白名单 M1-14 未实现口径如实

- `docs/SECURITY.md:337` 明写「日志字段白名单（M1-14 计划，当前未实现）」；`middleware.go:369` 标注完整中间件链（含 access_log）归 M1-14，当前只有 req_id 注入。
- 被验报告 §0 第 4 条、§1.2、§3 均如实声明：本结论只对「本次构造的四/五场景」成立，M1-14 白名单 fail-closed 尚未落地，未来新增 slog 出口仍需按 `:338` 禁记清单复核；未把待办冒充已实现、也未把待办当成本次探测到的缺陷。
- 本 verifier 口径一致：**PASS 的适用范围限于已核出口与已构造场景**，不外推为「所有未来出口都不泄漏」。✓ 如实。

## 5. 发现的不精确项（非实质，均不触发 BLOCKED）

1. **S1 归因行号**：报告 §2.2 S1 把无泄漏归因于 `middleware.go:129`（token_ip_denied 路径），实际错误 Bearer 在 `:121-123` 短路、不走审计。两路径均 detail=""、无凭据写出，结论不受影响。
2. **M1-14 标注行号漂移**：SECURITY.md:337 与报告 §1.3/§1.2 写 `middleware.go:269` 标注归 M1-14；实际标注在 `:369`（`:269` 为空行）。标注本体存在，属代码演进后的行号漂移。
3. **P1-14 之外**：报告 §2.2 S1 的 token marker 场景响应与 `:121-123` 一致；无自相矛盾。
4. **`grep 'RT50...'` 计数口径**：报告写 0，字面重跑为 2（命中命令描述文本）；真实值 0 命中经 §3 双重扫描确认。属文档简写。

> 以上均为引用/表述层面的精确性瑕疵，不改变「五场景无凭据泄漏」这一核心结论，也不涉及真实凭据落盘。按任务口径「抽算不自洽或发现真泄漏报 BLOCKED」——未发现真泄漏、核心自洽成立，故判 PASS 并如实登记瑕疵。

---

## 6. 隔离清理复核（只读探测，不启服务）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 隔离树删除 | `[ -e .tmp/redact-r50 ]` | **GONE**（不存在）；`find . -name probe.py -o -name report.json \| grep -i redact` 无残留 |
| 隔离端口 | `ss -ltnp \| grep -E '55261\|55262'` | **无监听**；`ps aux \| grep -E 'redact-r50\|probe.py\|55261\|55262'` 无残留进程 |
| 主实例健康 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz --max-time 5` | **HTTP 200**（主实例未被干扰） |
| 宿主二进制 | `stat bin/kored` | size=13451426，mtime=2026-11-28 11:48:17 +0800；报告 §2.1 声明未重建/未触碰，本轮无改动证据 |
| 主配置 | `stat .kore-local.yaml` | mtime=2026-11-25 20:15:44 +0800 —— 未改动 ✓ |
| 他人 dirty 原样 | `sha256sum scripts/usability-pending.txt`（前后两次） | 前后均 `2eb88750...528904bc28`，未变；完整 `git status --short` 与开工前一致 |

**结论**：隔离清理到位，主实例与运行态资产零改动，他人 dirty 原样。

---

## 7. Git 提交纪律复核

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 精确单文件 121 行 | `git show --stat ce5d19c` / `git show --numstat` / `git diff-tree --name-only -r ce5d19c` | 仅 `.agents/verify/runtime-log-redaction.md`，**121 insertions / 0 deletions** ✓ |
| 行数核对 | `git show HEAD:.agents/verify/runtime-log-redaction.md \| wc -l` | 121 ✓ |
| 工作区一致 | `git diff HEAD -- .agents/verify/runtime-log-redaction.md` | 空（工作区=提交内容）✓ |
| DCO | `git show -s --format='%B' ce5d19c` | 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ✓ |
| agent 前缀 | commit 首行 | `[agent:runtime-redact] docs(verify): ...` ✓ |
| 未 push | `git branch -a --contains ce5d19c` + `git for-each-ref refs/remotes` | ce5d19c 仅在本地 main；各远端 main 为 a07a73f/812f9fc/342316a，**均不含该提交** ✓ |
| 他人 dirty 未混入 | `git status --short` | 提交仅含目标报告；scripts/usability-pending.txt 与各 untracked 均未被卷入 ✓ |

---

## 8. 核验结论

- **五场景无凭据泄漏**：PASS（S1/S1b/S2/S3/S4 逐条经代码重推 + 报告原文交叉坐实；机器判定 log/response/raw_audit_leak 五值全 false 与代码一致；报告本体无真实凭据；`make secret-check` 0 FAIL）。
- **阶段一口径**：PASS（缺口成立、SECURITY.md 六条款与生产代码六出口逐处吻合）。
- **诚实边界**：PASS（M1-14 未实现如实声明，适用范围未外推）。
- **隔离清理**：PASS（.tmp/redact-r50 GONE、55261/55262 无监听、8787 healthz 200、宿主 bin/主配置/他人 dirty 未变）。
- **Git 纪律**：PASS（精确单文件 121 行 + DCO + agent 前缀 + 未 push + 他人 dirty 原样）。
- **不精确项**：4 处引用/表述瑕疵（§5），非实质、不影响结论，已如实登记。

**总评：PASS**
