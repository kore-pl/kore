# R5 · §3.5 #12 方法级 capability 的审计收益 · 端到端验证

> 状态: verified · 归属: verifier（独立于 implementer）· 更新: 2026-11-23 · 里程碑: M3
> 判定: **「#12 收益已证」**（收益成立；#12 的**表述**需按 §1 修正，见 §6）
> 只改本文件；未改任何生产代码 / `.kore-local.yaml` / `.kore-local-state/` / 索引 / 插件仓。

## 0. 三态判定

| 判据 | 结果 |
| --- | --- |
| 已声明 `method_capabilities` 的只读方法不再进审计 | **成立**：`site.list` / `site.config.get` / `db-mysql.instances` / `db-mysql.config.get` / `cron.list` / `waf.status` 共 6 个方法、全部 HTTP 200，审计增量 **0**（§3） |
| 写方法仍进审计（排除"审计坏了"） | **成立**：`site.config.set`（200 `saved:true`）、`cron.enable`（400 `E_INVALID`）各 **+1** 条 `invoke.*`（§3） |
| 回退分支仍按插件级判定 | **成立**：`process`（无 `method_capabilities`，插件级含 `proc:write`）的只读方法 `process.list` **+1** 条 `invoke.process.process.list`；`logs`（插件级仅 `system:read`）的 `logs.sources` **+0**（§3.3） |
| 收益归因于方法级声明（非审计失效） | **成立**：同一 `site@0.3.1` 包、同一请求，修复前内核（`e1e804a`）审计 `invoke.site.site.list ok`，修复后（`ff92f6c`）不落库（§4 A/B） |
| 审计写入链路本身完好 | **成立**：隔离实例热开 `audit.invoke_all=true` 后，同一 `site.list` 立即落 `invoke.site.site.list ok`；改回 false 复归 0（§3.4） |

**判定：`#12 收益已证`**。唯一保留项是措辞：收益是"只读方法**完全不落库**"，不是"按 `system:read` 落库"（§1、§6.1）。

## 1. 代码实际语义（先定性，再实测）

两种语义里，代码实现的是**前者**：

- `internal/core/httpapi/audit_http.go:137-139`：`if !s.auditInvokeAll.Load() && !auth.needAdmin { return }` —— 只读调用**连记录都不写**，不是"按 read 落一条"。
- `auth.needAdmin` 来自 `effectiveInvokeRequirement`（`internal/core/httpapi/invoke_capability.go:165-177`）：命中 `methodLevel["<id>.<action>"]` **只**按该方法级能力判定（173-175），未命中才 `requiredInvokeCapability(pluginLevel)`（176）。
- `requiredInvokeCapability`（同文件 47-71）对 `system:/net:/proc:` 取"最高要求"：read 不提升，write/admin → `needAdmin=true`。
- 审计记录**没有 capability 字段**：`store.AuditRecord`（`internal/core/store/audit.go:36-44`）只有 `subject/action/plugin/target/result/detail`，`detail` 仅 `duration_ms` / `error_code`。所以"按 `system:admin` 进审计"只是**判定来源**，记录里看不出能力名。
- 全量审计开关 `audit.invoke_all` 默认 false（`internal/core/config/types.go:100-102`、`parse_nested.go:171-179`）。

⇒ #12 修复后的可观测差异是 **`invoke.<plugin>.<method>` 记录的有/无**，不是记录里的能力值变化。

## 2. 隔离环境（G-29）

| 项 | 修复后实例 | 修复前对照实例 |
| --- | --- | --- |
| 地址 | `127.0.0.1:18875`（**非 8787**） | `127.0.0.1:18876`（**非 8787**） |
| 源码 | `git archive ff92f6c HEAD` → `/tmp/kore-v12-methodcap/src`（工作树有 170 个他人未提交改动，**不参与**构建） | `git archive e90947a^`（`e1e804a`，方法级 capability 之前）→ `/tmp/kore-v12-prefix/src` |
| 二进制 | `/tmp/kore-v12-methodcap/bin/kored` sha256 `ddccec36…6b75` | `/tmp/kore-v12-prefix/bin/kored` sha256 `ee7e6d12…b066` |
| 配置/状态/运行/日志 | 全在 `/tmp/kore-v12-methodcap/`（`config.yaml` / `state` / `run` / `log`） | 全在 `/tmp/kore-v12-prefix/` |
| `index_dir` | `/home/pt/Work/GolandProjects/kore-plugins/index`（`GET /api/v1/system/info` 回读一致） | 同（未被使用：两个包走 `kored install --package` 本地装） |
| 已装插件 | `site` 0.3.1、`db-mysql` 0.3.1、`waf` 0.2.0、`cron` 0.4.0、`process` 0.2.0、`logs` 0.3.0 | `site` 0.3.1、`process` 0.2.0 |
| 主实例影响 | **无**：8787 `/-/healthz`=200、PID 175666 不变；`.kore-local.yaml` mtime 仍 04:59:58、sha256 `59957ee1…0d3c`；`.kore-local-state/` mtime 仍 04:59:10 | 同 |

**索引时序说明（诚实披露）**：13:03 起实例时索引里 `site` 仍是 **0.2.0**（`plugins.json` 12:39 版），故 `site@0.3.1` 用 `kored install --package kore-plugin-site/dist/site-0.3.1.tar.gz` 装入。该包 sha256 `8fa58e36cc3b0465908efac118c0bee11aebfc64b0c342b280c99e05af682910` = GitHub `releases/download/v0.3.1` 资产 sha256（下载比对一致）。13:06 索引被其他 agent 重签，`site` 升为 0.3.1 且 sha256 正是 `8fa58e36…`——**与实测装载的包逐字节一致**，不存在"测了非索引版本"。其余插件均走 `POST /api/v1/store/install {"download":true}` 从签名索引下载（响应 `state:"succeeded"`）。

内核读到的声明（`GET /api/v1/plugins/{id}`，`granted_capabilities` / `method_capabilities` 条数）：

```text
site      0.3.1  caps=[system:admin]            method_capabilities=18
db-mysql  0.3.1  caps=[system:admin]            method_capabilities=13
waf       0.2.0  caps=[system:read,system:admin] method_capabilities=6
cron      0.4.0  caps=[system:admin,system:read] method_capabilities=8
process   0.2.0  caps=[proc:read,proc:write]    无 method_capabilities 字段
logs      0.3.0  caps=[system:read]             无 method_capabilities 字段
```

## 3. 修复后实测（18875，默认配置 `audit.invoke_all=false`）

请求统一为（登录 `POST /api/v1/auth/login` 拿 `kore_csrf`，回填 `X-Kore-CSRF` 双提交；口令以 `***` 占位）：

```bash
curl -s -b cookies.txt -X POST http://127.0.0.1:18875/api/v1/invoke/<plugin>/<method> \
  -H 'Content-Type: application/json' -H "X-Kore-CSRF: $CSRF" --data-binary '<body>'
```

### 3.1 只读方法：应 0 条 `invoke.*`

| 方法 | 方法级声明 | HTTP | 响应要点 | 审计增量 |
| --- | --- | --- | --- | --- |
| `site.list` | `system:read` | 200 | `{"count":3,"nginx_mode":"docker",…}` | **+0** |
| `site.config.get` | `system:read` | 200 | `{"schema":{…},"values":…}` | **+0** |
| `db-mysql.instances` | `system:read` | 200 | `{"instances":[],"count":0}` | **+0** |
| `db-mysql.config.get` | `system:read` | 200 | `{"schema":{…}}` | **+0** |
| `cron.list` | `system:read` | 200 | `{"entries":[],"count":0,"warning":"当前用户无 crontab 权限…"}` | **+0** |
| `waf.status` | `system:read` | 200 | `{"available":false,"engine":"none","mode":"off","error_code":"E_UNSUPPORTED"}` | **+0** |

原始 HTTP（`site.list`）：

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: r-5586e3acdd5d6840
{"nginx_mode":"docker","sites":[…],"count":3,"applied":true}
```

审计侧：整轮只读探测后 `GET /api/v1/audit?since=1970-01-01T00:00:00Z&limit=1000` 中 **不存在任何** `invoke.site.site.list` / `invoke.site.site.config.get` / `invoke.db-mysql.*` / `invoke.cron.*` / `invoke.waf.*` 记录。

> 噪声甄别：探测期间出现过 `plugin.disable`（`detail.state=ready`）——那是 **lazy 插件 LRU 驱逐**（`serve.log`: `"msg":"驱逐最久未用的 lazy 插件","victim":"db-mysql","wakeup":"waf"`），不是 invoke 审计。按 action 前缀 `invoke.` 过滤后为 0，二者不可混为一谈。

### 3.2 写方法：应 +1 条（正例对照）

| 请求 | HTTP | 响应 | 新增审计记录（原文） |
| --- | --- | --- | --- |
| `site.config.set` `{"nginx_mode":"auto"}`（缺 `values`） | 400 | `{"code":"E_INVALID","message":"缺少 values 对象"}` | `2026-11-23T05:04:59.062089652Z invoke.site.site.config.set error site/site.config.set {"duration_ms":"0","error_code":"E_INVALID"}` |
| `cron.enable` `{"id":"no-such-job"}` | 400 | `{"code":"E_INVALID","message":"index 必填"}` | `2026-11-23T05:04:59.510456555Z invoke.cron.cron.enable error cron/cron.enable {"duration_ms":"0","error_code":"E_INVALID"}` |
| `site.config.set` `{"values":{"nginx_mode":"auto"}}` | 200 | `{"saved":true,"applied":true,"restart_required":false,"warnings":[]}` | `2026-11-23T05:05:19.447018412Z invoke.site.site.config.set ok site/site.config.set {"duration_ms":"4"}` |

⇒ 审计不是"没记"，只读与写的差别确实由 `needAdmin` 决定。

### 3.3 回退分支（最关键）

| 插件 | 插件级 capabilities | 方法级 | 方法 | HTTP | 审计增量 | 原始记录 / 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `process` | `[proc:read, proc:write]` | 无 | `process.list`（只读语义） | 200 `{"schema":"process.list.v1","count":50,"total":824,…}` | **+1** | `2026-11-23T05:05:00.003773634Z invoke.process.process.list ok process/process.list {"duration_ms":"52"}`（05:06:38 复跑再 +1） |
| `logs` | `[system:read]` | 无 | `logs.sources` | 200 `{"sources":[],"count":0}` | **+0** | 无任何 `invoke.logs.*` |

`process` 的只读方法**仍然进审计**，因为未命中方法级 → 回退插件级 → 数组含 `proc:write` → `needAdmin=true`。这证明：#12 的收益来自 `method_capabilities` 命中，而不是"审计链路坏了"或"所有只读都不记"。`logs` 则说明回退也不是"一律 admin"，而是按插件级声明的最高要求——两个方向都闭合。

### 3.4 审计链路完好性（`audit.invoke_all` 开关）

`config.yaml` 追加 `audit: {invoke_all: true}` → `kill -HUP <pid>` → `serve.log` 记 `{"msg":"config.reloaded","applied":["audit.invoke_all"]}`，随即重放 `site.list`：

```text
2026-11-23T05:05:29.669584204Z invoke.site.site.list ok site/site.list {"duration_ms":"138"}
```

改回 `invoke_all:false` + SIGHUP（`applied:["audit.invoke_all"]`）后重放同一请求：新增记录 **0**。⇒ 记录器本身正常；默认配置下只读不落库是**判定策略**的结果。

## 4. 修复前 A/B（`e1e804a`，内核无 `method_capabilities`）

同一 `site@0.3.1` 包（`kored install --package` 本地装入，插件侧字节相同）、同一请求、同端口族（18876）：

```text
== site/site.list        http=200  新增: 2026-11-23T05:08:14.441812306Z invoke.site.site.list ok site/site.list {"duration_ms":"113"}
== site/site.config.get  http=200  新增: 2026-11-23T05:08:14.888273114Z invoke.site.site.config.get ok site/site.config.get {"duration_ms":"0"}
== process/process.list  http=200  新增: 2026-11-23T05:08:15.366948999Z invoke.process.process.list ok process/process.list {"duration_ms":"28"}
== site/site.config.set  http=200  新增: 2026-11-23T05:08:15.822961317Z invoke.site.site.config.set ok site/site.config.set {"duration_ms":"9"}
```

修复前 `GET /api/v1/plugins/site` 的键里**没有** `method_capabilities`（`['depth_level','desired','enabled','granted_capabilities',…]`），内核按插件级 `[system:admin]` 判定，只读方法与写方法**同样落审计** —— 正是 `round4-audit.md` §6 记录的基线现象（当时 `db-mysql.instances` 也按 admin 类落审计）。

修复前后同一请求对照：

| 请求 | `e1e804a`（修复前） | `ff92f6c`（HEAD） |
| --- | --- | --- |
| `site.list` | +1 `invoke.site.site.list ok` | **+0** |
| `site.config.get` | +1 `invoke.site.site.config.get ok` | **+0** |
| `site.config.set` | +1 | +1 |
| `process.list` | +1 | +1 |

## 5. 审计原文（修复后实例最终快照）

`GET /api/v1/audit?since=1970-01-01T00:00:00Z&limit=1000&order=asc` → `count=22`（`login.*` 1 / `plugin.enable|disable` 15 / `invoke.*` 6）。`invoke.*` 全量 6 条（无一条来自上表 6 个只读方法）：

```json
{"at":"2026-11-23T05:04:59.062089652Z","subject":"admin","action":"invoke.site.site.config.set","plugin":"site","target":"site/site.config.set","result":"error","detail":[{"key":"duration_ms","value":"0"},{"key":"error_code","value":"E_INVALID"}]}
{"at":"2026-11-23T05:04:59.510456555Z","subject":"admin","action":"invoke.cron.cron.enable","plugin":"cron","target":"cron/cron.enable","result":"error","detail":[{"key":"duration_ms","value":"0"},{"key":"error_code","value":"E_INVALID"}]}
{"at":"2026-11-23T05:05:00.003773634Z","subject":"admin","action":"invoke.process.process.list","plugin":"process","target":"process/process.list","result":"ok","detail":[{"key":"duration_ms","value":"52"}]}
{"at":"2026-11-23T05:05:19.447018412Z","subject":"admin","action":"invoke.site.site.config.set","plugin":"site","target":"site/site.config.set","result":"ok","detail":[{"key":"duration_ms","value":"4"}]}
{"at":"2026-11-23T05:05:29.669584204Z","subject":"admin","action":"invoke.site.site.list","plugin":"site","target":"site/site.list","result":"ok","detail":[{"key":"duration_ms","value":"138"}]}
{"at":"2026-11-23T05:06:38.97841457Z","subject":"admin","action":"invoke.process.process.list","plugin":"process","target":"process/process.list","result":"ok","detail":[{"key":"duration_ms","value":"26"}]}
```

第 5 条是 §3.4 的 `invoke_all=true` 实验产物，第 6 条是 §3.3 的 HTTP 复跑；默认配置下 6 个只读方法无一落库。

## 6. 与文档表述不符的地方

1. **#12 收益措辞（需修正）**：`docs/PLUGIN-MATURITY.md` §3.5 #12 与任务描述的"只读方法**按 `system:admin` 进审计**"容易被读成"记录里标着 admin"。事实：审计记录**没有 capability 字段**，修复前是"被记一条 `invoke.*`（判定依据是插件级 admin）"，修复后是"**完全不落库**"。这两句差别是真金白银的：若按"按 read 落一条"理解，#12 的收益会被读成"降级记录"，实际收益是"零记录"。`docs/PLUGIN-MATURITY.md:108` 的"只读调用不落库"才是与代码一致的表述，#12 行应与它统一。
2. **声明仓数已过期**：`docs/PLUGIN-MATURITY.md:146` 与 `:122` 写"已声明 3/24 仓（`cron`/`db-mysql`/`waf`）"。实测 `grep -l 'method_capabilities' ../kore-plugin-*/info.json` = **7/24**（另含 `site` 0.3.1、`file`、`monitor`、`terminal`）。`site@0.3.1` 就是本轮 #12 的主要演示对象，文档若停留在 3 仓会漏掉证据。
3. **"db-mysql 只读方法审计增量已归零（0.3.1 CHANGELOG）"的证据等级**：这是拿**插件 CHANGELOG 自述**当验收依据。#12 行原文的"证据"栏只有 `CHANGELOG`；本次给出了真机请求 + `/api/v1/audit` 原文（本文件 §3、§4）。建议把本文件补进 #12 证据栏。
4. **行号引用轻微漂移**：`docs/PLUGIN-MATURITY.md:28` / `:146` 指向 `invoke_capability.go:203-218`（实际是 `pluginCapabilityDeclaration` 的读取段），**判定与回退**在 `165-177`，**审计门**在 `audit_http.go:137`。功能描述正确，行号指向的是"读声明"而非"下判定"。
5. **`process` 作为回退样本的坑（给后来者）**：`logs` 虽然也没有 `method_capabilities`，但它插件级只声明 `system:read`，回退后**同样不审计**，拿它当"回退仍审计"的反例会得出错误结论。必须选插件级含 write/admin 的仓（`process` 的 `proc:write`）。

## 7. 门禁与断言（本报告可复跑）

| 检查 | 命令 / 断言 | 结果 |
| --- | --- | --- |
| 单元测试（HEAD 快照，与生产代码同源） | `cd /tmp/kore-v12-methodcap/src && CGO_ENABLED=0 go test ./internal/core/httpapi -run 'MethodCapability\|InvokeCapability\|Audit' -count=1` | `ok … 0.467s` |
| 同上（registry） | `… go test ./internal/core/registry -run 'MethodCapabilities' -count=1` | `ok … 0.003s` |
| 只读 0 条 | 6 个方法各 1 次调用后 `invoke.<plugin>.<method>` 记录 = 0 | PASS（§3.1） |
| 写 1 条 | `site.config.set` 200 / `cron.enable` 400 各 +1 | PASS（§3.2） |
| 回退 | `process.list` +1、`logs.sources` +0 | PASS（§3.3） |
| 归因 | 修复前 `site.list` +1 / 修复后 +0 | PASS（§4） |
| 主实例未动 | 8787 healthz=200、PID 175666、`.kore-local.yaml` sha256 未变 | PASS（§2） |

**清理实测**：

```text
TERM 371022 /tmp/kore-v12-methodcap/bin/kored serve --config /tmp/kore-v12-methodcap/config.yaml
TERM 379524 /tmp/kore-v12-methodcap/state/plugins/site/0.3.1/bin/site
TERM 400259 /tmp/kore-v12-prefix/bin/kored serve --config /tmp/kore-v12-prefix/config.yaml
TERM 400840 /tmp/kore-v12-prefix/state/plugins/site/0.3.1/bin/site
$ ls -d /tmp/kore-v12-*   → (all removed)
$ ps -eo pid,args | grep kore-v12 | grep -v 'grep\|bash -c'   → (no isolated kored/plugin processes)
$ ss -ltn | grep -E ':18875|:18876'   → (none)
$ curl 8787/-/healthz → 200；ps -p 175666 → 仍在（etime 26:33）；.kore-local.yaml sha256 未变
```

`/tmp/kore-v12-src`（GitHub release 资产比对下载目录）一并删除。
