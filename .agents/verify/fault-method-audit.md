# 故障注入 · 方法级覆盖审计（dns / ssl / integrity / site / echo）

- 审计时间：2026-11-24
- 基线：`kore` HEAD `4ad89c6`；插件仓为其工作区当前状态（未提交改动未纳入判定）
- 性质：**只读核查**。未改代码 / 未改测试 / 未改文档 / 未起服务 / 未 sudo
- 问题：这 5 仓的 `tests/fault/` 到底「调用过哪些方法」——不是「有没有 fault 目录」

## 0. 结论摘要

| 判定 | 结论 |
| --- | --- |
| 「5 仓方法名不可追溯」 | **不成立**，颗粒度太粗。只有 `ssl` 是真正 0 处协议方法名；`integrity` 用可读的 verb 字符串走 service 层（半可追溯）；`dns` / `site` / `echo` 走黑盒 UDS，方法名可追溯，问题是**覆盖窄** |
| 方法级真缺口 | **42 个方法零触及**（dns 8 / ssl 8 / integrity 5 / site 18 / echo 3） |
| 直接覆盖 | 7 个方法（dns 3 / site 2 / echo 2），全部黑盒 UDS |
| 间接覆盖（算覆盖） | 15 个方法（ssl 12 / integrity 3），全部 service 层入口 |
| 四类故障齐备 ≠ 方法级覆盖 | 5 仓都真有 kill/timeout/disk/cgroup（或等价进程级注入）用例，但 `site` 只有 2/20 方法、`echo` 只有 2/5 方法被这些故障用例实际打到 |

方法总数 64 = dns 11 + ssl 20 + integrity 8 + site 20 + echo 5；7 直接 + 15 间接 + 42 缺口 = 64 ✓

## 1. 口径与判定规则

1. **方法清单真源**：各仓 dispatch / `businessVerb` 接受的业务 verb，与 `info.json` 的 `method_capabilities` 交叉核对。`kore.*` 协议方法与 `config.get/set` 契约方法单列，不计入业务方法总数。
2. **覆盖判定**（与任务卡一致）：
   - **直接**：fault 用例带协议方法名（`dns.status`、`site.create` 等）打到真实进程。→ 覆盖
   - **间接**：fault 用例经黑盒入口（service 层 / UDS 无方法名）执行到该方法的实现。→ **算覆盖，标注「间接」**
   - **缺口**：`tests/fault/` 里零触及。→ 缺口
3. **不计入覆盖的证据**：只做帧编解码往返、或只在方法映射表里出现的字符串，不算打到方法（例：`integrity/tests/fault/kill_test.go:119` 的 `"integrity.status"` 只是 `DecodeFrame` 断言）。
4. 下文证据路径均相对各插件仓根。

## 2. 逐仓逐方法矩阵

### 2.1 `kore-plugin-dns`（业务方法 11）

| 方法 | 被 tests/fault 调用 | 类型 | 证据 |
| --- | --- | --- | --- |
| status | 是 | 直接（UDS） | `TestDependencyMissingDegrades` · `tests/fault/degrade_test.go:175` |
| zones | **否** | 缺口 | — |
| records | **否** | 缺口 | — |
| query | 是 | 直接（UDS） | `TestDependencyMissingDegrades` · `tests/fault/degrade_test.go:201` |
| record.add | 是 | 直接（UDS） | `TestWriteWithoutBindZone` · `tests/fault/write_channel_test.go:28` |
| record.update | **否** | 缺口 | — |
| record.delete | **否** | 缺口 | — |
| addRecord | **否** | 缺口 | — |
| updateRecord | **否** | 缺口 | — |
| deleteRecord | **否** | 缺口 | — |
| reload | **否** | 缺口 | — |

契约方法补充：`dns.config.set` 有用例（`TestStateDirUnwritable` · `tests/fault/degrade_test.go:95`）；`dns.config.get` 零触及。
`kore.ping` 作为存活探针出现在 `degrade_test.go:112`、`write_channel_test.go:51`。

### 2.2 `kore-plugin-ssl`（业务方法 20）

**全仓 `tests/fault/` 无一处协议方法名**，全部经 `*certs.Service` 直调（黑盒入口 = service 层）。全仓 `svc.*` 调用 23 处，其中 `new_methods_test.go` 12 处（与上一轮抽查数字一致）。

| 方法 | 被 tests/fault 调用 | 类型 | 证据 |
| --- | --- | --- | --- |
| list | 是 | 间接（`svc.List`） | `TestKillHealthyPath` · `tests/fault/kill_test.go:33`（对照组） |
| import | 是 | 间接（`svc.Import`） | `TestDiskFullImport` · `tests/fault/disk_test.go:25` |
| selfsign | 是 | 间接（`svc.SelfSign`） | `kill_test.go:14` / `disk_test.go:14` / `timeout_test.go:16` / `cgroup_test.go:14`（四类故障全覆盖） |
| renew | 是 | 间接（`svc.Renew`） | `TestCgroupHealthyRenew` · `tests/fault/cgroup_test.go:31`（仅对照组） |
| verify | 是 | 间接（`svc.Verify`） | `TestRealHandshakeTimeout` · `tests/fault/timeout_test.go:36`（真实 TCP 握手超时） |
| issue | **否** | 缺口（低优先） | `methods.go:83-91` 该 verb 恒返回 `E_UNSUPPORTED`，无故障分支可注入 |
| expiring | 是 | 间接（`svc.Expiring`） | `TestFaultCoversNewMethods` · `tests/fault/new_methods_test.go:30` |
| renew.set | 是 | 间接（`svc.RenewalTask`） | `new_methods_test.go:36` |
| acme.status | 是 | 间接（`svc.ACMEStatus`） | `new_methods_test.go:42` |
| acme.issue | 是 | 间接（`svc.ACMEIssue`） | `new_methods_test.go:47` |
| bind.set | 是 | 间接（`svc.SetBinding`） | `new_methods_test.go:89` |
| bind.remove | **否** | 缺口 | 守卫已接：`internal/certs/binding.go:301-302` |
| bind.list | 是 | 间接（`svc.Bindings`） | `new_methods_test.go:96` |
| https.status | 是 | 间接（`svc.HTTPSStatus`） | `new_methods_test.go:101` |
| acme.builtin.issue | **否** | 缺口 | 守卫已接：`internal/certs/acme_issue.go:208-209` |
| acme.builtin.renew | **否** | 缺口 | 守卫已接：`internal/certs/acme_issue.go:340-341` |
| acme.builtin.status | **否** | 缺口 | 守卫已接：`internal/certs/acme_auto.go:43-44` |
| acme.auto | **否** | 缺口 | 守卫已接：`internal/certs/acme_auto.go:142-143` |
| https.enforce | **否** | 缺口 | 守卫已接：`internal/certs/https_state.go:134-135` |
| https.unenforce | **否** | 缺口 | 守卫已接：`internal/certs/https_state.go:200-201` |

关键结论：8 个缺口的 `faultError(s.fault)` 守卫**全部已经接好**，只是没有用例调用 → 补测成本最低（各加一个 svc 调用 + `assertError` + `assertNoCertFiles`）。

### 2.3 `kore-plugin-integrity`（dispatch 接受 8 个业务 verb）

fault 用例全部经 `internal/integrity.Service.Call(verb, params)` 直调（service 层 = 间接）。kill / timeout / short-frame 三组用例只打 `pluginapi.ReadFrame`，不触及任何业务方法。

| 方法 | 被 tests/fault 调用 | 类型 | 证据 |
| --- | --- | --- | --- |
| baseline | 是 | 间接（`service.Call("baseline")`） | `boundary_test.go:22`（helper，调用点 `:57` / `:78`）、`storage_test.go:48` |
| baseline.list | **否** | 缺口 | — |
| restore | **否** | 缺口 | — |
| check | 是 | 间接（`service.Call("check")`） | `TestCorruptBaselineFault` · `tests/fault/storage_test.go:71` |
| status | 是 | 间接（`service.Call("status")`） | `storage_test.go:71`（同循环） |
| verify_file | **否** | 缺口 | — |
| schedule.set | **否** | 缺口 | — |
| schedule.get | **否** | 缺口 | — |

附带发现（超出本卡范围，仅记录）：`info.json` 的 `method_capabilities` 只有 7 条，缺 `integrity.verify_file`，与 `methods.go:57` 的 dispatch 白名单不一致 → 声明漂移，建议另开卡核实。另：`tests/fault/kill_test.go:119,131` 的 `"integrity.status"` 仅验证帧解码后 method 字段保真，**未进入 dispatch**，不计覆盖。

### 2.4 `kore-plugin-site`（业务方法 20 + config 2）

fault 用例 100% 黑盒：真拉 `bin/site`、真 UDS、真帧协议（`tests/fault/helper_test.go:1-13` 注释 + `startPlugin`）。

| 方法 | 被 tests/fault 调用 | 类型 | 证据 |
| --- | --- | --- | --- |
| create | 是 | 直接（UDS） | `TestFaultDisk` · `disk_test.go:29`；`TestFaultDiskNoPanic` · `disk_test.go:57`；`TestFaultKill` · `kill_test.go:54`；`sanity` · `helper_test.go:250` |
| status | 是 | 直接（UDS） | `sitedir_test.go:108` / `:136` / `:157`（三态 unknown 契约） |
| list | **否** | 缺口 | — |
| delete | **否** | 缺口 | — |
| get | **否** | 缺口 | — |
| bindSSL | **否** | 缺口 | — |
| unbindSSL | **否** | 缺口 | — |
| setRewrite | **否** | 缺口 | — |
| getRewrite | **否** | 缺口 | — |
| setProxy | **否** | 缺口 | — |
| unsetProxy | **否** | 缺口 | — |
| setRedirect | **否** | 缺口 | — |
| unsetRedirect | **否** | 缺口 | — |
| disable | **否** | 缺口 | — |
| enable | **否** | 缺口 | — |
| setIndex | **否** | 缺口 | — |
| clone | **否** | 缺口 | — |
| setPassword | **否** | 缺口 | — |
| clearPassword | **否** | 缺口 | — |
| traffic | **否** | 缺口 | — |

`site.config.get/set` 同样零触及。判定：site 的 fault 形态是「进程级四类故障 + 2 个方法」，满足 G-20 的**存在性**要求，方法覆盖面只有 10%。

### 2.5 `kore-plugin-echo`（业务方法 5）

`info.json` 无 `method_capabilities`（fault 验证插件，`count=0`），方法表面取 `methods.go:85` 的 `businessVerb`。

| 方法 | 被 tests/fault 调用 | 类型 | 证据 |
| --- | --- | --- | --- |
| echo | 是 | 直接（UDS） | `TestInvokeInvalidParams` · `tests/fault/fault_test.go:142`；`TestEchoNullParams` · `:170` |
| crash | 是 | 直接（UDS） | `TestCrashExitCode` · `tests/fault/fault_test.go:182` |
| ping | **否** | 缺口 | — |
| slow | **否** | 缺口 | — |
| timeout | **否** | 缺口 | — |

协议方法补充：`kore.shutdown` 多次覆盖（`fault_test.go:146` / `:160` / `:174` / `:195`）；`kore.reload` 零触及；握手类用例覆盖 `kore.hello` 的四种异常路径（`fault_test.go:65-129`）。

## 3. 三类判定汇总

| 仓 | 方法数 | 直接覆盖 | 间接覆盖 | 缺口 | 一句话判定 |
| --- | --- | --- | --- | --- | --- |
| dns | 11 | 3 | 0 | 8 | 方法名可追溯，写通道只覆盖 `record.add`，其余 6 个写/读方法零触及 |
| ssl | 20 | 0 | 12 | 8 | **真·方法名不可追溯**，但 service 层覆盖成立；8 个缺口守卫已接、无用例 |
| integrity | 8 | 0 | 3 | 5 | verb 字符串可追溯，但入口是 service 层；restore/schedule/verify_file 零触及 |
| site | 20 | 2 | 0 | 18 | 黑盒 UDS 判定正确，非零覆盖，但只有 create/status 两个方法 |
| echo | 5 | 2 | 0 | 3 | ping/slow/timeout 三个业务方法零触及，而 slow/timeout 正是内核超时策略的探针 |

**对上一轮结论的核实结果**：

| 上一轮说法 | 核实 |
| --- | --- |
| 24 仓都有 `tests/fault/` | 本卡范围内 5 仓全部存在，且有真实 `Test` 函数、无「全跳」文件 |
| 19 仓四类齐备、5 仓定制 | 与实读一致：dns/echo 为进程级（kill/timeout + 降级），ssl/integrity/site 为四类文件齐备或等价注入 |
| `site` 是黑盒 UDS | **确认**（`tests/fault/helper_test.go:1-13`、`startPlugin` 拉真二进制） |
| `ssl` 有 12 处 `svc.*` 调用 | **确认但需修正口径**：`new_methods_test.go` 恰 12 处；全仓 `tests/fault` 共 23 处 |
| 5 仓「方法名不可追溯」 | **过粗**：仅 ssl 成立；site/dns/echo 方法名在协议帧里明确出现 |

## 4. 真缺口清单 + 补测建议（本卡不实现）

### 4.1 缺口清单

- **dns（8）**：`zones`、`records`、`record.update`、`record.delete`、`addRecord`、`updateRecord`、`deleteRecord`、`reload`（+ 契约方法 `config.get`）
- **ssl（8）**：`issue`（低优先）、`bind.remove`、`acme.builtin.issue`、`acme.builtin.renew`、`acme.builtin.status`、`acme.auto`、`https.enforce`、`https.unenforce`
- **integrity（5）**：`baseline.list`、`restore`、`verify_file`、`schedule.set`、`schedule.get`
- **site（18）**：`list`、`delete`、`get`、`bindSSL`、`unbindSSL`、`setRewrite`、`getRewrite`、`setProxy`、`unsetProxy`、`setRedirect`、`unsetRedirect`、`disable`、`enable`、`setIndex`、`clone`、`setPassword`、`clearPassword`、`traffic`
- **echo（3）**：`ping`、`slow`、`timeout`

### 4.2 补测建议（按性价比排序）

**P0 · ssl（成本最低，守卫已就绪）**
复用 `new_methods_test.go` 的 4 类故障表驱动，各补一个 svc 调用：

| 方法 | 注入 | 断言的外部行为 |
| --- | --- | --- |
| `bind.remove` | 四类故障 | `E_UPSTREAM`/`E_INTERNAL`；`bindings.json` 内容不变（对照：无故障时真的删掉） |
| `https.enforce` / `https.unenforce` | 四类故障 | 返回结构化错误；https 状态文件不被改写（对照：无故障时状态翻转） |
| `acme.builtin.issue` / `.renew` | 四类故障 | 错误码分组同现有用例；不落 ACME 标记 / audit 记录 / 证书文件 |
| `acme.builtin.status` / `acme.auto` | 四类故障 | 同上；`acme.auto` 额外断言配置未落盘 |
| `issue` | 无需故障注入 | 仅需一条稳定性断言：故障下仍返回 `E_UNSUPPORTED`（不是 500/崩溃），优先级最低 |

**P0 · site（写方法先补，读方法抽样）**

| 方法 | 注入 | 断言的外部行为 |
| --- | --- | --- |
| `delete` / `bindSSL` / `unbindSSL` / `setProxy` | `KORE_SITE_CONF_DIR` 指向普通文件（ENOTDIR，与 `TestFaultDisk` 同法） | `E_INTERNAL`、无 panic、不留半成品 vhost / 不清空清单、`kore.shutdown` 仍可用 |
| `list` / `status` / `get` / `traffic`（抽 2-3 个） | 收窄 PATH（nginx/docker 不可用） | 结构化降级（`nginx_mode` / 可用性字段明确），不谎报 `applied=true`，不 panic |

建议明确分层口径：**8 个写方法必须覆盖，10 个读方法抽 3 个**，避免 18 个全补把 fault 套件拖成分钟级。

**P1 · dns**

| 方法 | 注入 | 断言的外部行为 |
| --- | --- | --- |
| `record.update` / `record.delete` | `KORE_DNS_BIND_CONF` 指向缺失文件（同 `TestWriteWithoutBindZone`） | `E_NOTFOUND` + `hint` 含 `bind_conf`；不产生 `dns-journal`（fail-closed） |
| `addRecord` / `updateRecord` / `deleteRecord`（旧别名） | 同上 | 与 `record.*` 错误码/hint 一致，证明别名未分叉 |
| `zones` / `records` | `PATH=/nonexistent`（同 `TestDependencyMissingDegrades`） | 显式降级（`available=false` 或空清单 + warning），不返回 `E_INTERNAL`，不 panic |
| `reload` | 状态目录不可写 / 依赖缺失 | 显式失败或明确降级，不静默返回 ok |

**P1 · integrity**

| 方法 | 注入 | 断言的外部行为 |
| --- | --- | --- |
| `restore` | 状态目录 `0o500` | `E_INTERNAL`，且当前 `baseline.json` 未被截断/覆盖 |
| `schedule.set` / `schedule.get` | 状态目录不可写 / `schedule.json` 写坏 | `set` 报 `E_INTERNAL`；`get` 不得静默返回空计划（与 `TestCorruptBaselineFault` 同模式） |
| `baseline.list` | `baseline.json` 写坏 | `E_INTERNAL` 而非空列表 |
| `verify_file` | 文件 `0o000` / 超限大小 | 结构化错误或 warning，不 panic（可扩展现有权限用例） |

**P2 · echo**

| 方法 | 注入 | 断言的外部行为 |
| --- | --- | --- |
| `slow` | 调用方 500ms 预算 | 调用方必须按预算放弃（`E_TIMEOUT` 语义），插件侧仍可继续服务 |
| `timeout` | 调用方 1s 预算 | 同上，且用于验证内核侧「超时 > 默认预算」的判定边界 |
| `ping` | 无故障 | 作为健康对照基线，避免「永远失败」的假通过 |

## 5. 未确认与限制

1. **root 下会跳过部分用例**：`dns/tests/fault/degrade_test.go:80`、`integrity/tests/fault/boundary_test.go:31`、`storage_test.go:30` 在 `euid==0` 时 `t.Skip`。本卡未实际运行（只读、不起服务），**这些用例在当前用户身份下是否执行未确认**。
2. **非 fault 测试的覆盖情况只做参考**：例如 site 的 18 个缺口方法在 `l2_*_test.go` / `tests/e2e` 里大多有对应测试（按字面 grep 命中），但**未逐条核实其语义是否等价于故障注入**；本矩阵的「缺口」严格限定为 `tests/fault` 口径。
3. `integrity` 的 `verify_file` 在 `info.json` 未声明（声明 7 条 vs dispatch 8 条），是否属 G-20 声明漂移**待另卡确认**，本卡不判定。
4. 未审计 `tests/live`（dns）与 `tests/e2e`（ssl/site/integrity）的方法面，那是运维/联调覆盖，不属于本卡口径。
5. 插件仓工作区可能存在未提交改动，矩阵基于实读文件内容，未与各仓 HEAD 比对。

## 6. 复现命令（全部只读）

```bash
# 方法清单真源
python3 -c "import json;print(sorted(json.load(open('<repo>/info.json'))['method_capabilities']))"
grep -n 'func businessVerb' -A 20 <repo>/methods.go

# fault 用例实际打到的方法（逐仓）
grep -rn 'dns\.\|site\.\|ssl\.\|integrity\.' <repo>/tests/fault/*.go
grep -rn 'svc\.[A-Z]' <repo>/tests/fault/*.go          # service 层入口（ssl）
grep -rn 'service\.Call(' <repo>/tests/fault/*.go      # service 层入口（integrity）

# 不进入 dispatch 的假证据
grep -n 'integrity.status' kore-plugin-integrity/tests/fault/kill_test.go
```
