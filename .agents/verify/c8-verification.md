> 元信息: 2026-11-26T19:55+08:00 · 执行者 c8-verifier（独立 verifier，G-09，非 c8-close）· task-130 · 只读复核 C8 证伪收口 commit bcbb2c2 · 报告 ≤120 行

# C8 独立验收报告（G-09 / task-130）

## 0. 总评：**BLOCKED**

核心结论（C8「前端未接后端能力」缺口前提被推翻）在**读码层面成立**：五项后端生产实现、前端 invoke 落点、source/dist 一致、两份文档已改、三门禁全绿、git 范围正确。
但按任务卡「证据缺失或断言不成立如实报 BLOCKED」的硬纪律，存在**两项不能放过的证据缺陷**：

1. **断言账面不符**：报告声称 `PASS=18 FAIL=0`，但 §2 逐项自报的子计数为 rename 2/2 + copy 2/2 + search 2/2 + trash 5/5 + uploadChunk 2/2 = **13**，与 18 差 5；唯一「harness 原样」出处 `testrun.log` 已随隔离树删除，无法对账或复跑，18 不可验证。
2. **文档 file:line 指向错误**：bcbb2c2 写入 `PLUGIN-MATURITY.md:71` / `FEATURE-GAP-BACKLOG.md:73` 的 `web/files.js:295,303,470,626,644,711`、`web/files-l2.js:318` 在 HEAD 上均**不是** invoke 调用点（见 §2.2）；接线事实本身为真，但引用行号已漂移，属文档准确性缺陷且已随提交固化。

以下为逐项核验（命令 + 退出码 + 结果）。

## 1. git 范围核验 —— PASS

| 项 | 命令 | exit | 结果 |
| --- | --- | --- | --- |
| HEAD | `git rev-parse HEAD` | 0 | `bcbb2c2437540c55bbca14dde5b269c1c8b0001f` |
| 提交精确 3 文件 | `git show --name-status --format=fuller bcbb2c2` | 0 | A `.agents/verify/c8-file-invoke-live.md`、M `docs/FEATURE-GAP-BACKLOG.md`、M `docs/PLUGIN-MATURITY.md`；3 files changed, 108 insertions(+), 5 deletions(-) |
| 提交署名 | 同上 | 0 | `[agent:c8-close]` 前缀 + `Signed-off-by: pengtang1024 <...>` |
| 未 push | `git branch -r --contains bcbb2c2` / `git merge-base --is-ancestor bcbb2c2 origin/main` | 0 / 1 | 无远端分支包含；`NO-NOT-PUSHED`；`git log origin/main..HEAD` 领先 10 提交（本提交在列） |
| worktree | `git worktree list` | 0 | 仅 1 行主树 `/home/.../kore bcbb2c2 [main]` |
| 他人 dirty 原样 | `git status --porcelain=v1` + `sha256sum scripts/usability-pending.txt` | 0 | 基线与收尾一致：` M scripts/usability-pending.txt`（sha `2eb88750...`）与 11 项 untracked（`data/`、`dist/`、8 份 `.agents/verify/*.md`、1 张截图）均未被动；本报告为新增第 12 项 untracked，提交时精确 add |

## 2. 读码核验

### 2.1 五项后端生产实现 —— PASS（file:line）

| 方法 | 分派 (`kore-plugin-file/internal/fileop/call.go`) | 生产实现 |
| --- | --- | --- |
| rename | `:53-54` → `callRename` | `rename.go:30-62`：单段新名校验、解析源、`exec.Move`、返回 `{from,to,renamed:true,method}` |
| copy | `:55-56` → `callCopy` | `copy.go:37-74`：分辨率/目标、类型与覆盖策略、`exec.Copy`、返回 `{copied,kind,entries,bytes}` |
| search | `:57-58` → `callSearch` | `search.go:70-114`：glob + 内容双模、阈值校验、`exec.Search`、返回 `{matched,entries[].line/preview}` |
| trash | `:59-64` → list/restore/purge | `trash.go:11-42` / `:46-71` / `:75-100`：list 倒序、restore 校验原路径、purge 强制 `id` 或 `all=true` |
| uploadChunk | `:35-38` → chunk/status | `upload_chunk.go:51-120`（offset 重叠重传幂等、`received`/`complete`）、`:123-140`（uploadStatus） |

`businessVerb`（`call.go:73-87`）确认新动词必须全限定名 `file.<verb>`，与前端调用形态一致。

### 2.2 前端接线 —— 实质 PASS / 引用行号 FAIL

`grep -n` 实测当前 HEAD 的调用点：
- `web/files.js`：`file.search`:700、`file.trash.list`:779/799、`file.trash.restore`:881/896、`file.trash.purge`:948/951、`file.rename`:988。
- `web/files-l2.js`：`file.uploadChunk`:142、`file.uploadStatus`:149/203/233、`file.copy`:455/467。
- 五项均真实经 `invoke()` 调用，C8 的「前端未接」事实断言**确已不成立**。
- 但 bcbb2c2 文档所引 `web/files.js:295/303/470/626/644/711`、`web/files-l2.js:318` 逐行回读：`:295=var single = targetEntry()`、`:303=S.selectAll.indeterminate`、`:470=}`、`:626=// targetEntry 注释`、`:644=S.tabTrash.textContent`、`:711=});`、`files-l2.js:318=归档文件名校验`——**均非调用点**。系 2026-11-23 `files-l2.md` 的旧行号在 11-26 多次 UI 重构（如 dccecd7）后漂移，c8-close 直接沿用未复核。

### 2.3 source/dist diff —— PASS

`diff -q web/files.js web/dist/files.js` exit **0**；`diff -q web/files-l2.js web/dist/files-l2.js` exit **0**；两组 sha256 各自相同（files.js `d99d90f6...`，files-l2.js `74eb7a93...`）；dist 中 invoke 落点与源文件同号。

### 2.4 两份文档已改 —— PASS（行号引用错误见 2.2）

`docs/PLUGIN-MATURITY.md:71` 已由「前端未接…」改为「**五项已接线并经隔离实例 invoke 真跑 PASS**」并引用两报告；
`docs/FEATURE-GAP-BACKLOG.md:70-74` C8 条已改为【已证伪 / 已接线 PASS】、`:164` 第 2 期前置条件已同步（报告 §4 写「:163」，实为编辑后 :164，轻微漂移）。

## 3. 证据复核 `c8-file-invoke-live.md` —— 部分成立 / 关键计数 BLOCKED

- 格式：报告 102 行，`> 元信息` 合规；逐方法给出 curl 形态、HTTP 200、响应原文、断言语义，叙事自洽（trash_id 时间戳、77 字节 payload、scanned=5/matched=1/line=2 均可与实现逻辑对上）。
- 静态前置可交叉验证项：`sha256sum kore-plugin-file/dist/file-0.3.6.tar.gz` = `990611c062aa6e335c8691110321c5c2cfb2b52a5a29acdb53d99dcc3f73bcc3`、size `1697595`，与报告及 `kore-plugins/index/plugins.json:43-44` 完全一致（exit 0）；`git rev-parse bcbb2c2^` = `576fcd15...`，与报告 §1 HEAD 一致；报告如实记录首轮 harness 参数错误（缺 username → 401）并说明修正，未掩饰失败。
- **BLOCKED ①**：§2 各节自报子计数合计 13（2+2+2+5+2），头条/`PASS=18 FAIL=0`/三处文档引用均为 18。报告未给出 18 条的拆分规则（例如是否把 HTTP 200 单列），差额 5 无解释；唯一原始出处 `testrun.log` 按 §6 已随 `rm -rf $ISO` 删除，harness 脚本亦不存。**无法逐条核对「18 条」命令+退出码+结果**，判定该证据要求未满足。
- **BLOCKED ②**：§4/文档中的 file:line 引用在 HEAD 失效（见 2.2），「带 file:line 的证据」这一 G-07 口径未达标。

## 4. 门禁复跑 —— PASS

| 门禁 | 命令 | exit | 结果 |
| --- | --- | --- | --- |
| docs-check | `bash scripts/docs-check.sh` | **0** | `5 pass, 1 warn, 0 fail`；10 份行数越界 WARN 均为既有文件（CORE/DATA-MODEL/SECURITY/DETAIL.*），不含本次 3 文件 |
| secret-check | `bash scripts/secret-check.sh` | **0** | `0 FAIL / 23 处匹配（占位写法均合规）` |
| diff --check | `git diff --check` / `git diff --check HEAD` / `git show --check --format='' bcbb2c2` | **0 / 0 / 0** | 三项均无输出 |

## 5. 隔离声明核验 —— 可验证部分 PASS

- `ss -ltnp` 仅见 `127.0.0.1:8787` 监听，**无 18887 残留**；隔离树 `.c8iso` 已不存在（`ls` → No such file），符合 §6 收尾声明。
- 主实例配置只读回读：`.kore-local.yaml:3 addr=127.0.0.1:8787`、`:11-14` state/run/log/index 路径；报告声称隔离实例 18887 + `$ISO` 全隔离，路径零交集，与配置事实不冲突。
- `.kore-local-state/state.db` mtime 19:49（晚于报告 19:47），系运行中 8787 守护进程自身活动，无证据归因于 c8-close；未发现主配置/插件生产代码/插件版本被改。
- 注意：因 harness 与 raw log 已删，「未碰主实例」只能靠路径声明 + 残留检查间接佐证，**不能独立重放验证**。

## 6. 处置建议（不改代码，交 lead 裁决）

1. 由 c8-close（原 owner）补一份可核对的 18 条断言清单（或把报告头条与三处文档引用改为**实际可证的 13 条**，并说明 HTTP 200 是否另计）；若无法补证，应撤回「18 断言」表述。
2. 修正 `PLUGIN-MATURITY.md:71` 与 `FEATURE-GAP-BACKLOG.md:73` 的 file:line 为 HEAD 实际调用点（2.2 表），或改为不带行号的「见 files-l2.md」表述。
3. 上述修正完成并复核后再将 C8 标为 PASS；在此之前 task-130 按硬纪律判 **BLOCKED**。

**总评：BLOCKED**（核心事实成立，18 断言证据不可核 + 文档引用行号失效）。
