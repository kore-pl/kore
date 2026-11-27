# 红队 Round 26 独立验收报告（G-09）

> Verifier：`security-r26-verifier`（独立 verifier，非 `security-r26`，满足 G-09 角色不可兼任）
> 任务卡：`task-224` · 时间：2026-11-27 20:48–20:55 CST
> 被验对象：commit `0061808701c28bae93a630528d8b03fe84f4252f` 单文件 `.agents/verify/security-redteam-r26.md`（221 行）
> **总评：PASS**（六场景证据自洽、零缺陷结论诚实、清理与 git 合规；1 条次要叙事不一致，见 §5，不构成阻断）

## 0. 验证方法与边界（诚实披露）

- 全程只读；唯一写域为本报告。未改生产代码/配置，未启实例，未联网，未碰 8787 主实例、`.kore-local-*`、宿主与外网真实服务，未 install/upgrade，未 push。
- 红队按纪律已删除隔离实例、接收端与 harness（报告 §8），因此**动态证据（HTTP 响应、退出码、接收端日志）无法由本 verifier 独立复跑**；复跑需要启实例，与硬纪律冲突。故本次复核口径为：①报告内部自洽性；②逐条代码点静态核对；③清理/git/门禁的现场只读核验。凡无法现场复核的项均在本报告标注，不冒充已复跑。

## 1. 六场景证据自洽（逐项）

| 场景 | 报告主张 | 代码点/现场核对结果 | 结论 |
| --- | --- | --- | --- |
| ① PG `database` 注入 | 17 组×query/exec=34 例注入全 `E_INVALID`、`executor_got_db=""`；合法 `kore_app` 到达 executor；`TestRedteamR26DatabaseInjection exit 0` | 报告列举 case 精确可数 17 组（semicolon/single-quote/backslash/path/abs-path/overlong64/1000/unicode/fullwidth/nul/newline/tab/percent/sql-comment/argv-dash/number-db/object-db）×2 路径=34，与主张一致。代码：`kore-plugin-db-postgres/internal/pgop/validate.go` `databaseNameRE=^[a-zA-Z0-9_]{1,63}$`（白名单，行 25/51-57 区段）；`call.go:109-118` `resolveDatabase` 先 `TrimSpace` 再校验、非法回 `invalid(...)`（E_INVALID）；`dup-last-good` 与 `control-valid` 两行显示合法库名到达 executor，自洽。首轮 harness 失败后修正重跑全绿属如实披露。 | 自洽 |
| ② scheduler 任意 plugin/method | `plugin=kore` 及 `Kore`/`kore.`/`kore ` 变体 400 E_INVALID；system/install 等建成任务但 run `E_NOTFOUND` 无提权 | `scheduler/task.go:64-65` `pluginIDPattern=^[a-z][a-z0-9-]*$`、`methodNamePattern=^[a-z][A-Za-z0-9_-]*(\.[a-z][A-Za-z0-9_-]*)*$` → `Kore`/`kore.`/`kore `/`evil/../x`/`a;b` 均被形状拒绝；`input.go:96-98` 保留名 `kore` 拒绝，错误文案与报告逐字一致；`input.go:85-112` 只校验形状/保留名/参数/时限，**无方法级 capability**（如实记为 B-1）；`run.go:57` 走 `s.invoker.Invoke`，`serve_runtime.go:172` 注释确认 Invoker=`daemon.Invoke`，不经 HTTP `authorizeInvoke`；`handlers_scheduler.go:51-68` 创建端点要求 `system:admin`；`invoke_capability.go:104-112` 明示单管理员全权边界。 | 自洽（1 条次要叙事不一致见 §5） |
| ③ webhook SSRF（ADR-0054） | file/gopher/凭据 URL 400；302 不跟随、接收端 0 条；3s×3 有界重试；日志无密钥 | `webhook.go:427-441` `validateWebhookURL` 只接受 http/https、拒空 host/内嵌凭据/空白控制字符，两条错误文案与报告逐字一致；`:37` `channelHTTPTimeout=3s`、`channelMaxAttempts=3`；`:896-901` `CheckRedirect` 返回 `http.ErrUseLastResponse`；`:881-894` `sanitizeChannelError` 把完整 URL 换成 `scheme://host`；ADR-0054 §2 六判据/§6 复审条件存在，B-2「不拒 127.0.0.1」标注与 ADR 一致。报告自身披露了 grep 管道退出码陷阱并已逐行复核，属诚实。 | 自洽 |
| ④ alerts 滥用（C9 桥接） | 未登录/仅 CSRF 401；非法 source/severity 400 E_INVALID；合法 200 且一次出站 | `handlers_alerts.go:66-81` `authorizeAlerts` 先 `authorizeTargetAction`（会话）再 capability，缺会话 401；`:111-136` `handleAlertsWrite` 受控词表校验，400 文案与报告逐字一致，合法走 `recordAlertView` 200；`:183-197` `validAlertWords` 限定 critical/warning/info 与 audit/plugin/resource/slot。单管理员边界如实标注。 | 自洽 |
| ⑤ audit capability 伪造 / detail 上限（UDS） | 伪造 capability/action 400 unknown field；capability 恒硬编码；version 256 成功/257 超长 503；256×`<` 序列化 >1024 503 fail-closed | `selfupdate.go:258-265` `readStrictBody` 用 `DisallowUnknownFields()` → capability/action 注入必 400；`selfupdate_local.go:124-131` confirm 必填；`server.go:205` `selfUpdateCapability="system:self_update"`，`:180-198` `auditLocalUpdate` detail 中 capability 取该常量（硬编码，无外部输入）；`:140-160` 审计写入在 `StartUpgrade` 之前、写不进即 503 E_INTERNAL「更新审计写入失败，本次更新未执行」→ fail-closed 成立；`store/audit.go:25-29,83-109` 键≤32/数≤16/值≤256/序列化≤1KiB，错误文案与报告日志逐字一致；`selfupdate.go:288` 非 root→403 E_NEED_ROOT「当前进程不是 root，无法自升级」。B-5「无外部路径、仅代码级确认」标注属实。先用错主 socket 得 401 后纠正属如实披露。 | 自洽 |
| ⑥ 统一 401 不泄露 | 10 GET + 6 POST + UDS 全 401，固定三字段，无路径/用户名/栈；`/api/v1/nope` 也 401 | 报告列举 GET 路径精确 10 条、POST 精确 6 条、UDS 4 条。代码：`server.go:440-446` `withAuth` 包裹整个 mux（含 `handleNotFound`）；`middleware.go:35-72` `withAuth` 对**所有** `/api/v1` 前缀路径先校验会话，未登录直接 401 `E_UNAUTHORIZED`「未授权」，因此 `handleNotFound`（`handlers.go:192-195` 的 404）对未登录请求不可达 → `/api/v1/nope` 返回 401 成立；`handlers.go:203-207` `writeError` 固定 `{code,message,detail}` 三字段。现场只读 `curl 127.0.0.1:8787/api/v1/system/info` 亦回 `{"code":"E_UNAUTHORIZED","message":"未授权","detail":""}`，与该形态一致。CSRF 优先于 auth（`server.go:442-444`）解释 POST 回「CSRF 校验失败」，自洽。 | 自洽 |

## 2. 零缺陷结论与 5 条边界项诚实性

- **发现清单**：报告 §7 写「确认的可利用缺陷：0」，与 §1–§6 证据（注入全被拒、危险任务执行面 E_NOTFOUND、302 不跟随、出站仅告警事件一次性、审计 fail-closed、401 无泄露）逻辑一致，未夸大也未隐瞒。
- **B-1**（scheduler 不做方法级 capability）：代码点 `input.go:85-112`/`run.go:57`/`serve_runtime.go:172` 逐一核对属实；报告明确「未证实提权、单管理员全权边界、多用户 RBAC 落地前视为设计边界」，未包装成已修复，也未隐瞒风险。
- **B-2**（webhook 不拒 127）：`validateWebhookURL` 确实只查 scheme/host/凭据/控制字符，不查 IP；报告明写「ADR-0054 有意边界、由 system:admin 显式配置、非请求体注入、若放开低权配置须重审」，诚实。
- **B-3**（`TrimSpace` 放行 `"  name  "`）：`call.go:109-118` 确实先 TrimSpace；裁剪后仍过白名单，报告标为非注入面，属实。
- **B-4**（JSON 重复键末值生效）：Go `encoding/json` 通用语义，报告如实标注为边界，未夸大为缺陷。
- **B-5**（audit detail 键长/键数无外部路径）：`store/audit.go:25-29,83-109` 校验确实存在；`auditLocalUpdate` detail 由服务端构造，报告明写「仅代码级确认、运行态不可达」，未冒充运行态验证。
- **凭据口径（G-30）**：报告口令/密钥/查询串均以 `$VAR` / `***` / `<REDACTED>` 占位。现场门禁：`make secret-check` → `secret-check: 0 FAIL / 24 处匹配（占位写法均合规）`，**exit 0**（G-30 通过）。

## 3. 隔离与清理（现场只读复核）

命令与结果（均为只读探测）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 临时目录 | `BASE=$(realpath -m .tmp/security-r26-r26); test -e "$BASE"` | `GONE=yes`（解析路径 `/home/pt/Work/GolandProjects/kore-pl/kore/.tmp/security-r26-r26`） |
| 55131 已停 | `curl -sS -i --max-time 2 http://127.0.0.1:55131/-/healthz` | `curl: (7) Failed to connect`；`probe_exit=7` |
| 监听面 | `ss -ltnp \| grep -E '55131\|8787'` | 仅 `127.0.0.1:8787` 在 LISTEN；55131/55132/55133 无匹配 |
| 残留进程 | `ps -eo pid,comm,args` 过滤 kored/python3；`pgrep -af` | 无 `kored` / `receiver.py` 残留（pgrep 命中的是本次核验命令自身字符串） |
| 主实例 | `curl -s http://127.0.0.1:8787/api/v1/system/info`（只读 GET，未改配置/未重启） | 401 未授权（主实例存活、鉴权生效）；本轮未改动主实例运行态配置 |

与报告 §8 声明一致。**注**：历史「未碰外网真实服务/未 install-upgrade」无法由现场只读证据反证，但现场未发现任何与之矛盾的残留（无临时资产、无额外监听/进程），且报告_outbound 仅到 127.0.0.1 接收端、收尾已删除；如实标注为「无矛盾证据，非独立复跑」。

## 4. git 合规（现场只读复核）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 精确单文件 | `git show --stat --format=full 0061808` | `1 file changed, 221 insertions(+)`；`--name-status` = `A .agents/verify/security-redteam-r26.md`；`--numstat` = `221 0` |
| DCO | 同上 | `[agent:security-r26] docs(verify): 复验 round26 六类新增攻击面` + `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` |
| 未 push | `git branch -r --contains 0061808` | 空；所有远端跟踪引用（origin/gitea/gitee/github）均不含该提交；`origin/develop=d9f12c2`，本地 HEAD 领先且未推送 |
| worktree 仅主树 | `git worktree list` | 仅 `/home/pt/Work/GolandProjects/kore-pl/kore 0061808 [develop]` 一行 |
| 无临时分支 | `git branch --list 'wt-*' 'tmp-*'` | 空 |
| 他人 dirty 原样 | `git status --short` | `M scripts/usability-pending.txt` 及多条 `??`（`.agents/.agents/`、`e2e-*.md`、`local-update-plan.md`、`release-batch-*.md`、`screenshots/adp-debug-desktop-01.png`、`data/`、`dist/` 等）保持未提交原样；0061808 未夹带 |
| 二进制时点 | `git log --since="2026-11-27 19:00" --oneline -- cmd internal pkg go.mod` + `stat bin/kored` | 代码零命中；`bin/kored` mtime `2026-11-27 19:26:20 +0800`，与报告 §0 一致；父提交 `3690018` 仅 docs，故二进制与 HEAD 代码一致 |

## 5. 次要观察（不阻断，如实记录）

- 报告 §2 第三条 run 命令注释写 `plugin=logs/method=root-action`（`tsk-77afcec8948d39d7`，回 `E_NOTFOUND: 插件 logs 未安装`），但其上方展示的创建命令中 p4 为 `plugin=db-postgres/method=root-action`，未展示 logs 任务的创建。该处 task-id↔plugin 映射存在叙事不一致（疑为摘录省略或笔误）。**不影响场景结论**：三条 run 结果均为未安装插件的 `E_NOTFOUND`，前两条（system/install、db-postgres/exec）与创建命令逐字对应，足以支撑「危险字符串可建成任务、执行面无提权」的主张；故记为次要观察，不判 BLOCKED。
- 动态 HTTP/测试输出因红队按纪律清理临时资产而不可由本 verifier 复跑（见 §0）；本次 PASS 建立在报告自洽 + 代码点静态核对 + 现场清理/git/门禁证据之上，不宣称已独立重放红队请求。

## 6. 总评

| 维度 | 判定 |
| --- | --- |
| 六场景证据自洽 | PASS（代码点逐条核对属实；case 计数自洽；错误文案逐字匹配） |
| 零缺陷结论与 B-1~B-5 诚实性 | PASS（未夸大未隐瞒；边界均明标非缺陷/不可达） |
| G-30 secret-check | PASS（exit 0，0 FAIL / 24 合规占位） |
| 隔离清理 | PASS（55131 exit7、临时目录 GONE、仅 8787、无残留进程） |
| git 合规 | PASS（单文件+DCO、未 push、仅主树、他人 dirty 原样） |
| 次要观察 | 1 条（§5），不阻断 |

**最终判定：PASS**。未发现需回派 `security-r26` 修正的实质问题；§5 次要观察供 lead 斟酌是否在后续轮次统一摘录口径。

> 本 verifier 未修改任何生产代码/配置，未启实例，未联网，未 push；唯一落盘物为本报告。
