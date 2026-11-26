# 内核 finalize 清理接线独立验收报告（G-09 / task-87）

- 验收人：`kernel-cleanup-verifier`（独立于实现者 `kernel-cleanup`；G-09 角色不兼任）
- 对象：`cdcf3cf` `[agent:kernel-cleanup] fix(cmd/kored): 内核 finalize 成功路径接入旧版本清理`（父 `4c7bfb52`）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）
- 复跑时间：2026-11-26 14:17–14:22（Asia/Shanghai，CST +0800）
- 结论：**PASS**（全部验收项成立；环境性依赖下载按授权精确披露，不影响结论）

## 0. 结论摘要

| 验收项 | 结果 |
| --- | --- |
| 读码核对架构与语义（成功清理 / 失败 WARN / 三路零清理短路 / coreconfig.Load 同源 / 短开 state.db + closeStore / 复用 M7 / 未改装配文件） | PASS（逐项 file:line 证据见 §2） |
| `go test -count=1 -timeout 200s ./cmd/kored/...`（隔离 GOPROXY=off） | exit 0（`ok .../cmd/kored 9.151s`） |
| `-run 'TestFinalize' -v` | 10/10 PASS（断言逐条读过，见 §3） |
| `go vet ./cmd/kored/...` / `make vet` | exit 0 / `[OK] go vet 通过`，exit 0 |
| `gofmt -l`（2 写域文件） | 输出空（无未格式化） |
| G-24（`map[string]any`/`json.RawMessage`）/ G-01（`kore/plugins/` import） | 双零命中 |
| git：cdcf3cf 恰好 2 写域文件、未碰装配文件与他人 dirty、worktree 仅主树、无临时分支 | PASS（见 §5） |
| 纪律：只读复跑、无 push/CLI/运行态写入、临时目录清理 | PASS（见 §6） |

## 1. 环境与联网口径（精确披露）

默认环境（只读探测，未改动默认缓存）：

```
go version go1.26.8 linux/amd64
go env GOCACHE    = /home/pt/.cache/go-build
go env GOMODCACHE = /home/pt/go/pkg/mod
go env GOPROXY    = https://goproxy.cn,direct
默认 modcache 缺：go.etcd.io/bbolt v1.5.0、golang.org/x/sys v0.45.0（yaml.v3 v3.0.1 已在）；
工作区 .tmp/gomodcache 只有旧版 bbolt v1.3.11 / x/sys v0.4.0，不满足 go.mod。
```

按 task-87 已授权口径（沿用 task-77/task-81/task-66 先例），仅从 `https://goproxy.cn` 拉缺失构建依赖到**工作区内临时 GOMODCACHE**，GOCACHE 指向工作区内可写目录；所有测试/门禁阶段一律 `GOPROXY=off` 离线复跑。临时目录 `.tmp/verify-87/` 命中既有 `.gitignore`（`git check-ignore .tmp/verify-87` → 命中，输出该路径），不污染 git 状态。

| 命令（原文） | exit | 说明 |
| --- | --- | --- |
| `mkdir -p .tmp/verify-87/gocache .tmp/verify-87/gomodcache` | 0 | 建工作区内隔离缓存 |
| `GOWORK=off GOPROXY=https://goproxy.cn,direct GOCACHE=<abs>/.tmp/verify-87/gocache GOMODCACHE=<abs>/.tmp/verify-87/gomodcache go mod download` | **1** | 首次误用相对 GOMODCACHE 路径，Go 报 `GOMODCACHE entry is relative; must be absolute path`；未联网到上游，无副作用，改参数重跑 |
| `GOWORK=off GOPROXY=https://goproxy.cn,direct GOCACHE=<abs>/.tmp/verify-87/gocache GOMODCACHE=<abs>/.tmp/verify-87/gomodcache go mod download` | 0 | 绝对路径重试成功；下载到 bbolt v1.5.0 / x/sys v0.45.0 / yaml.v3 v3.0.1 |
| 校验三版本目录均 `PRESENT` | — | bbolt@v1.5.0、x/sys@v0.45.0、yaml.v3@v3.0.1 全在隔离 cache |

说明：除上述 go proxy 下载外**全程无联网**；`go.mod` / `go.sum` 未被改动（`git status --short` 无这两项）。

## 2. 读码核对：架构与语义（file:line 证据）

| # | 验收点 | 证据 | 判定 |
| --- | --- | --- | --- |
| 1 | finalize 成功写标记后调 `deps.finalizeClean(stateDir)` | `cmd/kored/upgrade.go:431-439` 写 success 成功→打印 INFO→`:445-449` 调 `finalizeClean` | PASS |
| 2 | 清理失败只 WARN 不改升级结论 | `upgrade.go:446-448`：`err != nil` 仅 `fmt.Fprintf(w,"[WARN] ...清理不可用")`，无返回码/状态改写；`finalizePendingUpgrade` 无返回值（`:405`），签名决定其无法改判升级结果 | PASS |
| 3 | 已 success → 零清理 | `upgrade.go:415-417` `if marker.State == upgradeStateSuccess { return }` 原短路保留，在清理调用点之前 | PASS |
| 4 | sha 不符 → 零清理 | `upgrade.go:425-429` sha 不等 `ExpectedSHA256` → WARN + return，短路在清理前 | PASS |
| 5 | 无标记 / 读失败 / stateDir 解析失败 → 零清理 | `upgrade.go:406-414` 三处 return 均在清理调用之前 | PASS |
| 6 | 生产实现用 `coreconfig.Load`（与 `resolveUpgradeStateDir` 同源） | `upgrade.go:135-141` `coreconfig.Load(coreconfig.Options{StateDir: stateDir, ...})`；对照 `:701-705` `resolveUpgradeStateDir` 同样 `coreconfig.Load(...Options{StateDir:...})`，同源口径一致，含 `backup.*` | PASS |
| 7 | 短开 state.db + `market.New` + 返回前 `closeStore` 释放 bbolt 锁供 runServe | `upgrade.go:144` `market.New(market.Options{Logger: slog.Default()})`；`:154` `store.Open(stateDir, ...)`；`:158` `defer closeStore(db)`（closeStore 定义 `serve_boot.go:429-434`，`db.Close()` 释放独占锁）；调用时序：`cmd/kored/main.go:74` finalize 在 `:75` `runServe` 之前 | PASS |
| 8 | 复用 M7 `cleanupAfterInstall`，无第二套清理逻辑 | `upgrade.go:172` 在 `for _, ref := range refs` 内直接调 `cleanupAfterInstall(cfg, svc, ref.ID)`（函数定义 `serve_boot.go:94-121`）；backup 透传（`:98-109` KeepCount/MaxDiskBytes）、`Confirmed=true`（`:110`）、`Actor="kored"`（`:111`）、`CleanupAuditor`→`store.PutAudit`（`:112` + `cleanupAuditorFromStore` `:69-88`）、失败只 WARN（`:114-117`）全部复用同一原语；新增代码仅为装配调用，无删版本/审计的重复实现（G-01/G-02） | PASS |
| 9 | 未改 `serve_runtime.go` / `serve_boot.go` / `main.go` | `git diff-tree --no-commit-id --name-only -r cdcf3cf` = 仅 `cmd/kored/upgrade.go`、`cmd/kored/upgrade_cleanup_test.go`；`git diff --name-only cdcf3cf^ cdcf3cf \| grep -E 'serve_runtime.go\|serve_boot.go\|main.go'` → 无命中 | PASS |
| 10 | G-24 显式类型 | 新增 `finalizeCleanup func(string) error`（`:99`）、`finalizeCleanupWith(stateDir string, snap *coreconfig.Snapshot, marketSvc cleanupService)`（`:150`），无 `any` / `map[string]any` / `json.RawMessage` 逃逸 | PASS |

补充：`finalizeClean` 设计为可空（`upgrade.go:109-110` 注释 + `:445` nil 检查），nil 只闭环标记不清理，绝不阻断启动；实现者满足"非阻塞"约束。

## 3. 测试复跑与断言覆盖（非只看绿）

命令（隔离，`GOPROXY=off`）：

```
GOWORK=off GOPROXY=off GOCACHE=<abs>/.tmp/verify-87/gocache GOMODCACHE=<abs>/.tmp/verify-87/gomodcache \
  go test -count=1 -timeout 200s ./cmd/kored/...
→ ok github.com/pengtang1024/kore/cmd/kored 9.151s   EXIT=0

GOWORK=off GOPROXY=off GOCACHE=<abs>/.tmp/verify-87/gocache GOMODCACHE=<abs>/.tmp/verify-87/gomodcache \
  go test -count=1 -timeout 200s -run 'TestFinalize' -v ./cmd/kored/...
→ PASS  10/10   EXIT=0
```

10 条（9 条新增于 `upgrade_cleanup_test.go`，1 条既有 `upgrade_test.go:296`）：

| 用例 | 断言覆盖（读源码逐条核对） |
| --- | --- |
| `TestFinalizeSuccessTriggersCleanup` (:101) | 标记闭环 success、清理恰好 1 次且 stateDir 匹配、成功输出含"升级已生效" |
| `TestFinalizeCleanupFailureOnlyWarns` (:121) | 清理失败→标记仍 success、仍调 1 次、输出含 `[WARN]`+错误原因且保留成功结论 |
| `TestFinalizeAlreadySuccessZeroCleanup` (:141) | 已 success→零清理 |
| `TestFinalizeShaMismatchZeroCleanup` (:157) | 篡改二进制→标记仍 pending、零清理、留 WARN |
| `TestFinalizeMissingMarkerZeroCleanup` (:176) | 无标记→零清理 |
| `TestFinalizeCleanupWithPassesConfigAndAudit` (:254) | keep=10/disk=1GiB 透传、`Confirmed=true`、`Actor="kored"`、Auditor 非空、每插件 1 次（echo/site 共 2）、返回后重开 state.db 回读 audit bucket 落 2 条 |
| `TestFinalizeCleanupWithRealPrimitiveDeletesAndAudits` (:292) | 真实 `market.New` 原语：keep=1 时最旧 `0.1.0` 被删、`0.2.0`/`0.3.0`/`.prev` 保留、审计恰 1 条且 detail 的 `keep_count=1`/`max_disk_bytes=1048576`/`deleted=0.1.0` |
| `TestFinalizeCleanupWithCleanupErrorOnlyWarns` (:329) | 替身报错→`finalizeCleanupWith` 不上抛、审计仍落 `result=error` |
| `TestFinalizeCleanupWithReleasesStoreLock` (:355) | 返回后再次 `store.Open` 成功（bbolt 独占锁已释放，runServe 可再开） |
| `TestFinalizePendingUpgradeByNewProcess`（既有，`upgrade_test.go:296`） | 新进程闭环标记路径未回归 |

测试全程 `t.TempDir()` 隔离 + 替身，未执行真实 upgrade/install/serve、未开主实例 state.db、未联网、未碰 `.kore-local-*`。

## 4. 静态门禁

| 命令（隔离 GOPROXY=off） | exit | 关键输出 |
| --- | --- | --- |
| `go vet ./cmd/kored/...` | 0 | 无输出 |
| `make vet`（含 `web-dist` 前置） | 0 | `[OK] go vet 通过` |
| `gofmt -l cmd/kored/upgrade.go cmd/kored/upgrade_cleanup_test.go` | 0 | 输出为空 |
| `grep -n 'map\[string\]any\|json.RawMessage' cmd/kored/upgrade.go` | 1（零命中） | G-24 通过 |
| `grep -rn '"kore/plugins/' internal/core/` | 1（零命中） | G-01 通过 |

（G-24/G-01 的 grep exit=1 即"无匹配"，为期望结果。）

## 5. git 核对

```
git diff-tree --no-commit-id --name-only -r cdcf3cf
→ cmd/kored/upgrade.go
  cmd/kored/upgrade_cleanup_test.go          （恰好 2 写域文件）
git log -1 --format='%H%n%P%n%G? %GS' cdcf3cf
→ cdcf3cf66739db8510d65b2276d5ebe03c171f4a
  4c7bfb52fafb72bdf1805e6e4697743a854a3e33
  N                                           （提交未签名；任务卡未要求签名校验，如实记录）
git diff --name-only cdcf3cf^ cdcf3cf | grep -E 'serve_runtime.go|serve_boot.go|main.go'
→ 无命中                                      （装配层未改）
git worktree list
→ /home/pt/Work/GolandProjects/kore-pl/kore cdcf3cf [main]   （仅主树，G-25）
git branch --list 'wt-*' 'tmp-*' → 空           （无临时分支）
```

他人 dirty（`git status --short`）复跑前后一致，本轮无新增残留（临时目录被 `.gitignore` 忽略；本报告文件是本轮唯一新增可追踪文件）：

```
 M scripts/usability-pending.txt
?? .agents/verify/e2e-*.md 等其他 .agents/verify/*.md（9 条）
?? .agents/verify/screenshots/adp-debug-desktop-01.png
?? data/
?? dist/
```

## 6. 纪律自检

- 只读复跑：未改生产代码、未改配置、未 `git add`/`commit` 任何生产文件；唯一可写为报告本身。
- 未 push、未执行 `kored` CLI、未执行真实 upgrade/install/serve、未碰 `.kore-local-*`（含运行态配置/state/run/bin）。
- 联网仅限已授权的 go proxy 依赖下载（§1 精确披露）；测试阶段 `GOPROXY=off`。
- 隔离缓存 `.tmp/verify-87/` 用完删除（含 gocache/gomodcache/testfinalize.log）。
- 复跑前后 `git status --short` 一致（除本报告），无临时 worktree / 分支。

## 7. 最终判定

**PASS**。内核 finalize 清理接线与任务卡语义一致；隔离环境全量测试 + 10/10 焦点用例 + 全部静态门禁 + git 范围核对均成立。无失败项、无伪报。
