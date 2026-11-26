# C8 证据链修复独立复核报告（commit 0530855）

> 时间：2026-11-26T20:05+08:00（Asia/Shanghai）｜复核者：`c8-fix-verifier`（task-135 / G-09 独立 verifier，非 c8-fix、非 c8-close，不复用实现者结论，按证据原文独立只读回读 + 复跑门禁）
> 工作目录：`/home/pt/Work/GolandProjects/kore-pl/kore`（git 根，HEAD=`0530855629afbc63bcec6a71cf4e52ccf039240c`）
> 纪律：全程只读复核；唯一写入 = 本报告；精确 add + `commit -s [agent:c8-fix-verifier]`；未 push、未联网、未执行主流程 CLI、未碰 `.kore-local-*`。

## VERDICT：PASS

之前 BLOCKED 两项（断言计数不自洽、file:line 失效）**均已消**。四项复核范围全部达标，无一项需报 BLOCKED。

## ① 断言计数自洽

- `.agents/verify/c8-file-invoke-live.md:7` 头条：`五项**全部 PASS**（13 条可逐项核对的断言 / 0 FAIL；HTTP 200 为每次 invoke 的传输前提，不另计断言，见 §2 汇总）`。
- 同文件 `:74` §2 汇总原文：`rename 2 + copy 2 + search 2 + trash 5 + uploadChunk 2 = **13 断言 / 0 FAIL**`；分项来源逐项可回读：`:43` 2/2、`:49` 2/2、`:55` 2/2、`:64` 5/5、`:72` 2/2。2+2+2+5+2=13，与头条一致。
- HTTP 200 不另计说明在案：`:75-76` 明写「HTTP 200 是每次 invoke 的传输前提，不另计入断言数（否则 9 次 invoke 将另得 9 条，合计 22，与原『18』亦不符）」。
- 原 18 仅留痕、不再维持：`:77-78` 明写「原 harness 曾输出 `PASS=18 FAIL=0`，但 `testrun.log` 已随隔离树删除、harness 脚本不存，18 这一数字无法逐条追溯，故本报告按可核对的 13 条为准，不再维持 18」。全仓 grep `18 断言|PASS=18` 仅在报告该留痕句命中，无一处仍把 18 当有效口径。
- 三处口径统一为 13（逐行 read 回读）：
  1. `.agents/verify/c8-file-invoke-live.md:7,74` — 13；
  2. `docs/PLUGIN-MATURITY.md:71` — 「隔离实测 13 条可核对断言 0 FAIL，HTTP 200 不另计」；
  3. `docs/FEATURE-GAP-BACKLOG.md:73`（C8 条）与 `:164`（第 2 期前置条件）— 均为「13 条可核对断言 / 0 FAIL」。
  三份文件内无残留「18 断言」有效口径。

## ② file:line 有效（全部用 read 逐行回读，均为 invoke 调用点）

`web/files.js`（9 处）：

| 引用行 | 回读原文（invoke 调用点） | 判定 |
| --- | --- | --- |
| :700 | `invoke('file.search', params).then(...)` | ✅ 调用点 |
| :779 | `return invoke('file.trash.list', { limit: 1 }).then(...)` | ✅ 调用点 |
| :799 | `return invoke('file.trash.list', { limit: 200 }).then(...)` | ✅ 调用点 |
| :881 | `return invoke('file.trash.restore', { id: id }).then(...)` | ✅ 调用点 |
| :896 | `return invoke('file.trash.restore', { id: id, overwrite: true }).then(...)` | ✅ 调用点 |
| :948 | `? invoke('file.trash.purge', { all: true }).then(...)` | ✅ 调用点 |
| :951 | `return invoke('file.trash.purge', { id: id }).then(...)` | ✅ 调用点 |
| :988 | `invoke('file.rename', { path: entry.path, name: name }).then(...)` | ✅ 调用点 |

`web/files-l2.js`（5 处）：

| 引用行 | 回读原文（invoke 调用点） | 判定 |
| --- | --- | --- |
| :142 | `return ctx.invoke('file.uploadChunk', {...});` | ✅ 调用点 |
| :149 | `return ctx.invoke('file.uploadStatus', { path: targetPath }).then(...)` | ✅ 调用点 |
| :203 | `return ctx.invoke('file.uploadStatus', { path: path }).then(...)` | ✅ 调用点 |
| :233 | `return ctx.invoke('file.uploadStatus', { path: item.path }).then(...)` | ✅ 调用点 |
| :455 | `ctx.invoke('file.copy', { src: entry.path, dst: dst, overwrite: !!overwrite.checked }).then(...)` | ✅ 调用点 |
| :467 | `return ctx.invoke('file.copy', { src: entry.path, dst: dst, overwrite: true }).then(...)` | ✅ 调用点 |

（上表 files-l2.js 实为 6 处：142 / 149 / 203 / 233 / 455 / 467，与文档引用逐一对应。）

- 报告 §4 `.agents/verify/c8-file-invoke-live.md:95` 已由 `:163` 改为 `:164`；对照 `docs/FEATURE-GAP-BACKLOG.md:164` 正是第 2 期前置条件含 C8 的那一句，行号指向正确。
- 失效旧行号不再作为调用点引用：`c8-file-invoke-live.md:90` 与 `FEATURE-GAP-BACKLOG.md:73` 均把 `files.js:295/300/748/470/626/644/711`、`files-l2.js:318` 明确标为「11-23 旧行号…已漂移，以当前 HEAD 真实调用点为准」，不再当作有效调用点；PLUGIN-MATURITY.md:71 也已换成当前 HEAD 行号。

## ③ 门禁复跑（命令 + exit + 关键输出）

| 门禁 | 命令 | exit | 关键输出 |
| --- | --- | --- | --- |
| docs-check | `cd kore && make docs-check` | **0** | `docs-check: 5 pass, 1 warn, 0 fail`；`结果: 门禁通过（1 WARN 不阻断）`（WARN 为 docs 行数越界存量 10 份，非本次改动引入） |
| secret-check | `cd kore && make secret-check` | **0** | `secret-check: 0 FAIL / 23 处匹配（占位写法均合规）` |
| git diff --check | `git diff --check` | **0** | 无输出；`git diff --cached --check` 亦 exit 0 无输出 |

## ④ git 状态

- `git show --stat 0530855` / `git diff-tree --no-commit-id --name-only -r 0530855`：精确 **3 文件** —— `.agents/verify/c8-file-invoke-live.md`、`docs/FEATURE-GAP-BACKLOG.md`、`docs/PLUGIN-MATURITY.md`（16 insertions / 9 deletions）；作者与 Signed-off-by 为 pengtang1024，message 带 `[agent:c8-fix]`。
- 未 push：`git branch -r --contains 0530855` 与 `git for-each-ref --contains 0530855 refs/remotes/` 均空；`git status -sb` 显示 `## main...origin/main [领先 12]`，0530855 仅在本地。
- worktree 仅主树：`git worktree list` 仅 `/home/.../kore-pl/kore 0530855 [main]` 一行；`git branch --list 'wt-*' 'tmp-*'` 空（G-25 达标）。
- 他人 dirty 原样：复核前后 `git status --short` 同为 ` M scripts/usability-pending.txt`、` M web/monitor.js` 及 11 项 `??`（verify 报告、screenshots、data/、dist/），本 verifier 未改其中任何一个。（注：复核期间 `web/monitor.js` 内容 sha 变化一次，属并发他人编辑；始终为未提交 dirty，本 verifier 从未触碰/暂存/提交该文件。）
- 本报告提交仅含自身一个文件，精确 add，无 `git add .`，不夹带他人 dirty。

## 结论

原 BLOCKED 两项（①13/18 计数不自洽、②file:line 失效漂移）均已按证据消解；③④门禁与 git 纪律全绿。**总评 PASS**。
