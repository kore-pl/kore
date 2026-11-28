# hands-p1-fix-verification · 上手 P1 修复独立验收报告（G-09 / task-329）

> 元信息：2026-11-28 16:21–16:35 +08:00 · owner 独立 verifier `hands-p1-fix-verifier`（非实现者 `hands-p1-fix`）· 工作目录 `/home/pt/Work/GolandProjects/kore-pl/kore` · 被验对象 HEAD `3d7bce6128a4c7bec86e7713bb2715432ad218b1`（0.1.5）· 基线 `58d8dfac`（round51 真实上手报告）。全程只读复跑（唯一可写＝本报告），不 push / 不联网业务 / 不启主流程 CLI / 不碰 `.kore-local-*`。

## 总评：PASS（3 个 P1 全部成立；门禁 FAIL 归因属实；版本/提交精确；无夸大）

| 项 | 结论 |
| --- | --- |
| P1-1 备份表头 TypeError 修复 + 真机 DOM 断言 + 阴性对照 | PASS（独立复跑浏览器探针：阳性全绿、阴性精确复现原 TypeError） |
| P1-2 store/install 装完启用态可见（enabled+hint，默认不自动启用） | PASS（读码契约齐 + 2 条新测试 + 全量绿） |
| P1-3 未启用错误白话化 + 内部 API 只进 slog | PASS（读码 + 真 daemon UDS 409 测试绿 + grep 仅日志行） |
| 门禁（go test 两包全量 / vet / gofmt / version-check / docs-check / secret-check / frontend） | 全 exit 0 |
| usability exit 1，唯一实质 FAIL = waf tests/e2e（写域外），pending 清单未改 | PASS（归因属实，mtime 早于修复窗口佐证） |
| 版本 0.1.4→0.1.5 三处 + CHANGELOG | PASS |
| 提交 3d7bce6 精确 10 文件 + DCO + 未 push；他人 dirty 原样；临时 harness 删净 | PASS |

---

## 0. 基线与提交形态

```
$ git rev-parse HEAD                    -> 3d7bce6128a4c7bec86e7713bb2715432ad218b1
$ git show --name-only --format='' 3d7bce6 | grep -c .   -> 10
$ git branch -a --contains 3d7bce6      -> * main（无远端分支）
$ git rev-parse origin/main github/main gitee/main -> 342316a06ed2092be2d5e91000c25b0035f0ba97（均落后 3d7bce6，未 push）
$ git show -s --format='%an <%ae>%n%b' 3d7bce6 -> pengtang1024 <pengtang1024@qq.com> / Signed-off-by: pengtang1024 <pengtang1024@qq.com>（DCO 齐）
$ git show --check --format='' 3d7bce6   -> exit 0（无空白错误）
```

提交精确 10 文件，与实现报告 §1 写域表逐项一致：

```
.agents/verify/hands-r51-p1-fix.md   CHANGELOG.md                      Makefile
cmd/kored/main.go                    cmd/kored/serve_daemon_actions.go cmd/kored/serve_daemon_test.go
docs/CORE.md                         internal/core/httpapi/handlers_store.go
internal/core/httpapi/store_install_state_test.go (新增)              web/backups.js
```

`git worktree list` 仅主树（`/home/pt/.../kore 3d7bce6 [main]`）。

## 1. P1-1 备份表头（`web/backups.js`）— PASS

### 1.1 读码核对

- `:57` `function add(parent, child) { parent.appendChild(child); return child; }` — `add` 直传 child 给 `appendChild`，字符串必抛 TypeError。
- `:747`（修复后）`var htr = add(add(table, el('thead')), el('tr'));` + 两行根因注释（`:745-746`）。
- diff：`git show 3d7bce6 -- web/backups.js` 确认旧行 `add(add(table, 'thead') || table.appendChild(el('thead')), el('tr'))` → 新行 `add(add(table, el('thead')), el('tr'))`。
- 同文件正确写法对照：`:244`（定时备份任务表）、`:898`（备份列表表）均为 `add(table, el('thead'))`，修复后 `:747` 与之完全一致。全 `web/` grep `add(...,'thead')` 零命中。
- `node --check web/backups.js` → exit 0。

### 1.2 真机 DOM 断言独立复跑（关键：含阴性对照）

实现报告 §2 称：真实 Chromium（`chromium_headless_shell-1248` + `playwright-core 1.65.1`）加载当前工作区 `web/backups.js`、stub 非空 `backup.jobs`，`KoreBackup.render` 得 `{hasThead:true, headers 全 7 列, rowCount:1, pageErrors:[]}`；阴性对照注入旧行复现 TypeError + thead 消失。

我用同一工具链、inline stdin（不落任何临时脚本文件）、`window.KoreUI` shim + 完整 fetch stub（jobs 1 条 succeeded / list 空 / presets / stats / scheduler / plugins），独立复跑两遍：

```
POSITIVE (fixed source):  {"hasTable":true,"hasThead":true,
  "headers":["状态","名称","维度","开始时间","条目","大小","错误"],
  "rowCount":1,"winErrs":[]}, "pageErrors":[]           -> POSITIVE_ASSERT_OK=true
NEGATIVE (旧问题行注入到 jobs 表 :747):
  {"hasTable":true,"hasThead":false,"headers":[],"rowCount":0,"winErrs":[]},
  "pageErrors":["Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'."]
                                                -> NEGATIVE_CONTROL_OK=true
PROBE_EXIT=0
```

与实现报告 §2 的 DOM 证据逐项自洽（表头 7 列顺序、rowCount=1、零 pageerror；阴性对照精确复现 `appendChild` TypeError 且 thead 消失）。**阴性对照成立**：同一 harness 注回旧行即复现原缺陷，证明阳性断言不是空跑（关键判据满足）。补充核对：`paintJobs` 的三处 `add(table, el('thead'))` 中我只替换 jobs 表那行（按局部锚点定位），未误改任务表/列表表，阴性对照的失败确由旧问题行引起。

注：首次探针未提供 `KoreUI` shim 时多出一条 `emptyBlock` pageerror（来自空 `backup.list` 的 UI 依赖，与本缺陷无关）；补齐 shim 后阳性零错误——仅为探针 stub 噪声，不否定报告证据。

### 1.3 G-28 双端截图义务判定

报告 §2 末尾声明：本次是纯逻辑 bug 修复（仅 `el('thead')` 节点创建 + 注释），未改视觉布局 / CSS / 组件尺寸 / 文案尺寸，因此不触发双端截图 + 三问门槛；DOM 断言仅作逻辑验证、不冒充截图证据。核对 diff：本提交 `web/backups.js` 改动只有 1 行逻辑 + 2 行注释，无 CSS / 布局 / 尺寸变化。**判定如实**，与 G-28「涉及用户界面交付需双端截图」的口径一致——此处交付物是逻辑修复，未改变界面呈现，报告未夸大也未伪造截图。

## 2. P1-2 store/install 装完启用态 — PASS

### 2.1 读码核对（"不自动启用"是设计，无 API 契约冲突）

- `internal/core/installer/record.go:85` 注释明文「首次安装仍写 desired=disabled」，`:134-136` `desired := stateDesired; if previousDesired == "enabled" { desired = previousDesired }` — 首次装 `desired=disabled`、升级/重装保留原 desired，是设计。
- `web/store.js:1093` 安装成功后 `autoEnableAfterInstall(p)`，`:1112` 该函数单独 `POST .../enable` — 只有 UI 商店路径额外启用；API 直连无此步。
- `docs/CORE.md:127/142` 只说 reloadOne 按 desired 拉起、不改默认；全仓未发现"API 必须自动启用"契约。实现报告对此判断准确。

### 2.2 响应新增 enabled + hint（白话、无内部路径）

`git show 3d7bce6 -- internal/core/httpapi/handlers_store.go` 核对：
- `storeInstallResponse` 新增 `Enabled bool json:"enabled"` + `Hint string json:"hint,omitempty"`。
- `installEnabledState` 读 `Backend.Plugin` 真实态；未装配/查询失败按 false 并只 `slog.Warn`，不把 200 变 500。
- `handleStoreInstall` 成功响应填 `enabled`；`!enabled` 时 hint = 「插件已安装，但还没启用；请到『软件商店 → 插件管理』里启用它之后再用。」无 `POST` / `/api/v1/` / `/enable`。
- `docs/CORE.md:142` 同步"安装≠启用（0.1.5 明确）"语义与字段口径。

### 2.3 测试断言 + 全量绿

```
$ go test -count=1 -timeout 200s ./internal/core/httpapi/ -run TestStoreInstall -v
--- PASS: TestStoreInstallValidation / ForceRoutes / ReportsNotEnabled / ReportsEnabled / RefreshesRegistry / RefreshFailureSurfaces
ok  github.com/pengtang1024/kore/internal/core/httpapi  0.007s   STORE_TEST_EXIT=0
```

新增两测试断言（读码 `store_install_state_test.go:40-96`）：`...NotEnabled` → `enabled=false`、hint 含「软件商店」+「启用」、hint 不含 `POST`/`/api/v1/`/`/enable`、`backend.enableLog` 为空（默认行为未变、未自动调 Enable）；`...Enabled` → `enabled=true` 且无 hint。断言覆盖与实现报告 §3 一致。

## 3. P1-3 未启用错误白话化 — PASS

### 3.1 读码核对

`git show 3d7bce6 -- cmd/kored/serve_daemon_actions.go`：未启用分支 `Invoke` message 从「请先 POST /api/v1/plugins/<id>/enable」改为「插件「%s」尚未启用，请在『软件商店 → 插件管理』里启用后重试」；内部 API 路径只走 `slog.Info("插件未启用，invoke 被拒绝", "plugin_id",..., "enable_endpoint", apiPlugins+"/"+plugin+"/enable")`，不进 message / detail。

`grep -n "api/v1/plugins\|enable_endpoint\|尚未启用" cmd/kored/serve_daemon_actions.go` → 内部路径仅出现在 `:15` 常量、`:105` slog 行；message（`:107`）只有白话。实现报告 §1/§3 描述属实。

### 3.2 真 daemon + UDS 409 测试

`cmd/kored/serve_fixture_test.go:49-70` 确认 `newHarness` 在 `t.TempDir()` 下装配真实 service + `newSocket(t)` 随机 UDS + `startServer` 真 HTTP server，`h.do` 走 UDS HTTP — 是真 daemon 端到端，非纯 mock。

```
$ go test -count=1 -timeout 200s ./cmd/kored/ -run TestInvokeNotEnabledConflict -v
INFO 插件未启用，invoke 被拒绝 plugin_id=echo enable_endpoint=/api/v1/plugins/echo/enable  ← 内部路径只进日志
--- PASS  ok github.com/pengtang1024/kore/cmd/kored  0.271s   INVOKE_TEST_EXIT=0
```

测试增强（`serve_daemon_test.go`）断言：409 `E_CONFLICT`、message 含「软件商店」+「启用」白话锚点、message/detail 均不含 `POST`/`/api/v1/`/`/enable`。断言覆盖与报告一致。

## 4. 门禁复跑（隔离缓存：GOCACHE=.tmp/gocache-h51 GOMODCACHE=.tmp/gomodcache GOWORK=off GOPROXY=off GOSUMDB=off）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `go test -count=1 -timeout 200s ./internal/core/httpapi/ ./cmd/kored/` | 0 | 两包全量 ok（6.739s / 8.728s） |
| `go vet ./internal/core/httpapi/ ./cmd/kored/` | 0 | 无输出 |
| `gofmt -l`（4 个改动 Go 文件） | 0 | 无输出 |
| `node --check web/backups.js` | 0 | 无输出 |
| `make version-check` | 0 | `内核 VERSION=0.1.5 覆盖 24 个插件，全部落在 requires_kore 区间内` |
| `make docs-check` | 0 | `5 pass, 1 warn, 0 fail`（warn 为存量 11 份行数越界，非本次引入） |
| `make secret-check` | 0 | `0 FAIL / 35 处匹配（1 WARN 为存量 grep 正则片段）` |
| `make frontend` | 0 | `首屏 91092 字节 ≤ 307200 字节`；i18n 增量 2941 ≤ 3072（首屏 WARN 为存量漂移） |

全部与实现报告 §4 表一致。报告 §4 诚实声明未跑 `make check` 全量 21 段（含跨仓/交叉编译/race，耗时且混入他人在途 dirty），按任务卡只跑关键段 + 受影响 Go 包全量 —— 边界如实，不夸大。

### 4.1 usability exit 1 归因核对

```
$ bash scripts/usability-check.sh（带可写 Go 缓存）
USABILITY_EXIT=1
实质 FAIL 仅 1 条：[FAIL] A1 waf: ZeroParam 真跑失败: FAIL github.com/pengtang1024/kore-plugin-waf/tests/e2e 0.258s ...
末行 [FAIL] G-33 有新违规 ... 为汇总聚合行（同一 FAIL 的重复陈述）
统计：usability-check: 0 pass, 502 warn, 1 fail, 194 unverified
tab 计数（推荐提示，不影响判定）：8 hub / 20 tab
```

- 唯一实质 FAIL 是兄弟仓 `kore-plugin-waf/tests/e2e` 的 ZeroParam 真跑失败，位于本任务写域（kore 仓 3 P1 修复）之外，与本次改动无关。
- `git status --porcelain scripts/usability-pending.txt` → ` M`（他人 dirty），该文件**不在** 3d7bce6 提交内（`git show --name-only 3d7bce6 | grep -c usability-pending` → 0）。
- 关键归因佐证：`stat` mtime `scripts/usability-pending.txt = 2026-11-24 21:22:52`，而修复窗口为 2026-11-28 16:05–16:20（改动文件 mtime 均 11-28 16:10–16:19，含已移除 A1 waf 行的旧快照）。实现者未在本轮改 pending 清单，"未改 pending 清单掩盖 FAIL"的声明成立。
- 合并判定：usability 为存量 WARN 级 + 域外 FAIL，非本提交新增 FAIL；实现报告归因属实、未夸大。

## 5. 版本判定 — PASS

- `Makefile:29 VERSION ?= 0.1.5`、`cmd/kored/main.go:17 var version = "0.1.5"`、`docs/CORE.md:13` 版本基线三处同步（diff 确认为 0.1.4→0.1.5；fix→patch）。
- `CHANGELOG.md` 新增 `[0.1.5] - 2026-11-28` fix 条目，逐条记三 P1 动机/修法/诚实边界，不宣称超越竞品；0.1.5 < 0.2.0，`version-check` 24 仓全绿。

## 6. 收尾卫生 — PASS

- 提交未 push：三端 main 均停在 342316a；无 tag / Release 动作（verifier 未执行）。
- 他人 dirty 原样：`git status --porcelain` 仍为开工前的同一集合（`scripts/usability-pending.txt` M；`.agents/.agents/`、多份 `.agents/verify/*.md`、`screenshots/adp-debug-desktop-01.png`、`.gocache-kore-014/`、`data/`、`dist/` untracked）；本报告之外未新增/删改任何他人文件。
- 临时 harness：全工作区 `find ... -iname '*h51-p1-fix*'` 零命中（实现者的 `.tmp/h51-p1-fix/` 已删净）；本 verifier 的浏览器探针全程 inline stdin、Go 缓存复用 `.tmp/gocache-h51`/`.tmp/gomodcache`（既有口径，未新增持久脚本），usability 临时输出已 `rm` 删除。
- 未碰 `.kore-local-*`（mtime 均为 11-23～11-28 11:48，早于修复窗口）、未请求 8787、未执行真实 install/upgrade/serve、未联网业务、未 push。

## 7. 结论

三个 P1 的证据链完整、断言有效（尤其 P1-1 阴性对照证明断言非空跑），门禁关键段全绿，唯一 usability FAIL 为写域外兄弟仓且归因有 mtime 佐证，版本/提交精确、卫生合规。**总评 PASS**，无 BLOCKED 项，无归因夸大。

—— verifier `hands-p1-fix-verifier`（G-09，独立于实现者 hands-p1-fix）
