# 账本回滚 mode 修复独立验收（G-09 / task-340）

- 验收对象：commit `1ff423007e97d9c2250927e56c850e3bf9117267`（`[agent:ledger-mode-fix] fix(filewrite): 账本回滚逐属性还原 mode（0.1.6）`，版本 0.1.5→0.1.6）
- 验收人：ledger-mode-verifier（独立 verifier，非 ledger-mode-fix implementer；角色满足 G-09 不可兼任）
- HEAD：`4aafdfe`（`1ff4230` 之后唯一后续提交为并发的 c12-p1）
- 纪律：只读复核，唯一写入 = 本报告；不 push、不联网业务、不启主流程 CLI、不碰 `.kore-local-*`
- 总评：**PASS**（五项复核全部成立，mode 守恒坐实）

## 0. 环境与方法（证据可复现）

- Go：`go version go1.26.8 linux/amd64`。
- 只读隔离：`git -C kore archive HEAD` 解到工作区 `.lmv-archive`（确认含修复版 `func Restore` @ `filewrite.go:517`、`filewrite.Restore(dst, src)` @ `changes.go:184`）；`make web-dist` 补 gitignored 的 `web/dist`（`//go:embed` 依赖，exit 0）。对照基线：父提交 `b16a575` 同样 archive 到 `.lmv-base`。
- 沙箱默认 `GOCACHE=/home/pt/.cache/go-build` 与 `GOMODCACHE=/home/pt/go/pkg/mod` 均只读（首跑 setup failed）；按本机既有 verifier 口径显式指定工作区内可写 `GOCACHE=.gocache-ledger-mode-verifier`，复用已含全部依赖的 `GOMODCACHE=.tmp-acct-gomodcache`（含 `x/sys@v0.45.0`、`bbolt@v1.5.0`、`yaml.v3@v3.0.1`、`pluginapi@v0.1.3`）。所有 Go 命令 `GOWORK=off GOPROXY=off GOSUMDB=off`，**全程无联网、无 push**。
- 收尾：`.lmv-archive` / `.lmv-base` / 三个 `.lmv-*.txt` / 临时 GOCACHE 全部删除，kore git status 无本轮新增噪声。

## 1. 读码（逐条 file:line，全部在 HEAD / archive 复核）

### 1.1 `copyFile` 备份保留源 mode（创建 0600 + 落盘 Chmod 源 mode）

`internal/core/filewrite/filewrite.go`：

- `:417` `func copyFile(source, target string, mode os.FileMode) error`。
- `:423` `os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)` —— 副本创建期即 0600，内容写入期间不暴露。
- `:427-430` `io.Copy` + 失败关句柄返回；`:431-434` `out.Sync()` 后落盘。
- `:435-438` `out.Chmod(mode)`（失败关句柄返回）；`:439` `out.Close()` —— 内容落盘后才把副本 mode 改成源 mode。
- 调用点 provenance：`:308` 对目标 `os.Lstat` 取 `info`；`:309` `previousMode = info.Mode().Perm()`；`:320` `copyFile(clean, copyPath, info.Mode().Perm())` —— **传入的是写前源文件 mode，不是本次请求的 `opts.Mode`**（关键：mode 守恒取自源而非新写入权限）；`:316` 备份目录 `os.MkdirAll(dir, 0o700)`，全文可见性不扩大。
- 判据：`purge_op: file.restore` 的 args 只有（备份, 目标），备份自身是原 mode 唯一载体（`:411-416` 注释自洽）。成立。

### 1.2 新增 `Restore(target, copyPath)`：读备份 mode + 允许集校验 + fail-closed + 幂等 + 不改 purge_op

`internal/core/filewrite/filewrite.go`：

- `:517` `func Restore(target, copyPath string) error`。
- `:518-520` 空备份路径即拒（fail-closed）。
- `:521-524` `os.Stat(copyPath)` 读备份属性失败即拒。
- `:525` `mode := info.Mode().Perm()` —— mode 来自备份文件而非 purge_op 参数，协议形状不变。
- `:526-528` `ValidateMode(mode)` 校验；`ValidateMode` @ `:210-215` switch only `Mode0644/Mode0600/Mode0640`（常量 `:34-36`），否则 `CodeBadMode`「权限 %#o 不在允许集 {0644,0600,0640}」——0777 等宽权限在写目标之前被拒。
- `:529-532` `revertWrite(target, copyPath, mode)`，错误上抛包装；成功返回 nil。`revertWrite` @ `:484-502`：非空 copyPath 时 `os.ReadFile` 读备份内容（`:491-494`），`:495-497` mode==0 兜底 0644，`:498` `atomicWrite(target, content, mode)`。`atomicWrite` @ `:358-395`：同目录 `CreateTemp` → `Write` → `Sync` → `Chmod(mode)` → `Close` → `Rename` → 目录 `Sync`，任一步失败清临时文件 —— 覆盖是原子的且显式按备份 mode 落权限。
- 幂等：`:516` 注释「备份读后保留不消费」；实现只读备份（`:521 stat` + `revertWrite` 内 `:491 ReadFile`），无 Rename/Remove 备份 → 重复回滚不会因源消失失败（旧 `os.Rename` 语义会）。
- 不改 purge_op：`changes.go` 中 `purgeKindFileRestore` 仍要求 `len(op.Args)==2`（`:170-172`），`src,dst := op.Args[0],op.Args[1]`（`:173`），路径校验（`:174-179`）全部保留，只换执行体；账本登记/审计形状未变。成立。

### 1.3 `changes.go` 的 file.restore 从 os.Rename 改调 filewrite.Restore

`cmd/kored/changes.go`：

- `:169` `case purgeKindFileRestore:`；`:170-179` 参数与路径校验（同前）。
- `:180-183` 注释说明不用裸 `os.Rename` 的理由（rename 把备份自身 0600 带给目标 → 0644 drop-in/vhost 权限退化）。
- `:184` `if err := filewrite.Restore(dst, src); err != nil {`；`:185` 错误包装 `file.restore %s → %s 失败: %w`；`:187` return nil。
- `git show 1ff4230 -- cmd/kored/changes.go` 确认 diff 为 `- os.Rename(src, dst)` → `+ filewrite.Restore(dst, src)`（参数顺序正确：目标在前、备份在后，与 `Restore(target, copyPath)` 签名一致）。
- 依赖：新增 import `internal/core/filewrite`（`:13`）；薄壳门禁 4 pass/0 fail（§3）确认未越界。成立。

## 2. 回归复跑（干净 archive HEAD，离线，exit 0）

- 主回归：`GOWORK=off GOPROXY=off GOSUMDB=off GOCACHE/GOMODCACHE=<工作区可写> go test -count=1 -timeout 200s ./cmd/kored/... ./internal/core/filewrite/...`
  → `ok github.com/pengtang1024/kore/cmd/kored 8.493s` / `ok .../internal/core/filewrite 0.088s`，**exit 0**。
- verbose 具名用例（全部 PASS，子用例逐一核对）：

| 用例 | 子用例 | 结果 | 断言覆盖 |
| --- | --- | --- | --- |
| `TestBackupPreservesMode` | mode_0644 / mode_0600 / mode_0640 | 3/3 `--- PASS` | 受控写后 `os.Stat(result.CopyPath).Mode().Perm()` == 源 mode（0644/0600/0640） |
| `TestRestorePreservesModeAndContent` | sshd_dropin_0644 / nginx_vhost_0644 / sshd_dropin_0600 | 3/3 PASS | `bytes.Equal(回滚内容, 写前原文)` + `Stat(target).Mode().Perm()==tc.mode`；末尾再次 Restore 复验幂等（备份不被消费） |
| `TestRestoreRejectsUnsafeMode` | 单一用例 | PASS | 0777 备份 `Restore` 返回 error，且目标内容仍为 `"y\n"`（拒绝时目标不变，fail-closed） |
| `TestLedgerFileRestorePreservesMode` | sshd_dropin_0644 / nginx_vhost_0644 / sshd_dropin_0600 | 3/3 PASS | 完整链：`filewrite.Write`（备份保留 mode）→ `changes.jsonl` 登记 `file.restore`（`purgeOp{Args:[copyPath,target]}`）→ `readChanges` 读回 1 条 → `executePurgeOp` → `bytes.Equal` + `Stat.Mode().Perm()==tc.mode` |

- 关键覆盖点坐实：备份 mode 三值 0644/0600/0640；Restore 逐字节内容一致 + mode 一致；0777 拒绝且目标不被写；完整账本链覆盖 sshd drop-in 0644 / nginx vhost 0644 / 0600 片段。mode 守恒成立。

## 3. 门禁（干净 archive HEAD；无新增 FAIL，与父提交基线一致）

| 门禁 | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| vet | `make vet`（离线） | 0 | `[OK] go vet 通过` |
| gofmt | `gofmt -l` 五个改动 Go 文件 | — | **空输出**（全部已格式化） |
| docs-check | `make docs-check` | 0 | `docs-check: 5 pass, 1 warn, 0 fail` / `[PASS] 关键口径…` |
| secret-check | `make secret-check` | 0 | `0 FAIL / 31 处匹配（占位/正则均合规，1 WARN）` |
| thin-shell-check | `bash scripts/thin-shell-check.sh` | 0 | `4 pass, 0 fail（扫描 204 个可执行 .go 文件）` |
| version-check | `make version-check` | 0 | `内核 VERSION=0.1.6 覆盖 24 个插件，全部落在 requires_kore 区间内` |

- 无新增 FAIL：父提交 `b16a575` 同样 archive 上复跑，docs-check `5 pass/1 warn/0 fail`、secret-check `0 FAIL/31 处匹配/1 WARN`、thin-shell `4 pass/0 fail`、version-check `0.1.5 覆盖 24 仓全绿` —— 与 HEAD 逐项同口径（唯一差异为 VERSION 字符串 0.1.5→0.1.6，属预期）。secret-check 的 WARN 为 `backup-download-verification.md:125` 的 `ADMIN_PASSWORD` grep 正则片段，非凭据，且为存量。

## 4. git 合规（④）

- 精确 12 文件（`git diff-tree --no-commit-id --name-only -r 1ff4230`）：`CHANGELOG.md`、`Makefile`、`README.md`、`cmd/kored/changes.go`、`cmd/kored/changes_test.go`、`cmd/kored/main.go`、`docs/CORE.md`、`docs/DECISIONS/0028-controlled-file-write.md`、`docs/DECISIONS/0053-controlled-file-delete.md`、`docs/PLUGIN-PROTOCOL.md`、`internal/core/filewrite/filewrite.go`、`internal/core/filewrite/filewrite_test.go`。COUNT=12，与任务描述精确一致。
- DCO：`git log -1 --format=%B 1ff4230` 含 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>`；author=committer 同人。
- 未 push：`git branch -r --contains 1ff4230` 空（origin/gitea/github/gitee 四个远端跟踪分支均不含该提交）。
- 与并发 c12-p1（`4aafdfe`）共享文件只带自己 hunk：
  - `docs/DECISIONS/0028-controlled-file-write.md`：1ff4230 hunk `@@ -87,7 +87,7 @@`、`@@ -140,11 +140,24 @@`、`@@ -162,7 +175,7 @@`；c12-p1 仅 `@@ -218,3 +218,17 @@` —— 不重叠。
  - `docs/PLUGIN-PROTOCOL.md`：1ff4230 hunk `@@ -258,7 +258,7 @@`；c12-p1 为 `@@ -199,8 +199,15 @@`、`@@ -208,6 +215,13 @@` —— 不重叠。
  - HEAD 上两方 marker 同时存在：本修复 `2.1 回滚逐属性还原修订` / `按备份携带的原 mode 原子写回目标` 各 1 命中；c12-p1 `sshd.config.d` 8 命中、`sshd.dropin.v1` 2 命中。无互相覆盖。
- 他人 dirty 原样：本轮前后 `git status --porcelain` 一致 —— `M scripts/usability-pending.txt` + 10 项 `??`（`.agents/.agents/`、`.agents/verify/e2e-*.md`、`.agents/verify/local-update-plan.md`、`release-batch-*`、`run-user-model.md`、`screenshots/adp-debug-desktop-01.png`、`.gocache-kore-014/`、`015/`、`data/`、`dist/`）全部保持，未提交、未改。
- 临时资产：本轮全部临时 archive/GOCACHE/输出文本在父工作区，收尾已删；kore git status 无新增本轮噪声。
- worktree：`git worktree list` 仅 1 行主树 `[main]`；`git branch --list 'wt-*' 'tmp-*'` 空（G-25 合规）。
- `.kore-local-*`：仅列目录确认存在，未读未改未启主实例；未跑任何主流程 CLI。

## 5. 版本 0.1.5→0.1.6（⑤）

- `Makefile:29` `VERSION ?= 0.1.6`（原 0.1.5）；`cmd/kored/main.go:17` `var version = "0.1.6"`（原 0.1.5）；`docs/CORE.md:13` 版本基线「当前 MVP 版本 0.1.6」并记 0.1.6 修复说明；`README.md:146` 「当前版本（v0.1.6）」。三处版本真源 + README 展示面一致。
- `CHANGELOG.md:6` 新增 `## [0.1.6] - 2026-11-28`，fix→patch，逐条记动机（备份固定 0600 + 裸 rename 致 0644→0600）、修法（copyFile 保留源 mode / Restore 允许集 fail-closed / 幂等 / 不改 purge_op）、回归覆盖、文档同步；明确 0.1.6 < 0.2.0 仍在 24 仓 `requires_kore` 上界内，本轮不 push/不打 tag/不建 Release。
- 残留 0.1.5 引用均为历史证据文档（`hands-p1-fix-verification.md` 等）、CHANGELOG 历史条目、README 留痕与 docs/CORE 语义描述（「安装≠启用（0.1.5 明确）」），非当前版本声明，无漂移。

## 6. 结论

五项复核（读码 / 回归 / 门禁 / git 合规 / 版本）全部成立；mode 守恒通过完整账本链实证（内容逐字节 + mode 一致，0777 fail-closed，重复回滚幂等）。**总评 PASS**。报告以精确路径提交，未 push。
