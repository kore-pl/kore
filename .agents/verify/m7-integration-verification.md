# M7 接线独立验收报告（G-09 / task-81）

- 验收人：`m7-int-verifier`（独立于实现者 `m7-integration`；G-09 角色不兼任）
- 对象：`960821c` `[agent:m7-integration] fix(core/market,docs): 接线安装后旧版本清理 + 配置边界用例`（父 `6564ed2`）
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）
- 复跑时间：2026-11-26 13:31–13:34（Asia/Shanghai，CST +0800）
- 结论：**PASS**（全部验收项成立；1 项如实披露的环境性观察，不影响结论）

## 0. 结论摘要

| 验收项 | 结果 |
| --- | --- |
| 读码核对 8 项接线语义 | PASS（逐项 file:line 证据见 §2） |
| `go test ./cmd/kored/... ./internal/core/config/...`（隔离 GOPROXY=off） | exit 0（2/2 包 ok） |
| 4 条焦点用例 `-v` | 4/4 PASS（断言逐条读过，见 §3） |
| `go vet ./...` / `make vet` | exit 0 / `[OK] go vet 通过`，exit 0 |
| `make docs-check` | exit 0（5 pass / 1 warn / 0 fail；1 WARN 为存量行数越界，不阻断） |
| git：960821c 恰好 5 写域文件、未改 M1-M6 装配语义、worktree 仅主树、他人 dirty 原样 | PASS（见 §5） |
| 纪律：只读复跑、无 push/CLI/运行态写入、临时目录清理 | PASS（见 §6） |

## 1. 环境与联网口径（精确披露）

默认环境（只读探测，未改动默认缓存）：

```
go version go1.26.8 linux/amd64
go env GOCACHE    = /home/pt/.cache/go-build
go env GOMODCACHE = /home/pt/go/pkg/mod
go env GOPROXY    = https://goproxy.cn,direct
默认 modcache：bbolt 仅有 v1.3.11（缺 v1.5.0 zip）；x/sys 缺 v0.45.0 zip
```

按 task-81 已授权口径（沿用 task-77/task-66 先例），仅从 `https://goproxy.cn` 拉缺失构建依赖到**工作区内临时 GOMODCACHE**，并把 GOCACHE 指向工作区内可写目录；测试/门禁阶段一律 `GOPROXY=off` 离线复跑。

| 命令（原文） | exit | 说明 |
| --- | --- | --- |
| `mkdir -p .verify-m7int-tmp/gocache .verify-m7int-tmp/gomodcache` | 0 | 临时目录落工作区（并加入 `.git/info/exclude`） |
| `GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOPROXY=https://goproxy.cn GOFLAGS=-mod=mod go mod download go.etcd.io/bbolt golang.org/x/sys` | 0 | 下载核心缺包 |
| `GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOPROXY=https://goproxy.cn GOFLAGS=-mod=mod go mod download all` | **1** | 仅 cobra/pflag 的 go.mod 校验撞默认 sumdb 只读路径：`open /home/pt/go/pkg/sumdb/sum.golang.org/latest: read-only file system`；与被测包无关，未改 `go.mod`/`go.sum`，如实记录 |

下载后确认临时缓存内 `bbolt v1.5.0.zip`（255081 B）、`x/sys v0.45.0.zip`（2021312 B）、`yaml.v3 v3.0.1.zip`（104623 B）均就位（共 14 个 zip）。

**联网范围**：仅上述两次 `go mod download`，仅走 goproxy.cn；未碰 git 远端、未 push、未执行任何 CLI（kored/upgrade/install/serve）、未碰 `.kore-local-*`。

统一离线环境（后续所有 Go 命令均带）：

```
BASE=/home/pt/Work/GolandProjects/kore-pl/kore/.verify-m7int-tmp
GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOWORK=off GOPROXY=off GOFLAGS=-mod=mod
```

## 2. 读码核对：接线语义（8/8 PASS）

证据均来自 `git show 960821c` 与当前 HEAD 源码。

| 验收点 | 证据（文件:行 / 原文） | 判定 |
| --- | --- | --- |
| ① `startHTTP` 的 `InstallRefresh` 包装为 `installRefreshWithCleanup` | `cmd/kored/serve_boot.go:197`：`InstallRefresh: installRefreshWithCleanup(cfg, svc, svc.reloadOne),`（原 `svc.reloadOne`）；父提交 `:123` 为旧值，diff 仅此一行替换 | PASS |
| ② 仅 reload 成功后触发清理；reload 失败零清理零审计 | `serve_boot.go:124-131`：`result, err := reload(id); if err != nil { return result, err }`（原样上抛，清理前置门不成立）；仅在 err==nil 后调 `cleanupAfterInstall`。测试 `serve_boot_cleanup_test.go:151-166` 验证 `errors.Is(err, wantErr)` + `result==reloadFailed` + `fake.calls==0` + 审计行数 0 | PASS |
| ③ 传 `config.Snapshot.Backup` 的 `KeepCount`/`MaxDiskBytes` | `serve_boot.go:91-92`：`backup := cfg.snapshot.Backup`，`KeepCount: backup.KeepCount`、`MaxDiskBytes: backup.MaxDiskBytes`；测试 `:123-141` 用 keep=10/disk=1GiB 断言逐字段透传 | PASS |
| ④ `CurrentVersion` 取 `installer.PreviousVersion` | `serve_boot.go:93-97`：`current, err := installer.PreviousVersion(svc.db, id)`，失败只 WARN 并把 current 置空（由 market 层按最大版本视为当前，`cleanup.go:36-37`）；`installer/record.go:181-199` 确认该函数只读 plugins bucket 当前版本、未安装返回空串 | PASS |
| ⑤ `Confirmed=true` 代表生效确认 | `serve_boot.go:100`：`Confirmed: true, // reloadOne 成功 = 新版本生效确认`；配合 ② 的门控，`Confirmed=false` 在 market 层短路（`cleanup.go:44-46`） | PASS |
| ⑥ 清理失败只 WARN 不改安装结果 | `serve_boot.go:105-110`：`if err != nil { slog.Warn("安装成功后旧版本清理失败（不影响已完成的安装）", ...); return }`；`installRefreshWithCleanup` 在 cleanup 后仍 `return result, nil`（`:129`），不改写 reload 结果 | PASS |
| ⑦ `CleanupAuditor` detail 映射受控 | `serve_boot.go:66-87`：`cleanupAuditorFromStore.Audit` 把 `ev.Result != "ok"` 归一为 `store.AuditResultError`，`Action: market.CleanupAction`，`Detail: ev.AuditDetail()`；market `cleanup.go:74-105` 的 `AuditDetail()` 显式列 10 键、按 rune 截断（≤16 键/值≤256），无 `any`/`map[string]any`。测试 `:98-116` 断言 detail 的 `keep_count`/`max_disk_bytes`/`deleted`/`reason` 精确值；`TestCleanupAuditorMapsFailureResult` 断言 error 映射落库 | PASS |
| ⑧ `serve_runtime.go` 仅加 1 字段、未改既有自更新装配段 | `git show --format='' 960821c -- cmd/kored/serve_runtime.go`：单 hunk `+marketSvc cleanupService`（`:61` 注释 ADR-0059 §3.5），无其他增删。`serve_boot.go` 中 `CapabilityAuditor`/`RestartService`/`ConfigWriter` 三行与父提交逐字相同（父 `:120-122` → 现 `:194-196`），仅 `InstallRefresh` 一行替换 + `buildMarket` 末尾加 `svc.marketSvc = marketSvc`（`:237-239`），既有自更新装配语义未动 | PASS |

补充：`buildMarket` 把 `market.New(opts)` 的结果同时赋给 `svc.marketSvc`（`:236-239`），使 `cleanupAfterInstall` 拿到真实 service；`cleanupService` 最小接口（`:64-67`）只声明一个方法，符合 G-01/G-02（未给 service 结构引入 market 包的新依赖面）。

## 3. go test + 4 条焦点用例（读断言）

| 命令（原文，离线环境见 §1） | exit | 关键输出 |
| --- | --- | --- |
| `go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/config/...` | **0** | `ok github.com/pengtang1024/kore/cmd/kored 9.584s`；`ok github.com/pengtang1024/kore/internal/core/config 0.007s` |
| `go test -count=1 -timeout 200s -run 'TestInstallRefreshWithCleanup\|TestCleanupAuditorMapsFailureResult' -v ./cmd/kored/... ./internal/core/config/...` | **0** | 4/4 `--- PASS`；config 包 `[no tests to run]`（焦点用例均在 cmd/kored，符合预期） |

4 条焦点用例逐条断言核对（`cmd/kored/serve_boot_cleanup_test.go`）：

1. **`TestInstallRefreshWithCleanupTriggersOnSuccess`**（`:68-117`）— reload 替身返回 `reloadRestarted` → 断言 result/err 未变、reload 恰好 1 次；真实 `market.New(market.Options{})` 清理原语处理 `t.TempDir()` 内 4 版本目录：最旧 `0.1.0` 被删、`0.2.0`/`0.3.0`/`.prev` 保留；`ListAudit` 断言清理审计恰好 1 条、`Subject=kored`/`Target=dir`/`Result=ok`，detail 的 `keep_count=1`、`max_disk_bytes=1048576`、`deleted=0.1.0`、`reason=count` 精确匹配。**覆盖：reload 成功 → 真实清理 + 审计落库**。
2. **`TestInstallRefreshWithCleanupPassesBackupConfig`**（`:120-147`）— 记录型替身断言 `Confirmed=true`、`Actor=kored`、`PluginID=echo`、`KeepCount=10`、`MaxDiskBytes=1<<30`、`Root=filepath.Join(pluginRootDir,"echo")`、`Auditor!=nil`；并真调 `opts.Auditor(...)` 验证审计写入 store（1 条）。**覆盖：配置透传 keep=10/disk=1GiB + 生效确认 + 审计适配真实落库**。
3. **`TestInstallRefreshWithCleanupSkipsOnReloadFailure`**（`:150-166`）— reload 替身返回 `reloadFailed, wantErr` → 断言 `errors.Is(err, wantErr)` 与 result 原样上抛、`fake.calls==0`、审计行数 0。**覆盖：reload 失败零清理零审计**。
4. **`TestCleanupAuditorMapsFailureResult`**（`:169-182`）— `ev.Result="error"` 经 `cleanupAuditorFromStore.Audit` 写入 → 断言 1 条审计且 `rows[0].Result == store.AuditResultError`。**覆盖：error 结果映射**。

`go.mod`/`go.sum` 全程 `git status --porcelain -- go.mod go.sum` 无输出（未改依赖版本）。

## 4. go vet / make docs-check

| 命令（原文） | exit | 关键输出 |
| --- | --- | --- |
| `go vet ./...`（隔离环境） | **0** | 无输出（干净） |
| `make vet`（隔离环境） | **0** | `[OK] go vet 通过` |
| `make docs-check` | **0** | `docs-check: 5 pass, 1 warn, 0 fail`；`结果: 门禁通过（1 WARN 不阻断）` |

`docs-check` 唯一 WARN 为存量 10 份文档行数越界（含 `docs/DATA-MODEL.md:405`，本提交 +10 行后仍越界；判据为 WARN 级不阻断），非本轮引入的新违规；相对链接 1290 条全可达（含本提交新增的 backup.* 配置段，无死链）。

## 5. git 完整性

| 检查项 | 证据 | 判定 |
| --- | --- | --- |
| HEAD / 分支 | `git rev-parse HEAD` = `960821cb54db7f0261ea66a235c8ee05242919dd`；`git branch --show-current` = `main` | PASS |
| 960821c 只含 5 写域文件 | `git show --name-only --format='' 960821c`：`cmd/kored/serve_boot.go`、`cmd/kored/serve_boot_cleanup_test.go`、`cmd/kored/serve_runtime.go`、`docs/DATA-MODEL.md`、`internal/core/config/backup_test.go`（`--stat` = 5 files, +298 -3） | PASS（与 task-76 写域完全一致，无越界） |
| 未碰 M1-M6 既有装配语义 | `serve_boot.go` 的 `CapabilityAuditor`/`RestartService`/`ConfigWriter` 三行逐字未变；无 `coreasset.go`/`upgrade_supply.go`/`batch.go` 等 M3/M6 文件；diff 仅新增清理相关函数与 1 行包装替换（见 §2） | PASS |
| 未碰 M7 实现文件 | 5 文件清单无 `internal/core/market/cleanup.go`/`types.go`（M7 实现写域），仅在装配层调用其公开 API | PASS |
| worktree 仅主树（G-25） | `git worktree list` = 1 行（`/home/pt/.../kore 960821c [main]`）；`git branch --list 'wt-*' 'tmp-*'` 空 | PASS |
| 他人 dirty 原样 | `git status --short` 仅存量：`M scripts/usability-pending.txt` + 8 个 `.agents/verify/*.md`/截图 untracked + `data/` + `dist/`；本轮除本报告外无新增/改动 | PASS |

## 6. 纪律自检与残余观察

- **只读复跑**：除本报告外未改任何代码/配置/文档；未 push、未执行 CLI（install/serve/upgrade/kored）、未 force/reset/rebase、未碰 `.kore-local-*`（`ls` 只读核对 mtime：`.kore-local.yaml` 2026-11-25 20:15、`.kore-local-run` 2026-11-25 21:30、`.kore-local-state` 2026-11-23 20:08，均非本轮时间）。
- **临时目录**：`.verify-m7int-tmp/`（工作区内）在报告提交后 `chmod -R u+w` + `rm -rf` 清理，并同步移除 `.git/info/exclude` 中对应条目；不留垃圾。
- **失败如实记录**：`go mod download all` exit=1（默认 sumdb 只读，与被测包无关，已披露）；无其他失败。
- **残余观察（如实披露，非验收项）**：`cleanupAfterInstall` 在主流程中只在 `InstallRefresh` 回调（插件 reload 成功）路径接线；任务卡描述里的「内核 finalize 成功」路径（`docs/DATA-MODEL.md` 语义）在本次 960821c 的 5 文件 diff 中未见对应调用点。该点超出 task-81 的 8 项读码口径与 4 条焦点用例范围，列为观察供 lead 判断是否另派接线，不计入本次 PASS/FAIL。

---

**独立验收结论：task-81 全部验收项 PASS。** 复跑人 `m7-int-verifier`，2026-11-26 13:34 CST。
