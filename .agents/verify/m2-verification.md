# M2 独立验收报告（G-09 verifier 复跑）

- 验收对象：merge commit `36c5801` / 实现 commit `da2afea`（ADR-0058 §3.2 进程内更新编排服务）
- verifier：`m2-verifier`（独立于 implementer `m2-impl`，满足 G-09）
- 验收时间：2026-11-26（Asia/Shanghai）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）
- 复跑基准：当前 HEAD `36c5801`（读码与测试均针对此 HEAD；`da2afea` 的两个文件与 merge 结果逐字节一致）

## 结论

**FAIL**（go test 门禁不稳定：首次冷缓存复跑 exit=1，实测新引入测试存在约 17% 概率的 cleanup 竞态；断言覆盖面与其余门禁均通过。失败如实记录，未改代码。）

## 1. git 顺序与 worktree 卫生（G-25）

命令与关键输出：

```
$ git log --oneline --graph -8
*   36c5801 (HEAD -> main) [agent:m2-impl] merge: M2 进程内更新编排服务（wt-m2 → main）
|\
| * da2afea [agent:m2-impl] feat(kored): ADR-0058 §3.2 进程内更新编排服务（B）
* | 08ca76c [agent:m1-verifier] docs(verify): M1 独立验收 PASS（commit 2f56c2a）
|/
* 2f56c2a [agent:m1-impl] feat(httpapi): ADR-0058 UDS-only 专用自更新端点
```
退出码 0。

```
$ git log -1 --format='%H%n%P%n%s' 36c5801
36c58011d5f6aa98092a3a0250239063077b00fe
08ca76ca5360f04d0b3c047a1889af1a63783923 da2afea0dc9b9271ed8e2709132e00d3999daceb
[agent:m2-impl] merge: M2 进程内更新编排服务（wt-m2 → main）
$ git log -1 --format='%H%n%P%n%s' da2afea
da2afea0dc9b9271ed8e2709132e00d3999daceb
2f56c2ac59b0bbfe8e64d998814f3757056f7f26
[agent:m2-impl] feat(kored): ADR-0058 §3.2 进程内更新编排服务（B）
```
退出码 0。顺序符合预期：`2f56c2a`(M1) → `da2afea`(M2，父=2f56c2a) → merge `36c5801`（父=08ca76c + da2afea）。

```
$ git worktree list
/home/pt/Work/GolandProjects/kore-pl/kore 36c5801 [main]
$ git for-each-ref --format='%(refname)' refs/heads refs/remotes | grep -i 'wt-'
(no wt-* refs found)
```
退出码 0。只有主工作树，无 `wt-*` 分支/引用 → G-25 通过。

merge 变更面（相对第一父）：

```
$ git diff --stat 08ca76c 36c5801
 cmd/kored/selfupdate_orchestrator.go      | 221 ++++++++++++++++++++++++++
 cmd/kored/selfupdate_orchestrator_test.go | 301 ++++++++++++++++++++++++++
 2 files changed, 522 insertions(+)
$ git diff --stat da2afea 36c5801 -- cmd/kored/selfupdate_orchestrator.go cmd/kored/selfupdate_orchestrator_test.go
(空 = 两文件与实现提交逐字节一致)
```

## 2. 边界读码核对（G-01/G-13 + 复用性）

`cmd/kored/selfupdate_orchestrator.go`（221 行）逐行核对结论：

- 只 import `context/errors/fmt/strings` + `internal/core/httpapi` + `internal/core/store`（第 15–23 行）；**不 import `plugins/**`、不 import 任何 `kore-plugin-*` 仓**。
- 不重复实现校验/原子替换/重启提交：`updater httpapi.SelfUpdater`（第 79 行）只委托 `StartUpgrade`/`StartRollback`/`UpgradeJob`；替换与重启提交由共享 `selfUpdater`（`serve_upgrade.go`）完成（第 76–79 行注释与第 104/135/158 行调用）。
- 结果结构不另起第二套：`OrchestrationResult.Job` 直接内嵌 `httpapi.SelfUpdateJob`（第 63–72 行）；错误码用 `errors.Is` 复用 M1 哨兵 `httpapi.ErrUpgrade*`（第 204–221 行）；审计用同一 `httpapi.SelfUpdateAuditRecorder` + `httpapi.AuditEvent`（第 80–82、185–200 行）。
- 审计 fail-closed：`recordStart` 在 `StartUpgrade` 之前调用（第 100/131 行），写不进则直接返回 `httpapi.ErrUpgradeAudit`，不执行更新。
- 不碰运行态（G-29）：无 `.kore-local-*` 读写、无 install/serve/upgrade 动作、无 HTTP/UDS 自连接。

grep 核对：

```
$ grep -rn '"kore/plugins/' internal/core
(零命中；grep exit=1)
$ grep -rn 'kore-plugin' --include='*.go' internal/ cmd/ | grep -i 'import\|"github'
(none)
$ grep -n 'kore/plugins\|kore-plugin' cmd/kored/selfupdate_orchestrator.go
(none in orchestrator)
```
退出码符合零命中预期。`plugins/` 宽 grep 的命中均为既有 URL 路由、state 路径与注释，非插件仓库 import → G-01/G-13 通过。

## 3. 断言覆盖面核对（7 个测试，逐条读码）

文件：`cmd/kored/selfupdate_orchestrator_test.go`（301 行，由 `da2afea` 新增）。

| # | 测试 | 任务卡要求维度 | 实际断言 | 覆盖 |
| --- | --- | --- | --- | --- |
| 1 | `TestOrchestratorHappyPathCommitted` | happy path `phase=committed` | `phaseVerified` 受理 → `waitOrchestrationPhase` 等终态 → `final.Phase==phaseCommitted`、`Job.State==success`、`ExitCode==exitOK`；并断言二进制已替换、`.prev` 保留、pending 标记落盘、重启 unit 提交、编排审计 1 条 + updater 审计 start/result 2 条（行 60–128） | ✅ 真断言 |
| 2 | `TestOrchestratorSharesM1ResultStructure` | 与 M1 结果结构对比 | M1 直调 `StartUpgrade` 与编排入口分别取 `jsonFieldSet`，`reflect.DeepEqual` 比对 JSON 字段集 + `reflect.TypeOf` 比对类型（行 132–168） | ✅ 真断言（但见 §4 flake） |
| 3 | `TestOrchestratorAuditFailClosed` | 审计 fail-closed（写失败不执行） | 注入 `Record` 返回错误 → `errors.Is(err, httpapi.ErrUpgradeAudit)`、无任务产生、目标文件仍为 `old-binary`（行 190–214） | ✅ 真断言 |
| 4 | `TestOrchestratorUnwiredAuditRejects` | （额外）审计出口未装配 | `audit=nil` 时同样回 `ErrUpgradeAudit`（行 217–230） | ✅ 加分项 |
| 5 | `TestOrchestratorRequiresConfirm` | confirm 必填 | `Confirm:false` → `errors.Is(err, orchestrationErrNoConfirm)` 且文案含 `confirm=true`，且不写审计（行 233–249） | ✅ 真断言 |
| 6 | `TestOrchestrationErrorCodeSharesM1Sentinels` | 错误码映射 | 7 组表驱动：`SOURCE/CHECKSUM/NEED_ROOT/BUSY/AUDIT/RESTART/内部默认 E_INTERNAL`，全部复用 M1 哨兵（行 252–270） | ✅ 真断言 |
| 7 | `TestOrchestratorRollbackPhase` | 回滚 `phase=rolled_back` | 先升级到 committed 产生 `.prev`，再 `OrchestrateRollback` → `waitOrchestrationPhase` → `final.Phase==phaseRolledBack`（行 273–301） | ✅ 真断言 |

**覆盖面结论：任务卡要求的 6 个维度全部被真实断言覆盖，不是"只绿不断言"；另有 1 条额外审计未装配拒绝测试。覆盖面本身 PASS。**

## 4. go test 复跑（关键失败如实报告）

统一前置：`GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.gocache-m2-verify GOWORK=off`（临时目录在工作区内，验收结束已删除）。go 版本 `go1.26.8 linux/amd64`。

### 运行 1：冷缓存，完整验收范围 → FAIL（exit=1）

```
$ GOCACHE=<临时目录> GOWORK=off go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/...
--- FAIL: TestOrchestratorSharesM1ResultStructure (0.00s)
    testing.go:1464: TempDir RemoveAll cleanup: unlinkat /tmp/TestOrchestratorSharesM1ResultStructure3174087826/002: directory not empty
FAIL
FAIL	github.com/pengtang1024/kore/cmd/kored	10.245s
ok  	github.com/pengtang1024/kore/internal/core/auth	1.167s
ok  	github.com/pengtang1024/kore/internal/core/bus	1.091s
ok  	github.com/pengtang1024/kore/internal/core/config	0.010s
ok  	github.com/pengtang1024/kore/internal/core/credential	0.005s
ok  	github.com/pengtang1024/kore/internal/core/envprobe	0.002s
ok  	github.com/pengtang1024/kore/internal/core/filewrite	0.086s
ok  	github.com/pengtang1024/kore/internal/core/httpapi	4.834s
ok  	github.com/pengtang1024/kore/internal/core/installer	0.043s
ok  	github.com/pengtang1024/kore/internal/core/market	0.007s
ok  	github.com/pengtang1024/kore/internal/core/metrics	0.203s
ok  	github.com/pengtang1024/kore/internal/core/privilege	2.519s
ok  	github.com/pengtang1024/kore/internal/core/registry	0.006s
ok  	github.com/pengtang1024/kore/internal/core/scheduler	1.062s
ok  	github.com/pengtang1024/kore/internal/core/store	1.141s
ok  	github.com/pengtang1024/kore/internal/core/supervisor	8.822s
FAIL
=== EXIT_CODE=1 ===
```

失败发生在 `TestOrchestratorSharesM1ResultStructure` 的 **t.TempDir() teardown cleanup**（`RemoveAll: directory not empty`），**不是断言失败**：本次运行中 7 个编排测试的断言均无失败输出。

### 运行 2：同命令第二次（热缓存）→ PASS（exit=0）

```
$ GOCACHE=<临时目录> GOWORK=off go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/...
ok  	github.com/pengtang1024/kore/cmd/kored	10.149s
ok  	github.com/pengtang1024/kore/internal/core/{auth,bus,config,credential,envprobe,filewrite,httpapi,installer,market,metrics,privilege,registry,scheduler,store,supervisor}  （全部 ok）
=== EXIT_CODE=0 ===
```

### 竞态可复现性与根因

```
$ GOCACHE=<临时目录> GOWORK=off go test -count=8 -timeout 200s ./cmd/kored/ -run '^TestOrchestratorSharesM1ResultStructure$'
--- FAIL: TestOrchestratorSharesM1ResultStructure (0.00s)
    testing.go:1464: TempDir RemoveAll cleanup: unlinkat /tmp/TestOrchestratorSharesM1ResultStructure3204863513/001: directory not empty
FAIL	github.com/pengtang1024/kore/cmd/kored	0.007s
=== EXIT_CODE=1 ===
```

```
$ for i in $(seq 1 12); do go test -count=1 ./cmd/kored/ -run '^TestOrchestratorSharesM1ResultStructure$'; done
PASS=10 FAIL=2 (total 12)   # 约 17% 概率失败
```

根因（读码）：`TestOrchestratorSharesM1ResultStructure`（行 132–168）调用 `m1.StartUpgrade` 与 `orch.OrchestrateUpgrade` 后**未等待异步任务结束就返回**（缺少 `waitUpgradeJob` / `waitOrchestrationPhase`），异步 goroutine 继续写 `stateDir` 等文件，与 `t.TempDir()` 的 `RemoveAll` cleanup 竞态。对比：happy path（行 86）与 rollback（行 288/297）测试都显式调用了 `waitOrchestrationPhase`，因此稳定。该缺陷由 `da2afea` 随测试文件一并引入。

影响：`go test -count=1 ./cmd/kored/...` 门禁**非稳定通过**（实测 exit 1 与 exit 0 均出现），不满足任务卡"exit 0"的确定性要求。回派 `m2-impl` 修复建议：在 `TestOrchestratorSharesM1ResultStructure` 返回前对两个 job 调用 `waitUpgradeJob(t, m1, m1Job.ID)` 与 `waitOrchestrationPhase(t, orch, orchRes.Job.ID)`，待异步写入结束后再退出，使 cleanup 无竞态。

## 5. make vet（PASS）

```
$ GOCACHE=<临时目录> GOWORK=off make vet
[OK] go vet 通过
=== EXIT_CODE=0 ===
```

## 6. 纪律自述

- 只读复跑：未改任何代码，未碰 `.kore-local-*`；未执行 install/serve/upgrade；未联网；未 push。
- 唯一写入：本报告 `.agents/verify/m2-verification.md`；精确 `git add` + `git commit -s ... [agent:m2-verifier]`。
- GOCACHE 临时目录 `/home/pt/Work/GolandProjects/kore-pl/.gocache-m2-verify` 与 `/tmp/orch-run-*.log` 均已在验收结束删除并回读确认不存在。
- 主树存在他人未提交/未跟踪文件（`scripts/usability-pending.txt`、多个 `.agents/verify/*.md`、`data/`、`dist/` 等），本轮一律未触碰、未提交。
