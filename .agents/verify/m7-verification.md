# M7 独立验收报告（G-09 / task-77）

- 验收人：`m7-verifier`（独立于实现者 `m7-impl`）
- 对象：实现 `83a42ae` `[agent:m7-impl] feat(core/market,config): 备份份数/磁盘上限配置 + stale 自动清理`；合并 `f9c979e` `[agent:m7-impl] merge: M7 备份清理（wt-m7 → main）`
- 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根）
- 复跑时间：2026-11-26（Asia/Shanghai）
- 结论：**PASS（带 2 项如实记录的残余观察，不影响 task-77 验收项成立）**

## 1. 环境口径（精确披露）

默认环境只读、缺包（已核对，未改动默认缓存）：

```
go version go1.26.8 linux/amd64
go env GOCACHE   = /home/pt/.cache/go-build
go env GOMODCACHE= /home/pt/go/pkg/mod
go env GOPROXY   = https://goproxy.cn,direct
默认 modcache：go.etcd.io/bbolt/@v/v1.5.0 只有 .info/.mod（无 .zip）；golang.org/x/sys/@v/v0.45.0 无 .zip
```

按 task-77 授权先例（task-66），选用「goproxy.cn 拉缺失构建依赖到工作区临时 GOMODCACHE」口径：工作区内建 `.verify-m7-tmp/gocache` + `.verify-m7-tmp/gomodcache`，**只在临时 GOMODCACHE 内下载**，GOCACHE 指向工作区内可写目录；测试/门禁阶段 `GOPROXY=off` 离线复跑。

| 命令（原文） | exit |
| --- | --- |
| `GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOPROXY=https://goproxy.cn GOFLAGS=-mod=mod go mod download go.etcd.io/bbolt golang.org/x/sys` | 0 |
| `GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOPROXY=https://goproxy.cn GOFLAGS=-mod=mod go mod download all` | 1（仅 cobra/pflag 走默认 sumdb 只读路径报 `open /home/pt/go/pkg/sumdb/sum.golang.org/latest: read-only file system`；与 market/config 依赖无关，未影响后续测试；未改 `go.mod`/`go.sum`） |

`go.mod` / `go.sum` 全程 `git status --porcelain -- go.mod go.sum` 无输出（未改）。下载后确认临时缓存内 `bbolt v1.5.0.zip`（255081 B）与 `x/sys v0.45.0.zip`（2021312 B）就位。

**联网范围**：仅上述两次 `go mod download`，仅走 `https://goproxy.cn`；未碰 git 远端、未 push、未执行 CLI（kored/upgrade/install/serve）、未碰 `.kore-local-*`。

## 2. go test（market + config）

| 命令（原文） | exit | 关键输出 |
| --- | --- | --- |
| `GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOPROXY=off GOFLAGS=-mod=mod go test -count=1 -timeout 200s ./internal/core/market/... ./internal/core/config/...` | **0** | `ok github.com/pengtang1024/kore/internal/core/market 0.012s`；`ok github.com/pengtang1024/kore/internal/core/config 0.010s` |

首次仅下载 bbolt+x/sys 后离线跑曾因缺 `gopkg.in/yaml.v3` 失败（`FAIL ... config [setup failed]` / `module lookup disabled by GOPROXY=off`）；补下全仓依赖后重跑全绿（如实记录中间失败一次）。

verbose 复核（`-v`）逐条 PASS：market 新增 10 个用例、config 新增 6 个 `TestBackup*` 用例全部通过，无 FAIL。

### 断言覆盖面逐项核对（读码，不只看绿）

| 要求 | 证据（文件:行） | 覆盖 |
| --- | --- | --- |
| 装 4 旧版 keep=2 → 恰好 2 份 + `.prev` 保留 | `internal/core/market/cleanup_test.go:56-107`：建 0.1–0.4 + `.prev` + `.bak-*`，断言 Kept=`[0.3.0,0.4.0]`、Deleted=`[0.1.0,0.2.0]`、旧目录消失、`.prev`/`.bak` 仍存在 | ✅ |
| max_disk_bytes 超限触发删除 | `cleanup_test.go:110-137`：3×300B / 上限 650 → 删 1.0.0、保留 1.1/1.2、Reason=`disk`、不误标 OverBudget | ✅ |
| 审计删除清单 | `cleanup_test.go:90-106`：审计事件数=1、Actor/PluginID/KeepCount、`ev.Deleted` 精确、`AuditDetail()["deleted"]` 含两项、detail 键数 ≤16；`cleanup.go:76-93` `AuditDetail()` 映射 deleted/deleted_count 等受控字段 | ✅ |
| 保底当前+最新回滚（因保底导致超限 OverBudget） | `cleanup_test.go:140-162`：keep=0 + 上限 1 字节 → 2.1.0/2.2.0 保留、OverBudget=true；实现 `cleanup.go:152-157`（保底 2）、`343-365`（protectedVersions）、`187-224`（磁盘段不删受保护+OverBudget） | ✅ |
| 未确认短路 | `cleanup_test.go:182-207`：Confirmed=false → Skipped + `new_version_unconfirmed`、三目录全在、不写审计；实现 `cleanup.go:137-142` | ✅ |
| 审计失败不回滚 | `cleanup_test.go:210-230`：Auditor 返回 error → error 含「审计写入失败」、5.0.0 已删不回滚、Deleted 清单仍为 1 项；实现 `cleanup.go:389-397` 仅 WARN+返回 error | ✅ |
| 临时目录免删 | `cleanup_test.go:233-257`：`.staging`/`.prev`/`backup`/`.bak-123`/`v6.3.0` 全保留，只删 6.0.0；实现 `cleanup.go:27` 严格三段数字正则 + `263-304` 只扫直接子目录、排除符号链接 | ✅ |
| 配置默认值 keep=2 / disk=256MiB | `backup_test.go:11-28`：`Default()` 与缺文件场景均断言 2 / 268435456；实现 `config/types.go:123-126,216` | ✅ |
| 覆盖 | `backup_test.go:31-55`：显式 keep=5/disk=805306368 覆盖；只写 keep=3 时 disk 保留默认；实现 `config/parse_nested.go:133-151` 只覆盖显式键 | ✅ |
| 校验 keep 1–10 / disk 1MiB–1GiB | 拒绝侧 `backup_test.go:58-79`：keep=0 / keep=11 / disk=100 / 字符串 `"256MB"` 均被拒并指名字段；实现 `config/validate.go:162-177`（`1–10`、`1<<20 – 1<<30`）；`config/scalar.go:47-58` int64 类型校验 | ✅（拒绝侧） |
| 冷字段 | `backup_test.go:82-108`：Reload 改 keep=2→4 后仍为 2，且 WARN 含「不可热更」；实现 `config/reload.go:176-182` 列入冷字段索引 | ✅ |
| 审计 detail UTF-8 截断 | `cleanup_test.go:283-297`：100 个中文 Actor + 400 字符 Root → 全部值 ≤256 rune、`actor` 带 `...`；实现 `cleanup.go:95-105` 按 rune 截断 | ✅（额外） |
| Service 入口 | `cleanup_test.go:260-280`：`svc.CleanupAfterInstall` 补 logger 后同原语行为一致；实现 `cleanup.go:244-249` | ✅（额外） |

**残余观察 1（如实披露，非 task-77 验收项）**：
- 校验的「接受侧」边界（keep=1/10、disk=1MiB/1GiB 恰好通过）无专门用例；现有用例只覆盖拒绝侧。`validate.go` 判据本身正确（`<1 || >10`、`<1MiB || >1GiB`），属覆盖面缩水而非逻辑缺陷。
- `CleanupStaleVersions` / `CleanupAfterInstall` 在当前 HEAD 只有测试调用（`grep` 全仓非测试文件仅命中定义处），即 M7 交付的是圈闭原语 + 配置面，装配层（install/reload 成功后）尚未接线；与 `cleanup.go:5-8` 自述「由装配层在生效确认后调用」一致，属后续里程碑接线项，不计入本次 task-77 验收项。

## 3. make vet / make budget-check

| 命令（原文） | exit | 关键输出 |
| --- | --- | --- |
| `GOCACHE="$BASE/gocache" GOMODCACHE="$BASE/gomodcache" GOPROXY=off GOFLAGS=-mod=mod make vet` | **0** | `[OK] go vet 通过` |
| `make budget-check` | **0** | `budget-check: 1 pass, 0 warn, 2 skip, 0 fail`；`[OK] ./bin/kored: 13107362 字节（≤ 25 MiB）`；mem/idle 因无 `kored` 进程 `[SKIP]`（M0 预期） |

确认未执行 `make install` / `serve` / `upgrade` / CLI 启动；`bin/kored` mtime 为 2026-11-25 21:30（非本次构建）；`.kore-local.yaml`（2026-11-25 20:15）、`.kore-local-state/`、`.kore-local-run/` 本次未触碰（只读 `ls` 核对 mtime，无写入）。

## 4. git 顺序 / 写域 / G-25 / 状态

- 顺序：`f9c979e` 是 `83a42ae`（父=`f27955a`）与第二父 `82ffb69`（M6 merge）的合并；`83a42ae` 在 `f9c979e` 之前，`git merge-base --is-ancestor f9c979e HEAD` → 0（在链上）。验收中 HEAD 因其他 agent 并行提交从 `f9c979e` 前移到 `df90f4a`（M6 verifier）→ `64aa301`（ui-designer）；`f9c979e` 仍为祖先，M7 写域在 HEAD 与 `f9c979e` 完全一致（`git diff --quiet f9c979e HEAD -- <10 files>` → 0）。
- 合并写域（`git diff --name-status f9c979e^1 f9c979e`）：`internal/core/config/{backup_test.go,parse.go,parse_nested.go,reload.go,scalar.go,types.go,validate.go}` + `internal/core/market/{cleanup.go,cleanup_test.go,types.go}`，共 10 文件 / +899 -3，与实现提交逐文件一致；**未碰 `coreasset.go`**（M6 写域，M6 已先于 M7 合入 `82ffb69`，`git diff` 中无 coreasset）。
- G-25：`git worktree list` 仅主树 1 行；`git branch --list 'wt-*' 'tmp-*'` 空。
- `git status --porcelain`：仅他人 dirty（`M scripts/usability-pending.txt` + 8 个 `.agents/verify/*.md`/截图 untracked、`data/`、`dist/`）。本次唯一新增为报告 `.agents/verify/m7-verification.md`；临时缓存目录 `.verify-m7-tmp/` 已 `chmod -R u+w` 后 `rm -rf` 清理并确认不存在。

## 5. 交付与纪律自检

- 只读复跑：除本报告外未改任何代码/配置/文档；未 push、未执行 CLI、未碰真实运行态。
- 联网：仅 goproxy.cn 下载构建依赖（用户已授权），无其他出网。
- 临时目录：`.verify-m7-tmp/`（工作区内）已删除，不留垃圾。
- 失败如实记录：`go mod download all` exit=1（sumdb 只读，非市场/配置依赖）；首次离线 go test 因缺 yaml.v3 setup failed，补齐后 exit=0。
