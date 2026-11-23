# 复验报告：今晚最后三个修复（G-09 独立 verifier）

- 复验人：`verify-new-fixes`（独立于实现者；未运行、未复用实现者测试的断言）
- 时间：2026-11-24 03:02–03:14（+08:00）
- 复验基线：`kore` @ `ae2d2b8`；复验期间主分支前进到 `df5b4e1`，`git diff --stat ae2d2b8..HEAD` 仅新增 `.agents/verify/resign-50.md`，**代码零变化**
- 隔离方式：临时 git worktree `/home/pt/Work/GolandProjects/kore-wt-vnf`（与主仓同父目录，保证 `make check` 的 `../kore-plugin-*` 解析正常），自写测试与假插件全部跑完即删；**主工作树零写入、8787 主实例零写入未重启**（`curl /-/healthz` = `{"status":"ok"}`）
- 产物：本文件（`.agents/verify/verify-new-fixes.md`），未 push

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| `8c50d21` bus 超时重同步 | **成立**。独立 UDS 复现通过；反例回退后精确复现 `E_INVALID` |
| `1a326af` oneshot 超时回收 | **成立**。超时后 `/proc/<pid>` 消失且非僵尸，令牌归还 |
| `b71a900` + `d67e5f7` post_upgrade | **成立**。真实 v0.5.0→v0.6.0 升级、lazy 插件全程未手动调用，`cron.migrate` 被执行 |
| 门禁 | `make check` 17/17、`go vet ./...`、`go test ./...` 全部 exit 0 |
| 反例存活 | **0 条**（三项机制均被反例证明测试有区分力） |

**最重要的事实更正**：`d67e5f7` **不在 `kore` 仓**，它是兄弟仓 `kore-plugin-cron` 的提交（任务表未标仓库名）。已在 `../kore-plugin-cron` 核实存在，见 §3。

## 1. `8c50d21`：bus 超时后重同步迟到帧

**声称**：超时后下一次调用成功，不再误报 `E_INVALID`。

**独立复现**（自写，未复用 `call_test.go` / `call_internal_test.go` / `testdata/fakeplugin`）：
- 真实 UDS：`net.Listen("unix")` + `net.Dial`，`bus.New` 注入只返回该连接的 Provider。
- 自写假插件：首个请求挂起 **400ms** 后才写回 `{"who":"stale"}`；第二个请求回 `{"who":"fresh"}`。
- 第一次调用用 `ctx` 200ms 制造超时（`CallTimeout=5s`，保证第二次调用有足够预算跨过迟到帧）。
- 断言：第二次 `err == nil`，且 `reply.Result` 为 `fresh`、不是 `stale`。

**实测**：
```text
第一次调用按预期超时: E_UPSTREAM: 插件 verifier 调用超时
VERIFIER-BUS-OK second_result={"who":"fresh","from":"second-call"}
--- PASS: TestVerifierBusResyncLateFrame (0.40s)   exit 0
```

**反例**：`git checkout 8c50d21^ -- internal/core/bus/call.go`（同时临时移走该提交新增的两个测试文件以便编译），同一复现：
```text
第二次调用失败: E_INVALID: 响应 id=495527ef… 与请求 id=2dead31d… 不匹配，连接不再可信
--- FAIL: TestVerifierBusResyncLateFrame (0.40s)   go test exit 1
```
反例精确命中「误报 E_INVALID」这一被声称修复的缺陷；已还原（`git status` 干净）。

## 2. `1a326af`：oneshot 超时回收

**声称**：超时后进程被回收 + 令牌归还。

**独立复现**：
- 自写 oneshot 假插件（`verifier-tmp/oneshotplugin`，不复用 `testdata/fakeplugin`）：握手后对 `verifier.work` 挂起 60s 不回帧；启动即写 pid 文件。
- 真实 supervisor + bus（`CallTimeout=300ms`），`ShutdownGrace=200ms`（与实现者测试同口径；**`kored` 未显式配置该值，默认 5s**，见 §6）。
- 断言：超时后 `/proc/<pid>` 在 6s 内消失、最后观察到的状态不是 `Z`（僵尸）；随后 `verifier.echo` 在 3s 内成功（串行令牌已归还）。

**实测**：
```text
oneshot 调用按预期超时: E_UPSTREAM
VERIFIER-ONESHOT-RECLAIMED pid=485054
VERIFIER-ONESHOT-TOKEN-OK result={"ok":true}
--- PASS: TestVerifierOneshotTimeoutReclaims (0.70s)   exit 0
```
并发复跑两次 pid 不同（479624 / 485054），均确认 `gone`，无残留进程。

**反例**：`git checkout 1a326af^ -- internal/core/supervisor/oneshot.go`（移除 `FinishCall` 钩子），同一复现：
```text
oneshot 超时后进程未被回收：/proc/482934 仍存在（state=S）
--- FAIL: TestVerifierOneshotTimeoutReclaims (6.65s)   go test exit 1
```
已还原。

## 3. `b71a900` + `d67e5f7`：post_upgrade 对 lazy 插件生效

**仓库归属核实**：`kore` 仓 `git cat-file -t d67e5f7` → `fatal: Not a valid object name`；该提交在 **`kore-plugin-cron`**：
```text
d67e5f7 [agent:cron-migrate-on-upgrade] feat(cron): 新增 cron.migrate 并声明 post_upgrade…
  CHANGELOG.md / README.md / info.json / manifest.json / methods.go / methods_test.go
```
`info.json`：`version 0.7.0`、`lifecycle lazy`、`post_upgrade "cron.migrate"`。用当前内核真实解析：
```text
LOAD_OK id=cron version=0.7.0 lifecycle=lazy post_upgrade="cron.migrate"   exit 0
```

**独立复现**（我关心的核心断言；**真升级**，不是重装）：
- 自写 cron 假插件 + 自写 tar.gz 打包（不复用 `echoplugin` / `TestReloadOneRunsDeclaredPostUpgrade`）；插件每次握手/方法调用都写 `<KORE_STATE_DIR>/verifier-calls.log`。
- 步骤：装 **v0.5.0**（无 `post_upgrade`）→ `reloadOne` 登记 → `Enable`（lazy 不拉起，断言日志文件不存在 = 用户从未调用）→ 装 **v0.6.0**（`post_upgrade: "cron.migrate"`）→ `reloadOne`。
- 全程测试代码**没有任何**对插件的业务调用。
- 断言：重载返回 `reloadRestarted`；插件日志包含 `hello 0.6.0` 与 `method cron.migrate 0.6.0`；catalog 版本为 0.6.0。

**实测**：
```text
INFO 插件就绪 plugin_id=cron ...
INFO 升级后置动作完成 plugin_id=cron method=cron.migrate
INFO 插件重载完成 plugin_id=cron version=0.6.0 result=restarted
VERIFIER-POST-UPGRADE-OK log="start 0.6.0\nhello 0.6.0\nmethod cron.migrate 0.6.0"
--- PASS: TestVerifierPostUpgradeLazyNotInvoked (0.55s)   exit 0
```

**反例**：`git checkout b71a900^ -- cmd/kored/serve_runtime.go`（移除 `runPostUpgrade` 调用），同一复现：
```text
升级后插件日志不存在——lazy 插件未被冷启，post_upgrade 未执行
--- FAIL: TestVerifierPostUpgradeLazyNotInvoked (0.50s)   go test exit 1
```
已还原。

### G-01 边界检查（原文命令）

```text
grep -rn "cron\|crontab" internal/core/ --include=*.go   → 9 处命中（exit 0）
grep -rn "migrate" internal/core/ --include=*.go         → 3 处命中，全部 parse_test.go
grep -rn '"cron\|"migrate' internal/core --include=*.go | grep -v _test.go → 0 命中（exit 1）
```

| 命中 | 性质 |
| --- | --- |
| `scheduler/task.go:83` | 注释：`interval_s` 与 cron 表达式二选一（调度器既有语义） |
| `registry/manifest.go:142` | 注释：举例「写进 crontab 的路径」；正文明确「内核不认识动作语义」 |
| `installer/layout.go:19/25/74` | 注释：稳定路径与宿主 crontab 的关系（安装器既有说明） |
| `httpapi/handlers_scheduler.go:74` | 注释：任务创建支持 cron 表达式 |
| `installer/current_link_test.go:38` | 测试注释 |
| `filewrite/filewrite_test.go:86` | 测试数据：路径穿越样例 `../../cron.d/x.conf` |
| `registry/parse_test.go:263/264/268` | 测试数据：`site.migrateStale` 合法样例、`cron.migrate` 作**非法前缀**样例 |

**判定**：内核代码里**没有** `cron` / `migrate` / `crontab` 的业务分支、动词表或字符串常量；`validatePostUpgrade` 只校验 `<id>.` 前缀与动作段字符集，方法名原样交 `bus.Call`。按「内核是否认识业务」判定 **不违反薄壳红线**；按任务给出的「出现即违反」**字面口径**则命中 9 处（7 注释 + 2 测试数据），需主控裁定——我按代码事实判不违反，但如实报出命中。

## 4. 门禁复跑（隔离 worktree @ `ae2d2b8`，clean tree）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `make check` | **0** | 17/17 段全部 `[RUN]`，`[OK] 门禁全部通过`（含 17/17 交叉编译五目标 exit 0，2490ms） |
| `go vet ./...` | **0** | 无输出 |
| `go test ./...` | **0** | 18 个包全 `ok`，`^FAIL` 行数 = 0 |

> 环境说明：worktree 内复制了主工作树的 `web/dist`（`.gitignore:13` 忽略的构建产物，主仓同款）；不含它 `cmd/kored` 的 `web/embed.go` 无法编译，属环境还原而非测试放宽。worktree 已 `git worktree remove` + `prune`，`git worktree list` 仅主工作树。

## 5. 声称 vs 实测

| # | 声称 | 实测 | 判定 |
| --- | --- | --- | --- |
| 1 | bus 超时后下一次调用成功，不再误报 `E_INVALID` | 第二次调用成功拿到 `fresh`；反例下精确报 `E_INVALID` | ✅ 成立（「成功」需限定，见 §6-A） |
| 2 | oneshot 超时后进程被回收 + 令牌归还 | `/proc/<pid>` 消失、非僵尸；后续调用成功；反例下进程 6.65s 仍存活 | ✅ 成立（时延受 `ShutdownGrace`，见 §6-B） |
| 3 | 升级后即使 lazy 插件未被调用，`cron.migrate` 也被执行 | 真实 v0.5.0→v0.6.0，无任何手动调用，日志 `method cron.migrate 0.6.0` | ✅ 成立 |
| 4 | `b71a900` + `d67e5f7` 均为 kore 仓修复提交 | `d67e5f7` 不在 kore；属 `kore-plugin-cron`（0.7.0） | ⚠️ 表述风险（非缺陷） |
| 5 | 门禁全绿 | `make check` / `go vet` / `go test` 全 exit 0 | ✅ 成立 |

## 6. 不成立清单（最重要）

**没有任何一条「功能不成立」**——三项机制均通过独立复现，且反例证明测试有区分力。以下为**口径不成立 / 未覆盖边界**，如实列出：

- **A（口径）**：bus 的「下一次调用成功」**不是无条件**。第二次调用自身的剩余超时预算必须覆盖迟到帧到达的时刻；若预算更短，会再次超时 `E_UPSTREAM`（**不再是 `E_INVALID`**）。我首版复现即因第二次调用 200ms 预算 < 400ms 迟到帧而超时，改用 5s `CallTimeout` 后通过。修复语义正确，但"成功"应限定为"预算足够时"。
- **B（时延口径）**：oneshot 回收时延取决于 `ShutdownGrace`：`kored` 未显式配置，默认 **5s**，加 2s SIGKILL 兜底，最坏约 **7s**；我的复现设 200ms 以在 6s 内断言。机制（`FinishCall` → 异步 `Stop`）不依赖该值，但**默认配置下的回收时延本轮未实测**。
- **C（未覆盖边界）**：`post_upgrade` 只在 `desired=enabled` 的重载路径执行——`reloadOne` 在 `!found || Desired != enabled` 分支提前 `return reloadRegistered`，升级时插件处于 **disabled** 则本次不执行，且后续单纯 `Enable` 也不会补跑（需再次重载）。对 cron 实际影响低（插件保留启动期迁移兜底），但声明文本未限定此边界。
- **D（G-01 字面）**：`internal/core` 中存在 9 处 `cron`/`crontab` 命中（7 注释 + 2 测试数据），无代码级业务耦合。按任务「出现即违反」字面口径命中，按逻辑口径不违反——需主控裁定。
- **E（端到端残余风险）**：`kore-plugin-cron` 0.7.0 **尚未入索引**（分发链未生效），真实 crontab 存量条目在真机上的迁移未实测；ADR-0048 §7 已声明该边界，本轮同样未覆盖。
- **F（表述）**：任务表的 `d67e5f7` 未标仓库，它在 `kore-plugin-cron` 而非 `kore`；核实存在后**不构成不成立**，但跨仓变更集的表述应带仓库名。

## 7. 清理与影响声明

- 临时 worktree 已删除并 `prune`，`git worktree list` 仅主工作树；自写测试/假插件/打包脚本全部删除。
- 主工作树仅新增本报告；临时反例回退全部还原（worktree 内 `git status` 归零）。
- 未 push；未改任何代码/测试/评分资产；未写入或重启 8787 主实例。
