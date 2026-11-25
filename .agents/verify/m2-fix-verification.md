# M2 修复独立验收报告（cleanup 竞态闭环）

- 修复对象：task-49 / commit `002f853`（`[agent:m2-impl] fix(kored): 等待异步升级任务收敛消除结构对比测试 cleanup 竞态`）
- verifier：`m2-verifier`（原缺陷发现者，独立于 implementer `m2-impl`，满足 G-09）
- 验收时间：2026-11-26（Asia/Shanghai）
- 复跑基准：当前 HEAD `002f853`（其父 `19219c0` 为 M3 merge；主树已有新 merge，按当前 HEAD 复跑）

## 结论

**PASS** —— 原 cleanup 竞态已消除：修复后原复现命令 `-count=8` 与 `-count=12`（单测）连续全绿、exit 0；断言覆盖面不变、core 15 包含 market 全绿、make vet exit 0；修复只改 1 个测试文件（+9 行两处 wait），生产代码与结果结构与 `da2afea` 逐字节一致，M3 依赖的 M2 结构未变。

## 1. 变更面核对（git）

```
$ git log -3 --oneline --decorate
002f853 (HEAD -> main) [agent:m2-impl] fix(kored): 等待异步升级任务收敛消除结构对比测试 cleanup 竞态
19219c0 [agent:m3-impl] merge: M3 批量更新编排器（wt-m3 → main）
a5e4af8 [agent:m3-impl] feat(kored): ADR-0059 U2=A 批量更新编排器（依赖序逐条安装+失败分诊）
```
退出码 0。

```
$ git show --stat --format='%H%n%P%n%s%n%b' 002f853
002f853ef3a5fdab4561c73db71e4658cf15f81b
19219c09d2f1c7386db6110a7724e14fd14f78b8
[agent:m2-impl] fix(kored): 等待异步升级任务收敛消除结构对比测试 cleanup 竞态
Signed-off-by: pengtang1024 <pengtang1024@qq.com>
 cmd/kored/selfupdate_orchestrator_test.go | 9 +++++++++
 1 file changed, 9 insertions(+)
```
退出码 0：**只改 1 个测试文件，+9 行**。

```
$ git diff --stat da2afea HEAD -- cmd/kored/selfupdate_orchestrator.go
(空 = 生产编排代码与 da2afea 逐字节一致)
$ git diff --stat da2afea HEAD -- internal/core/httpapi/
(空 = M1 结果结构所在的 httpapi 包未变)
```
退出码 0。`.agents/verify/m2-verification.md`（前次验收报告）也在 da2afea..HEAD 变更集中，M3 新增 `selfupdate_batch.go` / `market/batch.go` 等，但**生产编排结构与 httpapi 结果结构零改**，M3 依赖的 M2 契约不变。

## 2. 读码确认修复（两条异步 job 都 wait）

`cmd/kored/selfupdate_orchestrator_test.go` 的 `TestOrchestratorSharesM1ResultStructure`：

- 行 140–145：M1 路径 `m1.StartUpgrade(...)` 取得 `m1Job`；
- **行 146–150（新增）**：`if final := waitUpgradeJob(t, m1, m1Job.ID); final.State != jobStateSuccess { t.Fatalf(...) }` —— 等 M1 异步替换链跑完并断言成功；
- 行 157–162：进程内路径 `orch.OrchestrateUpgrade(...)` 取得 `orchRes`；
- **行 163–166（新增）**：`if final := waitOrchestrationPhase(t, orch, orchRes.Job.ID); final.Phase != phaseCommitted { t.Fatalf(...) }` —— 等编排异步链跑完并断言 committed；
- 行 168–176：两个 wait 之后才做 JSON 字段集 / 类型对比（对比对象为已收敛的 job 快照）。

`git show --format='' 002f853 -- cmd/kored/selfupdate_orchestrator_test.go` 显示正好这两处 `+` 块，与缺陷根因（异步 goroutine 与 `t.TempDir()` RemoveAll 竞态）对症。

全量扫描其它异步入口配对：

```
$ grep -rn 'StartUpgrade\|StartRollback\|OrchestrateUpgrade\|OrchestrateRollback' --include='*_test.go' cmd/kored/
... 列出所有启动点 ...
$ grep -rn 'waitUpgradeJob\|waitOrchestrationPhase' --include='*_test.go' cmd/kored/
selfupdate_orchestrator_test.go:86,148,164,297,306
serve_upgrade_test.go:95,159,233,287
```
逐条核对：
- `selfupdate_orchestrator_test.go`：happy path(:76→wait :86)、结构对比 M1(:140→wait :148) / 编排(:157→wait :164)、回滚升级(:291→wait :297) / 回滚(:302→wait :306)，全部配对。
- 未 wait 的调用 `:209/:233/:249`（审计失败/缺 confirm/审计库不可写）都是**同步拒绝路径，不启动异步 job**。
- `serve_upgrade_test.go`：成功路径 `:89→:95`、`:153→:159`、`:227→:233`、HTTP 链 `:275→:287` 均 wait；未 wait 的 `:180/:197/:213` 是审计失败 / sha 不符 / URL 来源拒绝的同步错误路径，不启动异步 job。
- **结论：无其他未 wait 的异步用例。**

## 3. 原复现命令重跑（竞态消除证据）

统一前置：`GOCACHE=/home/pt/Work/GolandProjects/kore-pl/.gocache-m2-fix-verify GOWORK=off`（工作区内临时目录，验收结束已删除）；go `go1.26.8 linux/amd64`。

### 3.1 任务卡指定：`go test -count=8 ./cmd/kored/...`

```
$ GOCACHE=<临时目录> GOWORK=off go test -count=8 -timeout 200s ./cmd/kored/...
ok  	github.com/pengtang1024/kore/cmd/kored	82.487s
=== EXIT_CODE=0 ===
```
连续 8 轮全绿，无 `TempDir RemoveAll cleanup` 失败。

### 3.2 原缺陷单测复现命令（此前 ~17% FAIL）：`-count=12`

```
$ GOCACHE=<临时目录> GOWORK=off go test -count=12 -timeout 200s ./cmd/kored/ -run '^TestOrchestratorSharesM1ResultStructure$'
ok  	github.com/pengtang1024/kore/cmd/kored	0.264s
=== EXIT_CODE=0 ===
```
修复前该命令 `-count=8` exit=1、12 次循环 PASS=10 FAIL=2；修复后 12 次连续全绿 → **竞态已消除**。

## 4. core 全量与 vet

```
$ GOCACHE=<临时目录> GOWORK=off go test -count=1 -timeout 200s ./internal/core/...
ok  	github.com/pengtang1024/kore/internal/core/auth	1.166s
ok  	github.com/pengtang1024/kore/internal/core/bus	1.090s
ok  	github.com/pengtang1024/kore/internal/core/config	0.007s
ok  	github.com/pengtang1024/kore/internal/core/credential	0.006s
ok  	github.com/pengtang1024/kore/internal/core/envprobe	0.002s
ok  	github.com/pengtang1024/kore/internal/core/filewrite	0.086s
ok  	github.com/pengtang1024/kore/internal/core/httpapi	4.836s
ok  	github.com/pengtang1024/kore/internal/core/installer	0.060s
ok  	github.com/pengtang1024/kore/internal/core/market	0.011s
ok  	github.com/pengtang1024/kore/internal/core/metrics	0.204s
ok  	github.com/pengtang1024/kore/internal/core/privilege	2.518s
ok  	github.com/pengtang1024/kore/internal/core/registry	0.008s
ok  	github.com/pengtang1024/kore/internal/core/scheduler	1.066s
ok  	github.com/pengtang1024/kore/internal/core/store	1.180s
ok  	github.com/pengtang1024/kore/internal/core/supervisor	8.841s
=== EXIT_CODE=0 ===
```
15 包全 ok（含 market，M3 新增的 batch 逻辑所在包）。

```
$ GOCACHE=<临时目录> GOWORK=off make vet
[OK] go vet 通过
=== EXIT_CODE=0 ===
```

## 5. 纪律自述

- 只读复跑：未改任何代码，未碰 `.kore-local-*`，未联网、未 push、未执行 CLI（install/serve/upgrade 等）。
- 唯一写入：本报告 `.agents/verify/m2-fix-verification.md`，精确 `git commit -s -- <path>`（`[agent:m2-verifier]`）。
- GOCACHE 临时目录 `/home/pt/Work/GolandProjects/kore-pl/.gocache-m2-fix-verify` 已删除并回读确认不存在。
- 主树他人未提交/未跟踪文件（`scripts/usability-pending.txt`、既有 `.agents/verify/*.md`、`data/`、`dist/` 等）在验收前后 `git status --short` 一致，均未触碰、未提交。
