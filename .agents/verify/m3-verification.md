# M3 独立验收报告（G-09 · m3-verifier）

- 验收对象：实现 `a5e4af8` / merge `19219c0`，并在当前 HEAD `002f853`（m2-impl 的 cleanup 竞态修复）上复跑。
- 角色：m3-verifier（与 implementer m3-impl 不同人，G-09）。
- 纪律：只读复跑；唯一写物 = 本报告；不 push、不联网、不执行 install/serve/upgrade、不碰 `.kore-local-*`；GOCACHE 落工作区 `.tmp/m3verify-gocache`，用完删除。
- 时间：2026-11-26（Asia/Shanghai）。

## 结论（PASS/FAIL 一句）

**PASS — M3 批量更新编排器在 HEAD `002f853` 上完整复跑通过：所有门禁命令 exit 0、断言覆盖面核对到位、复用 M2 结构且不新增 schema、git 顺序与主树/工作树卫生均符合 G-25，无阻断项（单条重试断言有一处口径备注，见 §2.3）。**

## 1. 环境与验收基线

| 项 | 值 |
| --- | --- |
| go version | `go version go1.26.8 linux/amd64` |
| 模块 | `module github.com/pengtang1024/kore`，`go 1.26` |
| GOWORK | `off`（复跑时显式导出） |
| GOCACHE | `/home/pt/Work/GolandProjects/kore-pl/.tmp/m3verify-gocache`（临时，用后删） |
| HEAD | `002f853ef3a5fdab4561c73db71e4658cf15f81b` |

## 2. 复跑命令 + 退出码 + 关键输出

### 2.1 主测试（任务卡第 1 项）

```
$ cd kore && GOCACHE=<workspace>/.tmp/m3verify-gocache GOWORK=off \
    go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/market/...
ok  github.com/pengtang1024/kore/cmd/kored          10.078s
ok  github.com/pengtang1024/kore/internal/core/market  0.011s
exit code: 0
```

### 2.2 稳定性 -count=3（任务卡第 2 项）

```
$ GOCACHE=<...> GOWORK=off go test -count=3 -timeout 200s ./internal/core/market/...
ok  github.com/pengtang1024/kore/internal/core/market  0.023s
exit code: 0
```

连续 3 次全绿，未复现「误判排序断言」；拓扑序断言 `want=[echo,site,waf]` 稳定（market/batch_test.go `TestOrderPendingStableOrder`，见 §3.2）。

### 2.3 make vet（任务卡第 3 项）

```
$ GOCACHE=<...> GOWORK=off make vet
[OK] go vet 通过
exit code: 0
```

### 2.4 G-01 薄壳边界（grep "kore/plugins/ import）

```
$ grep -rn '"kore/plugins/' internal/core/
（无输出）
exit code: 1（零命中，符合预期）
```

补充宽口径 `grep -rn 'plugins/' internal/core/ --include='*.go'` 仅命中注释 / 路由字面量 / 测试 URL（如 `/api/v1/plugins/{id}`、`../kore-plugins/index`、`<state>/plugins/<id>` 属主说明），无 `internal/core` import 插件仓库，符合 G-01/G-13。

### 2.5 G-24 无 any / object 逃逸

新生产文件（M3 新增）逐行剔除注释后 grep：

```
$ grep -nvE '^\s*//|//.*' cmd/kored/selfupdate_batch.go internal/core/market/batch.go \
    | grep -nE '(^|[^[:alnum:]])(any|object)([^[:alnum:]]|$)|map\[string\]any'
（无输出）—— 无实际 any/object 类型 token
```

注释里出现的「禁 any」「禁 any/object，G-24」是守规说明，不算类型逃逸。全仓 `grep -rn 'map[string]any' --include='*.go' internal/ cmd/`（排除 `_test.go`）命中的是已有文件 `internal/core/supervisor/testdata/fakeplugin/main.go` 的测试替身与注释行，与 M3 新增代码无关。G-24 判定通过。

## 3. 断言覆盖面核对（不只看绿）

### 3.1 cmd/kored/selfupdate_batch_test.go（6 个用例）

- `TestBatchHappyPath`：整批 `phaseCommitted`、`Summary={3,3,0}`、`Failures` 为空；`installer.calls == [echo,site,waf]`（逐条调单条 `InstallDownload` 且按依赖序）；`reloads == [echo,site,waf]`（`reloadOne` 逐条调用）；每条 `Job.State=success`、`ExitCode=0`、`Reload=reloadRestarted`；`reflect.TypeOf(item.Job) == httpapi.SelfUpdateJob{}`（结果结构复用 M2）；审计仅 1 条、`Action=orchestrationAuditAction`、`Subject=inProcessActor`、`channel=...`、`target_version=batchAuditTarget`（审计复用 M2 出口）。**覆盖：happy path 依赖序 / reloadOne 逐条 / 审计复用 / 结果结构对比。**
- `TestBatchIsolatedFailure`：注入 `site` 失败 → `Summary={3,2,1}`、三条都尝试（`[echo,site,waf]`）、失败项不阻断后续；`reloads == [echo,waf]`（失败项不 reload）；`Failures` 精确 1 条且 `ID=site`/`ErrorCode=E_UPSTREAM`/`Retryable=true`；`Items[1].Phase=failed` 且 `Job.State=failed`，`Items[0]/[2].Phase=committed`（**无整批回滚**）。随后取消注入失败，直接调 `installer.InstallDownload(ctx,"site","0.2.0")` 验证失败项可单条成功重试。
  - **口径备注（非阻断）**：「单条重试」用例是直接调用 `batchFakeInstaller.InstallDownload`（测试替身的单条安装原语，第 159 行），而非重新走 `batchUpdateOrchestrator.Run` 只重跑失败项——后者对应 U2-C 完整期的单条重试入口，本任务明确不新增对外 API（见 `selfupdate_batch.go` 头注释与 `BatchFailure.Retryable` 字段意图）。该断言证明「取消故障后单条安装路径可用」，足以支撑「失败项可单条重试」的设计主张；若后续要求「编排器级按 id 重试」需另加用例。记为覆盖备注，不判 FAIL。
- `TestBatchIdempotent`：同输入两次 Run，`Summary`/`Phase`/`Items` 顺序一致 → 幂等。
- `TestBatchAuditFailClosed`：审计注入错误 → `errors.Is(err, httpapi.ErrUpgradeAudit)`、`installer.calls` 与 `reloads` 均 0（fail-closed，复用 M2 语义）。
- `TestBatchPlanningError`：`pendingSource` 注入「索引验签失败」→ `err` 含原文、`Phase=failed`、零安装零 reload（规划失败零安装）。
- `TestBatchErrorCodeUsesMarketCodes`：结构化码透传（`E_NOTFOUND`）、M2 哨兵映射（`ErrUpgradeBusy → E_UPGRADE_BUSY`）、未知错误回落 `E_INTERNAL`。

### 3.2 internal/core/market/batch_test.go（7 个用例）

- `TestPendingFromIndexFiltersAndOrders`：未安装跳过、版本一致幂等跳过、其余按依赖序（`want=[echo,site]`）、版本快照透传、`DependsOn` 透传。
- `TestPendingFromIndexIdempotent`：同一输入重复计算 `reflect.DeepEqual(first, second)` → 幂等。
- `TestOrderPendingStableOrder`：拓扑序 `want=[echo,site,waf]`（初始入队 `{echo,waf}` 按 id 升序，echo 出队后 site 解锁并重排 → site 先于 waf）→ 依赖恒先于被依赖者且同层确定。
- `TestPendingFromIndexCycleRejected`：a↔b 循环依赖 → err 含「循环依赖」。
- `TestPendingFromIndexSelfDependencyRejected`：a 依赖自身 → err 含「依赖自身」。两者均经 `protocolError("E_INVALID", ...)`（`verify.go:81` → `pluginapi.Error{Code:E_INVALID}`）落地，符合「环/自依赖 E_INVALID」。
- `TestPendingUpdatesSignedIndex`：ed25519 配对公钥签名的索引可读（`PendingUpdates` → echo 一条，SHA256/URL 透传），篡改正文 → 验签门拒绝、零数据（**PendingUpdates 只读已验签索引**）。
- `TestBuiltinKeyHexStillValid`：内置公钥常量未被误伤（信任根守卫）。

**覆盖面结论**：任务卡要求的 happy path 依赖序、reloadOne 逐条、审计复用 M2、注入失败其余成功且失败项可单条重试且不 reload 失败项、幂等、环/自依赖 E_INVALID、规划失败零安装、审计 fail-closed、结果结构对比——逐项均有显式断言，非「只跑绿」。唯一口径备注见 §3.1（单条重试用例走单条安装替身而非编排器重跑），不构成 FAIL。

## 4. 读码确认（任务卡第 4 项）

- **不新增 schema / 不改 store/install**：`a5e4af8` 仅新增 4 文件（`cmd/kored/selfupdate_batch.go` + `_test.go`、`internal/core/market/batch.go` + `_test.go`，共 754 行），merge `19219c0` 文件集相同；`git show --stat` 无 `store*`/`install*`/`types.go`/`info.json`/索引文件改动。`PendingUpdate`（batch.go:18）是只读投影结构，未改 `Plugin`/`Index`/`InstallJob` 等对外 schema。
- **PendingUpdates 只读已验签索引、不变大小比较**：`batch.go:43` 调 `s.readVerified()`（与 `Install`/`InstallDownload` 共用的强制验签门，market.go:137）；`pendingFromIndex` 为纯函数，注释与实现均明确「不做大小比较：索引是精确版本」，仅按版本相等幂等跳过。
- **逐条调现有单条 InstallDownload**：`selfupdate_batch.go:33-35` 定义 `batchSingleInstaller` 接口，`InstallDownload(ctx,id,version)` 由 `market.Service`（`download.go:34`）实现；编排器 `runOne`(157) 逐条调该接口，不复制下载/校验/落盘逻辑。
- **单条失败继续、不整批回滚**：`runOne` 失败走 `markFailed`（写 `Failures` + 计数），`Run` 的 for 循环继续下一条；代码无撤销/回滚既有成功项的路径（注释亦明确）。
- **结果内嵌 M2 OrchestrationResult，不另起结构**：`BatchItemResult`(44) 内嵌 `OrchestrationResult`（定义在 `selfupdate_orchestrator.go:63`，其 `Job` 为 `httpapi.SelfUpdateJob`），`Phase` 词表、`ErrorCode` 口径、审计出口（`orch.recordStart`）均复用 M2；测试用 `reflect.TypeOf` 双重对比（M3 batch test:113 + M2 `TestOrchestratorSharesM1ResultStructure`:173-175）。
- 交付未新增对外端点（`newBatchUpdateOrchestrator` 注释：装配在 M4 触发链使用）。

## 5. git 顺序 / 主树残留 / worktree（G-25）

```
$ git rev-parse HEAD
002f853ef3a5fdab4561c73db71e4658cf15f81b
$ git log --oneline -4
002f853 [agent:m2-impl] fix(kored): 等待异步升级任务收敛消除结构对比测试 cleanup 竞态
19219c0 [agent:m3-impl] merge: M3 批量更新编排器（wt-m3 → main）
a5e4af8 [agent:m3-impl] feat(kored): ADR-0059 U2=A 批量更新编排器（依赖序逐条安装+失败分诊）
c760c2b [agent:m2-verifier] docs(verify): M2 独立验收 FAIL（cleanup 竞态，覆盖面通过）
$ git merge-base --is-ancestor a5e4af8 19219c0   → exit 0（是祖先）
$ git log -1 --pretty='%P' 19219c0
c760c2b... a5e4af8...   （merge 双亲：主线在前、M3 实现在后，顺序正确）
$ git status --short cmd/kored/ internal/core/market/
（无输出）→ 目标路径无 M3 在途/未跟踪残留（m3-impl 误写主树已迁回，核实为真）
$ git worktree list
/home/pt/Work/GolandProjects/kore-pl/kore  002f853 [main]   （仅主树 1 行）
$ git branch --list 'wt-*' 'tmp-*'
（无输出）→ 无临时分支
```

G-25 通过。

## 6. 收尾

- 临时目录 `.tmp/m3verify-gocache` 用后删除（见最终操作记录）。
- 本报告为唯一写物；精确 `git add .agents/verify/m3-verification.md` + `git commit -s -m "[agent:m3-verifier] docs(verify): M3 独立验收 PASS（...）"`，不 push。
