# M4 独立验收报告（G-09 · m4-verifier）

- 验收对象：实现 `8d105bd` / merge `ee2e1de`，在 HEAD `ee2e1de` 上复跑。
- 角色：m4-verifier（与 implementer m4-impl 不同人，G-09）。
- 纪律：只读复跑；唯一写物 = 本报告；不 push、不联网、不执行 install/serve/upgrade、不碰 `.kore-local-*`；GOCACHE 与临时路径记录文件落工作区，用完删除；失败如实报告。
- 时间：2026-11-26（Asia/Shanghai）。

## 结论（PASS/FAIL 一句）

**PASS — M4 内置 `update.check` 任务在 HEAD `ee2e1de` 上独立复跑通过：scheduler/cmd-kored 测试、go vet、make idle、make docs-check 全部 exit 0（idle 为正常 SKIP），6 用例断言覆盖面逐条核对到位（含 fail-closed 与验签重启提示），G-19 单 ticker / G-24 / G-01 / 端点 72 / git 顺序 / G-25 主树均符合，无阻断项。**

## 1. 环境与基线

| 项 | 值 |
| --- | --- |
| 工作目录 | `/home/pt/Work/GolandProjects/kore-pl/kore` |
| go version | `go version go1.26.8 linux/amd64` |
| GOWORK | `off`（复跑显式导出） |
| GOCACHE | `/home/pt/Work/GolandProjects/kore-pl/kore/.gocache-m4-verify`（临时，用后删） |
| HEAD | `ee2e1de6451d0bb7ce4d4eceab3b79965046d7a3` |
| HEAD 前两条 | `ee2e1de`（merge M4）← `8d105bd`（实现 M4）← `883a342`（M5 merge） |

## 2. 复跑命令 + 退出码 + 关键输出

### 2.1 scheduler 测试（任务卡第 1 项）

```
$ GOCACHE=<workspace>/kore/.gocache-m4-verify GOWORK=off \
    go test -count=1 -timeout 200s ./internal/core/scheduler/...
ok  github.com/pengtang1024/kore/internal/core/scheduler  1.058s
exit code: 0
```

6 用例逐条 verbose 复跑（确认无 SKIP/空跑）：

```
$ GOCACHE=<...> GOWORK=off go test -count=1 -timeout 200s -v -run TestUpdateCheck \
    ./internal/core/scheduler/...
=== RUN   TestUpdateCheckDefaultDisabled       --- PASS (0.00s)
=== RUN   TestUpdateCheckOfflineShortCircuit   --- PASS (0.00s)
=== RUN   TestUpdateCheckOnlineResult          --- PASS (0.00s)
=== RUN   TestUpdateCheckSignatureFailureRequiresRestart --- PASS (0.00s)
=== RUN   TestUpdateCheckMissingCheckerFailClosed --- PASS (0.00s)
=== RUN   TestUpdateCheckOfflineNilFailClosed  --- PASS (0.00s)
PASS / ok  github.com/pengtang1024/kore/internal/core/scheduler  0.011s
exit code: 0
```

### 2.2 cmd/kored 测试（任务卡第 2 项）

```
$ GOCACHE=<...> GOWORK=off go test -count=1 -timeout 200s ./cmd/kored/...
ok  github.com/pengtang1024/kore/cmd/kored  9.733s
exit code: 0
```

装配位零值核对：`cmd/kored/serve_runtime.go` buildService 显式写死 `UpdateCheckEnabled: false` / `UpdateSource: ""`，`UpdateChecker` / `IsOffline` 未传即 nil（fail-closed），M1–M3 自更新装配段未触碰（`git show 8d105bd --stat` 该文件仅 +5 行）。cmd/kored 全量测试绿即零值不破坏既有装配。

### 2.3 go vet（任务卡第 4 项）

```
$ GOCACHE=<...> GOWORK=off go vet ./internal/core/scheduler/... ./cmd/kored/...
（无输出）
exit code: 0
```

### 2.4 G-19 ticker 唯一性 + make idle（任务卡第 3 项）

```
$ grep -rn "time.NewTicker\|time.AfterFunc" internal/core
internal/core/scheduler/loop.go:18:  ticker := time.NewTicker(s.tick)
exit code: 0（唯一命中，位于 scheduler/loop.go）
```

```
$ make idle
[SKIP] 未发现运行中的 kored 进程（M0 阶段正常）；需启动 kored 后实测（M1 起生效）
exit code: 0
```

SKIP 为 Makefile 设计内行为（无 kored 进程即跳过实测），符合任务卡「exit 0 或 SKIP」。源码侧周期性定时器白名单检查通过（唯一命中在 scheduler/，未新增周期源）。

### 2.5 make docs-check（任务卡第 4 项）

```
$ make docs-check
[RUN ] docs-check
[INFO] 文档计数: 124 份 · 证据计数: 301 份（.agents/verify/，仅参与链接检查）
-- 1/6 必需文件 -- [PASS] 16 项 + docs/DECISIONS 52 篇
-- 2/6 元信息 --   [PASS] 全部 124 份合规
-- 3/6 相对链接 -- [PASS] 检查 1275 条，全部可达
-- 4/6 占位词 --   [PASS] 全部 ≤2 次
-- 5/6 行数 --     [WARN] 越界 9 份（含 docs/CORE.md:414），2 条 [EXEMPT]，不阻断
-- 6/6 关键口径 -- [PASS] '8 MiB' / 'kore.plugin.v1' / '/run/kore' 覆盖达标
docs-check: 5 pass, 1 warn, 0 fail
结果: 门禁通过（1 WARN 不阻断）
exit code: 0
```

CORE.md 定向核对：`git show 8d105bd -- docs/CORE.md` 仅在 §2.15 scheduler 任务表新增 1 行（内置任务 `update.check`：`builtin-update-check`、默认禁用、离线短路、验签失败 `requires_restart:true`、M6 注入供应链、不自行联网），未改动其它行。端点计数仍为 **72**（65 业务 + 7 store）；§2.4 与 §12.2「70 → 71 → 72」口径未变，M1 端点表（`routes()` 74 − 6 兜底 + 独立注册 + UDS 专用端点）未动；`git show --stat 8d105bd` 仅 CORE.md +1 行，佐证端点表零改动。

### 2.6 G-24 / G-01（任务卡第 5 项）

```
$ grep -nE '\bany\b|map\[string\]any|\bobject\b|interface\{\}' \
    internal/core/scheduler/updatecheck.go
30:// 更新检查结果状态（显式枚举，G-24 禁 any/object）。   ← 仅注释守规说明
$ grep -nE '[[:space:]]any\b|map\[string\]any|interface\{\}|[[:space:]]object\b' \
    internal/core/scheduler/updatecheck.go | grep -vE '^[0-9]+:[[:space:]]*//'
（无输出，exit 1 = 零非注释命中）
```

结论：新生产文件 `updatecheck.go` 无 `any` / `map[string]any` / `interface{}` / `object` 实际类型逃逸；结果/参数结构全部显式类型（`UpdateCheckResult`、`updateCheckParams`、`UpdateIndexCheck`）。

```
$ grep -nE 'plugins/|internal/core/market|internal/core/installer' \
    internal/core/scheduler/updatecheck.go
（无输出，exit 1 = 零命中）
```

结论：无 `plugins/` / `market` / `installer` 引用，G-01 薄壳边界成立（检查器由装配层注入，调度器不自行联网，G-10）。

附带格式核对：`gofmt -l updatecheck.go updatecheck_test.go scheduler.go run.go serve_runtime.go` 无输出（exit 0）。

### 2.7 git 顺序与 G-25（任务卡第 6 项）

```
$ git log --oneline -3
ee2e1de [agent:m4-impl] merge: M4 scheduler update.check（wt-m4 → main）
8d105bd [agent:m4-impl] feat(core/scheduler): 内置 update.check 任务...
883a342 [agent:m5-impl] merge: M5 本地状态文件（wt-m5 → main）
$ git log -1 --pretty='%H %P' ee2e1de
ee2e1de6... 883a3429... 8d105bde...      ← merge 双亲 = M5 基线 + M4 实现
$ git merge-base --is-ancestor 8d105bd HEAD
exit code: 0                                ← 实现先于 merge
$ git worktree list --porcelain
worktree /home/pt/Work/GolandProjects/kore-pl/kore
HEAD ee2e1de6...
branch refs/heads/main                     ← 仅主树，无 wt-*
```

结论：8d105bd → ee2e1de 顺序正确；worktree 仅主树，无 `wt-*` 残留（G-25）。`git status --short` 无 `.kore-local-*` 命中，未触碰本地状态文件。

## 3. 6 用例断言覆盖面核对（不只看绿）

1. **默认禁用**：`TestUpdateCheckDefaultDisabled` 调 `service.Start` 后断言 `loadTask(builtinUpdateCheckID)` 返回 `ErrNotFound`，并遍历 `List()` 确认无 `Method==UpdateCheckMethod` 的任务行。覆盖「enabled=false 不落任务行」。注释明确不把 ticker 存在与否当判据（logs-maintain 默认启用本就会起 ticker），判据落在任务行，正确。
2. **离线短路零调用**：`TestUpdateCheckOfflineShortCircuit` 注入 `IsOffline=func(){true}` + `recordingChecker`（若被调用会置 calls=1、source），执行后断言 `run.Status==StatusOK`、`checker.calls==0`、`loadRuns()` 含该任务一条成功记录；再直接调 `runUpdateCheck` 断言输出 `Status==offline_skipped`、`Count==0`。覆盖「零调用（=零出站）、无错误、结构化跳过结果」。
3. **在线透传**：`TestUpdateCheckOnlineResult` 注入 `IsOffline=false`，断言 `checker.calls==1` 且 `checker.source=="https://updates.example.com/index"`、`run.Status==StatusOK`。覆盖「源地址从落库参数透传到注入检查器」。
4. **验签失败 requires_restart**：`TestUpdateCheckSignatureFailureRequiresRestart` 注入返回 `pluginapi.Error{Code:E_UNAUTHORIZED, Detail:{"requires_restart":true,...}}` 的检查器，断言 `run.Status==StatusFailed` 且 `run.Error` 含 `"requires_restart":true`；再补两条：无 detail 的 E_UNAUTHORIZED 经 `mapUpdateCheckError` 自动补 `requires_restart:true`，非签名错误 `errors.Is(got, other)` 原样透传（不误导重启）。覆盖「E_UNAUTHORIZED → failed + detail 带 requires_restart + 不改写其它错误」。
5. **缺检查器 fail-closed**：`TestUpdateCheckMissingCheckerFailClosed` 先注入 `enabled=true, checker=nil` 断言 `syncUpdateCheckTask()` 返回错误；再置 `updateSource="  "` 断言仍拒绝注册；最后用非内置 id 调 `runUpdateCheck` 断言 `ErrInvalid`。覆盖「源空/检查器空拒绝注册 + 用户任务冒用 method 拒绝执行」。
6. **IsOffline nil fail-closed**：`TestUpdateCheckOfflineNilFailClosed` 注入 `IsOffline=nil` + 检查器，执行后断言 `run.Status==StatusOK` 且 `checker.calls==0`。覆盖「未注入可达性判定视为离线、零出站」。

**覆盖面结论**：6 项各有一条独立用例，断言均为具体数值/状态/错误文本比对，无 vacuous pass；测试通过 `Start → syncUpdateCheckTask` 和 `execute → invoke → runUpdateCheck` 真实接线路径（已读码核对 `scheduler.go:312`、`run.go:45`），非直接调用孤立函数即可通过。验签用例还额外覆盖 detail 缺失补全与非签名错误不改写。无覆盖缺口。

## 4. 纪律执行说明

- 全程只读复跑 + 仅写本报告；未改任何生产/测试/文档文件。
- 临时 GOCACHE 目录 `.gocache-m4-verify` 与其路径记录 `.gocache-m4-verify.path` 在提交报告前删除（均在工作区内，不污染 git）。
- 未 push、未联网、未执行 CLI/install/serve/upgrade、未碰 `.kore-local-*`。
- 工作区存在他人未提交改动（如 `scripts/usability-pending.txt`、多个 `.agents/verify/*.md` 未跟踪、`data/`、`dist/`），本 verifier 仅精确 `git add .agents/verify/m4-verification.md` 后 `git commit -s`，不纳入他人改动。

## 5. 最终判定

**PASS。**
